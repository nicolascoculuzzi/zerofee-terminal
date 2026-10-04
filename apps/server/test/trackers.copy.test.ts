/**
 * Copy-trade engine against a PGlite store with a fake clock, controllable token views and a recording
 * topic hub: sizing, every filter and cap, the drift guard, the per-leader slot cap, sell mirroring,
 * TP / SL exits, reported results and feed confirmations, pause / resume, deletes and restarts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type CopyTaskConfig, DEFAULT_COPY_CONFIG, type Trade } from "@zerofee/protocol";
import { UserStore } from "../src/db/pg";
import { setLogLevel } from "../src/log";
import { CopyEngine, type CopyExitHook, type CopyLimits, type LeaderTrade, type TokenView } from "../src/trackers/copy";
import { CopyRepo } from "../src/trackers/copyRepo";
import type { BalanceView } from "../src/trackers/positions";
import { mergeCopyConfig } from "../src/trackers/routes";
import { addr } from "./helpers";
import { pgliteDb, type TestDb } from "./pgHelpers";
import { FakeHub, mkTrade, noBalance, sig, tokenView } from "./trackerHelpers";
import { Clock } from "./userHelpers";

setLogLevel("error");
let t: TestDb;
let store: UserStore;
let repo: CopyRepo;

beforeAll(async () => {
  t = await pgliteDb();
  store = new UserStore(t.db);
  repo = new CopyRepo(t.db);
}, 60_000);
afterAll(async () => {
  await t.close();
});

const FILL = 1 / 30_000_000; // mkTrade default: 1 SOL for 30M tokens
const LIMITS: CopyLimits = {
  leaderSlotCapSol: 25,
  buyTtlMs: 15_000,
  sellTtlMs: 60_000,
  minSol: 0.001,
  skipLogPerHour: 120,
  exitCooldownMs: 30_000,
};
let n = 0;

interface Env {
  engine: CopyEngine;
  hub: FakeHub;
  clock: Clock;
  tokens: Map<string, TokenView>;
  recent: Map<string, Trade[]>;
  leaders: [string, string[]][];
  exits: Parameters<CopyExitHook["leaderSold"]>[0][];
}

function engineEnv(o: { limits?: Partial<CopyLimits>; clock?: Clock } = {}): Env {
  const clock = o.clock ?? new Clock(Date.UTC(2026, 9, 3, 12, 0, 0));
  const hub = new FakeHub();
  const tokens = new Map<string, TokenView>();
  const recent = new Map<string, Trade[]>();
  const leaders: [string, string[]][] = [];
  const exits: Parameters<CopyExitHook["leaderSold"]>[0][] = [];
  const engine = new CopyEngine({
    repo,
    store,
    now: clock.now,
    token: (m) => tokens.get(m) ?? null,
    recentTrades: (m) => recent.get(m) ?? [],
    limits: { ...LIMITS, ...o.limits },
    exits: {
      leaderSold: (ev) => {
        exits.push(ev);
        return false;
      },
    },
    onLeadersChanged: (u, l) => leaders.push([u, l]),
  });
  engine.attach(hub);
  return { engine, hub, clock, tokens, recent, leaders, exits };
}

interface Follower {
  userId: string;
  taskId: string;
  leader: string;
  topic: string;
}

async function follower(e: Env, o: { leader?: string; config?: Record<string, unknown>; subscribe?: boolean } = {}): Promise<Follower> {
  const userId = (await store.users.upsertOnLogin(addr(`copy-user-${++n}`), e.clock.now())).id;
  const leader = o.leader ?? addr(`copy-leader-${n}`);
  const topic = `copy@${userId}`;
  if (o.subscribe !== false) e.hub.subs.add(topic);
  const config: CopyTaskConfig = mergeCopyConfig(DEFAULT_COPY_CONFIG, o.config ?? {});
  const task = await e.engine.createTask(userId, { leader, label: "test", status: "active", config });
  return { userId, taskId: task.id, leader, topic };
}

function newMint(e: Env, o: Partial<TokenView> = {}): string {
  const mint = addr(`copy-mint-${++n}`);
  e.tokens.set(mint, tokenView(mint, e.clock.now(), o));
  return mint;
}

function leaderTrade(
  f: Follower,
  trade: Partial<Trade> & { side: "buy" | "sell"; mint: string; tokens?: number },
  balance: BalanceView = noBalance,
  firstBuy: boolean | null = null,
): LeaderTrade {
  return { leader: f.leader, trade: mkTrade({ trader: f.leader, ...trade }), balance, firstBuy };
}

// biome-ignore lint/suspicious/noExplicitAny: wire payloads
const pendingOf = (e: Env, f: Follower): any[] => e.engine.pendingOf(f.userId);
const stats = (e: Env, f: Follower) => e.engine.getTask(f.userId, f.taskId)?.stats;

async function buyAndFill(e: Env, f: Follower, mint: string, o: { sol?: number; tokens?: string; balance?: BalanceView } = {}) {
  e.engine.onLeaderTrade(leaderTrade(f, { side: "buy", mint }, o.balance ?? noBalance, true));
  const s = pendingOf(e, f).find((x) => x.mint === mint && x.side === "buy");
  expect(s).toBeDefined();
  const r = await e.engine.report(f.userId, s.id, {
    status: "executed",
    signature: sig("fill"),
    solAmount: o.sol ?? s.sizeSol,
    tokenAmount: o.tokens ?? "1500000000000",
  });
  expect(r.ok).toBe(true);
  return s;
}

describe("buy signals", () => {
  test("fixed size: a vetted, expiring signal is pushed at once, reserved against the caps and persisted", async () => {
    const e = engineEnv();
    const f = await follower(e);
    const mint = newMint(e);
    const tr = leaderTrade(f, { side: "buy", mint, slot: 4242 }, noBalance, true);
    e.engine.onLeaderTrade(tr);
    const [s] = e.hub.signals(f.topic);
    expect(s).toMatchObject({
      taskId: f.taskId,
      side: "buy",
      status: "pending",
      mint,
      symbol: "COPY",
      leader: f.leader,
      leaderSignature: tr.trade.signature,
      leaderSlot: 4242,
      leaderSol: 1,
      sizeSol: 0.05,
      slippageBps: 1_500,
      preset: 1,
      takeProfitPct: null,
      stopLossPct: null,
      delivered: true,
      expiresAt: e.clock.now() + 15_000,
      trigger: null,
    });
    expect(s.leaderPriceSol).toBeCloseTo(FILL, 15);
    expect(s.maxPriceSol).toBeCloseTo(FILL * 1.1, 15);
    expect(stats(e, f)).toMatchObject({ buySignals: 1, spentSol: 0.05, spentTodaySol: 0.05, buysToday: 1, skipped: 0 });
    e.engine.sweep(); // task stats go out off the hot path
    expect(e.hub.of(f.topic).some((m) => m.data.tasks?.[0]?.stats.buySignals === 1)).toBe(true);
    await e.engine.drain();
    const rows = await repo.listSignals(f.userId, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: s.id, status: "pending", sizeSol: 0.05, leaderSignature: tr.trade.signature });
  });

  test("ratio sizing is capped per buy and by the account's maxTradeSol", async () => {
    const e = engineEnv();
    const f = await follower(e, {
      config: { sizing: { mode: "ratio", pct: 10 }, maxPerBuySol: 0.5, totalSpendLimitSol: 100, dailySpendLimitSol: 100 },
    });
    const sizes: number[] = [];
    for (const sol of [3, 10]) {
      const mint = newMint(e);
      e.engine.onLeaderTrade(leaderTrade(f, { side: "buy", mint, amountSol: sol, tokens: 30_000_000 * sol }));
      sizes.push(pendingOf(e, f).find((x) => x.mint === mint).sizeSol);
    }
    e.engine.setUserCaps(f.userId, { maxTradeSol: 0.2, maxDailySol: 100 });
    const mint = newMint(e);
    e.engine.onLeaderTrade(leaderTrade(f, { side: "buy", mint, amountSol: 10, tokens: 300_000_000 }));
    sizes.push(pendingOf(e, f).find((x) => x.mint === mint).sizeSol);
    expect(sizes).toEqual([0.3, 0.5, 0.2]);
  });

  const filterCases: {
    name: string;
    reason: string;
    config?: Record<string, unknown>;
    view?: (now: number) => Partial<TokenView> | null;
    trade?: Partial<Trade>;
    firstBuy?: boolean | null;
  }[] = [
    { name: "task token blacklist", reason: "blacklisted_token", config: { blacklist: { mints: ["MINT"] } } },
    { name: "task dev blacklist", reason: "blacklisted_dev", config: { blacklist: { devs: ["DEV"] } } },
    { name: "curve complete, migration pending", reason: "curve_complete", view: () => ({ curveComplete: true, onCurve: false }) },
    { name: "exclude bonding curve", reason: "bonding_curve_excluded", config: { excludeBondingCurve: true } },
    { name: "Token-2022 danger flags", reason: "token_danger", view: () => ({ dangerous: true }) },
    { name: "only first buy, leader adding", reason: "not_first_buy", config: { onlyFirstBuy: true }, firstBuy: false },
    { name: "minimum age", reason: "token_too_young", config: { ageSec: { min: 120 } } },
    { name: "maximum age", reason: "token_too_old", config: { ageSec: { min: null, max: 30 } } },
    {
      name: "maximum age, age unknown",
      reason: "token_too_old",
      config: { ageSec: { min: null, max: 3_600 } },
      view: () => ({ createdAt: null }),
    },
    { name: "minimum MC (USD)", reason: "mc_below_min", config: { mc: { min: 10_000 } } },
    { name: "maximum MC (USD)", reason: "mc_above_max", config: { mc: { max: 1_000 } } },
    { name: "maximum MC (SOL)", reason: "mc_above_max", config: { mc: { max: 30, currency: "sol" } } },
    { name: "USD filter without SOL/USD", reason: "usd_price_unavailable", config: { mc: { min: 100 } }, view: () => ({ mcUsd: null }) },
    { name: "minimum liquidity", reason: "liquidity_below_min", config: { liquidity: { min: 20 } } },
    { name: "maximum liquidity (USD)", reason: "liquidity_above_max", config: { liquidity: { max: 1_000, currency: "usd" } } },
    { name: "minimum leader size", reason: "leader_size_below_min", config: { leaderSol: { min: 2 } } },
    { name: "maximum leader size", reason: "leader_size_above_max", config: { leaderSol: { max: 0.5 } } },
    { name: "price unknown", reason: "price_unknown", view: () => ({ priceSol: 0 }) },
    { name: "drift guard", reason: "price_drift", view: () => ({ priceSol: FILL * 1.2 }) },
    { name: "size below the minimum", reason: "size_below_minimum", config: { sizing: { mode: "ratio", pct: 0.01 } } },
    { name: "token not in market state", reason: "token_unknown", view: () => null },
  ];

  for (const c of filterCases) {
    test(`filter: ${c.name} -> ${c.reason}`, async () => {
      const e = engineEnv();
      const mint = addr(`filter-mint-${++n}`);
      const view = c.view ? c.view(e.clock.now()) : {};
      const base = tokenView(mint, e.clock.now(), view ?? {});
      if (view !== null) e.tokens.set(mint, base);
      const config = JSON.parse(
        JSON.stringify(c.config ?? {})
          .replaceAll('"MINT"', JSON.stringify(mint))
          .replaceAll('"DEV"', JSON.stringify(base.creator)),
      );
      const f = await follower(e, { config });
      e.engine.onLeaderTrade(leaderTrade(f, { side: "buy", mint, ...c.trade }, noBalance, c.firstBuy ?? null));
      expect(pendingOf(e, f)).toEqual([]);
      expect(stats(e, f)?.skippedByReason).toEqual({ [c.reason]: 1 });
      e.engine.sweep();
      const logged = e.hub.signals(f.topic).filter((s) => s.status === "skipped");
      expect(logged.map((s) => s.reason)).toEqual([c.reason]);
    });
  }

  test("filters pass when they should: unknown first buy, unknown age under a minimum, allowed dangerous tokens", async () => {
    const e = engineEnv();
    const f = await follower(e, { config: { onlyFirstBuy: true, skipDangerousTokens: false, ageSec: { min: 30 }, maxBuysPerToken: 5 } });
    const a = newMint(e, { createdAt: null, dangerous: true });
    e.engine.onLeaderTrade(leaderTrade(f, { side: "buy", mint: a }, noBalance, null));
    expect(pendingOf(e, f)).toHaveLength(1);
  });

  test("account blacklists (tokens and devs) apply and refresh", async () => {
    const e = engineEnv();
    const f = await follower(e);
    const a = newMint(e);
    const b = newMint(e, { creator: addr("bad-dev") });
    await store.prefs.addBlacklist(f.userId, "token", a, undefined, e.clock.now(), 100);
    await store.prefs.addBlacklist(f.userId, "dev", addr("bad-dev"), undefined, e.clock.now(), 100);
    await e.engine.loadUser(f.userId);
    e.engine.onLeaderTrade(leaderTrade(f, { side: "buy", mint: a }));
    e.engine.onLeaderTrade(leaderTrade(f, { side: "buy", mint: b }));
    expect(stats(e, f)?.skippedByReason).toEqual({ blacklisted_token: 1, blacklisted_dev: 1 });
    await store.prefs.removeBlacklist(f.userId, "token", a);
    await e.engine.loadUser(f.userId);
    e.engine.onLeaderTrade(leaderTrade(f, { side: "buy", mint: a }));
    expect(pendingOf(e, f)).toHaveLength(1);
  });

  test("drift guard: at the bound passes, past it skips", async () => {
    const e = engineEnv();
    const f = await follower(e, { config: { maxDriftPct: 5, maxBuysPerToken: 10 } });
    const ok = newMint(e, { priceSol: FILL * 1.049 });
    const late = newMint(e, { priceSol: FILL * 1.051 });
    e.engine.onLeaderTrade(leaderTrade(f, { side: "buy", mint: ok }));
    e.engine.onLeaderTrade(leaderTrade(f, { side: "buy", mint: late }));
    const [s] = pendingOf(e, f);
    expect(s.mint).toBe(ok);
    expect(s.maxPriceSol).toBeCloseTo(FILL * 1.05, 15);
    expect(stats(e, f)?.skippedByReason).toEqual({ price_drift: 1 });
  });

  test("task spend caps shrink a buy to fit, then skip; the daily count caps too; a new UTC day resets them", async () => {
    const e = engineEnv();
    const total = await follower(e, { config: { totalSpendLimitSol: 0.12, dailySpendLimitSol: 0.12 } });
    const daily = await follower(e, { config: { dailySpendLimitSol: 0.07 } });
    const count = await follower(e, { config: { dailyBuyLimit: 2 } });
    for (const f of [total, daily, count]) {
      for (let i = 0; i < 4; i++) e.engine.onLeaderTrade(leaderTrade(f, { side: "buy", mint: newMint(e) }));
    }
    expect(
      pendingOf(e, total)
        .map((s) => s.sizeSol)
        .sort(),
    ).toEqual([0.02, 0.05, 0.05]);
    expect(stats(e, total)?.skippedByReason).toEqual({ total_limit: 1 });
    expect(
      pendingOf(e, daily)
        .map((s) => s.sizeSol)
        .sort(),
    ).toEqual([0.02, 0.05]);
    expect(stats(e, daily)?.skippedByReason).toEqual({ daily_limit: 2 });
    expect(pendingOf(e, count)).toHaveLength(2);
    expect(stats(e, count)?.skippedByReason).toEqual({ daily_buy_limit: 2 });
    // Next day: daily caps reset (pending reservations from yesterday still count toward the lifetime cap).
    e.clock.advance(86_400_000);
    e.engine.onLeaderTrade(leaderTrade(daily, { side: "buy", mint: newMint(e) }));
    e.engine.onLeaderTrade(leaderTrade(count, { side: "buy", mint: newMint(e) }));
    expect(pendingOf(e, daily)).toHaveLength(3);
    expect(pendingOf(e, count)).toHaveLength(3);
    expect(stats(e, daily)).toMatchObject({ spentTodaySol: 0.05, buysToday: 1 });
  });

  test("the account's maxDailySol caps copy spend across all its tasks", async () => {
    const e = engineEnv();
    const a = await follower(e);
    const userId = a.userId;
    await store.prefs.putSettings(userId, { maxTradeSol: 1, maxDailySol: 0.08 }, e.clock.now());
    await e.engine.loadUser(userId);
    const leaderB = addr(`leader-b-${++n}`);
    const taskB = await e.engine.createTask(userId, { leader: leaderB, label: "b", status: "active", config: DEFAULT_COPY_CONFIG });
    const b: Follower = { userId, taskId: taskB.id, leader: leaderB, topic: a.topic };
    e.engine.onLeaderTrade(leaderTrade(a, { side: "buy", mint: newMint(e) }));
    e.engine.onLeaderTrade(leaderTrade(b, { side: "buy", mint: newMint(e) }));
    e.engine.onLeaderTrade(leaderTrade(b, { side: "buy", mint: newMint(e) }));
    expect(pendingOf(e, a).map((s) => [s.taskId === a.taskId ? "a" : "b", s.sizeSol])).toEqual(
      expect.arrayContaining([
        ["a", 0.05],
        ["b", 0.03],
      ]),
    );
    expect(stats(e, b)?.skippedByReason).toEqual({ user_daily_limit: 1 });
  });

  test("one copied buy per token until the copy position closes", async () => {
    const e = engineEnv();
    const f = await follower(e);
    const mint = newMint(e);
    e.engine.onLeaderTrade(leaderTrade(f, { side: "buy", mint }));
    e.engine.onLeaderTrade(leaderTrade(f, { side: "buy", mint }));
    expect(pendingOf(e, f)).toHaveLength(1);
    expect(stats(e, f)?.skippedByReason).toEqual({ max_buys_per_token: 1 });
    e.clock.advance(15_001);
    e.engine.sweep(); // the buy expires: nothing bought, the position is gone
    expect(stats(e, f)).toMatchObject({ expired: 1, spentSol: 0, buysToday: 0, openPositions: 0 });
    e.engine.onLeaderTrade(leaderTrade(f, { side: "buy", mint }));
    expect(pendingOf(e, f)).toHaveLength(1);
  });

  test("per-leader cap per slot is shared pro rata by every follower, and resets each slot", async () => {
    const e = engineEnv({ limits: { leaderSlotCapSol: 0.12, minSol: 0.001 } });
    const leader = addr(`popular-leader-${++n}`);
    const fs = [await follower(e, { leader }), await follower(e, { leader }), await follower(e, { leader })];
    const m1 = newMint(e);
    e.engine.onLeaderTrade(leaderTrade(fs[0] as Follower, { side: "buy", mint: m1, slot: 900 }));
    expect(fs.map((f) => pendingOf(e, f)[0]?.sizeSol)).toEqual([0.04, 0.04, 0.04]);
    const m2 = newMint(e);
    e.engine.onLeaderTrade(leaderTrade(fs[0] as Follower, { side: "buy", mint: m2, slot: 900 })); // same slot: budget spent
    for (const f of fs) expect(stats(e, f)?.skippedByReason).toEqual({ leader_slot_cap: 1 });
    const m3 = newMint(e);
    e.engine.onLeaderTrade(leaderTrade(fs[0] as Follower, { side: "buy", mint: m3, slot: 901 }));
    expect(fs.map((f) => pendingOf(e, f).find((s) => s.mint === m3)?.sizeSol)).toEqual([0.04, 0.04, 0.04]);
  });

  test("a leader trade delivered twice signals once; a dead slot revokes and the fork's replay signals again", async () => {
    const e = engineEnv();
    const f = await follower(e);
    const mint = newMint(e);
    const tr = leaderTrade(f, { side: "buy", mint, slot: 777 });
    e.engine.onLeaderTrade(tr);
    e.engine.onLeaderTrade(tr);
    expect(pendingOf(e, f)).toHaveLength(1);
    e.engine.onDeadSlot(777);
    expect(pendingOf(e, f)).toHaveLength(0);
    expect(e.hub.signals(f.topic).at(-1)).toMatchObject({ status: "revoked", reason: "leader_trade_rolled_back" });
    e.engine.onLeaderTrade({ ...tr, trade: { ...tr.trade, slot: 778 } });
    expect(pendingOf(e, f)).toHaveLength(1);
    expect(stats(e, f)).toMatchObject({ buySignals: 2, revoked: 1, spentSol: 0.05 });
  });
});

describe("sells and exits", () => {
  test("a leader sell revokes pending copy buys of that token", async () => {
    const e = engineEnv();
    const f = await follower(e);
    const mint = newMint(e);
    e.engine.onLeaderTrade(leaderTrade(f, { side: "buy", mint }));
    e.engine.onLeaderTrade(leaderTrade(f, { side: "sell", mint, tokens: 30_000_000 }));
    expect(pendingOf(e, f)).toEqual([]);
    expect(e.hub.signals(f.topic).at(-1)).toMatchObject({ side: "buy", status: "revoked", reason: "leader_sold" });
    expect(stats(e, f)).toMatchObject({ revoked: 1, spentSol: 0, sellSignals: 0 });
  });

  test("copy sells mirror the leader's sold fraction; a second sell before the first fills uses what is left", async () => {
    const e = engineEnv();
    const f = await follower(e);
    const mint = newMint(e);
    await buyAndFill(e, f, mint, { balance: { before: 0n, after: 30_000_000_000_000n, source: "balances" } });
    e.engine.onLeaderTrade(
      leaderTrade(
        f,
        { side: "sell", mint, tokens: 15_000_000 },
        { before: 30_000_000_000_000n, after: 15_000_000_000_000n, source: "balances" },
      ),
    );
    const [half] = pendingOf(e, f);
    expect(half).toMatchObject({
      side: "sell",
      trigger: "leader_sell",
      sellFraction: 0.5,
      sellTokenAmount: "750000000000",
      fractionSource: "balances",
      delivered: true,
    });
    expect(half.expiresAt).toBe(e.clock.now() + 60_000);
    e.engine.onLeaderTrade(
      leaderTrade(f, { side: "sell", mint, tokens: 15_000_000 }, { before: 15_000_000_000_000n, after: 0n, source: "holders" }),
    );
    const rest = pendingOf(e, f).find((s) => s.id !== half.id);
    expect(rest).toMatchObject({ sellFraction: 1, sellTokenAmount: "750000000000", fractionSource: "holders" });
    expect(stats(e, f)?.sellSignals).toBe(2);
  });

  test("without balances the fraction comes from the leader's tracked trades, else a full exit", async () => {
    const e = engineEnv();
    const f = await follower(e);
    const mint = newMint(e);
    await buyAndFill(e, f, mint); // the leader bought 30M tokens (tracked from the copied trade)
    e.engine.onLeaderTrade(leaderTrade(f, { side: "sell", mint, tokens: 10_000_000 }));
    expect(pendingOf(e, f)[0]).toMatchObject({ fractionSource: "tracked", sellTokenAmount: "500000000000" });
    expect(pendingOf(e, f)[0].sellFraction).toBeCloseTo(1 / 3, 6);

    // A late fill after expiry: the position has no leader estimate, so a leader sell means a full exit.
    const g = await follower(e);
    const m2 = newMint(e);
    e.engine.onLeaderTrade(leaderTrade(g, { side: "buy", mint: m2 }));
    const buy = pendingOf(e, g)[0];
    e.clock.advance(15_001);
    e.engine.sweep();
    expect(
      (await e.engine.report(g.userId, buy.id, { status: "executed", signature: sig(), solAmount: 0.05, tokenAmount: "1500000000000" })).ok,
    ).toBe(true);
    e.engine.onLeaderTrade(leaderTrade(g, { side: "sell", mint: m2, tokens: 1_000 }));
    expect(pendingOf(e, g)[0]).toMatchObject({ fractionSource: "unknown", sellFraction: 1, sellTokenAmount: "1500000000000" });
  });

  test("copySells off: leader sells raise nothing", async () => {
    const e = engineEnv();
    const f = await follower(e, { config: { copySells: false } });
    const mint = newMint(e);
    await buyAndFill(e, f, mint);
    e.engine.onLeaderTrade(leaderTrade(f, { side: "sell", mint, tokens: 30_000_000 }));
    expect(pendingOf(e, f)).toEqual([]);
    expect(stats(e, f)?.openPositions).toBe(1);
  });

  test("an executed sell books realized PnL at weighted-average cost; the position closes at zero", async () => {
    const e = engineEnv();
    const f = await follower(e, { config: { maxBuysPerToken: 2 } });
    const mint = newMint(e);
    await buyAndFill(e, f, mint, { sol: 0.05, tokens: "1000000000000" });
    await buyAndFill(e, f, mint, { sol: 0.15, tokens: "1000000000000" }); // avg cost 0.1 SOL per 1M tokens
    const pos = e.engine.positions(f.userId)[0];
    expect(pos).toMatchObject({ tokens: "2000000000000", costSol: 0.2, buys: 2 });
    e.engine.onLeaderTrade(
      leaderTrade(
        f,
        { side: "sell", mint, tokens: 30_000_000 },
        { before: 60_000_000_000_000n, after: 30_000_000_000_000n, source: "balances" },
      ),
    );
    const half = pendingOf(e, f)[0];
    await e.engine.report(f.userId, half.id, { status: "executed", signature: sig(), solAmount: 0.3, tokenAmount: "1000000000000" });
    expect(e.engine.positions(f.userId)[0]).toMatchObject({ tokens: "1000000000000", costSol: 0.1, realizedPnlSol: 0.2 });
    e.engine.onLeaderTrade(
      leaderTrade(f, { side: "sell", mint, tokens: 30_000_000 }, { before: 30_000_000_000_000n, after: 0n, source: "balances" }),
    );
    const rest = pendingOf(e, f)[0];
    await e.engine.report(f.userId, rest.id, { status: "executed", signature: sig(), solAmount: 0.05, tokenAmount: "1000000000000" });
    expect(e.engine.positions(f.userId)).toEqual([]);
    expect(stats(e, f)).toMatchObject({ realizedPnlSol: 0.15, openPositions: 0, executed: 4 });
    expect(e.hub.of(f.topic).some((m) => m.data.closedPositions?.includes(`${f.taskId}:${mint}`))).toBe(true);
    // Closed: a new leader buy of the token may be copied again.
    e.engine.onLeaderTrade(leaderTrade(f, { side: "buy", mint }));
    expect(pendingOf(e, f)).toHaveLength(1);
  });

  test("TP / SL raise one full exit while the browser is open, with a cooldown after a decline", async () => {
    const e = engineEnv();
    const f = await follower(e, { config: { takeProfitPct: 50, stopLossPct: 30 } });
    const mint = newMint(e);
    await buyAndFill(e, f, mint, { sol: 0.05, tokens: "1500000000000" }); // avg 1/30M SOL per token
    const view = e.tokens.get(mint) as TokenView;
    view.priceSol = FILL * 1.4;
    e.engine.onPrices([mint]);
    expect(pendingOf(e, f)).toEqual([]);
    view.priceSol = FILL * 1.6;
    e.engine.onPrices([mint]);
    e.engine.onPrices([mint]);
    const exits = pendingOf(e, f);
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({
      side: "sell",
      trigger: "take_profit",
      sellFraction: 1,
      sellTokenAmount: "1500000000000",
      leaderSignature: "",
    });
    await e.engine.report(f.userId, exits[0].id, { status: "declined", reason: "user_cancelled" });
    e.engine.onPrices([mint]);
    expect(pendingOf(e, f)).toEqual([]); // cooldown
    e.clock.advance(30_001);
    e.engine.onPrices([mint]);
    expect(pendingOf(e, f)).toHaveLength(1);

    const g = await follower(e, { config: { stopLossPct: 30 } });
    const m2 = newMint(e);
    await buyAndFill(e, g, m2, { sol: 0.05, tokens: "1500000000000" });
    (e.tokens.get(m2) as TokenView).priceSol = FILL * 0.69;
    e.engine.onPrices([m2]);
    expect(pendingOf(e, g)[0]).toMatchObject({ trigger: "stop_loss", sellFraction: 1 });
  });

  test("a leader exit while no browser of the follower is connected calls the armed-exit hook", async () => {
    const e = engineEnv();
    const f = await follower(e);
    const mint = newMint(e);
    await buyAndFill(e, f, mint);
    e.hub.subs.delete(f.topic);
    const tr = leaderTrade(f, { side: "sell", mint, tokens: 30_000_000 }, { before: 30_000_000_000_000n, after: 0n, source: "balances" });
    e.engine.onLeaderTrade(tr);
    expect(pendingOf(e, f)[0]).toMatchObject({ delivered: false, sellFraction: 1 });
    expect(e.exits).toEqual([
      { userId: f.userId, taskId: f.taskId, mint, leader: f.leader, leaderSignature: tr.trade.signature, fraction: 1, full: true },
    ]);
  });
});

describe("results reported by the browser", () => {
  test("executed replaces the reservation with the fill; failed and declined release it", async () => {
    const e = engineEnv();
    const f = await follower(e, { config: { maxBuysPerToken: 5 } });
    const [m1, m2, m3] = [newMint(e), newMint(e), newMint(e)];
    for (const mint of [m1, m2, m3]) e.engine.onLeaderTrade(leaderTrade(f, { side: "buy", mint }));
    expect(stats(e, f)?.spentSol).toBe(0.15);
    const byMint = new Map(pendingOf(e, f).map((s) => [s.mint, s]));
    const done = await e.engine.report(f.userId, byMint.get(m1).id, {
      status: "executed",
      signature: sig(),
      solAmount: 0.048,
      tokenAmount: "1400000000000",
    });
    expect(done.ok && done.signal).toMatchObject({ status: "executed", filledSol: 0.048, filledTokens: "1400000000000", confirmed: false });
    await e.engine.report(f.userId, byMint.get(m2).id, { status: "failed", reason: "slippage" });
    await e.engine.report(f.userId, byMint.get(m3).id, { status: "declined", reason: "price_moved" });
    expect(stats(e, f)).toMatchObject({
      spentSol: 0.048,
      spentTodaySol: 0.048,
      buysToday: 1,
      executed: 1,
      failed: 1,
      declined: 1,
      openPositions: 1,
    });
    expect(e.engine.positions(f.userId)).toEqual([expect.objectContaining({ mint: m1, tokens: "1400000000000", costSol: 0.048, buys: 1 })]);
    await e.engine.drain();
    const rows = await repo.listSignals(f.userId, { limit: 10 });
    expect(rows.map((r) => [r.mint === m1 ? "m1" : r.mint === m2 ? "m2" : "m3", r.status, r.reason]).sort()).toEqual([
      ["m1", "executed", null],
      ["m2", "failed", "slippage"],
      ["m3", "declined", "price_moved"],
    ]);
  });

  test("reports are owner-only, idempotent for the same outcome, and conflicting outcomes are refused", async () => {
    const e = engineEnv();
    const f = await follower(e);
    const other = await follower(e);
    e.engine.onLeaderTrade(leaderTrade(f, { side: "buy", mint: newMint(e) }));
    const s = pendingOf(e, f)[0];
    expect(await e.engine.report(other.userId, s.id, { status: "failed" })).toMatchObject({ ok: false, status: 404 });
    expect(await e.engine.report(f.userId, crypto.randomUUID(), { status: "failed" })).toMatchObject({ ok: false, status: 404 });
    expect((await e.engine.report(f.userId, s.id, { status: "declined", reason: "x" })).ok).toBe(true);
    expect((await e.engine.report(f.userId, s.id, { status: "declined", reason: "x" })).ok).toBe(true);
    expect(await e.engine.report(f.userId, s.id, { status: "failed" })).toMatchObject({ ok: false, status: 409 });
    expect(
      await e.engine.report(f.userId, s.id, { status: "executed", signature: sig(), solAmount: 0.05, tokenAmount: "1" }),
    ).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  test("an execution reported after expiry still counts, as executed rather than expired", async () => {
    const e = engineEnv();
    const f = await follower(e);
    e.engine.onLeaderTrade(leaderTrade(f, { side: "buy", mint: newMint(e) }));
    const s = pendingOf(e, f)[0];
    e.clock.advance(20_000);
    e.engine.sweep();
    expect(stats(e, f)).toMatchObject({ expired: 1, spentSol: 0 });
    await e.engine.report(f.userId, s.id, { status: "executed", signature: sig(), solAmount: 0.05, tokenAmount: "1500000000000" });
    expect(stats(e, f)).toMatchObject({ expired: 0, executed: 1, spentSol: 0.05, buysToday: 1, openPositions: 1 });
  });

  test("fills are confirmed from the feed, and chain amounts replace the reported ones", async () => {
    const e = engineEnv();
    const f = await follower(e, { config: { maxBuysPerToken: 5 } });
    const mint = newMint(e);
    e.engine.onLeaderTrade(leaderTrade(f, { side: "buy", mint }));
    const s = pendingOf(e, f)[0];
    const followerSig = sig("follower");
    await e.engine.report(f.userId, s.id, { status: "executed", signature: followerSig, solAmount: 0.05, tokenAmount: "1500000000000" });
    const follower1 = addr("follower-trading-wallet");
    e.engine.onAnyTrade(
      mkTrade({ side: "buy", mint, trader: follower1, signature: followerSig, amountSol: 0.0495, tokenAmount: "1480000000000" }),
    );
    expect(e.hub.signals(f.topic).at(-1)).toMatchObject({ id: s.id, confirmed: true, filledSol: 0.0495, filledTokens: "1480000000000" });
    expect(stats(e, f)?.spentSol).toBe(0.0495);
    expect(e.engine.positions(f.userId)[0]).toMatchObject({ tokens: "1480000000000", costSol: 0.0495 });

    // Already in the token's recent trades when the report arrives: confirmed at once.
    e.engine.onLeaderTrade(leaderTrade(f, { side: "buy", mint }));
    const s2 = pendingOf(e, f)[0];
    const sig2 = sig("follower2");
    e.recent.set(mint, [mkTrade({ side: "buy", mint, trader: follower1, signature: sig2, amountSol: 0.05, tokenAmount: "1490000000000" })]);
    const r = await e.engine.report(f.userId, s2.id, { status: "executed", signature: sig2, solAmount: 0.06, tokenAmount: "1" });
    expect(r.ok && r.signal).toMatchObject({ confirmed: true, filledSol: 0.05, filledTokens: "1490000000000" });
  });
});

describe("lifecycle and persistence", () => {
  test("pause revokes pending buys and stops new ones; sells keep protecting positions; resume restarts", async () => {
    const e = engineEnv();
    const f = await follower(e, { config: { maxBuysPerToken: 3 } });
    const held = newMint(e);
    await buyAndFill(e, f, held);
    e.engine.onLeaderTrade(leaderTrade(f, { side: "buy", mint: newMint(e) }));
    expect(pendingOf(e, f)).toHaveLength(1);
    const paused = await e.engine.setStatus(f.userId, f.taskId, "paused");
    expect(paused).toMatchObject({ status: "paused", pausedReason: "user" });
    expect(pendingOf(e, f)).toEqual([]);
    expect(e.hub.signals(f.topic).at(-1)).toMatchObject({ status: "revoked", reason: "task_paused" });
    e.engine.onLeaderTrade(leaderTrade(f, { side: "buy", mint: newMint(e) }));
    expect(pendingOf(e, f)).toEqual([]);
    expect(stats(e, f)?.skipped).toBe(0); // paused tasks do not evaluate buys at all
    e.engine.onLeaderTrade(leaderTrade(f, { side: "sell", mint: held, tokens: 30_000_000 }));
    expect(pendingOf(e, f)[0]).toMatchObject({ side: "sell", mint: held });
    expect(await e.engine.setStatus(f.userId, f.taskId, "active")).toMatchObject({ status: "active", pausedReason: null });
    e.engine.onLeaderTrade(leaderTrade(f, { side: "buy", mint: newMint(e) }));
    expect(pendingOf(e, f).filter((s) => s.side === "buy")).toHaveLength(1);
    expect(await e.engine.setStatus((await follower(e)).userId, f.taskId, "paused")).toBeNull(); // not the owner
  });

  test("delete revokes pending signals, removes the task and its leader from the matcher", async () => {
    const e = engineEnv();
    const f = await follower(e);
    expect(e.leaders.at(-1)).toEqual([f.userId, [f.leader]]);
    e.engine.onLeaderTrade(leaderTrade(f, { side: "buy", mint: newMint(e) }));
    const s = pendingOf(e, f)[0];
    expect(await e.engine.deleteTask(f.userId, f.taskId)).toBe(true);
    expect(e.leaders.at(-1)).toEqual([f.userId, []]);
    expect(e.engine.isLeader(f.leader)).toBe(false);
    expect(e.hub.signals(f.topic).find((x) => x.id === s.id && x.status === "revoked")?.reason).toBe("task_deleted");
    expect(e.hub.of(f.topic).at(-1)?.data).toEqual({ removedTasks: [f.taskId] });
    expect(await repo.getTask(f.userId, f.taskId)).toBeNull();
    expect(await e.engine.deleteTask(f.userId, f.taskId)).toBe(false);
  });

  test("a restart restores spend, positions and counters; signals left pending expire", async () => {
    const e = engineEnv();
    const f = await follower(e, { config: { maxBuysPerToken: 3 } });
    const held = newMint(e);
    await buyAndFill(e, f, held, { sol: 0.05, tokens: "1500000000000" });
    e.engine.onLeaderTrade(leaderTrade(f, { side: "buy", mint: newMint(e) })); // left pending
    e.engine.onLeaderTrade(leaderTrade(f, { side: "buy", mint: newMint(e, { dangerous: true }) })); // skipped
    await e.engine.drain();

    const e2 = engineEnv({ clock: e.clock });
    for (const [k, v] of e.tokens) e2.tokens.set(k, v);
    await e2.engine.load();
    expect(e2.engine.isLeader(f.leader)).toBe(true);
    expect(e2.leaders).toContainEqual([f.userId, [f.leader]]);
    expect(e2.engine.getTask(f.userId, f.taskId)?.stats).toMatchObject({
      buySignals: 2,
      executed: 1,
      skipped: 1,
      skippedByReason: { token_danger: 1 },
      spentSol: 0.05,
      spentTodaySol: 0.05,
      buysToday: 1,
      openPositions: 1,
    });
    expect(e2.engine.positions(f.userId)).toEqual([
      expect.objectContaining({ mint: held, tokens: "1500000000000", costSol: 0.05, buys: 1 }),
    ]);
    expect((await repo.listSignals(f.userId, { limit: 10 })).map((s) => s.status).sort()).toEqual(["executed", "expired", "skipped"]);
    // The restored position still mirrors the leader's sells.
    e2.hub.subs.add(f.topic);
    e2.engine.onLeaderTrade(
      leaderTrade(f, { side: "sell", mint: held, tokens: 30_000_000 }, { before: 30_000_000_000_000n, after: 0n, source: "balances" }),
    );
    expect(e2.engine.pendingOf(f.userId)[0]).toMatchObject({ side: "sell", sellTokenAmount: "1500000000000" });
  });

  test("skipped trades always count, and are logged at a bounded rate", async () => {
    const e = engineEnv({ limits: { skipLogPerHour: 2 } });
    const f = await follower(e, { config: { leaderSol: { min: 5 } } });
    for (let i = 0; i < 5; i++) e.engine.onLeaderTrade(leaderTrade(f, { side: "buy", mint: newMint(e) }));
    expect(stats(e, f)).toMatchObject({ skipped: 5, skippedByReason: { leader_size_below_min: 5 } });
    await e.engine.drain();
    expect((await repo.listSignals(f.userId, { limit: 10 })).filter((s) => s.status === "skipped")).toHaveLength(2);
    expect(await repo.purgeSkipped(e.clock.now() + 1)).toBeGreaterThanOrEqual(2); // retention covers every task
    expect(await repo.listSignals(f.userId, { limit: 10 })).toEqual([]);
  });
});
