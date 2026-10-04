import { describe, expect, test } from "bun:test";
import {
  adaptCandle,
  adaptToken,
  adaptTrackedRow,
  adaptTrade,
  columnOf,
  curveStateOf,
  feedHealthOf,
  isFullSummary,
  poolStateOf,
  uiAmount,
} from "./adapters";
import { curveCtx, MINT, TRADER, trackedRow, WALLET, wireOrder, wireToken, wireTrade } from "./fixtures";
import { adaptOrder, impliedPriceSol } from "./orderAdapter";
import { WalletModel } from "./walletModel";

describe("token summary", () => {
  test("maps names, nesting and units; unknown values become NaN, never zero", () => {
    const t = adaptToken(wireToken(), { solUsd: 119.5, column: "new" });
    expect(t).toMatchObject({
      mint: MINT,
      symbol: "SCAT",
      imageUri: "https://ipfs.io/ipfs/Qm1",
      launchpad: "pump",
      quote: "SOL",
      venue: "pump_curve",
      column: "new",
      marketCapSol: 31,
      marketCapUsd: 3_704.5,
      holders: 7,
      bondingProgress: 0.1234,
      socials: { x: "scat_sol" },
      dexPaid: false,
      token2022: null,
      lpBurnedPct: null,
    });
    expect(t.risk).toMatchObject({ top10Pct: 41.2, devPct: 3.1, devSold: false, snipersPct: 4.4, bundlersPct: 0 });
    expect(t.risk.insidersPct).toBeNaN(); // null on the wire: not computed
    expect(t.proTraders).toBeNaN();
    expect(t.feesPaidSol).toBeNaN();
    expect(t.netBuyUsd).toBeNaN();
    expect(t.change5mPct).toBeNaN();
    expect(t.volumeUsd).toBeCloseTo(2.5 * 119.5);
    expect(t.socials).not.toHaveProperty("telegram");
  });

  test("unknown SOL/USD leaves USD values unknown", () => {
    const t = adaptToken(wireToken({ priceUsd: null, mcUsd: null, liquidityUsd: null }), { solUsd: Number.NaN });
    expect(t.priceUsd).toBeNaN();
    expect(t.marketCapUsd).toBeNaN();
    expect(t.volumeUsd).toBeNaN();
  });

  test("venue, launchpad and column", () => {
    expect(adaptToken(wireToken({ migrated: true, migratedAt: 5 }), { solUsd: 1 })).toMatchObject({
      venue: "pumpswap",
      column: "migrated",
      bondingProgress: 1,
    });
    expect(adaptToken(wireToken({ isMayhem: true }), { solUsd: 1 }).launchpad).toBe("mayhem");
    expect(adaptToken(wireToken({ launchpad: "pumpswap" }), { solUsd: 1 }).launchpad).toBe("other");
    expect(columnOf(wireToken({ bondingProgressBps: 6_500 }))).toBe("final");
    expect(columnOf(wireToken({ bondingProgressBps: 5_999 }))).toBe("new");
    expect(adaptToken(wireToken({ quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }), { solUsd: 1 }).quote).toBe("USDC");
  });

  test("full summaries vs patches", () => {
    expect(isFullSummary(wireToken())).toBe(true);
    expect(isFullSummary({ mint: MINT, priceSol: 1 })).toBe(false);
  });
});

describe("trades, candles, venue state", () => {
  test("trade: base units to UI units, USD from the trade's own rate, 'you' for own wallets", () => {
    const t = adaptTrade(wireTrade(), { decimals: 6, solUsd: 200, own: new Set([TRADER]) });
    expect(t).toMatchObject({ id: "sig1:0", ts: 1_700_000_060_000, side: "buy", solAmount: 0.5, maker: TRADER });
    expect(t.tokenAmount).toBe(15_000_000);
    expect(t.priceUsd).toBeCloseTo(0.000000033 * 119.5); // 59.75 / 0.5
    expect(t.marketCapUsd).toBeCloseTo(33 * 119.5);
    expect(t.tags).toEqual(["you", "sniper"]);
    const anon = adaptTrade(wireTrade({ amountUsd: null, tags: [] }), { decimals: 6, solUsd: 100 });
    expect(anon.marketCapUsd).toBeCloseTo(3_300);
    expect(anon.tags).toEqual([]);
  });

  test("candle: ms to s, trade split unknown, missing SOL/USD falls back to the current rate", () => {
    const c = adaptCandle({ t: 1_700_000_040_000, o: 1, h: 2, l: 0.5, c: 1.5, v: 3, n: 4, solUsd: null }, 118);
    expect(c).toMatchObject({ time: 1_700_000_040, open: 1, high: 2, low: 0.5, close: 1.5, volumeSol: 3, solUsd: 118 });
    expect(c.buys).toBeNaN();
  });

  test("curve and pool state for the display quote", () => {
    const curve = curveStateOf(curveCtx(), 125);
    expect(curve).toMatchObject({ virtualQuoteReserves: 31, virtualTokenReserves: 1_000_000_000, realTokenReserves: 720_000_000 });
    expect(curve?.feeBps).toBe(125);
    expect(poolStateOf(curveCtx(), 125)).toBeNull();
    const pool = poolStateOf(
      {
        ...curveCtx(),
        venue: "pumpswap",
        pool: "Poo1111111111111111111111111111111111111111",
        poolIndex: 0,
        poolCreator: "x",
        isCanonical: true,
        lpMint: "x",
        lpSupply: "1",
        poolBaseTokenAccount: "x",
        poolQuoteTokenAccount: "x",
        baseReserve: "200000000000000",
        quoteVaultReserve: "80000000000",
        virtualQuoteReserves: "-5000000000",
        coinCreator: "x",
        coinCreatorVaultAuthority: "x",
        canEditCreatorFee: false,
      },
      30,
    );
    // Effective quote reserves = vault + signed virtual reserves.
    expect(pool).toMatchObject({ quoteReserves: 75, baseReserves: 200_000_000, feeBps: 30 });
  });

  test("uiAmount handles big and negative values exactly enough", () => {
    expect(uiAmount("1000000000000000", 6)).toBe(1_000_000_000);
    expect(uiAmount(-1_500_000_000n, 9)).toBe(-1.5);
    expect(uiAmount("1", 9)).toBe(1e-9);
  });

  test("feed health from /api/health", () => {
    expect(feedHealthOf(null).state).toBe("reconnecting");
    const base = {
      sources: [{ connected: true }],
      ingest: { latency: { p50: 900 }, tradesPerSec1m: 42.5 },
    } as unknown as Parameters<typeof feedHealthOf>[0];
    expect(feedHealthOf(base)).toEqual({ state: "connected", lagMs: 900, eventsPerSec: 42.5 });
    const slow = { ...base, ingest: { latency: { p50: 9_000 }, tradesPerSec1m: 1 } } as typeof base;
    expect(feedHealthOf(slow).state).toBe("degraded");
  });

  test("tracked row: feed item with its token reference", () => {
    const item = adaptTrackedRow(trackedRow(), { decimals: 6, solUsd: 119.5 });
    expect(item.trade).toMatchObject({ maker: TRADER, side: "buy", solAmount: 1.25, tokenAmount: 37_000_000, tags: ["tracked", "pro"] });
    expect(item.token).toMatchObject({ mint: MINT, symbol: "SCAT", marketCapUsd: 4_063 });
    expect(adaptTrackedRow(trackedRow({ kind: "sell" }), { decimals: 6, solUsd: 1 }).trade.side).toBe("sell");
  });
});

describe("armed orders", () => {
  test("a take-profit reads as the price its quote-out threshold implies", () => {
    const o = adaptOrder(wireOrder(), { decimals: 6, symbol: "SCAT", nonceIndex: () => 3 });
    // 0.9 SOL out for 15M tokens = 0.00000006 SOL per token
    expect(o.trigger.metric).toBe("price");
    expect(o.trigger.direction).toBe("above");
    expect(o.trigger.value).toBeCloseTo(0.00000006, 12);
    expect(o).toMatchObject({
      kind: "take_profit",
      side: "sell",
      status: "armed",
      size: { kind: "tokens", tokens: 15_000_000 },
      landing: "secure",
      variants: 6,
      nonceSlots: 1,
      nonceIndex: 3,
      runsWithTabClosed: true,
    });
    expect(o.reservedSol).toBeCloseTo(0.002105);
    expect(o.armedPriceSol).toBeCloseTo(0.00000003, 12);
    expect(o.events[0]?.kind).toBe("armed");
  });

  test("buys, stop-losses, full exits and the remaining kinds", () => {
    const buy = adaptOrder(
      wireOrder({ kind: "limit-buy", side: "buy", amount: "250000000", trigger: { type: "quote-at-least", threshold: "10000000000000" } }),
      { decimals: 6, symbol: "SCAT" },
    );
    expect(buy.size).toEqual({ kind: "sol", sol: 0.25 });
    expect(buy.trigger).toMatchObject({ metric: "price", direction: "below" });
    expect(buy.trigger.value).toBeCloseTo(0.25 / 10_000_000, 15);
    const sl = adaptOrder(wireOrder({ kind: "stop-loss", fullExit: true, trigger: { type: "quote-at-most", threshold: "300000000" } }), {
      decimals: 6,
      symbol: "SCAT",
    });
    expect(sl).toMatchObject({ kind: "stop_loss", size: { kind: "pct", pct: 100 }, trigger: { direction: "below" } });
    expect(adaptOrder(wireOrder({ kind: "migration-snipe", trigger: { type: "migration" } }), { decimals: 6, symbol: "X" })).toMatchObject({
      kind: "migration_buy",
      trigger: { metric: "migration", value: null },
    });
    expect(
      adaptOrder(wireOrder({ kind: "trailing-stop", trigger: { type: "trailing", trailBps: 1_500, activationQuoteOut: null } }), {
        decimals: 6,
        symbol: "X",
      }).trigger,
    ).toEqual({ metric: "trailing", direction: "below", value: 15 });
    const consumed = adaptOrder(wireOrder({ status: "failed-consumed", statusReason: "slippage", open: false }), {
      decimals: 6,
      symbol: "X",
    });
    expect(consumed).toMatchObject({ status: "failed", statusReason: "slippage", reservedSol: 0 });
    expect(consumed.events.map((e) => e.kind)).toEqual(["armed", "failed"]);
    expect(impliedPriceSol({ side: "sell", amount: "0" }, "1", 6)).toBeNull();
  });
});

describe("wallet model", () => {
  const host = {
    token: () => adaptToken(wireToken({ priceSol: 0.00000004 }), { solUsd: 120 }),
    reserved: () => ({ sol: 0.01, nonceUsed: 1, nonceTotal: 10 }),
  };

  test("balances from the chain, cost basis from observed fills", () => {
    const m = new WalletModel(WALLET, host);
    const status = m.applySnapshot({
      lamports: "2500000000",
      tokens: [{ mint: MINT, account: "Ata1", amount: "10000000000000", decimals: 6, tokenProgram: "T" }],
      fills: [
        wireTrade({ id: "s2:0", side: "sell", amountSol: 0.2, tokenAmount: "5000000000000", blockTime: 3, trader: WALLET }),
        wireTrade({ id: "s1:0", side: "buy", amountSol: 0.45, tokenAmount: "15000000000000", blockTime: 2, trader: WALLET }),
      ],
    });
    expect(status.solBalance).toBe(2.5);
    expect(status.reservedSol).toBe(0.01);
    expect(status.nonceSlots).toEqual({ used: 1, total: 10 });
    const p = status.positions[0];
    expect(p?.holdingTokens).toBe(10_000_000);
    expect(p?.avgEntryPriceSol).toBeCloseTo(0.00000003, 12);
    expect(p?.costBasisSol).toBeCloseTo(0.3);
    expect(p?.realizedPnlSol).toBeCloseTo(0.2 - 0.15);
    expect(p?.valueSol).toBeCloseTo(0.4);
    expect(p?.unrealizedPnlSol).toBeCloseTo(0.1);
    expect(p?.feesSol).toBeNaN(); // fees per fill are not in the feed
    expect(status.activity.map((a) => a.kind)).toEqual(["sell", "buy"]);
    expect(m.balanceOf(MINT)?.amount).toBe(10_000_000_000_000n);
  });

  test("a holding whose buys predate the observed fills has an unknown basis", () => {
    const m = new WalletModel(WALLET, host);
    const s = m.applySnapshot({
      lamports: "0",
      tokens: [{ mint: MINT, account: "Ata1", amount: "10000000000000", decimals: 6, tokenProgram: "T" }],
      fills: [],
    });
    expect(s.positions[0]?.costBasisSol).toBeNaN();
    expect(s.positions[0]?.realizedPnlSol).toBeNaN();
    expect(s.positions[0]?.valueSol).toBeCloseTo(0.4);
  });

  test("deltas: new fills become activity and changed positions; closed accounts drop the holding", () => {
    const m = new WalletModel(WALLET, host);
    m.applySnapshot({ lamports: "1000000000", tokens: [], fills: [] });
    const d = m.applyDelta({
      lamports: "500000000",
      tokens: [{ mint: MINT, account: "Ata1", amount: "15000000000000", decimals: 6, tokenProgram: "T" }],
      fills: [wireTrade({ trader: WALLET, amountSol: 0.5 })],
    });
    expect(d.solBalance).toBe(0.5);
    expect(d.activity?.[0]?.kind).toBe("buy");
    expect(d.positions?.[0]?.holdingTokens).toBe(15_000_000);
    const closed = m.applyDelta({ closed: ["Ata1"] });
    expect(closed.positions?.[0]?.closed).toBe(true);
  });
});
