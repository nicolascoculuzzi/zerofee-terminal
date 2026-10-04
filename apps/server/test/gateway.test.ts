/**
 * The whole server in-process: fake ingest source, in-memory SQLite, mocked network (no RPC, no relays,
 * no Binance). Exercises the WebSocket subscribe flow (snapshot -> sequenced deltas), errors, REST and
 * POST /api/tx in dry-run.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  HealthResponse,
  LookupTablesResponse,
  SearchResponse,
  SourceHealth,
  TokenResponse,
  TxSubmitResponse,
} from "@zerofee/protocol";
import { type App, createApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { IngestSink, IngestTx, Source } from "../src/ingest/types";
import { setLogLevel } from "../src/log";
import { openDb } from "../src/storage/db";
import { RpcClient } from "../src/util/rpc";
import { addr, FakeCurve, mockFetch, synthTx, waitFor } from "./helpers";

class TestSource implements Source {
  readonly name = "test";
  sink: IngestSink | null = null;
  start(sink: IngestSink): void {
    this.sink = sink;
  }
  async stop(): Promise<void> {}
  emit(tx: IngestTx): void {
    this.sink?.tx(tx);
  }
  health(): SourceHealth {
    return { name: this.name, connected: true, reconnects: 0, messages: 0, lastMessageAt: null, slot: null, dropped: 0, notes: [] };
  }
}

interface Msg {
  type: string;
  topic?: string;
  seq?: number;
  // biome-ignore lint/suspicious/noExplicitAny: tests inspect payloads of every topic loosely
  data?: any;
  code?: string;
  reason?: string;
}

class Client {
  readonly msgs: Msg[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.onmessage = (ev) => this.msgs.push(JSON.parse(String(ev.data)));
  }
  static async connect(url: string): Promise<Client> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("ws error"));
    });
    return new Client(ws);
  }
  send(o: unknown): void {
    this.ws.send(JSON.stringify(o));
  }
  of(topic: string, type?: string): Msg[] {
    return this.msgs.filter((m) => m.topic === topic && (!type || m.type === type));
  }
  async next(pred: (m: Msg) => boolean, timeoutMs = 3_000): Promise<Msg> {
    return waitFor(() => this.msgs.find(pred), timeoutMs);
  }
}

const RPC_URL = "http://rpc.test";
const rpcMock = mockFetch((url, body) => {
  if (url !== RPC_URL) return [404, {}];
  if (body?.method === "simulateTransaction") {
    return [
      200,
      { jsonrpc: "2.0", id: 1, result: { context: { slot: 77 }, value: { err: null, logs: ["Program log: ok"], unitsConsumed: 12_345 } } },
    ];
  }
  if (body?.method === "getMultipleAccounts") {
    const n = ((body.params?.[0] as string[]) ?? []).length;
    return [200, { jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: new Array(n).fill(null) } }];
  }
  return [200, { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "not mocked" } }];
});

let app: App;
let source: TestSource;
let base: string;
const nowSec = () => Math.floor(Date.now() / 1000);
const mint = addr("gateway-mint");
const dev = addr("gateway-dev");
const curve = new FakeCurve(mint, dev);
let slot = 900_000;

beforeAll(() => {
  setLogLevel("error");
  source = new TestSource();
  const cfg = loadConfig({
    SERVER_PORT: "0",
    DB_PATH: ":memory:",
    RPC_URL,
    LOG_LEVEL: "error",
    RATE_LIMIT_REST_RPS: "1000",
    RATE_LIMIT_REST_BURST: "1000",
  });
  app = createApp(cfg, {
    source,
    db: openDb(":memory:"),
    rpc: new RpcClient({ url: RPC_URL, fetchFn: rpcMock.fn }),
    fetchFn: rpcMock.fn,
    solUsd: null,
    pollers: false,
  });
  base = `http://127.0.0.1:${app.gateway.port}`;
});

afterAll(async () => {
  await app.stop();
});

describe("websocket subscribe flow", () => {
  test("pulse:new snapshot, then a launch arrives as a full-summary delta with seq + 1", async () => {
    const c = await Client.connect(`${base.replace("http", "ws")}/ws`);
    c.send({ type: "subscribe", topic: "pulse:new" });
    const snap = await c.next((m) => m.topic === "pulse:new" && m.type === "snapshot");
    expect(snap.data.tokens).toEqual([]);
    source.emit(synthTx(++slot, [curve.create(nowSec()), curve.buy(dev, 2_000_000_000n, nowSec())]));
    const delta = await c.next(
      (m) => m.topic === "pulse:new" && m.type === "delta" && m.data.upsert.some((u: { mint: string }) => u.mint === mint),
    );
    expect(delta.seq).toBe((snap.seq ?? 0) + 1);
    const s = delta.data.upsert.find((u: { mint: string }) => u.mint === mint);
    expect(s).toMatchObject({ mint, launchpad: "pump", holders: 1, buys: 1, migrated: false });
    expect(s.devPct).toBeGreaterThan(0);
    c.ws.close();
  });

  test("token / trades / candles / tradectx: snapshots then deltas on the next trade, no seq gaps", async () => {
    const c = await Client.connect(`${base.replace("http", "ws")}/ws`);
    await Bun.sleep(20); // let the creator-vault PDA derivation finish
    const topics = [`token:${mint}`, `trades:${mint}`, `candles:${mint}:1s`, `tradectx:${mint}`];
    for (const topic of topics) c.send({ type: "subscribe", topic });
    for (const topic of topics) await c.next((m) => m.topic === topic && m.type === "snapshot");
    expect(c.of(`token:${mint}`, "snapshot")[0]?.data.mint).toBe(mint);
    expect(c.of(`trades:${mint}`, "snapshot")[0]?.data.trades).toHaveLength(1);
    expect(c.of(`candles:${mint}:1s`, "snapshot")[0]?.data).toMatchObject({ supply: 1e9 });
    expect(c.of(`tradectx:${mint}`, "snapshot")[0]?.data).toMatchObject({ venue: "pump", mint, creator: dev, complete: false });

    const buyer = addr("gateway-buyer");
    source.emit(synthTx(++slot, [curve.buy(buyer, 1_000_000_000n, nowSec())]));
    const trades = await c.next((m) => m.topic === `trades:${mint}` && m.type === "delta");
    expect(trades.data.trades).toHaveLength(1);
    expect(trades.data.trades[0]).toMatchObject({ trader: buyer, side: "buy", venue: "pump" });
    const token = await c.next((m) => m.topic === `token:${mint}` && m.type === "delta");
    expect(token.data).toMatchObject({ mint, buys: 2, holders: 2 });
    expect(token.data.name).toBeUndefined(); // patches carry only changed fields
    await c.next((m) => m.topic === `candles:${mint}:1s` && m.type === "delta");
    const ctx = await c.next((m) => m.topic === `tradectx:${mint}` && m.type === "delta");
    expect(BigInt(ctx.data.virtualQuoteReserves)).toBe(curve.vQuote);
    for (const topic of topics) {
      const seqs = c.of(topic).map((m) => m.seq as number);
      expect(seqs).toEqual(seqs.map((_, i) => (seqs[0] as number) + i)); // contiguous
    }
    c.ws.close();
  });

  test("errors: unknown topic, unpublished wallet topic, bad JSON; unsubscribe stops deltas", async () => {
    const c = await Client.connect(`${base.replace("http", "ws")}/ws`);
    c.send({ type: "subscribe", topic: "nope:1" });
    c.send({ type: "subscribe", topic: `wallet:${dev}` });
    c.ws.send("{not json");
    await waitFor(() => c.msgs.filter((m) => m.type === "error").length >= 3);
    expect(c.msgs.filter((m) => m.type === "error").map((m) => m.code)).toEqual(["unknown_topic", "unavailable", "bad_request"]);

    c.send({ type: "subscribe", topic: `trades:${mint}` });
    await c.next((m) => m.topic === `trades:${mint}` && m.type === "snapshot");
    c.send({ type: "unsubscribe", topic: `trades:${mint}` });
    await Bun.sleep(50);
    source.emit(synthTx(++slot, [curve.buy(addr("x"), 1_000_000n, nowSec())]));
    await Bun.sleep(250);
    expect(c.of(`trades:${mint}`, "delta")).toEqual([]);
    c.ws.close();
  });

  test("the internal debug topic serves recent launches and stats", async () => {
    const c = await Client.connect(`${base.replace("http", "ws")}/ws`);
    c.send({ type: "subscribe", topic: "debug" });
    const snap = await c.next((m) => m.topic === "debug" && m.type === "snapshot");
    expect(snap.data.stats).toMatchObject({ source: "test" });
    expect(snap.data.recent.some((f: { kind: string; mint: string }) => f.kind === "launch" && f.mint === mint)).toBe(true);
    c.ws.close();
  });
});

describe("REST", () => {
  test("GET /api/health", async () => {
    const h = (await (await fetch(`${base}/api/health`)).json()) as HealthResponse;
    expect(h).toMatchObject({ ok: true, dryRun: true, sources: [{ name: "test" }] });
    expect(h.ingest.launches).toBeGreaterThanOrEqual(1);
  });

  test("GET /api/tokens/:mint (known, unknown, invalid)", async () => {
    const r = await fetch(`${base}/api/tokens/${mint}`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as TokenResponse;
    expect(body.token.mint).toBe(mint);
    expect(body.tradeContext?.venue).toBe("pump");
    expect((await fetch(`${base}/api/tokens/${addr("unknown")}`)).status).toBe(404);
    expect((await fetch(`${base}/api/tokens/not-a-mint`)).status).toBe(400);
  });

  test("GET /api/search: exact contract address, ticker, name, no match, bad input", async () => {
    const get = async (q: string, extra = "") => {
      const r = await fetch(`${base}/api/search?q=${encodeURIComponent(q)}${extra}`);
      return { status: r.status, body: (await r.json()) as SearchResponse };
    };
    const symbol = mint.slice(0, 4).toUpperCase(); // FakeCurve names: symbol = first 4 chars, name "Name <first 4>"
    expect((await get(mint)).body.tokens.map((t) => t.mint)).toEqual([mint]);
    expect((await get(symbol.toLowerCase())).body.tokens[0]?.mint).toBe(mint);
    expect((await get(`$${symbol}`)).body.tokens[0]?.mint).toBe(mint);
    expect((await get(`name ${mint.slice(0, 4)}`)).body.tokens.some((t) => t.mint === mint)).toBe(true);
    expect((await get(addr("nobody-launched-this"))).body.tokens).toEqual([]);
    expect((await get("zzzz-no-such-token")).body.tokens).toEqual([]);
    expect((await get("", "&limit=5")).body.tokens).toEqual([]);
    expect((await get("x".repeat(65))).status).toBe(400);
  });

  test("GET /api/lookup-tables: chain reads (none exist on the mock RPC), bad input", async () => {
    const t1 = addr("alt-1");
    const t2 = addr("alt-2");
    const r = await fetch(`${base}/api/lookup-tables?addresses=${t1},${t2}`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as LookupTablesResponse;
    expect(body.tables).toEqual({ [t1]: null, [t2]: null });
    expect((await fetch(`${base}/api/lookup-tables`)).status).toBe(400);
    expect((await fetch(`${base}/api/lookup-tables?addresses=nope`)).status).toBe(400);
    const nine = Array.from({ length: 9 }, (_, i) => addr(`alt-${i}`)).join(",");
    expect((await fetch(`${base}/api/lookup-tables?addresses=${nine}`)).status).toBe(400);
  });

  test("GET /api/candles merges stored and in-memory candles", async () => {
    await Bun.sleep(300); // a writer flush
    const r = await fetch(`${base}/api/candles?mint=${mint}&tf=1s&from=0&to=${Date.now() + 60_000}`);
    const body = (await r.json()) as { candles: { t: number; n: number }[]; supply: number };
    expect(r.status).toBe(200);
    expect(body.supply).toBe(1e9);
    expect(body.candles.length).toBeGreaterThanOrEqual(1);
    expect((await fetch(`${base}/api/candles?mint=${mint}&tf=2m`)).status).toBe(400);
  });

  test("GET /debug serves the page", async () => {
    const r = await fetch(`${base}/debug`);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(await r.text()).toContain("zerofee feed");
  });

  test("POST /api/tx simulates in dry-run and never touches a landing lane", async () => {
    const signed = new Uint8Array([1, ...new Array(64).fill(7), 0x80, 1, 0, 1, 1, ...new Array(32).fill(3)]);
    const r = await fetch(`${base}/api/tx`, {
      method: "POST",
      body: JSON.stringify({ tx: Buffer.from(signed).toString("base64"), preset: "secure" }),
    });
    const body = (await r.json()) as TxSubmitResponse;
    expect(r.status).toBe(200);
    expect(body).toMatchObject({ dryRun: true, preset: "secure", lanes: [], simulation: { err: null, unitsConsumed: 12_345, slot: 77 } });
    const sim = rpcMock.calls.filter((c) => c.method === "simulateTransaction");
    expect((sim.at(-1)!.body as { params: [string, { sigVerify: boolean }] }).params[1].sigVerify).toBe(true);
    expect(rpcMock.calls.every((c) => c.url === RPC_URL)).toBe(true); // no sender / jito traffic

    const unsigned = new Uint8Array([1, ...new Array(64).fill(0), 0x80, 1, 0, 1, 1, ...new Array(32).fill(3)]);
    await fetch(`${base}/api/tx`, { method: "POST", body: JSON.stringify({ tx: Buffer.from(unsigned).toString("base64") }) });
    const last = rpcMock.calls.filter((c) => c.method === "simulateTransaction").at(-1)?.body as {
      params: [string, Record<string, unknown>];
    };
    expect(last.params[1]).toMatchObject({ sigVerify: false, replaceRecentBlockhash: true });

    expect((await fetch(`${base}/api/tx`, { method: "POST", body: JSON.stringify({ tx: "AAAA", preset: "yolo" }) })).status).toBe(400);
    expect((await fetch(`${base}/api/tx`, { method: "GET" })).status).toBe(405);
  });

  test("enrichment is wired in: a pass runs against the (mocked) network and health reports budgets", async () => {
    expect(app.enricher).not.toBeNull();
    app.enricher?.tick();
    await waitFor(() => (app.enricher?.stats.dexErrors ?? 0) >= 1); // the mock answers DexScreener with 404
    const h = (await (await fetch(`${base}/api/health`)).json()) as HealthResponse;
    const notes = h.sources[0]?.notes.join("\n") ?? "";
    expect(notes).toContain("enrich dex paid:");
    expect(notes).toContain("budget 60 per 60 s");
    expect(notes).toContain("enrich funding: off: no HELIUS_API_KEY");
    const token = (await (await fetch(`${base}/api/tokens/${mint}`)).json()) as TokenResponse;
    expect(token.token).toMatchObject({ holdersSource: "trades", insidersPct: null, devSoldAll: false });
  });
});

describe("rate limiting", () => {
  test("REST requests beyond the per-IP burst get 429", async () => {
    const cfg = loadConfig({ SERVER_PORT: "0", DB_PATH: ":memory:", RPC_URL, RATE_LIMIT_REST_RPS: "1", RATE_LIMIT_REST_BURST: "3" });
    const small = createApp(cfg, {
      source: null,
      db: openDb(":memory:"),
      rpc: new RpcClient({ url: RPC_URL, fetchFn: rpcMock.fn }),
      solUsd: null,
      pollers: false,
    });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await fetch(`http://127.0.0.1:${small.gateway.port}/api/health`)).status);
      expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
      expect(statuses.slice(3)).toEqual([429, 429]);
    } finally {
      await small.stop();
    }
  });
});
