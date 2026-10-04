/**
 * Live capture gaps (RpcLogsSource, YellowstoneSource): truncated / incomplete logs are re-read with getTransaction,
 * notifications the decode queue drops are re-read by signature (or reported as gaps), higher-priority re-reads
 * displace lower ones, reconnects and stalled subscriptions are reported as gaps. Real mainnet fixtures.
 */
import { describe, expect, test } from "bun:test";
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID } from "@zerofee/core";
import type { RpcJsonTx } from "../src/ingest/jsonTx";
import { expectedTradeEvents, RpcLogsSource } from "../src/ingest/rpcLogs";
import type { IngestGap, IngestTx } from "../src/ingest/types";
import { YellowstoneSource } from "../src/ingest/yellowstone";
import { setLogLevel } from "../src/log";
import { fixture } from "./helpers";

setLogLevel("error");

function notify(signature: string, logs: string[] | null, slot: number, sub = 11): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "logsNotification",
    params: { subscription: sub, result: { context: { slot }, value: { signature, err: null, logs } } },
  });
}

function source(
  fetch: ((sig: string) => Promise<RpcJsonTx | null>) | null,
  o: { queueMax?: number; maxQueue?: number; perSec?: number; silenceSlots?: number; WebSocketImpl?: typeof WebSocket } = {},
) {
  const txs: IngestTx[] = [];
  const gaps: IngestGap[] = [];
  const src = new RpcLogsSource({
    wsUrl: "ws://unused",
    programs: [PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID],
    commitment: "processed",
    queueMax: o.queueMax ?? 1_000,
    silenceSlots: o.silenceSlots,
    WebSocketImpl: o.WebSocketImpl,
    raydiumTx: fetch
      ? { fetch, perSec: o.perSec ?? 1_000, firstDelayMs: 0, retryDelayMs: 0, maxAttempts: 2, maxAgeMs: 1e12, maxQueue: o.maxQueue }
      : null,
  });
  (src as unknown as { sink: unknown }).sink = { tx: (t: IngestTx) => txs.push(t), gap: (g: IngestGap) => gaps.push(g) };
  return { src, txs, gaps };
}

const settle = () => new Promise((r) => setTimeout(r, 5));
async function pump(src: RpcLogsSource, rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    src.fetchTick(Date.now() + 10_000 * (i + 1));
    await settle();
  }
}

/** pump-create-v2's logs cut after the create event, before the buy's event line. */
function truncatedCreate(): { signature: string; slot: number; logs: string[]; tx: RpcJsonTx } {
  const f = fixture("pump-create-v2");
  const logs = f.tx.meta.logMessages;
  const dataLines = logs.map((l, i) => (l.startsWith("Program data:") ? i : -1)).filter((i) => i >= 0);
  const cut = (dataLines[1] as number) - 1;
  return { signature: f.signature, slot: f.tx.slot, logs: [...logs.slice(0, cut), "Log truncated"], tx: f.tx as unknown as RpcJsonTx };
}

describe("truncated and incomplete logs", () => {
  test("truncated logs wait for the full transaction: every event, accounts and balances", async () => {
    const t = truncatedCreate();
    const { src, txs } = source(async (sig) => (sig === t.signature ? t.tx : null));
    src.onMessage(notify(t.signature, t.logs, t.slot));
    src.drain();
    expect(txs).toHaveLength(0);
    await pump(src);
    expect(txs).toHaveLength(1);
    expect(txs[0]?.events.map((e) => e.kind)).toEqual(["pumpCreate", "pumpTrade"]);
    expect(txs[0]?.accountKeys?.length).toBeGreaterThan(0);
    expect(src.capture).toMatchObject({ truncated: 1, refetched: 1, partial: 0 });
  });

  test("the re-read fails: the logs-only (partial) record goes out and is counted", async () => {
    const t = truncatedCreate();
    const { src, txs } = source(async () => null);
    src.onMessage(notify(t.signature, t.logs, t.slot));
    src.drain();
    await pump(src, 8);
    expect(txs).toHaveLength(1);
    expect(txs[0]?.events.map((e) => e.kind)).toEqual(["pumpCreate"]);
    expect(src.capture).toMatchObject({ truncated: 1, partial: 1, refetched: 0 });
  });

  test("logs cut before any event line, or no logs at all, are not dropped as event-less", async () => {
    const t = truncatedCreate();
    const early = [...t.logs.slice(0, 3), "Log truncated"];
    const { src, txs } = source(async () => t.tx);
    src.onMessage(notify(t.signature, early, t.slot));
    src.onMessage(notify(fixture("pump-buy").signature, null, 9));
    src.drain();
    expect(src.stats.withoutEvents).toBe(0);
    await pump(src);
    expect(txs.map((x) => x.events.length)).toEqual([2, 2]);
  });

  test("fewer trade events than pump trade instructions: re-read", async () => {
    const f = fixture("pump-multi-buyer-tx");
    const logs = f.tx.meta.logMessages;
    expect(expectedTradeEvents(logs)).toBe(2);
    const firstData = logs.findIndex((l) => l.startsWith("Program data:"));
    const lossy = logs.filter((_, i) => i !== firstData);
    const { src, txs } = source(async () => f.tx as unknown as RpcJsonTx);
    src.onMessage(notify(f.signature, lossy, f.tx.slot));
    src.drain();
    await pump(src);
    expect(src.capture.incomplete).toBe(1);
    expect(txs[0]?.events.filter((e) => e.kind === "pumpTrade")).toHaveLength(2);
  });
});

describe("the decode queue never drops silently", () => {
  test("dropped notifications are re-read by signature", async () => {
    const labels = ["pump-create-v2", "pump-buy", "pump-sell", "amm-buy", "amm-sell"];
    const bySig = new Map(labels.map((l) => [fixture(l).signature, fixture(l).tx as unknown as RpcJsonTx]));
    const { src, txs, gaps } = source(async (sig) => bySig.get(sig) ?? null, { queueMax: 2 });
    for (const l of labels) src.onMessage(notify(fixture(l).signature, fixture(l).tx.meta.logMessages, fixture(l).tx.slot));
    src.drain();
    expect(src.health().dropped).toBe(3);
    await pump(src);
    expect(new Set(txs.map((t) => t.signature))).toEqual(new Set(bySig.keys()));
    expect(src.capture).toMatchObject({ queueDropped: 3, recovered: 3, lost: 0 });
    expect(gaps).toHaveLength(0);
    expect(src.health().capture).toMatchObject({ queueDropped: 3, recovered: 3 });
  });

  test("without re-reads, a dropped notification is reported as a gap with its signature", () => {
    const { src, gaps } = source(null, { queueMax: 1 });
    const a = fixture("pump-buy");
    const b = fixture("pump-sell");
    src.onMessage(notify(a.signature, a.tx.meta.logMessages, a.tx.slot));
    src.onMessage(notify(b.signature, b.tx.meta.logMessages, b.tx.slot));
    expect(gaps).toEqual([{ source: "rpc-logs", reason: "lost", fromSlot: a.tx.slot, toSlot: a.tx.slot, signature: a.signature }]);
    expect(src.capture.lost).toBe(1);
  });

  test("a full re-read queue: data-loss re-reads displace recoveries (which become gaps)", async () => {
    const { src, gaps } = source(async () => null, { queueMax: 1, maxQueue: 1, perSec: 0.0001 });
    const a = fixture("pump-buy");
    const b = fixture("pump-sell");
    src.onMessage(notify(a.signature, a.tx.meta.logMessages, a.tx.slot));
    src.onMessage(notify(b.signature, b.tx.meta.logMessages, b.tx.slot)); // drops a -> recovery job
    expect(src.fetchQueueSize).toBe(1);
    const t = truncatedCreate();
    src.drain(); // b decodes fine
    src.onMessage(notify(t.signature, t.logs, t.slot));
    src.drain(); // truncated (priority 0) displaces the recovery
    expect(src.fetchStats.displaced).toBe(1);
    expect(gaps.map((g) => g.signature)).toEqual([a.signature]);
  });
});

describe("feed gaps", () => {
  class FakeSocket {
    static all: FakeSocket[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: unknown = null;
    onclose: ((ev: { code: number; reason: string }) => void) | null = null;
    closed = false;
    constructor(_url: string) {
      FakeSocket.all.push(this);
    }
    send(): void {}
    close(): void {
      this.closed = true;
    }
  }

  test("the slots a socket was down for are reported once notifications resume", () => {
    FakeSocket.all = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((_fn: () => void) => 0) as unknown as typeof setTimeout;
    try {
      const { src, gaps } = source(null, { WebSocketImpl: FakeSocket as unknown as typeof WebSocket });
      const internals = src as unknown as { connect(): void };
      internals.connect();
      const ws1 = FakeSocket.all[0] as FakeSocket;
      ws1.onopen?.();
      const a = fixture("pump-buy");
      src.onMessage(notify(a.signature, a.tx.meta.logMessages, 1_000));
      ws1.onclose?.({ code: 1006, reason: "" });
      internals.connect();
      const ws2 = FakeSocket.all[1] as FakeSocket;
      ws2.onopen?.();
      expect(gaps).toHaveLength(0);
      const b = fixture("pump-sell");
      src.onMessage(notify(b.signature, b.tx.meta.logMessages, 1_090));
      expect(gaps).toEqual([{ source: "rpc-logs", reason: "reconnect", fromSlot: 1_000, toSlot: 1_090 }]);
      expect(src.capture.gaps).toBe(1);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test("a logs subscription stalled while slots advance is recycled", () => {
    FakeSocket.all = [];
    const { src } = source(null, { silenceSlots: 40, WebSocketImpl: FakeSocket as unknown as typeof WebSocket });
    (src as unknown as { connect(): void }).connect();
    const ws = FakeSocket.all[0] as FakeSocket;
    ws.onopen?.();
    // the subscription id maps to "pump"
    src.onMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 11 }));
    const a = fixture("pump-buy");
    src.onMessage(notify(a.signature, a.tx.meta.logMessages, 2_000));
    const slot = (s: number) =>
      src.onMessage(JSON.stringify({ jsonrpc: "2.0", method: "slotNotification", params: { result: { slot: s } } }));
    slot(2_020);
    expect(ws.closed).toBe(false);
    slot(2_041);
    expect(ws.closed).toBe(true);
    expect(src.stats.silenceRecycles).toBe(1);
  });

  test("Yellowstone: an outage longer than the replay window is reported as a gap", () => {
    const gaps: IngestGap[] = [];
    const ys = new YellowstoneSource({ endpoint: "http://unused", xToken: null, commitment: "processed", programs: [PUMP_PROGRAM_ID] });
    (ys as unknown as { sink: unknown }).sink = { tx: () => {}, gap: (g: IngestGap) => gaps.push(g) };
    const internals = ys as unknown as {
      downSince: number | null;
      slotBeforeDown: number | null;
      endDown(now: number, slot: number): void;
    };
    internals.downSince = Date.now() - 5_000;
    internals.slotBeforeDown = 100;
    internals.endDown(Date.now(), 120);
    expect(gaps).toHaveLength(0); // short: the fromSlot replay covered it
    internals.downSince = Date.now() - 60_000;
    internals.slotBeforeDown = 200;
    internals.endDown(Date.now(), 400);
    expect(gaps).toEqual([{ source: "yellowstone", reason: "reconnect", fromSlot: 200, toSlot: 400 }]);
    expect(ys.health().capture?.gaps).toBe(1);
  });
});
