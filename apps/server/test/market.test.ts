/** Derived market state: metrics, progress, late events, forks, dead slots, pool resolution. Offline. */
import { describe, expect, test } from "bun:test";
import { WSOL_MINT } from "@zerofee/core";
import { MarketState } from "../src/market/state";
import { addr, ammSwap, FakeCurve, FakeResolver, grpcIngest, logsIngest, synthTx } from "./helpers";

const CFG = { sniperSlots: 3, bundleMinBuyers: 4, proTraderWallets: [addr("pro-fee-wallet")] };

function market(solUsd: number | null = 120) {
  const resolver = new FakeResolver();
  const m = new MarketState(CFG, { resolver, solUsd: () => solUsd, now: () => 1_791_049_000_000 });
  return { m, resolver };
}

const T0 = 1_791_048_900; // event timestamps (s)

describe("real fixtures through the market state", () => {
  test("create_v2 + dev buy: identity, holders, dev %, progress, price", () => {
    const { m } = market();
    m.applyTx(logsIngest("pump-create-v2"));
    const s = m.summary("F62MDKs1XcNtTFmh6aeCDGhd2Q1u1Jt86mnWTK3Gpump");
    expect(s).toMatchObject({
      name: "SPECTRE",
      symbol: "SPEC",
      launchpad: "pump",
      quoteMint: WSOL_MINT,
      tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
      creator: "5zrQwJugYV1mwdvqEhsRmZ9BFwz16YZs2BnREUysH3yj",
      createdAt: 1_791_048_949_000,
      holders: 1,
      buys: 1,
      sells: 0,
      migrated: false,
    });
    // dev bought 34,271,956.398008 of 1B tokens = 3.4272 %
    expect(s?.devPct).toBeCloseTo(3.4272, 3);
    expect(s?.top10Pct).toBeCloseTo(3.4272, 3);
    // progress = 1 - 758,828,043.601992 / 793,100,000 = 4.32 %
    expect(s?.bondingProgressBps).toBe(432);
    // price = vQ / vT = 30.989824718 SOL / 1,038,728,043.601992 tokens
    expect(s?.priceSol).toBeCloseTo(30.989824718 / 1_038_728_043.601992, 15);
    expect(s?.mcSol).toBeCloseTo((30.989824718 / 1_038_728_043.601992) * 1e9, 6);
    expect(s?.mcUsd).toBeCloseTo((s?.mcSol ?? 0) * 120, 6);
    expect(s?.liquidity).toBeCloseTo(0.989824718, 9);
    expect(s?.snipersPct).toBe(0); // the dev is never a sniper
  });

  test("one transaction buying for two wallets marks both as bundlers", () => {
    const { m } = market();
    // tokens first seen mid-life have untracked holders; seed a tracked record via a synthetic create
    const mint = "G3VSWEnwQzv19DEgQJVDWT4mZVd7M3aJiDPafu2RxWdF";
    const curve = new FakeCurve(mint, addr("dev-g3"));
    m.applyTx(synthTx(453_002_400, [curve.create(T0)]));
    m.applyTx(logsIngest("pump-multi-buyer-tx"));
    const rec = m.tokens.get(mint);
    expect(rec?.holders?.bundlers.has("HL9rRBGSQRaeCqCXtFcraHBkx2mLBHnGEQpNqiPpuk3b")).toBe(true);
    expect(rec?.holders?.bundlers.has("JNpVNLrY5b1wkHBx6grNmHge6Zi8K5uqAbZGFBxLSmv")).toBe(true);
    expect(m.summary(mint)?.bundlersPct).toBeGreaterThan(0);
  });

  test("completion then migration: complete, migrated, canonical pool, pool price", () => {
    const { m, resolver } = market();
    m.applyTx(logsIngest("pump-pair-1")); // completing buy (+ CompleteEvent)
    const mint = "ER4ciu9k4jYYobVPjcyJr7fzLv6kgnX7SfRiG7Vpump";
    expect(m.summary(mint)).toMatchObject({ complete: true, migrated: false, bondingProgressBps: 10_000 });
    m.applyTx(logsIngest("pump-pair-2")); // migrate (CreatePoolEvent + CompletePumpAmmMigrationEvent)
    const s = m.summary(mint);
    expect(s).toMatchObject({
      complete: true,
      migrated: true,
      pool: "Fu13kG96d14jiCwAr8E2MiH8aEMKZeZsWPpKFD2yn7Hb",
      migratedAt: 1_791_049_152_000,
    });
    expect(resolver.pools.get("Fu13kG96d14jiCwAr8E2MiH8aEMKZeZsWPpKFD2yn7Hb")).toMatchObject({ baseMint: mint, isCanonical: true });
    // pool price = 84.99035953 SOL / 206,900,000 tokens
    expect(s?.priceSol).toBeCloseTo(84.99035953 / 206_900_000, 15);
  });

  test("PumpSwap trades wait for their pool, then price off effective reserves (vault + virtual)", () => {
    const { m, resolver } = market();
    const tx = logsIngest("amm-buy");
    m.applyTx(tx);
    expect(m.pendingPoolEvents).toBe(1);
    expect(resolver.requested.pools).toEqual(["37DYHS64kSovQoz1Zb3jq7gFKPQdUvC7gt2cWsa3EB4y"]);
    const info = resolver.learnPool({
      pool: "37DYHS64kSovQoz1Zb3jq7gFKPQdUvC7gt2cWsa3EB4y",
      baseMint: "kHdpWPAq9K9JMJUo4Hd4eNcG82FzqFaXY3HvkJZpump",
      quoteMint: WSOL_MINT,
      baseDecimals: 6,
      quoteDecimals: 9,
      isCanonical: true,
      fromAccount: true,
    });
    m.onPoolReady(info);
    expect(m.pendingPoolEvents).toBe(0);
    const s = m.summary("kHdpWPAq9K9JMJUo4Hd4eNcG82FzqFaXY3HvkJZpump");
    // post-trade: base 190,934,031,912,003 - 151,678,413,440; quote vault 75,055,361,366 + 73,799,127; virtual 17,584,505,512
    const base = 190_934_031_912_003 - 151_678_413_440;
    const effQ = 75_055_361_366 + 73_799_127 + 17_584_505_512;
    expect(s?.priceSol).toBeCloseTo(effQ / 1e9 / (base / 1e6), 15);
    expect(s).toMatchObject({ launchpad: "pump", migrated: true, holders: null });
    expect(s?.supply).toBeCloseTo(984_455_400.319645, 6); // from the event's base_supply
  });

  test("gRPC-shaped input learns the pool from instruction accounts (no RPC lookup)", () => {
    const { m, resolver } = market();
    const tx = grpcIngest("amm-sell");
    m.applyTx(tx);
    expect(resolver.pools.get("5VbavvxS1NLmyNJLS3QbDoRFsUHKn6rBzmfVQdWWSniq")?.baseMint).toBe(
      "9dSMwFfPezQ8WPcW1uZV7ns4rcviEj2LssSAg75WBLXd",
    );
  });

  test("non-SOL quote curve: quote amounts from the trailing fields, SOL value unknown, quote mint looked up once", () => {
    const { m, resolver } = market();
    m.applyTx(logsIngest("pump-non-sol-trade"));
    const mint = "ArenDYANqFNkp8ZqAXt69vT5Dz7WD4zDfSpVw6oPpump";
    const quote = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
    const s = m.summary(mint);
    expect(s?.quoteMint).toBe(quote);
    // the quote's decimals are unknown until its mint is read; its SOL value stays unknown (null, never 0)
    expect(s).toMatchObject({ priceQuote: null, mcQuote: null, priceSol: null, mcSol: null, liquidity: null, volume5m: null });
    expect(m.recentTrades(mint)[0]).toMatchObject({ amountSol: null, priceSol: null, mcSol: null, amountUsd: null });
    expect(resolver.requested.mints.filter((x) => x === quote)).toHaveLength(1);
    // the resolver answers: decimals and token program flow into the record (and its trade context)
    m.onMintResolved({
      mint: quote,
      tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      decimals: 6,
      supply: 0n,
      metadata: null,
      dangers: [],
    });
    expect(m.tokens.get(mint)).toMatchObject({ quoteDecimals: 6, quoteTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" });
    // now the quote-unit price is known (post-trade 4,503.010774 / 437,311,287.149733 tokens); the SOL value is not
    const after = m.summary(mint);
    expect(after?.priceQuote).toBeCloseTo(4_503.010774 / 437_311_287.149733, 15);
    expect(after?.mcQuote).toBeCloseTo((4_503.010774 / 437_311_287.149733) * 1e9, 6);
    expect(after).toMatchObject({ priceSol: null, mcSol: null, priceUsd: null, mcUsd: null, athMcSol: null });
  });

  test("detection latency samples = receive time - block time", () => {
    const { m } = market();
    m.applyTx(logsIngest("pump-buy", 1_791_048_946_000 + 1_234));
    expect(m.latency.percentiles([50])[0]).toBe(1_234);
  });
});

describe("audit metrics (synthetic)", () => {
  function scenario() {
    const { m } = market();
    const mint = addr("mint-1");
    const dev = addr("dev");
    const c = new FakeCurve(mint, dev);
    const S = 1_000; // creation slot
    m.applyTx(synthTx(S, [c.create(T0), c.buy(dev, 2_000_000_000n, T0)])); // dev buys in the create tx
    m.applyTx(synthTx(S, [c.buy(addr("A"), 500_000_000n, T0)])); // creation-slot co-buyer
    m.applyTx(synthTx(S + 2, [c.buy(addr("B"), 500_000_000n, T0 + 1)])); // sniper (2 slots)
    m.applyTx(synthTx(S + 4, [c.buy(addr("C"), 500_000_000n, T0 + 2)])); // 4 slots: not a sniper
    for (const w of ["E", "F", "G", "H"]) m.applyTx(synthTx(S + 10, [c.buy(addr(w), 100_000_000n, T0 + 4)])); // 4 buyers, one slot
    m.applyTx(synthTx(S + 20, [c.buy(addr("I"), 100_000_000n, T0 + 9), c.buy(addr("J"), 100_000_000n, T0 + 9)])); // one tx, two wallets
    m.applyTx(synthTx(S + 30, [c.buy(addr("K"), 50_000_000n, T0 + 12)])); // ordinary
    return { m, mint, dev, c, S };
  }

  test("snipers: non-dev first buys within 3 slots of creation", () => {
    const { m, mint } = scenario();
    const h = m.tokens.get(mint)?.holders;
    expect([...(h?.snipers ?? [])].sort()).toEqual([addr("A"), addr("B")].sort());
  });

  test("bundlers: creation-slot co-buyers, 4+ buyers in one slot, multi-wallet txs; never the dev", () => {
    const { m, mint, dev } = scenario();
    const h = m.tokens.get(mint)?.holders;
    expect([...(h?.bundlers ?? [])].sort()).toEqual(["A", "E", "F", "G", "H", "I", "J"].map(addr).sort());
    expect(h?.bundlers.has(dev)).toBe(false);
    expect(h?.devWallets.has(dev)).toBe(true);
  });

  test("percentages and holder count follow balances; sells reduce them; top 10 excludes the curve", () => {
    const { m, mint, c, S } = scenario();
    const before = m.summary(mint);
    expect(before?.holders).toBe(11); // dev + A,B,C,E,F,G,H,I,J,K
    const bBalance = m.tokens.get(mint)?.holders?.balanceOf(addr("B")) ?? 0n;
    m.applyTx(synthTx(S + 40, [c.sell(addr("B"), bBalance, T0 + 20)]));
    const after = m.summary(mint);
    expect(after?.holders).toBe(10);
    expect(after?.snipersPct ?? 0).toBeLessThan(before?.snipersPct ?? 0);
    m.tokens.get(mint)?.holders?.applyDelta(c.bondingCurve, 500_000_000_000_000n); // even if the curve showed up as a holder
    expect(m.summary(mint)?.top10Pct).toBeCloseTo(after?.top10Pct ?? 0, 9);
  });

  test("pro traders: traders in txs that include a known terminal fee wallet (needs account keys)", () => {
    const { m } = market();
    const mint = addr("mint-pro");
    const c = new FakeCurve(mint, addr("dev-pro"));
    const keys = [addr("payer"), addr("pro-fee-wallet")];
    m.applyTx(synthTx(5, [c.create(T0)], { accountKeys: keys }));
    m.applyTx(synthTx(6, [c.buy(addr("trader"), 1_000_000n, T0)], { accountKeys: keys }));
    m.applyTx(synthTx(7, [c.buy(addr("other"), 1_000_000n, T0)], { accountKeys: [addr("x")] }));
    expect(m.summary(mint)?.proTraders).toBe(1);
    // the logs source has no keys: the metric is unknown, not zero
    const { m: m2 } = market();
    m2.applyTx(synthTx(5, [new FakeCurve(addr("mint-y"), addr("d")).create(T0)]));
    expect(m2.summary(addr("mint-y"))?.proTraders).toBeNull();
  });
});

describe("ordering, late events, forks and dead slots", () => {
  test("a late trade updates volume and candles (as a correction) but not the latest reserves", () => {
    const { m } = market();
    const mint = addr("late");
    const c = new FakeCurve(mint, addr("dev-late"));
    m.applyTx(synthTx(100, [c.create(T0)]));
    const early = c.buy(addr("u1"), 1_000_000_000n, T0 + 1); // executed first...
    const later = c.buy(addr("u2"), 1_000_000_000n, T0 + 2);
    m.applyTx(synthTx(102, [later])); // ...but arrives second
    const priceAfterLater = m.priceQuote(mint);
    m.changes.tradeCorrections.clear();
    m.applyTx(synthTx(101, [early]));
    expect(m.priceQuote(mint)).toBe(priceAfterLater);
    expect(m.changes.tradeCorrections.get(mint)?.upsert).toHaveLength(1);
    expect(m.summary(mint)?.buys).toBe(2);
    expect(m.recentTrades(mint).map((t) => t.slot)).toEqual([102, 101]); // newest first, by chain order
  });

  test("dead slot: trades rolled back (holders, volume, reserves) with corrections", () => {
    const { m } = market();
    const mint = addr("dead");
    const c = new FakeCurve(mint, addr("dev-dead"));
    m.applyTx(synthTx(200, [c.create(T0)]));
    m.applyTx(synthTx(201, [c.buy(addr("keep"), 1_000_000_000n, T0 + 1)]));
    const priceAfterKeep = m.priceQuote(mint);
    m.applyTx(synthTx(202, [c.buy(addr("gone"), 3_000_000_000n, T0 + 2)]));
    expect(m.summary(mint)?.holders).toBe(2);
    m.dropSlot(202);
    const s = m.summary(mint);
    expect(s?.holders).toBe(1);
    expect(s?.buys).toBe(1);
    expect(m.priceQuote(mint)).toBe(priceAfterKeep);
    expect(m.changes.tradeCorrections.get(mint)?.remove).toHaveLength(1);
    expect(m.stats.rolledBackTrades).toBe(1);
  });

  test("a create in a dead slot removes the token", () => {
    const { m } = market();
    const mint = addr("ghost");
    const c = new FakeCurve(mint, addr("dev-ghost"));
    m.applyTx(synthTx(300, [c.create(T0), c.buy(addr("dev-ghost"), 1_000n, T0)]));
    m.dropSlot(300);
    expect(m.tokens.has(mint)).toBe(false);
  });

  test("the same signature in another slot is parked until the first slot dies", () => {
    const { m } = market();
    const mint = addr("fork");
    const c = new FakeCurve(mint, addr("dev-fork"));
    m.applyTx(synthTx(400, [c.create(T0)]));
    const buy = c.buy(addr("forked"), 1_000_000_000n, T0 + 1);
    const a = synthTx(401, [buy], { signature: "forksig" });
    const b = synthTx(402, [buy], { signature: "forksig" });
    m.applyTx(a);
    m.applyTx(b);
    expect(m.stats.forkParked).toBe(1);
    expect(m.recentTrades(mint).map((t) => t.slot)).toEqual([401]);
    m.dropSlot(401);
    expect(m.recentTrades(mint).map((t) => t.slot)).toEqual([402]);
    // an exact duplicate (same slot) is just dropped
    m.applyTx(synthTx(402, [buy], { signature: "forksig" }));
    expect(m.stats.duplicates).toBe(1);
  });

  test("pool events parked for an unresolved pool are replayed in order", () => {
    const { m, resolver } = market();
    const pool = addr("pool-x");
    const mint = addr("mint-x");
    m.applyTx(
      synthTx(500, [ammSwap({ pool, kind: "ammBuy", poolBaseReserves: 100_000_000_000_000n, poolQuoteReserves: 50_000_000_000n })]),
    );
    m.applyTx(
      synthTx(501, [
        ammSwap({
          pool,
          kind: "ammSell",
          poolBaseReserves: 99_999_000_000_000n,
          poolQuoteReserves: 50_000_400_800n,
          quoteAmountVault: 1_000n,
        }),
      ]),
    );
    expect(m.pendingPoolEvents).toBe(2);
    m.onPoolReady(
      resolver.learnPool({ pool, baseMint: mint, quoteMint: WSOL_MINT, baseDecimals: 6, quoteDecimals: 9, isCanonical: false }),
    );
    const s = m.summary(mint);
    expect(s).toMatchObject({ launchpad: "pumpswap", buys: 1, sells: 1, migrated: false });
    expect(m.recentTrades(mint).map((t) => t.side)).toEqual(["sell", "buy"]);
  });
});
