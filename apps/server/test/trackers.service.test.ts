/**
 * The firehose matcher end to end inside the server process: synthetic pump / PumpSwap transactions go
 * through the real MarketState, whose onTrade hook feeds the TrackerService. Checks delivery to the
 * owning users only (labels, emoji-free tags, MC at trade), chart-marker topics, first-buy detection
 * from every balance source, the alert hook (including the real AlertEngine's first-buy-only rule),
 * launches by tracked devs, fee-payer matches, dead-slot corrections, index refresh on CRUD, parked
 * PumpSwap events, and the hand-off of a leader's own trades to the copy engine.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { WSOL_MINT } from "@zerofee/core";
import { DEFAULT_COPY_CONFIG, type TrackedWalletAlerts } from "@zerofee/protocol";
import { AlertEngine, type WalletActivity } from "../src/alerts/engine";
import type { Notification } from "../src/alerts/types";
import { UserStore } from "../src/db/pg";
import type { IngestTx } from "../src/ingest/types";
import { setLogLevel } from "../src/log";
import { MarketState } from "../src/market/state";
import { TrackerService } from "../src/trackers/service";
import { addr, ammSwap, FakeCurve, FakeResolver, synthTx } from "./helpers";
import { pgliteDb, type TestDb } from "./pgHelpers";
import { FakeHub, trackerConfig } from "./trackerHelpers";

setLogLevel("error");
let t: TestDb;
let store: UserStore;

beforeAll(async () => {
  t = await pgliteDb();
  store = new UserStore(t.db);
}, 60_000);
afterAll(async () => {
  await t.close();
});

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const TS = Math.floor(NOW / 1000);
let n = 0;
const NO_ALERTS: TrackedWalletAlerts = { buy: false, sell: false, create: false, minSol: 0 };

interface Env {
  svc: TrackerService;
  hub: FakeHub;
  market: MarketState;
  resolver: FakeResolver;
  activity: WalletActivity[];
}

function env(alerts?: { onWalletActivity(ev: WalletActivity): void }): Env {
  const hub = new FakeHub();
  const activity: WalletActivity[] = [];
  const svc = new TrackerService({
    cfg: trackerConfig(),
    db: t.db,
    store,
    alerts: alerts ?? { onWalletActivity: (ev) => activity.push(ev) },
    now: () => NOW,
  });
  svc.attachHub(hub);
  const resolver = new FakeResolver();
  const market = new MarketState(
    { sniperSlots: 3, bundleMinBuyers: 4, proTraderWallets: [] },
    { resolver, solUsd: () => 150, now: () => NOW, onTrade: (tr, tx) => svc.onTrade(tr, tx) },
  );
  svc.attachMarket(market, () => 150);
  return { svc, hub, market, resolver, activity };
}

async function user(tag: string): Promise<string> {
  return (await store.users.upsertOnLogin(addr(`svc-${tag}-${++n}`), NOW)).id;
}

async function track(e: Env, userId: string, address: string, label = "", emoji = "", tags: string[] = [], alerts = NO_ALERTS) {
  await store.tracked.upsertMany(userId, [{ address, label, emoji, tags, alerts }], { now: NOW, max: 10_000, overwriteAlerts: true });
  await e.svc.reloadTracked(userId);
}

/** Applies a transaction the way the app's ingest sink does. */
function ingest(e: Env, tx: IngestTx): void {
  e.market.applyTx(tx);
  e.svc.onTx(tx);
}

function launch(e: Env, dev: string, slot = 100): FakeCurve {
  const curve = new FakeCurve(addr(`svc-mint-${++n}`), dev);
  ingest(e, synthTx(slot, [curve.create(TS - 30, { symbol: "WHL", name: "Whale Coin" })]));
  return curve;
}

describe("delivery", () => {
  test("a tracked wallet's trade reaches only the users who track it, labelled their way", async () => {
    const e = env();
    const [alice, bob, carol] = [await user("alice"), await user("bob"), await user("carol")];
    const whale = addr(`whale-${n}`);
    await track(e, alice, whale, "🐳 Whale", "🐳", ["kol"]);
    await track(e, bob, whale, "big");
    for (const u of [alice, bob, carol]) e.hub.subs.add(`tracked@${u}`);
    const curve = launch(e, addr(`dev-${n}`));
    e.hub.subs.add(`tracked:${curve.mint}@${alice}`);
    const tx = synthTx(101, [curve.buy(whale, 500_000_000n, TS)]);
    ingest(e, tx);
    ingest(e, synthTx(101, [curve.buy(addr("stranger"), 100_000_000n, TS)]));
    e.svc.feed.flush();
    const [row] = e.hub.rows(`tracked@${alice}`);
    const trade = e.market.recentTrades(curve.mint).find((x) => x.signature === tx.signature);
    expect(row).toMatchObject({
      id: `${tx.signature}:0:${whale}`,
      kind: "buy",
      wallet: whale,
      role: "trader",
      label: "🐳 Whale",
      emoji: "🐳",
      tag: "Whale",
      walletTags: ["kol"],
      trader: whale,
      mint: curve.mint,
      symbol: "WHL",
      name: "Whale Coin",
      launchpad: "pump",
      venue: "pump",
      amountSol: 0.5,
      amountUsd: 75,
      tokenAmount: trade?.tokenAmount,
      signature: tx.signature,
      slot: 101,
      blockTime: TS * 1000,
      firstBuy: true,
    });
    expect(row.mcSol).toBeCloseTo(trade?.mcSol as number, 9);
    expect(row.mcUsd).toBeCloseTo((trade?.mcSol as number) * 150, 6);
    expect(e.hub.rows(`tracked@${bob}`).map((r) => [r.label, r.tag])).toEqual([["big", "big"]]);
    expect(e.hub.rows(`tracked@${carol}`)).toEqual([]);
    expect(e.hub.rows(`tracked:${curve.mint}@${alice}`).map((r) => r.id)).toEqual([row.id]);
    expect(e.hub.of(`tracked@${alice}`)[0]?.wire).toBe("tracked");
    expect(e.hub.of(`tracked:${curve.mint}@${alice}`)[0]?.wire).toBe(`tracked:${curve.mint}`);
  });

  test("rows are batched per flush, and nothing is built for users without a socket", async () => {
    const e = env();
    const [alice, bob] = [await user("alice"), await user("bob")];
    const whale = addr(`whale-${n}`);
    await track(e, alice, whale, "w");
    await track(e, bob, whale, "w");
    e.hub.subs.add(`tracked@${alice}`);
    const curve = launch(e, addr(`dev-${n}`));
    for (let i = 0; i < 3; i++) ingest(e, synthTx(110 + i, [curve.buy(whale, 10_000_000n, TS)]));
    expect(e.hub.msgs).toEqual([]);
    e.svc.feed.flush();
    expect(e.hub.of(`tracked@${alice}`)).toHaveLength(1);
    expect(e.hub.rows(`tracked@${alice}`).map((r) => r.slot)).toEqual([110, 111, 112]); // oldest first
    expect(e.svc.feed.stats.rows).toBe(3); // bob is offline: no rows were built for him
  });

  test("snapshots: newest first, the user's wallets only, current labels; untracked wallets drop out", async () => {
    const e = env();
    const [alice, bob] = [await user("alice"), await user("bob")];
    const [w1, w2] = [addr(`w1-${n}`), addr(`w2-${n}`)];
    await track(e, alice, w1, "one");
    await track(e, bob, w2, "two");
    const curve = launch(e, addr(`dev-${n}`));
    ingest(e, synthTx(120, [curve.buy(w1, 10_000_000n, TS)]));
    ingest(e, synthTx(121, [curve.buy(w2, 10_000_000n, TS)]));
    ingest(e, synthTx(122, [curve.sell(w1, 1_000_000n, TS)]));
    expect(e.svc.feed.snapshot(alice, null, 100).map((r) => [r.kind, r.slot, r.label])).toEqual([
      ["sell", 122, "one"],
      ["buy", 120, "one"],
    ]);
    expect(e.svc.feed.snapshot(alice, curve.mint, 1)).toHaveLength(1);
    await store.tracked.update(alice, w1, { label: "renamed" }, NOW);
    await e.svc.reloadTracked(alice);
    expect(e.svc.feed.snapshot(alice, null, 100)[0]?.label).toBe("renamed");
    await store.tracked.remove(alice, w1);
    await e.svc.reloadTracked(alice);
    expect(e.svc.feed.snapshot(alice, null, 100)).toEqual([]);
    expect(e.svc.feed.snapshot(bob, null, 100).map((r) => r.wallet)).toEqual([w2]);
  });

  test("a dead slot drops its matches and sends corrections to the owners", async () => {
    const e = env();
    const alice = await user("alice");
    const whale = addr(`whale-${n}`);
    await track(e, alice, whale, "w");
    const curve = launch(e, addr(`dev-${n}`));
    e.hub.subs.add(`tracked@${alice}`);
    e.hub.subs.add(`tracked:${curve.mint}@${alice}`);
    const keep = synthTx(130, [curve.buy(whale, 10_000_000n, TS)]);
    const gone = synthTx(131, [curve.buy(whale, 10_000_000n, TS)]);
    ingest(e, keep);
    ingest(e, gone);
    e.svc.onDeadSlot(131);
    e.market.dropSlot(131);
    const corr = e.hub.msgs.filter((m) => m.type === "correction");
    expect(corr.map((m) => [m.topic, m.reason, m.data.remove])).toEqual([
      [`tracked@${alice}`, "dead_slot", [`${gone.signature}:0:${whale}`]],
      [`tracked:${curve.mint}@${alice}`, "dead_slot", [`${gone.signature}:0:${whale}`]],
    ]);
    // The rows went out before the correction, and the snapshot no longer has the dead one.
    expect(e.hub.msgs.findIndex((m) => m.type === "delta")).toBeLessThan(e.hub.msgs.findIndex((m) => m.type === "correction"));
    expect(e.svc.feed.snapshot(alice, null, 100).map((r) => r.signature)).toEqual([keep.signature]);
  });

  test("the fee payer of someone else's trade matches as feePayer (gRPC signers)", async () => {
    const e = env();
    const alice = await user("alice");
    const payer = addr(`payer-${n}`);
    const other = addr(`other-${n}`);
    await track(e, alice, payer, "funder");
    e.hub.subs.add(`tracked@${alice}`);
    const curve = launch(e, addr(`dev-${n}`));
    ingest(e, synthTx(140, [curve.buy(other, 10_000_000n, TS)], { signers: [payer, other] }));
    e.svc.feed.flush();
    expect(e.hub.rows(`tracked@${alice}`)).toEqual([
      expect.objectContaining({ wallet: payer, role: "feePayer", trader: other, label: "funder" }),
    ]);
    expect(e.activity.map((a) => a.address)).toEqual([payer]);
  });

  test("PumpSwap trades that waited for their pool still match", async () => {
    const e = env();
    const alice = await user("alice");
    const whale = addr(`whale-${n}`);
    await track(e, alice, whale, "w");
    const pool = addr(`pool-${n}`);
    const mint = addr(`pool-mint-${n}`);
    ingest(
      e,
      synthTx(150, [
        ammSwap({ pool, kind: "ammBuy", user: whale as never, poolBaseReserves: 100_000_000_000_000n, poolQuoteReserves: 50_000_000_000n }),
      ]),
    );
    expect(e.svc.stats.matchedTrades).toBe(0);
    e.market.onPoolReady(
      e.resolver.learnPool({ pool, baseMint: mint, quoteMint: WSOL_MINT, baseDecimals: 6, quoteDecimals: 9, isCanonical: false }),
    );
    expect(e.svc.stats.matchedTrades).toBe(1);
    expect(e.svc.feed.snapshot(alice, null, 10)[0]).toMatchObject({ venue: "pumpswap", launchpad: "pumpswap", mint, kind: "buy" });
  });
});

describe("first buy and the alert hook", () => {
  test("first buy: exact from the holder book; adds are not first buys; sells carry null", async () => {
    const e = env();
    const alice = await user("alice");
    const whale = addr(`whale-${n}`);
    await track(e, alice, whale, "w");
    const curve = launch(e, addr(`dev-${n}`));
    ingest(e, synthTx(160, [curve.buy(whale, 10_000_000n, TS)]));
    ingest(e, synthTx(161, [curve.buy(whale, 10_000_000n, TS)]));
    const held = e.market.tokens.get(curve.mint)?.holders?.balanceOf(whale) ?? 0n;
    expect(held).toBeGreaterThan(0n);
    ingest(e, synthTx(162, [curve.sell(whale, held, TS)])); // sells everything
    ingest(e, synthTx(163, [curve.buy(whale, 10_000_000n, TS)])); // re-entry after a full exit
    expect(e.svc.feed.snapshot(alice, null, 10).map((r) => [r.kind, r.firstBuy])).toEqual([
      ["buy", true],
      ["sell", null],
      ["buy", false],
      ["buy", true],
    ]);
  });

  test("first buy without a holder book: post-tx balances when the source has them, else the tracked trades", async () => {
    const e = env();
    const alice = await user("alice");
    const [w1, w2] = [addr(`w1-${n}`), addr(`w2-${n}`)];
    await track(e, alice, w1, "one");
    await track(e, alice, w2, "two");
    const pool = addr(`pool-${n}`);
    const mint = addr(`pool-mint-${n}`);
    e.market.onPoolReady(
      e.resolver.learnPool({ pool, baseMint: mint, quoteMint: WSOL_MINT, baseDecimals: 6, quoteDecimals: 9, isCanonical: false }),
    );
    const swap = (user: string, kind: "ammBuy" | "ammSell", baseAmount: bigint) =>
      ammSwap({ pool, kind, user: user as never, baseAmount, poolBaseReserves: 100_000_000_000_000n, poolQuoteReserves: 50_000_000_000n });
    // w1 already held 5 tokens (gRPC post balance = 5 + 1): not a first buy.
    ingest(e, synthTx(170, [swap(w1, "ammBuy", 1_000_000n)], { tokenBalances: [{ mint, owner: w1, amount: 6_000_000n }] }));
    // w2: no balances, no history: its first buy since we watch it, then an add.
    ingest(e, synthTx(171, [swap(w2, "ammBuy", 1_000_000n)]));
    ingest(e, synthTx(172, [swap(w2, "ammBuy", 1_000_000n)]));
    expect(e.market.tokens.get(mint)?.holders).toBeNull();
    expect(
      e.svc.feed
        .snapshot(alice, null, 10)
        .reverse()
        .map((r) => [r.label, r.firstBuy]),
    ).toEqual([
      ["one", false],
      ["two", true],
      ["two", false],
    ]);
  });

  test("the alert hook sees every match with its first-buy flag, and launches by tracked devs", async () => {
    const e = env();
    const bob = await user("bob");
    const dev = addr(`dev-${n}`);
    const whale = addr(`whale-${n}`);
    await track(e, bob, dev, "dev");
    await track(e, bob, whale, "whale");
    const curve = launch(e, dev, 180);
    ingest(e, synthTx(181, [curve.buy(whale, 2_000_000_000n, TS)]));
    ingest(e, synthTx(182, [curve.buy(whale, 1_000_000_000n, TS)]));
    expect(e.activity.map((a) => [a.kind, a.address === dev ? "dev" : "whale", a.amountSol, a.firstBuy ?? null, a.symbol])).toEqual([
      ["create", "dev", 0, null, "WHL"],
      ["buy", "whale", 2, true, "WHL"],
      ["buy", "whale", 1, false, "WHL"],
    ]);
    e.hub.subs.add(`tracked@${bob}`);
    expect(e.svc.feed.snapshot(bob, null, 10).at(-1)).toMatchObject({
      kind: "create",
      wallet: dev,
      amountSol: 0,
      marketTags: ["dev"],
      tag: "dev",
    });
  });

  test("with the real AlertEngine: buy alerts limited to first buys fire once per position", async () => {
    const out: Notification[] = [];
    const engine = new AlertEngine({ store, notify: (x) => out.push(x), appUrl: "https://zerofee.test", now: () => NOW });
    const e = env(engine);
    const alice = await user("alice");
    engine.setPrefs(alice, { walletChannels: ["push"], orderChannels: [], digestSeconds: 60 });
    const whale = addr(`whale-${n}`);
    await track(e, alice, whale, "Whale", "🐳", [], { buy: true, sell: false, create: false, minSol: 0, firstBuyOnly: true });
    await engine.reloadTracked(alice);
    const curve = launch(e, addr(`dev-${n}`));
    ingest(e, synthTx(190, [curve.buy(whale, 1_000_000_000n, TS)]));
    ingest(e, synthTx(191, [curve.buy(whale, 1_000_000_000n, TS)]));
    await Bun.sleep(20);
    expect(out.map((x) => x.title)).toEqual(["🐳 Whale bought 1.00 SOL of WHL (first buy)"]);
  });
});

describe("index refresh and copy hand-off", () => {
  test("tracked-wallet CRUD refreshes the index; overlapping reloads settle on the stored list", async () => {
    const e = env();
    const alice = await user("alice");
    const ws = Array.from({ length: 5 }, (_, i) => addr(`crud-${n}-${i}`));
    await store.tracked.upsertMany(
      alice,
      ws.map((address) => ({ address, label: "", emoji: "", tags: [], alerts: NO_ALERTS })),
      { now: NOW, max: 100 },
    );
    const r1 = e.svc.reloadTracked(alice);
    await store.tracked.remove(alice, ws[0] as string);
    const r2 = e.svc.reloadTracked(alice);
    await Promise.all([r1, r2]);
    expect(e.svc.index.trackedOf(alice)).toBe(4);
    expect(e.svc.index.tracks(alice, ws[0] as string)).toBe(false);
    // A full load (start-up) sees the same.
    const fresh = env();
    await fresh.svc.load();
    expect(fresh.svc.index.trackedOf(alice)).toBe(4);
  });

  test("a leader's own trades go to the copy engine; paying fees for someone else does not", async () => {
    const e = env();
    const alice = await user("alice");
    const leader = addr(`leader-${n}`);
    e.hub.subs.add(`copy@${alice}`);
    await e.svc.copy.createTask(alice, {
      leader,
      label: "",
      status: "active",
      config: { ...DEFAULT_COPY_CONFIG, ageSec: { min: null, max: null } },
    });
    expect(e.svc.index.get(leader)?.[0]).toMatchObject({ leader: true, tracked: null });
    const curve = launch(e, addr(`dev-${n}`));
    ingest(e, synthTx(200, [curve.buy(addr("someone"), 100_000_000n, TS)], { signers: [leader] }));
    expect(e.svc.copy.pendingOf(alice)).toEqual([]);
    ingest(e, synthTx(201, [curve.buy(leader, 500_000_000n, TS)]));
    const [s] = e.svc.copy.pendingOf(alice);
    expect(s).toMatchObject({ side: "buy", mint: curve.mint, leader, sizeSol: 0.05, symbol: "WHL", venue: "pump" });
    // Not on the tracker: the copy topic gets the signal, the tracked feed nothing.
    expect(e.svc.feed.snapshot(alice, null, 10)).toEqual([]);
  });
});
