/**
 * The whole server in-process with a fake chain: a viewer subscribes to a coin first seen mid-life, the token
 * snapshot says "partial", a backfill runs, `backfill` corrections arrive on trades:/candles:, the coverage goes
 * "complete", and GET /api/trades pages every buy and sell, GET /api/candles the whole history.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CandlesResponse, HealthResponse, SourceHealth, TradesPageResponse } from "@zerofee/protocol";
import { type App, createApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { IngestSink, IngestTx, Source } from "../src/ingest/types";
import { setLogLevel } from "../src/log";
import { openDb } from "../src/storage/db";
import { RpcClient } from "../src/util/rpc";
import { addr, FakeCurve, mockFetch, synthTx, waitFor } from "./helpers";
import { chainTx, decodeFake, FakeHistoryReader } from "./historyHelpers";

class TestSource implements Source {
  readonly name = "test";
  sink: IngestSink | null = null;
  start(sink: IngestSink): void {
    this.sink = sink;
  }
  async stop(): Promise<void> {}
  health(): SourceHealth {
    return { name: this.name, connected: true, reconnects: 0, messages: 0, lastMessageAt: null, slot: null, dropped: 0, notes: [] };
  }
}

// biome-ignore lint/suspicious/noExplicitAny: loose wire payloads
type Msg = { type: string; topic?: string; seq?: number; data?: any; reason?: string };

const RPC_URL = "http://rpc.test";
const rpcMock = mockFetch(() => [200, { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "not mocked" } }]);
const mint = addr("api-hist-mint");
const curve = new FakeCurve(mint, addr("api-hist-dev"));
const t0 = Math.floor(Date.now() / 1000) - 3_600;
/** A signature-shaped (base58, 64-88 chars) test signature. */
const b58sig = (tag: string) => (addr(`apih-sig-${tag}`) + addr(`apih-sig2-${tag}`)).slice(0, 86);
const txs: IngestTx[] = [synthTx(50_000, [curve.create(t0)], { signature: b58sig("create") })];
for (let i = 1; i <= 60; i++)
  txs.push(synthTx(50_000 + i, [curve.buy(addr(`apih-w${i % 7}`), 30_000_000n, t0 + i * 50)], { signature: b58sig(String(i)) }));

let app: App;
let source: TestSource;
let base: string;
let reader: FakeHistoryReader;

beforeAll(() => {
  setLogLevel("error");
  source = new TestSource();
  reader = new FakeHistoryReader(new Map([[curve.bondingCurve, [...txs].reverse().map((t) => chainTx(t))]]), 1, 3);
  const cfg = loadConfig({
    SERVER_PORT: "0",
    DB_PATH: ":memory:",
    RPC_URL,
    LOG_LEVEL: "error",
    RATE_LIMIT_REST_RPS: "1000",
    RATE_LIMIT_REST_BURST: "1000",
    HISTORY_MERGE_EVERY: "10",
    HISTORY_BACKGROUND: "false",
    HISTORY_VIEW_REFRESH_MS: "0",
  });
  app = createApp(cfg, {
    source,
    db: openDb(":memory:"),
    rpc: new RpcClient({ url: RPC_URL, fetchFn: rpcMock.fn }),
    fetchFn: rpcMock.fn,
    solUsd: null,
    pollers: false,
    historyReader: reader,
    historyDecode: decodeFake,
  });
  base = `http://127.0.0.1:${app.gateway.port}`;
  // the server sees the coin mid-life: its last trade only
  source.sink?.tx(txs[txs.length - 1] as IngestTx);
  const rec = app.market.tokens.get(mint);
  if (rec) rec.bondingCurve = curve.bondingCurve;
});

afterAll(async () => {
  await app.stop();
});

describe("history over the protocol", () => {
  test("subscribe -> partial -> backfill corrections -> complete; REST pages every trade and the whole chart", async () => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
    const msgs: Msg[] = [];
    ws.onmessage = (ev) => msgs.push(JSON.parse(String(ev.data)));
    await new Promise<void>((r) => {
      ws.onopen = () => r();
    });
    for (const topic of [`token:${mint}`, `trades:${mint}`, `candles:${mint}:1m`]) ws.send(JSON.stringify({ type: "subscribe", topic }));
    const tokenSnap = await waitFor(() => msgs.find((m) => m.topic === `token:${mint}` && m.type === "snapshot"));
    // a viewer opened it: the backfill is announced at once, and holder metrics are "computing", not unknown
    expect(tokenSnap.data.history.state).toBe("backfilling");
    expect(tokenSnap.data.historyState).toBe("backfilling");
    expect(tokenSnap.data.holders).toBeNull();
    expect(tokenSnap.data.holdersPending).toBe(true);
    const tradesSnap = await waitFor(() => msgs.find((m) => m.topic === `trades:${mint}` && m.type === "snapshot"));
    expect(tradesSnap.data.trades).toHaveLength(1);
    expect(tradesSnap.data.history).toBeDefined();
    const candleSnap = await waitFor(() => msgs.find((m) => m.topic === `candles:${mint}:1m` && m.type === "snapshot"));
    expect(candleSnap.data.more).toBe(false);

    // the backfill streams corrections, then the summary says complete
    await waitFor(
      () => msgs.find((m) => m.topic === `token:${mint}` && m.type === "delta" && m.data.history?.state === "complete"),
      15_000,
    );
    const tradeFixes = msgs.filter((m) => m.topic === `trades:${mint}` && m.type === "correction");
    expect(tradeFixes.length).toBeGreaterThan(1);
    expect(tradeFixes.every((m) => m.reason === "backfill")).toBe(true);
    const fixed = new Set(tradeFixes.flatMap((m) => m.data.upsert.map((t: { id: string }) => t.id)));
    expect(fixed.size).toBe(59); // 60 trades on chain, the live one was held already
    expect(msgs.some((m) => m.topic === `candles:${mint}:1m` && m.type === "correction" && m.reason === "backfill")).toBe(true);
    const deltas = msgs.filter((m) => m.topic === `token:${mint}` && m.type === "delta" && m.data.history);
    expect(deltas.some((m) => m.data.history.state === "backfilling" && m.data.history.progress)).toBe(true);
    // sequencing holds on every topic
    for (const topic of [`trades:${mint}`, `candles:${mint}:1m`, `token:${mint}`]) {
      const seqs = msgs.filter((m) => m.topic === topic).map((m) => m.seq ?? 0);
      for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe((seqs[i - 1] as number) + 1);
    }

    // every buy, by pages
    const ids: string[] = [];
    let next: string | null = null;
    let pages = 0;
    do {
      const r = (await (
        await fetch(`${base}/api/trades?mint=${mint}&limit=25${next ? `&before=${encodeURIComponent(next)}` : ""}`)
      ).json()) as TradesPageResponse;
      ids.push(...r.trades.map((t) => t.id));
      next = r.next;
      expect(r.history?.state).toBe("complete");
      pages++;
    } while (next && pages < 20);
    expect(pages).toBe(3);
    expect(new Set(ids).size).toBe(60);
    // a signature works as the cursor
    const bySig = (await (
      await fetch(`${base}/api/trades?mint=${mint}&limit=5&before=${txs[10]?.signature}`)
    ).json()) as TradesPageResponse;
    expect(bySig.trades.map((t) => t.slot)).toEqual([50_009, 50_008, 50_007, 50_006, 50_005]);

    // the chart: the whole hour of history, 1m buckets, paged
    const c = (await (await fetch(`${base}/api/candles?mint=${mint}&tf=1m`)).json()) as CandlesResponse;
    expect(c.candles.reduce((n, x) => n + x.n, 0)).toBe(60);
    expect(c.next).toBeNull();
    expect(c.history?.fromCreation).toBe(true);
    const page = (await (await fetch(`${base}/api/candles?mint=${mint}&tf=1m&limit=10`)).json()) as CandlesResponse;
    expect(page.candles).toHaveLength(10);
    expect(page.next?.to).toBe((page.candles[0]?.t ?? 0) - 1);
    const older = (await (await fetch(`${base}/api/candles?mint=${mint}&tf=1m&limit=10&to=${page.next?.to}`)).json()) as CandlesResponse;
    expect((older.candles[older.candles.length - 1]?.t ?? Infinity) < (page.candles[0]?.t ?? 0)).toBe(true);
    expect(page.hasMore).toBe(true);
    expect(page.historyState).toBe("complete");
    // the chart's paging: `before` (exclusive ms) + `limit`, newest buckets before it, UTC-aligned keys
    const first = page.candles[0]?.t ?? 0;
    const prev = (await (await fetch(`${base}/api/candles?mint=${mint}&tf=1m&before=${first}&limit=5`)).json()) as CandlesResponse;
    expect(prev.candles).toHaveLength(5);
    expect(prev.candles.every((x) => x.t < first && x.t % 60_000 === 0)).toBe(true);
    expect(prev.candles[4]?.t).toBe(older.candles[older.candles.length - 1]?.t ?? -1);
    // the old shape keeps working
    const legacy = (await (await fetch(`${base}/api/candles?mint=${mint}&tf=1m&from=0&to=${first - 1}`)).json()) as CandlesResponse;
    expect(legacy.candles[legacy.candles.length - 1]?.t).toBe(prev.candles[4]?.t ?? -1);

    const tok = (await (await fetch(`${base}/api/tokens/${mint}`)).json()) as {
      token: { holders: number | null; holdersPending?: boolean };
    };
    expect(tok.token.holdersPending).toBe(false);
    expect(tok.token.holders).toBe(7);
    const h = (await (await fetch(`${base}/api/health`)).json()) as HealthResponse;
    expect(h.history).toMatchObject({ enabled: true, completed: 1, tradesAdded: 59 });
    const hist = (await (await fetch(`${base}/api/history?mint=${mint}`)).json()) as { history: { state: string; trades: number } };
    expect(hist.history).toMatchObject({ state: "complete", trades: 60 });
    ws.close();
  });
});
