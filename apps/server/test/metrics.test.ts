/**
 * GET /metrics: exposition format, access control (loopback vs token, never X-Forwarded-For), the
 * feed-stall and blockhash alarms, slot lag, kill-switch flags, events/s sampling and tx outcomes.
 * Two whole servers run in-process (one without a token, one with), with mocked network.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceHealth } from "@zerofee/protocol";
import { type App, createApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { IngestSink, IngestTx, Source } from "../src/ingest/types";
import { setLogLevel } from "../src/log";
import { BLOCKHASH_STALE_MS, formatLabels, isLoopback, KILL_SWITCH_FLAGS, METRICS_CONTENT_TYPE } from "../src/metrics";
import { openDb } from "../src/storage/db";
import { RpcClient } from "../src/util/rpc";
import { addr, FakeCurve, mockFetch, synthTx } from "./helpers";

class TestSource implements Source {
  readonly name = "test";
  sink: IngestSink | null = null;
  slot: number | null = null;
  connected = true;
  start(sink: IngestSink): void {
    this.sink = sink;
  }
  async stop(): Promise<void> {}
  emit(tx: IngestTx): void {
    this.sink?.tx(tx);
  }
  health(): SourceHealth {
    return {
      name: this.name,
      connected: this.connected,
      reconnects: 2,
      messages: 5,
      lastMessageAt: null,
      slot: this.slot,
      dropped: 1,
      notes: [],
    };
  }
}

const RPC_URL = "http://rpc.test";
const rpcMock = mockFetch((url, body) => {
  if (url !== RPC_URL) return [404, {}];
  if (body?.method === "simulateTransaction") {
    return [200, { jsonrpc: "2.0", id: 1, result: { context: { slot: 77 }, value: { err: null, logs: [], unitsConsumed: 1 } } }];
  }
  if (body?.method === "getMultipleAccounts") {
    const n = ((body.params?.[0] as string[]) ?? []).length;
    return [200, { jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: new Array(n).fill(null) } }];
  }
  return [200, { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "not mocked" } }];
});

const TOKEN = "test-metrics-token-0123456789abcdef";
const flagDir = mkdtempSync(join(tmpdir(), "zerofee-flags-"));

function makeApp(env: Record<string, string>, source: TestSource): App {
  const cfg = loadConfig({
    SERVER_PORT: "0",
    DB_PATH: ":memory:",
    RPC_URL,
    LOG_LEVEL: "error",
    RATE_LIMIT_REST_RPS: "1000",
    RATE_LIMIT_REST_BURST: "1000",
    ...env,
  });
  return createApp(cfg, {
    source,
    db: openDb(":memory:"),
    rpc: new RpcClient({ url: RPC_URL, fetchFn: rpcMock.fn }),
    fetchFn: rpcMock.fn,
    solUsd: null,
    pollers: false,
  });
}

let open: App;
let openSource: TestSource;
let locked: App;
let lockedSource: TestSource;

beforeAll(() => {
  setLogLevel("error");
  openSource = new TestSource();
  open = makeApp({ KILL_SWITCH_DIR: flagDir }, openSource);
  lockedSource = new TestSource();
  locked = makeApp({ METRICS_TOKEN: TOKEN }, lockedSource);
});

afterAll(async () => {
  await open.stop();
  await locked.stop();
  rmSync(flagDir, { recursive: true, force: true });
});

const base = (app: App) => `http://127.0.0.1:${app.gateway.port}`;
const req = (headers: Record<string, string> = {}) => new Request("http://server/metrics", { headers });

/** Parses exposition text into `name{labels}` -> value, asserting the 0.0.4 grammar on the way. */
function parseExposition(text: string): Map<string, number> {
  const NAME = "[a-zA-Z_:][a-zA-Z0-9_:]*";
  const LABEL = '[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\\\\\n]|\\\\.)*"';
  const sampleRe = new RegExp(`^(${NAME})(\\{${LABEL}(?:,${LABEL})*\\})? (-?[0-9.]+(?:e[+-]?[0-9]+)?|NaN|[+-]Inf)$`);
  const typeRe = new RegExp(`^# TYPE (${NAME}) (counter|gauge)$`);
  const helpRe = new RegExp(`^# HELP (${NAME}) .+$`);
  const types = new Map<string, string>();
  const helped = new Set<string>();
  const out = new Map<string, number>();
  expect(text.endsWith("\n")).toBe(true);
  for (const line of text.trimEnd().split("\n")) {
    const h = helpRe.exec(line);
    if (h) {
      helped.add(h[1] as string);
      continue;
    }
    const t = typeRe.exec(line);
    if (t) {
      expect(types.has(t[1] as string)).toBe(false);
      expect(helped.has(t[1] as string)).toBe(true);
      types.set(t[1] as string, t[2] as string);
      continue;
    }
    const s = sampleRe.exec(line);
    if (!s) throw new Error(`invalid exposition line: ${line}`);
    const name = s[1] as string;
    const type = types.get(name);
    if (!type) throw new Error(`sample before its TYPE line: ${line}`);
    if (type === "counter") expect(name.endsWith("_total")).toBe(true);
    const key = `${name}${s[2] ?? ""}`;
    expect(out.has(key)).toBe(false);
    out.set(key, Number(s[3]));
  }
  return out;
}

describe("exposition", () => {
  test("valid 0.0.4 text with HELP and TYPE for every family, and the families ops relies on", () => {
    const m = parseExposition(open.metrics.render());
    for (const key of [
      "zerofee_dry_run",
      "zerofee_ingest_events_total",
      'zerofee_ingest_events_per_second{window="10s"}',
      "zerofee_ingest_decode_failures_total",
      "zerofee_feed_stalled",
      "zerofee_feed_silence_seconds",
      "zerofee_blockhash_stale",
      'zerofee_source_up{source="test"}',
      'zerofee_source_dropped_total{source="test"}',
      "zerofee_ws_clients",
      "zerofee_ws_messages_received_total",
      "zerofee_ws_messages_published_total",
      'zerofee_gateway_queue_depth{queue="trades"}',
      "zerofee_storage_queue_rows",
      'zerofee_tx_outcomes_total{outcome="rejected"}',
      'zerofee_halted{scope="tx"}',
      'zerofee_halted{scope="site"}',
      "process_resident_memory_bytes",
    ]) {
      expect(m.has(key)).toBe(true);
    }
    expect(m.get("zerofee_dry_run")).toBe(1);
    expect(m.get('zerofee_source_dropped_total{source="test"}')).toBe(1);
    expect(m.get("process_resident_memory_bytes")).toBeGreaterThan(0);
  });

  test("label values are escaped; build info carries version and runtime", () => {
    expect(formatLabels({})).toBe("");
    expect(formatLabels({ a: 'say "hi"\\now\nnext', b: "x" })).toBe('{a="say \\"hi\\"\\\\now\\nnext",b="x"}');
    const line = open.metrics
      .render()
      .split("\n")
      .find((l) => l.startsWith("zerofee_build_info{"));
    expect(line).toBe(`zerofee_build_info{version="0.2.0",bun="${Bun.version}"} 1`);
  });
});

describe("access", () => {
  test("isLoopback covers IPv4, IPv6 and mapped forms only", () => {
    for (const ip of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) expect(isLoopback(ip)).toBe(true);
    for (const ip of ["10.0.0.1", "172.18.0.1", "::ffff:10.0.0.1", "fe80::1", "", null]) expect(isLoopback(ip)).toBe(false);
  });

  test("no token: loopback peers only, and never requests that came through a proxy", () => {
    expect(open.metrics.handle(req(), "127.0.0.1")?.status).toBe(200);
    expect(open.metrics.handle(req(), "::1")?.status).toBe(200);
    expect(open.metrics.handle(req(), "172.18.0.1")).toBeNull();
    expect(open.metrics.handle(req(), null)).toBeNull();
    expect(open.metrics.handle(req({ "x-forwarded-for": "127.0.0.1" }), "127.0.0.1")).toBeNull();
    expect(open.metrics.handle(req({ forwarded: "for=127.0.0.1" }), "127.0.0.1")).toBeNull();
  });

  test("token: every peer needs the bearer token, loopback included", () => {
    expect(locked.metrics.handle(req(), "127.0.0.1")).toBeNull();
    expect(locked.metrics.handle(req({ authorization: "Bearer wrong-token-0123456789" }), "127.0.0.1")).toBeNull();
    expect(locked.metrics.handle(req({ authorization: `Basic ${TOKEN}` }), "10.0.0.2")).toBeNull();
    expect(locked.metrics.handle(req({ authorization: `Bearer ${TOKEN}` }), "10.0.0.2")?.status).toBe(200);
    expect(locked.metrics.handle(req({ authorization: `bearer ${TOKEN}`, "x-forwarded-for": "1.2.3.4" }), "10.0.0.2")?.status).toBe(200);
  });

  test("short tokens are rejected at config time", () => {
    expect(() => loadConfig({ METRICS_TOKEN: "short" })).toThrow(/at least 16/);
  });

  test("over HTTP: served to an allowed caller, otherwise the gateway's ordinary 404", async () => {
    const ok = await fetch(`${base(open)}/metrics`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe(METRICS_CONTENT_TYPE);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(await ok.text()).toContain("zerofee_feed_stalled ");

    const unknown = await fetch(`${base(locked)}/no-such-path`);
    const refused = await fetch(`${base(locked)}/metrics`);
    expect(refused.status).toBe(404);
    expect(await refused.text()).toBe(await unknown.text());

    const authed = await fetch(`${base(locked)}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(authed.status).toBe(200);
    parseExposition(await authed.text());
  });
});

describe("alarms", () => {
  const value = (app: App, key: string, now: number) => parseExposition(app.metrics.render(now)).get(key);

  test("feed stall: grace period after start, 0 right after an event, 1 once silent for 30 s", () => {
    const app = locked;
    const t0 = app.health().startedAt;
    expect(app.market.stats.lastEventAt).toBeNull();
    expect(value(app, "zerofee_feed_stalled", t0 + 5_000)).toBe(0);
    expect(value(app, "zerofee_feed_stalled", t0 + 30_000)).toBe(1);

    const mint = addr("metrics-mint");
    const curve = new FakeCurve(mint, addr("metrics-dev"));
    const ts = Math.floor(Date.now() / 1000);
    const receivedAt = Date.now();
    lockedSource.emit(synthTx(800_000, [curve.create(ts), curve.buy(addr("metrics-buyer"), 1_000_000_000n, ts)], { receivedAt }));
    expect(app.market.stats.lastEventAt).toBe(receivedAt);
    expect(value(app, "zerofee_feed_stalled", receivedAt + 1_000)).toBe(0);
    expect(value(app, "zerofee_feed_silence_seconds", receivedAt + 1_000)).toBe(1);
    expect(value(app, "zerofee_feed_stalled", receivedAt + 29_999)).toBe(0);
    expect(value(app, "zerofee_feed_stalled", receivedAt + 30_000)).toBe(1);
    expect(value(app, "zerofee_ingest_last_event_timestamp_seconds", receivedAt)).toBe(receivedAt / 1000);
  });

  test("blockhash: stale when missing after start-up or older than the threshold", () => {
    const app = open;
    const t0 = app.health().startedAt;
    expect(app.chain.state.blockhashUpdatedAt).toBeNull();
    expect(value(app, "zerofee_blockhash_stale", t0 + 1_000)).toBe(0);
    expect(value(app, "zerofee_blockhash_stale", t0 + BLOCKHASH_STALE_MS)).toBe(1);
    const at = Date.now();
    app.chain.state.blockhashUpdatedAt = at;
    expect(value(app, "zerofee_blockhash_stale", at + 2_000)).toBe(0);
    expect(value(app, "zerofee_blockhash_age_seconds", at + 2_000)).toBe(2);
    expect(value(app, "zerofee_blockhash_stale", at + BLOCKHASH_STALE_MS)).toBe(1);
  });

  test("slot lag = chain tip - primary source slot, omitted until both are known", () => {
    const app = open;
    expect(parseExposition(app.metrics.render()).has("zerofee_ingest_slot_lag")).toBe(false);
    openSource.slot = 1_000;
    app.chain.onSlot(1_004, "processed");
    expect(value(app, "zerofee_ingest_slot_lag", Date.now())).toBe(4);
    expect(value(app, "zerofee_chain_tip_slot", Date.now())).toBe(1_004);
    openSource.slot = 1_010; // source ahead of the slot stream: lag clamps at 0
    expect(value(app, "zerofee_ingest_slot_lag", Date.now())).toBe(0);
  });

  test("kill-switch flags in KILL_SWITCH_DIR show up as zerofee_halted", () => {
    const now = Date.now();
    expect(value(open, "zerofee_kill_switch_dir_present", now)).toBe(1);
    expect(value(open, 'zerofee_halted{scope="tx"}', now)).toBe(0);
    writeFileSync(join(flagDir, KILL_SWITCH_FLAGS.tx), "");
    expect(value(open, 'zerofee_halted{scope="tx"}', now)).toBe(1);
    expect(value(open, 'zerofee_halted{scope="site"}', now)).toBe(0);
    writeFileSync(join(flagDir, KILL_SWITCH_FLAGS.site), "");
    expect(value(open, 'zerofee_halted{scope="site"}', now)).toBe(1);
    rmSync(join(flagDir, KILL_SWITCH_FLAGS.tx));
    rmSync(join(flagDir, KILL_SWITCH_FLAGS.site));
    expect(value(open, 'zerofee_halted{scope="tx"}', now)).toBe(0);
    // Without KILL_SWITCH_DIR the halt state is unknown, so it is not reported at all.
    expect(parseExposition(locked.metrics.render()).has('zerofee_halted{scope="tx"}')).toBe(false);
  });
});

describe("counters", () => {
  test("events/s comes from 1 s samples of the event counter", () => {
    const app = locked;
    app.metrics.stop();
    // Far from wall-clock time, so buckets the (now stopped) 1 s timer filled stay out of the windows.
    const t = 10_000_000_000_000;
    app.metrics.sample(t - 120_000); // syncs the last-seen counter outside both windows
    app.metrics.sample(t);
    app.market.stats.events += 50;
    app.metrics.sample(t + 1_000);
    app.market.stats.events += 30;
    app.metrics.sample(t + 2_000);
    const m = parseExposition(app.metrics.render(t + 3_000));
    expect(m.get('zerofee_ingest_events_per_second{window="10s"}')).toBe(8);
    expect(m.get('zerofee_ingest_events_per_second{window="60s"}')).toBeCloseTo(80 / 60, 6);
  });

  test("POST /api/tx outcomes: dry-run simulations and rejections are counted", async () => {
    const before = parseExposition(open.metrics.render());
    const bad = await fetch(`${base(open)}/api/tx`, { method: "POST", body: JSON.stringify({ nope: 1 }) });
    expect(bad.status).toBe(400);
    // An unsigned one-signature transaction: dry run simulates it without signature checks.
    const tx = new Uint8Array(1 + 64 + 40);
    tx[0] = 1;
    const ok = await fetch(`${base(open)}/api/tx`, {
      method: "POST",
      body: JSON.stringify({ tx: Buffer.from(tx).toString("base64"), preset: "reduced" }),
    });
    expect(ok.status).toBe(200);
    const after = parseExposition(open.metrics.render());
    const delta = (k: string) => (after.get(k) ?? 0) - (before.get(k) ?? 0);
    expect(delta("zerofee_tx_requests_total")).toBe(2);
    expect(delta('zerofee_tx_outcomes_total{outcome="rejected"}')).toBe(1);
    expect(delta('zerofee_tx_outcomes_total{outcome="simulated"}')).toBe(1);
    expect(delta('zerofee_tx_outcomes_total{outcome="sent"}')).toBe(0);
  });

  test("WebSocket clients and received messages", async () => {
    const ws = new WebSocket(`${base(open).replace("http", "ws")}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("ws error"));
    });
    ws.send(JSON.stringify({ type: "subscribe", topic: "chain" }));
    await new Promise<void>((resolve) => {
      ws.onmessage = () => resolve();
    });
    const m = parseExposition(open.metrics.render());
    expect(m.get("zerofee_ws_clients")).toBeGreaterThanOrEqual(1);
    expect(m.get("zerofee_ws_messages_received_total")).toBeGreaterThanOrEqual(1);
    expect(m.get("zerofee_ws_subscriptions")).toBeGreaterThanOrEqual(1);
    ws.close();
  });
});
