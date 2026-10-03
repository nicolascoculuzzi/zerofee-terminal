/** RpcLogsSource: notification parsing, dedupe, backpressure, lag, dead slots, reconnects (local WS server). */
import { afterAll, describe, expect, test } from "bun:test";
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID } from "@zerofee/core";
import { RpcLogsSource } from "../src/ingest/rpcLogs";
import type { IngestTx, SlotStatus } from "../src/ingest/types";
import { setLogLevel } from "../src/log";
import { fixture, waitFor } from "./helpers";

setLogLevel("error");

function notification(label: string, o: { slot?: number; err?: unknown; sub?: number } = {}): string {
  const f = fixture(label);
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "logsNotification",
    params: {
      subscription: o.sub ?? 11,
      result: {
        context: { slot: o.slot ?? f.tx.slot },
        value: { signature: f.signature, err: o.err ?? null, logs: f.tx.meta.logMessages },
      },
    },
  });
}

function source(queueMax = 1_000) {
  const txs: IngestTx[] = [];
  const slots: [number, SlotStatus][] = [];
  const src = new RpcLogsSource({
    wsUrl: "ws://unused",
    programs: [PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID],
    commitment: "processed",
    queueMax,
  });
  // attach a sink without connecting
  (src as unknown as { sink: unknown }).sink = {
    tx: (t: IngestTx) => txs.push(t),
    slot: (s: number, st: SlotStatus) => slots.push([s, st]),
  };
  return { src, txs, slots };
}

describe("notification handling", () => {
  test("decodes events from Program data lines into IngestTx (no keys, arrival order)", () => {
    const { src, txs } = source();
    src.onMessage(notification("pump-create-v2"));
    src.onMessage(notification("amm-buy"));
    src.drain();
    expect(txs.map((t) => t.signature)).toEqual([fixture("pump-create-v2").signature, fixture("amm-buy").signature]);
    expect(txs[0]?.events.map((e) => e.kind)).toEqual(["pumpCreate", "pumpTrade"]);
    expect(txs[0]).toMatchObject({ txIndex: null, accountKeys: null, source: "rpc-logs", slot: fixture("pump-create-v2").tx.slot });
    expect(txs[0]?.receivedAt).toBeGreaterThan(0);
  });

  test("failed transactions, duplicates (same tx from both subscriptions) and event-less logs are skipped", () => {
    const { src, txs } = source();
    src.onMessage(notification("pump-buy", { err: { InstructionError: [2, { Custom: 6002 }] } }));
    src.onMessage(notification("pump-sell", { sub: 11 }));
    src.onMessage(notification("pump-sell", { sub: 12 }));
    const noEvents = JSON.stringify({
      jsonrpc: "2.0",
      method: "logsNotification",
      params: { subscription: 11, result: { context: { slot: 1 }, value: { signature: "s", err: null, logs: ["Program log: hi"] } } },
    });
    src.onMessage(noEvents);
    src.drain();
    expect(txs).toHaveLength(1);
    expect(src.stats).toMatchObject({ failedTxs: 1, duplicates: 1, withoutEvents: 1 });
  });

  test("the same signature in a different slot is passed on (the market state handles forks)", () => {
    const { src, txs } = source();
    src.onMessage(notification("pump-sell", { slot: 100 }));
    src.onMessage(notification("pump-sell", { slot: 101 }));
    src.drain();
    expect(txs.map((t) => t.slot)).toEqual([100, 101]);
  });

  test("backpressure: a full queue drops the oldest notifications and reports it", () => {
    const { src, txs } = source(2);
    for (const l of ["pump-create-v2", "pump-buy", "pump-sell", "amm-buy", "amm-sell"]) src.onMessage(notification(l));
    src.drain();
    expect(src.health().dropped).toBe(3);
    expect(txs.map((t) => t.signature)).toEqual([fixture("amm-buy").signature, fixture("amm-sell").signature]);
  });

  test("slot lag vs the slotSubscribe tip; dead / confirmed slot notices", () => {
    const { src, slots } = source();
    src.onMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "slotNotification",
        params: { result: { slot: 500, parent: 499, root: 400 }, subscription: 3 },
      }),
    );
    src.onMessage(notification("pump-buy", { slot: 498 }));
    expect(src.lag.percentiles([50])[0]).toBe(2);
    src.onMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "slotsUpdatesNotification",
        params: { result: { type: "dead", slot: 499, timestamp: 1, err: "x" }, subscription: 4 },
      }),
    );
    src.onMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "slotsUpdatesNotification",
        params: { result: { type: "optimisticConfirmation", slot: 498, timestamp: 1 }, subscription: 4 },
      }),
    );
    expect(slots).toEqual([
      [500, "processed"],
      [499, "dead"],
      [498, "confirmed"],
    ]);
  });

  test("an unsupported slotsUpdatesSubscribe is noted and not retried", () => {
    const { src } = source();
    src.onMessage(JSON.stringify({ jsonrpc: "2.0", id: 1001, error: { code: -32601, message: "Method not found" } }));
    expect(src.stats.slotUpdates).toBe("unsupported");
  });
});

describe("reconnects (local WebSocket server)", () => {
  const received: { conn: number; method: string }[] = [];
  let conn = 0;
  const server = Bun.serve<{ id: number }, never>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      return srv.upgrade(req, { data: { id: ++conn } }) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        const m = JSON.parse(String(raw));
        received.push({ conn: ws.data.id, method: m.method });
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: 10 + m.id }));
        if (ws.data.id === 1 && m.method === "slotsUpdatesSubscribe") setTimeout(() => ws.close(1011, "bye"), 20);
        if (ws.data.id === 2 && m.method === "slotsUpdatesSubscribe") ws.send(notification("pump-buy", { sub: 11 }));
      },
    },
  });
  afterAll(() => {
    void server.stop(true);
  });

  test("resubscribes everything after the server drops the socket, then keeps decoding", async () => {
    const txs: IngestTx[] = [];
    const src = new RpcLogsSource({
      wsUrl: `ws://127.0.0.1:${server.port}`,
      programs: [PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID],
      commitment: "processed",
      queueMax: 100,
    });
    src.start({ tx: (t) => txs.push(t) });
    try {
      await waitFor(() => txs.length === 1, 5_000);
      expect(src.health().reconnects).toBe(1);
      const methods = (c: number) => received.filter((r) => r.conn === c).map((r) => r.method);
      expect(methods(1)).toEqual(["logsSubscribe", "logsSubscribe", "slotSubscribe", "slotsUpdatesSubscribe"]);
      expect(methods(2)).toEqual(["logsSubscribe", "logsSubscribe", "slotSubscribe", "slotsUpdatesSubscribe"]);
      expect(txs[0]?.signature).toBe(fixture("pump-buy").signature);
      expect(src.stats.perProgram.pump).toBe(1);
    } finally {
      await src.stop();
    }
  });
});

describe("RpcLogsSource reconnect backoff", () => {
  test("connects that never open keep backing off instead of resetting to the base delay", () => {
    const sockets: { onclose?: (ev: { code: number; reason: string }) => void }[] = [];
    class NeverOpens {
      onopen: unknown = null;
      onmessage: unknown = null;
      onerror: unknown = null;
      onclose?: (ev: { code: number; reason: string }) => void;
      constructor(_url: string) {
        sockets.push(this);
      }
      send(): void {}
      close(): void {}
    }
    const realSetTimeout = globalThis.setTimeout;
    // capture reconnect timers instead of letting them fire; this test drives reconnects by hand
    globalThis.setTimeout = ((_fn: () => void, _ms?: number) => 0) as unknown as typeof setTimeout;
    try {
      const src = new RpcLogsSource({
        wsUrl: "ws://unused",
        programs: [PUMP_PROGRAM_ID],
        commitment: "processed",
        WebSocketImpl: NeverOpens as unknown as typeof WebSocket,
      });
      const internals = src as unknown as { connect(): void; backoff: { attempts: number } };
      internals.connect();
      for (let i = 0; i < 4; i++) {
        sockets.at(-1)?.onclose?.({ code: 1006, reason: "" });
        internals.connect();
      }
      // before the fix every failed connect reset the backoff, so attempts never got past 1
      expect(internals.backoff.attempts).toBe(4);
      expect(src.stats.reconnects).toBe(4);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});
