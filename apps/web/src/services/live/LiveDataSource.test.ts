import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ServerMessage, Topic } from "../../protocol";
import { useBackend } from "../../state/backend";
import { setApiFetch } from "./api";
import { curveCtx, MINT, MINT2, TRADER, WALLET, wireChain, wireOrder, wireToken, wireTrade } from "./fixtures";
import { LiveDataSource } from "./LiveDataSource";
import { type FakeSocket, ManualClock, socketFactory } from "./testkit";

/** Subscribes like state/subscribe.ts does and fails the test on any seq the UI would reject. */
function ui<T extends Topic>(ds: LiveDataSource, topic: T) {
  const got: ServerMessage<T>[] = [];
  let last: number | null = null;
  const off = ds.subscribe(topic, (m) => {
    if (m.type === "snapshot") last = m.seq;
    else {
      expect(last).not.toBeNull();
      expect(m.seq).toBe((last as number) + 1);
      last = m.seq;
    }
    got.push(m);
  });
  return { got, off, snapshots: () => got.filter((m) => m.type === "snapshot"), deltas: () => got.filter((m) => m.type === "delta") };
}

/** The payload of a message that must exist. */
function dataOf<T>(m: { data: unknown } | undefined): T {
  if (!m) throw new Error("expected a message");
  return m.data as T;
}

let clock: ManualClock;
let f: ReturnType<typeof socketFactory>;
let ds: LiveDataSource;
let s: FakeSocket;

const health = {
  ok: true,
  version: "0.2.0",
  dryRun: true,
  sources: [{ name: "rpc-logs", connected: true }],
  ingest: { latency: { p50: 650, p90: 900, p99: 1_500, samples: 10 }, tradesPerSec1m: 33.3 },
};

beforeEach(() => {
  setApiFetch(async (url) => {
    if (url.endsWith("/api/health")) return new Response(JSON.stringify(health));
    if (url.includes("/api/search")) return new Response(JSON.stringify({ tokens: [wireToken({ bondingProgressBps: 7_000 })] }));
    return new Response(JSON.stringify({ error: "nope", code: "not_found" }), { status: 404 });
  });
  clock = new ManualClock();
  f = socketFactory();
  ds = new LiveDataSource({ socket: { url: "ws://gw.test/ws", createSocket: f.create, clock, random: () => 1 }, healthPollMs: 0 });
  s = f.last();
  s.open();
});

afterEach(() => {
  ds.close();
  setApiFetch(null);
});

describe("LiveDataSource", () => {
  test("the chain topic is always on and feeds SOL/USD, the market view and the kill switch", () => {
    expect(s.sent).toContainEqual({ type: "subscribe", topic: "chain" });
    const m = ui(ds, "market");
    expect(m.got).toEqual([]); // nothing until the chain snapshot
    s.snapshot("chain", 1, wireChain());
    expect(m.snapshots()[0]?.data).toMatchObject({ solUsd: 119.5, slot: 300_000_100 });
    expect(ds.solUsd()).toBe(119.5);
    s.delta("chain", 2, { halt: { halted: true, reason: "maintenance", since: 5 } });
    expect(useBackend.getState()).toMatchObject({ halted: true, haltReason: "maintenance" });
    s.delta("chain", 3, { halt: { halted: false, reason: null, since: null } });
    m.off();
  });

  test("page load fetches /api/health once: the socket opening does not poll again while the first answer is fresh", async () => {
    let calls = 0;
    setApiFetch(async (url) => {
      if (url.endsWith("/api/health")) calls++;
      return new Response(JSON.stringify(health));
    });
    const f2 = socketFactory();
    const ds2 = new LiveDataSource({
      socket: { url: "ws://gw.test/ws", createSocket: f2.create, clock, random: () => 1 },
      healthPollMs: 60_000,
    });
    try {
      f2.last().open(); // while the constructor's poll is in flight
      await Bun.sleep(1);
      f2.last().open(); // just after it answered
      await Bun.sleep(1);
      expect(calls).toBe(1);
      expect(ds2.health()?.version).toBe("0.2.0");
    } finally {
      ds2.close();
    }
  });

  test("pulse: snapshot, merged patches, removals, and a resync for a patch of an unknown token", () => {
    s.snapshot("chain", 1, wireChain());
    const p = ui(ds, "pulse:new");
    expect(s.subscribes("pulse:new")).toBe(1);
    s.snapshot("pulse:new", 40, { tokens: [wireToken()] });
    expect(p.snapshots()[0]?.data).toMatchObject({ tokens: [{ mint: MINT, column: "new", symbol: "SCAT" }] });
    s.delta("pulse:new", 41, { upsert: [{ mint: MINT, mcSol: 40, buys: 10 }, wireToken({ mint: MINT2, symbol: "TWO" })], remove: [] });
    const d = p.deltas()[0]?.data as { upsert: { mint: string; marketCapSol: number; buys: number; symbol: string }[] };
    expect(d.upsert.map((t) => [t.mint, t.marketCapSol, t.symbol])).toEqual([
      [MINT, 40, "SCAT"],
      [MINT2, 31, "TWO"],
    ]);
    s.delta("pulse:new", 42, { upsert: [], remove: [MINT2] });
    expect(p.deltas()[1]?.data).toEqual({ upsert: [], remove: [MINT2] });
    s.delta("pulse:new", 43, { upsert: [{ mint: "Unseen1111111111111111111111111111111111111", mcSol: 1 }], remove: [] });
    expect(p.deltas()).toHaveLength(2); // dropped, resync requested
    expect(s.subscribes("pulse:new")).toBe(2);
    s.snapshot("pulse:new", 43, { tokens: [] });
    expect(p.snapshots()).toHaveLength(2);
    p.off();
    expect(s.unsubscribes("pulse:new")).toBe(1);
  });

  test("a second UI subscriber gets the view's snapshot at the current number and shares the wire topic", () => {
    const a = ui(ds, "pulse:final");
    s.snapshot("pulse:final", 7, { tokens: [wireToken({ bondingProgressBps: 8_000 })] });
    s.delta("pulse:final", 8, { upsert: [{ mint: MINT, mcSol: 50 }], remove: [] });
    const b = ui(ds, "pulse:final");
    expect(s.subscribes("pulse:final")).toBe(1);
    expect(b.snapshots()[0]?.seq).toBe(a.got.at(-1)?.seq);
    s.delta("pulse:final", 9, { upsert: [{ mint: MINT, mcSol: 51 }], remove: [] });
    expect(a.got.at(-1)?.seq).toBe(b.got.at(-1)?.seq);
    a.off();
    expect(s.unsubscribes("pulse:final")).toBe(0);
    b.off();
    expect(s.unsubscribes("pulse:final")).toBe(1);
  });

  test("token detail: summary + trade context; the venue quote waits for the trade engine's fee", () => {
    s.snapshot("chain", 1, wireChain());
    const t = ui(ds, `token:${MINT}`);
    expect(s.sent).toContainEqual({ type: "subscribe", topic: `tradectx:${MINT}` });
    s.snapshot(`tradectx:${MINT}`, 3, curveCtx());
    s.snapshot(`token:${MINT}`, 10, wireToken());
    const first = t.snapshots()[0]?.data as { summary: { mint: string }; curve: unknown; holders: unknown[]; devLaunches: number };
    expect(first.summary.mint).toBe(MINT);
    expect(first.curve).toBeNull(); // no fee yet: no display quote rather than a guessed fee
    expect(first.holders).toEqual([]);
    expect(first.devLaunches).toBe(2);
    ds.setFeeEngine(() => 125);
    const venue = t.deltas().at(-1)?.data as { curve: { feeBps: number; virtualQuoteReserves: number } };
    expect(venue.curve).toMatchObject({ feeBps: 125, virtualQuoteReserves: 31 });
    s.delta(`token:${MINT}`, 11, { mint: MINT, buys: 99 });
    expect(dataOf<{ summary: { buys: number; symbol: string } }>(t.deltas().at(-1)).summary).toMatchObject({ buys: 99, symbol: "SCAT" });
    t.off();
  });

  test("an unknown token answers nothing until it appears in full", () => {
    const t = ui(ds, `token:${MINT2}`);
    s.snapshot(`token:${MINT2}`, 1, null);
    expect(t.got).toEqual([]);
    s.delta(`token:${MINT2}`, 2, wireToken({ mint: MINT2 }));
    expect(t.snapshots()).toHaveLength(1);
    t.off();
  });

  test("trade tape: newest first, decimals from the summary, 'you' tag, corrections replace the tape", () => {
    s.snapshot("chain", 1, wireChain());
    ds.setOwnWallets([WALLET]);
    ds.rememberToken(wireToken());
    const tape = ui(ds, `trades:${MINT}`);
    s.snapshot(`trades:${MINT}`, 1, { trades: [wireTrade()] });
    s.delta(`trades:${MINT}`, 2, {
      trades: [wireTrade({ id: "a:0", slot: 300_000_011 }), wireTrade({ id: "b:0", slot: 300_000_012, trader: WALLET })],
    });
    const d = tape.deltas()[0]?.data as { trades: { id: string; tags: string[]; tokenAmount: number }[] };
    expect(d.trades.map((x) => x.id)).toEqual(["b:0", "a:0"]);
    expect(d.trades[0]?.tags).toContain("you");
    expect(d.trades[0]?.tokenAmount).toBe(15_000_000);
    s.correction(`trades:${MINT}`, 3, { remove: ["a:0"], upsert: [] });
    const snap = tape.snapshots().at(-1)?.data as { trades: { id: string }[] };
    expect(snap.trades.map((x) => x.id)).toEqual(["b:0", "sig1:0"]);
    tape.off();
  });

  test("candles: deltas upsert, a dead-slot correction drops an emptied bucket", () => {
    const c = ui(ds, `candles:${MINT}:1m`);
    const candle = (t: number, n = 3) => ({ t, o: 1, h: 1, l: 1, c: 1, v: 1, n, solUsd: 120 });
    s.snapshot(`candles:${MINT}:1m`, 5, { supply: 1e9, candles: [candle(60_000), candle(120_000)] });
    expect(dataOf<{ candles: { time: number }[] }>(c.snapshots()[0]).candles.map((x) => x.time)).toEqual([60, 120]);
    s.delta(`candles:${MINT}:1m`, 6, { candles: [candle(180_000)] });
    expect(dataOf<{ candles: { time: number }[] }>(c.deltas()[0]).candles.map((x) => x.time)).toEqual([180]);
    s.correction(`candles:${MINT}:1m`, 7, { candles: [candle(120_000, 0)] });
    expect(dataOf<{ candles: { time: number }[] }>(c.snapshots().at(-1)).candles.map((x) => x.time)).toEqual([60, 180]);
    c.off();
  });

  test("user topics signed out: orders read as empty; a later snapshot adapts the engine's orders", () => {
    const o = ui(ds, "orders");
    s.error("orders", "unauthorized", "sign in to subscribe to user topics");
    expect(o.snapshots()[0]?.data).toEqual({ orders: [] });
    // After sign-in the socket reconnects and the server answers with the real list.
    ds.socket.reconnect();
    f.last().open();
    f.last().snapshot("orders", 1, { orders: [wireOrder()] });
    const orders = dataOf<{ orders: { kind: string; reservedSol: number }[] }>(o.snapshots().at(-1)).orders;
    expect(orders[0]).toMatchObject({ kind: "take_profit" });
    expect(ds.reserved(WALLET).sol).toBeCloseTo(0.002105);
    expect(ds.reserved(WALLET).nonceUsed).toBe(1);
    o.off();
  });

  test("wallet topic: balances and positions; nothing is shown while the server refuses it", () => {
    ds.rememberToken(wireToken());
    const w = ui(ds, `wallet:${WALLET}`);
    s.error(`wallet:${WALLET}`, "unavailable", "wallet balances are not published yet");
    expect(w.got).toEqual([]);
    ds.socket.resync(`wallet:${WALLET}`);
    s.snapshot(`wallet:${WALLET}`, 1, {
      address: WALLET,
      lamports: "1500000000",
      tokens: [{ mint: MINT, account: "Ata1", amount: "15000000000000", decimals: 6, tokenProgram: "T" }],
      fills: [wireTrade({ trader: WALLET })],
      slot: 1,
    });
    const status = w.snapshots()[0]?.data as { solBalance: number; positions: { mint: string; holdingTokens: number }[] };
    expect(status.solBalance).toBe(1.5);
    expect(status.positions[0]).toMatchObject({ mint: MINT, holdingTokens: 15_000_000 });
    expect(ds.wallet(WALLET)?.balanceOf(MINT)?.amount).toBe(15_000_000_000_000n);
    w.off();
    expect(ds.wallet(WALLET)).toBeNull();
  });

  test("reconnect: the view keeps numbering and starts over from the server's new snapshot", () => {
    const p = ui(ds, "pulse:migrated");
    s.snapshot("pulse:migrated", 3, { tokens: [wireToken({ migrated: true })] });
    s.drop();
    clock.advance(600);
    const s2 = f.last();
    expect(s2).not.toBe(s);
    s2.open();
    expect(s2.subscribes("pulse:migrated")).toBe(1);
    s2.snapshot("pulse:migrated", 1, { tokens: [] }); // the restarted server numbers from scratch
    s2.delta("pulse:migrated", 2, { upsert: [wireToken({ migrated: true })], remove: [] });
    expect(p.got.map((m) => m.type)).toEqual(["snapshot", "snapshot", "delta"]);
    expect(ds.getConnectionState()).toBe("live");
    p.off();
  });

  test("connection state follows the socket; social is an empty feed; search adapts REST results", async () => {
    const states: string[] = [];
    ds.onConnectionState((st) => states.push(st));
    s.drop();
    expect(ds.getConnectionState()).toBe("connecting");
    const social = ui(ds, "social");
    expect(social.snapshots()[0]?.data).toEqual({ posts: [] });
    const res = await ds.search("scat");
    expect(res.tokens[0]).toMatchObject({ mint: MINT, column: "final" });
    expect(res.wallets).toEqual([]);
    expect(await ds.getWallet(TRADER)).toBeNull();
    expect(await ds.getPnlHistory(TRADER, "7d")).toEqual([]);
    expect(states).toEqual(["connecting"]);
  });
});
