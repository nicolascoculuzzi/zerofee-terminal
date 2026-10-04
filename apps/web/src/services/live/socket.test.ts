import { describe, expect, test } from "bun:test";
import type { ErrorMessage } from "@zerofee/protocol";
import { GatewaySocket, type SocketState, type WireMessage, WS_CLOSE_SESSION_ENDED } from "./socket";
import { ManualClock, socketFactory } from "./testkit";

function setup(opts: { maxMessagesPerSec?: number; burst?: number } = {}) {
  const clock = new ManualClock();
  const f = socketFactory();
  const gw = new GatewaySocket({ url: "ws://gw.test/ws", createSocket: f.create, clock, random: () => 1, ...opts });
  const states: SocketState[] = [];
  gw.onState((s) => states.push(s));
  return { clock, f, gw, states };
}

function recorder() {
  const got: WireMessage[] = [];
  const errors: ErrorMessage[] = [];
  return { got, errors, listener: { onMessage: (m: WireMessage) => got.push(m), onError: (e: ErrorMessage) => errors.push(e) } };
}

describe("GatewaySocket", () => {
  test("subscribes on open, delivers snapshot then contiguous deltas, drops stale and pre-snapshot ones", () => {
    const { f, gw, states } = setup();
    const r = recorder();
    gw.subscribe("pulse:new", r.listener);
    const s = f.last();
    expect(s.sent).toEqual([]); // not open yet
    s.open();
    expect(states).toEqual(["live"]);
    expect(s.sent).toEqual([{ type: "subscribe", topic: "pulse:new" }]);
    s.delta("pulse:new", 4, { upsert: [], remove: ["early"] }); // before the snapshot: dropped
    s.snapshot("pulse:new", 5, { tokens: [] });
    s.delta("pulse:new", 6, { upsert: [], remove: ["a"] });
    s.delta("pulse:new", 6, { upsert: [], remove: ["dup"] }); // stale
    s.correction("pulse:new", 7, { remove: ["b"], upsert: [] });
    expect(r.got.map((m) => [m.type, m.seq])).toEqual([
      ["snapshot", 5],
      ["delta", 6],
      ["correction", 7],
    ]);
    expect(gw.stats.stale).toBe(1);
  });

  test("a seq gap re-requests the snapshot and drops everything until it arrives", () => {
    const { f, gw } = setup();
    const r = recorder();
    gw.subscribe("trades:M", r.listener);
    const s = f.last();
    s.open();
    s.snapshot("trades:M", 10, { trades: [] });
    s.delta("trades:M", 12, { trades: [] }); // 11 went missing
    expect(gw.stats.gaps).toBe(1);
    expect(s.subscribes("trades:M")).toBe(2);
    s.delta("trades:M", 13, { trades: [] }); // still waiting for the snapshot
    s.snapshot("trades:M", 13, { trades: [] });
    s.delta("trades:M", 14, { trades: [] });
    expect(r.got.map((m) => [m.type, m.seq])).toEqual([
      ["snapshot", 10],
      ["snapshot", 13],
      ["delta", 14],
    ]);
  });

  test("shared topics: one server subscription, a late joiner triggers a resync, the last leaver unsubscribes", () => {
    const { f, gw } = setup();
    const a = recorder();
    const b = recorder();
    const offA = gw.subscribe("chain", a.listener);
    const s = f.last();
    s.open();
    s.snapshot("chain", 1, { slot: 1 });
    const offB = gw.subscribe("chain", b.listener);
    expect(s.subscribes("chain")).toBe(2);
    s.delta("chain", 2, { slot: 2 }); // in flight before the resync answer: dropped for both
    s.snapshot("chain", 2, { slot: 2 });
    s.delta("chain", 3, { slot: 3 });
    expect(a.got.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(b.got.map((m) => m.seq)).toEqual([2, 3]);
    offA();
    expect(s.unsubscribes("chain")).toBe(0);
    offB();
    expect(s.unsubscribes("chain")).toBe(1);
    s.delta("chain", 4, { slot: 4 });
    expect(b.got).toHaveLength(2);
  });

  test("a subscribe still queued when its listener leaves is never sent (and needs no unsubscribe)", () => {
    const { clock, f, gw } = setup({ maxMessagesPerSec: 2, burst: 1 });
    const s = (() => {
      gw.subscribe("chain", recorder().listener);
      const sock = f.last();
      sock.open();
      return sock;
    })();
    expect(s.sent).toHaveLength(1);
    const off = gw.subscribe("candles:M:1m", recorder().listener); // queued: the bucket is empty
    expect(s.subscribes("candles:M:1m")).toBe(0);
    off();
    clock.advance(5_000);
    expect(s.subscribes("candles:M:1m")).toBe(0);
    expect(s.unsubscribes("candles:M:1m")).toBe(0);
  });

  test("outgoing messages are paced under the server's rate limit", () => {
    const { clock, f, gw } = setup({ maxMessagesPerSec: 10, burst: 5 });
    for (let i = 0; i < 25; i++) gw.subscribe(`token:T${i}`, recorder().listener);
    const s = f.last();
    s.open();
    expect(s.sent).toHaveLength(5); // the burst
    clock.advance(1_000);
    expect(s.sent.length).toBeGreaterThanOrEqual(14);
    expect(s.sent.length).toBeLessThanOrEqual(16);
    clock.advance(2_000);
    expect(s.sent).toHaveLength(25);
  });

  test("reconnects with backoff, resubscribes everything and starts over from snapshots", () => {
    const { clock, f, gw, states } = setup();
    const r = recorder();
    gw.subscribe("pulse:final", r.listener);
    f.last().open();
    f.last().snapshot("pulse:final", 3, { tokens: [] });
    f.last().drop();
    expect(states.at(-1)).toBe("connecting");
    expect(f.sockets).toHaveLength(1);
    clock.advance(500); // first backoff: 500 ms (random = 1)
    expect(f.sockets).toHaveLength(2);
    f.last().drop(); // fails again: 1 s
    clock.advance(999);
    expect(f.sockets).toHaveLength(2);
    clock.advance(1);
    expect(f.sockets).toHaveLength(3);
    f.last().drop(); // third failure: offline (keeps retrying)
    expect(states.at(-1)).toBe("offline");
    clock.advance(2_000);
    const s = f.last();
    s.open();
    expect(states.at(-1)).toBe("live");
    expect(s.sent).toEqual([{ type: "subscribe", topic: "pulse:final" }]);
    s.delta("pulse:final", 9, { upsert: [], remove: [] }); // old numbering: ignored until the snapshot
    s.snapshot("pulse:final", 9, { tokens: [] });
    expect(r.got.map((m) => [m.type, m.seq])).toEqual([
      ["snapshot", 3],
      ["snapshot", 9],
    ]);
    expect(gw.stats.reconnects).toBe(1);
  });

  test("a quiet socket is treated as dead and replaced", () => {
    const { clock, f, gw } = setup();
    gw.subscribe("chain", recorder().listener);
    f.last().open();
    clock.advance(25_000);
    expect(gw.stats.staleSockets).toBe(1);
    clock.advance(1_000);
    expect(f.sockets.length).toBeGreaterThanOrEqual(2);
  });

  test("topic errors reach the listeners; rate limits retry; a session-ended close notifies and reconnects", () => {
    const { clock, f, gw } = setup();
    const r = recorder();
    let ended = 0;
    gw.onSessionEnded(() => ended++);
    gw.subscribe("orders", r.listener);
    const s = f.last();
    s.open();
    s.error("orders", "unauthorized", "sign in to subscribe to user topics");
    expect(r.errors.map((e) => e.code)).toEqual(["unauthorized"]);
    s.error("orders", "rate_limited");
    expect(r.errors).toHaveLength(1);
    clock.advance(1_500);
    expect(s.subscribes("orders")).toBe(2);
    s.drop(WS_CLOSE_SESSION_ENDED);
    expect(ended).toBe(1);
  });

  test("reconnect() swaps the socket at once (new session cookie) and resubscribes", () => {
    const { f, gw } = setup();
    gw.subscribe("orders", recorder().listener);
    f.last().open();
    gw.reconnect();
    expect(f.sockets[0]?.closedWith).toBe(1000);
    expect(f.sockets).toHaveLength(2);
    f.last().open();
    expect(f.last().subscribes("orders")).toBe(1);
  });
});
