import { describe, expect, test } from "bun:test";
import type { TokenSummary } from "@zerofee/protocol";
import { TopicHub } from "../src/gateway/topics";
import { classify, diffSummary, PulseBoard, type PulseConfig } from "../src/market/pulse";

const CFG: PulseConfig = {
  finalStretchBps: 6_000,
  migratedWindowMs: 24 * 3_600_000,
  newMaxAgeMs: 24 * 3_600_000,
  finalMaxIdleMs: 60 * 60_000,
  listLimit: 3,
};
const NOW = 1_791_049_000_000;

function summary(mint: string, o: Partial<TokenSummary> = {}): TokenSummary {
  return {
    mint,
    name: mint,
    symbol: mint,
    image: null,
    description: null,
    launchpad: "pump",
    quoteMint: "So11111111111111111111111111111111111111112",
    tokenProgram: null,
    decimals: 6,
    supply: 1e9,
    createdAt: NOW - 60_000,
    createdSlot: 1,
    creator: null,
    priceSol: 1e-8,
    priceUsd: null,
    mcSol: 10,
    mcUsd: null,
    priceQuote: 1e-8,
    mcQuote: 10,
    liquidity: 1,
    liquidityUsd: null,
    volume5m: 0,
    volume1h: 0,
    volume24h: 0,
    txns: 0,
    buys: 0,
    sells: 0,
    holders: 1,
    top10Pct: 1,
    devPct: 1,
    snipersPct: 0,
    insidersPct: null,
    bundlersPct: 0,
    proTraders: null,
    bondingProgressBps: 100,
    complete: false,
    migrated: false,
    migratedAt: null,
    pool: null,
    socials: { x: null, telegram: null, website: null },
    dexPaid: null,
    athMcSol: 10,
    isMayhem: false,
    lastTradeAt: NOW - 1_000,
    updatedAt: NOW,
    ...o,
  };
}

describe("pulse classification (defaults: 60% final stretch, 24 h migrated)", () => {
  test("columns", () => {
    expect(classify(summary("a"), CFG, NOW)).toBe("new");
    expect(classify(summary("a", { bondingProgressBps: 5_999 }), CFG, NOW)).toBe("new");
    expect(classify(summary("a", { bondingProgressBps: 6_000 }), CFG, NOW)).toBe("final");
    expect(classify(summary("a", { complete: true, bondingProgressBps: 10_000 }), CFG, NOW)).toBe("final");
    expect(classify(summary("a", { migrated: true, migratedAt: NOW - 3_600_000 }), CFG, NOW)).toBe("migrated");
    expect(classify(summary("a", { migrated: true, migratedAt: NOW - 25 * 3_600_000 }), CFG, NOW)).toBeNull();
    expect(classify(summary("a", { migrated: true, migratedAt: null }), CFG, NOW)).toBeNull(); // unknown migration time
    expect(classify(summary("a", { createdAt: NOW - 25 * 3_600_000 }), CFG, NOW)).toBeNull();
    expect(classify(summary("a", { createdAt: null }), CFG, NOW)).toBeNull();
    expect(classify(summary("a", { bondingProgressBps: 7_000, lastTradeAt: NOW - 2 * 3_600_000 }), CFG, NOW)).toBeNull();
    expect(classify(summary("a", { launchpad: "pumpswap" }), CFG, NOW)).toBeNull();
  });
});

describe("pulse board deltas", () => {
  test("entrants are sent in full, members as patches, leavers and capped-out tokens as removals", () => {
    const board = new PulseBoard(CFG);
    const db = new Map<string, TokenSummary>();
    const get = (m: string) => db.get(m) ?? null;
    for (const [i, m] of ["a", "b", "c", "d"].entries()) db.set(m, summary(m, { createdAt: NOW - (10 - i) * 1_000 }));
    let d = board.update(["a", "b", "c", "d"], get, NOW);
    // cap 3, newest first: d, c, b
    expect(d.new.upsert.map((s) => s.mint).sort()).toEqual(["b", "c", "d"]);
    expect(d.new.remove).toEqual([]);
    expect(board.snapshot("new").map((s) => s.mint)).toEqual(["d", "c", "b"]);

    // a field change on a member -> patch with only the changed fields
    db.set("c", { ...(db.get("c") as TokenSummary), mcSol: 99, updatedAt: NOW + 1 });
    d = board.update(["c"], get, NOW);
    expect(d.new.upsert).toEqual([{ mint: "c", mcSol: 99, updatedAt: NOW + 1 }]);

    // c crosses 60% -> leaves new (b... a enters new to refill the cap), joins final
    db.set("c", { ...(db.get("c") as TokenSummary), bondingProgressBps: 6_500 });
    d = board.update(["c"], get, NOW);
    expect(d.new.remove).toEqual(["c"]);
    expect(d.new.upsert.map((s) => s.mint)).toEqual(["a"]);
    expect(d.final.upsert.map((s) => s.mint)).toEqual(["c"]);
    expect(board.columnOf("c")).toBe("final");

    // unchanged tokens produce no delta
    d = board.update(["a"], get, NOW);
    expect(d.new).toEqual({ upsert: [], remove: [] });
  });

  test("time-based expiry moves tokens out", () => {
    const board = new PulseBoard(CFG);
    const s = summary("m", { migrated: true, migratedAt: NOW - 1_000 });
    board.update(["m"], () => s, NOW);
    expect(board.snapshot("migrated")).toHaveLength(1);
    const later = NOW + 25 * 3_600_000;
    board.expire(() => s, later);
    const d = board.update([], () => s, later);
    expect(d.migrated.remove).toEqual(["m"]);
  });

  test("diffSummary compares nested socials by value", () => {
    const a = summary("x");
    expect(diffSummary(a, { ...a, socials: { ...a.socials } })).toBeNull();
    expect(diffSummary(a, { ...a, socials: { ...a.socials, x: "https://x.com/y" } })).toEqual({
      mint: "x",
      socials: { x: "https://x.com/y", telegram: null, website: null },
      updatedAt: NOW,
    });
  });
});

describe("topic sequencing", () => {
  test("snapshot carries the current seq; deltas and corrections increment it; idle topics do not advance", () => {
    const sent: { topic: string; payload: { type: string; seq: number; reason?: string } }[] = [];
    const hub = new TopicHub((topic, payload) => sent.push({ topic, payload: JSON.parse(payload) }));
    expect(hub.publish("pulse:new", "delta", { upsert: [], remove: [] })).toBe(false); // nobody listening
    expect(JSON.parse(hub.snapshot("pulse:new", { tokens: [] })).seq).toBe(0);
    hub.addSubscriber("pulse:new");
    hub.publish("pulse:new", "delta", { upsert: [], remove: ["a"] });
    hub.publish("pulse:new", "correction", { candles: [] }, "late_event");
    expect(sent.map((s) => [s.payload.type, s.payload.seq, s.payload.reason])).toEqual([
      ["delta", 1, undefined],
      ["correction", 2, "late_event"],
    ]);
    // a late subscriber's snapshot continues from the current number
    expect(JSON.parse(hub.snapshot("pulse:new", { tokens: [] })).seq).toBe(2);
    hub.removeSubscriber("pulse:new");
    expect(hub.hasSubscribers("pulse:new")).toBe(false);
  });
});
