import { describe, expect, test } from "bun:test";
import { address } from "@solana/kit";
import {
  applyBuy,
  applySell,
  applySlippageDown,
  applySlippageUp,
  bondingProgressBps,
  CurveCompleteError,
  type CurveFeeRates,
  type CurveState,
  curveFeeRates,
  curveMarketCap,
  DEFAULT_PUBKEY,
  decodeBondingCurve,
  decodeFeeConfig,
  decodePumpGlobal,
  type FeeConfig,
  ONE_BILLION_SUPPLY,
  PUMP_FEE_CONFIG,
  PUMP_GLOBAL,
  quoteBuyExactQuoteIn,
  quoteBuyExactTokens,
  quoteSell,
  tokensForSellProceeds,
  USDC_MINT,
} from "../src";
import { fixture } from "./fixtures";

const CREATOR = address("AbEYodS3C8txo7vKdvnvnF7r9sFDi1Ush5tG8jytc4cZ");
const RATES: CurveFeeRates = { protocolFeeBps: 95n, creatorFeeBps: 30n, buybackBps: 5000n };

function curve(vQ: bigint, vT: bigint, extra: Partial<CurveState> = {}): CurveState {
  return {
    virtualQuoteReserves: vQ,
    virtualTokenReserves: vT,
    realTokenReserves: vT - 279_900_000_000_000n,
    realQuoteReserves: vQ - 30_000_000_000n,
    complete: false,
    creator: CREATOR,
    isMayhemMode: false,
    quoteMint: DEFAULT_PUBKEY,
    creatorFeeBps: 0n,
    ...extra,
  };
}

describe("mainnet replays (exact to the lamport, notes §2)", () => {
  test("legacy buy, exact tokens out - tx 2vVpDi4t…", () => {
    // Pre-state = event post-state minus the trade deltas.
    const c = curve(63_480_075_581n - 135_019_257n, 507_088_243_642_693n + 1_080_852_743_066n);
    const q = quoteBuyExactTokens(c, 1_080_852_743_066n, RATES);
    expect(q.quoteNet).toBe(135_019_257n);
    expect(q.protocolFee).toBe(1_282_683n);
    expect(q.creatorFee).toBe(405_058n);
    expect(q.buybackFee).toBe(641_341n);
    const post = applyBuy(c, q);
    expect(post.virtualQuoteReserves).toBe(63_480_075_581n);
    expect(post.virtualTokenReserves).toBe(507_088_243_642_693n);
  });

  test("legacy sell - tx 2K5JEfHo…", () => {
    const c = curve(46_064_870_573n + 16_730_000n, 698_797_148_012_451n - 253_699_441_994n);
    const q = quoteSell(c, 253_699_441_994n, RATES);
    expect(q.quoteGross).toBe(16_730_000n);
    expect(q.protocolFee).toBe(158_935n);
    expect(q.creatorFee).toBe(50_190n);
    expect(q.buybackFee).toBe(79_467n);
    expect(q.quoteNet).toBe(16_730_000n - 158_935n - 50_190n);
    const post = applySell(c, q);
    expect(post.virtualQuoteReserves).toBe(46_064_870_573n);
    expect(post.virtualTokenReserves).toBe(698_797_148_012_451n);
  });

  test("buy_exact_sol_in 0.1 SOL - consecutive txs 2nbzqZM2… then FpgAR3QK…", () => {
    // 2nbzqZM2 ran first; its post-state is FpgAR3QK's pre-state.
    const pre1 = curve(47_467_874_146n - 98_765_431n, 678_142_865_320_340n + 1_413_939_875_832n);
    const q1 = quoteBuyExactQuoteIn(pre1, 100_000_000n, RATES);
    expect(q1.quoteNet).toBe(98_765_431n);
    expect(q1.tokenAmount).toBe(1_413_939_875_832n);
    const pre2 = applyBuy(pre1, q1);
    expect(pre2.virtualQuoteReserves).toBe(47_467_874_146n);
    expect(pre2.virtualTokenReserves).toBe(678_142_865_320_340n);

    const q2 = quoteBuyExactQuoteIn(pre2, 100_000_000n, RATES);
    expect(q2.quoteNet).toBe(98_765_431n);
    expect(q2.protocolFee).toBe(938_272n);
    expect(q2.creatorFee).toBe(296_297n);
    expect(q2.buybackFee).toBe(469_136n);
    expect(q2.totalQuote).toBe(100_000_000n);
    expect(q2.tokenAmount).toBe(1_408_068_181_646n);
    const post = applyBuy(pre2, q2);
    expect(post.virtualQuoteReserves).toBe(47_566_639_577n);
    expect(post.virtualTokenReserves).toBe(676_734_797_138_694n);
  });

  test("buy_exact_quote_in_v2 / sell_v2 vectors confirmed by mainnet simulation (2026-10-03)", () => {
    // 8iF53SDs… curve state at slot ~452,994,860; simulated TradeEvent matched these exactly.
    const c = curve(48_332_413_593n, 666_012_677_499_820n);
    const b = quoteBuyExactQuoteIn(c, 10_000_000n, RATES);
    expect(b.tokenAmount).toBe(136_069_298_695n);
    expect(b.quoteNet).toBe(9_876_542n);
    expect([b.protocolFee, b.creatorFee]).toEqual([93_828n, 29_630n]);
    const s = quoteSell(c, 830_911_420_821n, RATES);
    expect(s.quoteGross).toBe(60_223_949n);
    expect([s.protocolFee, s.creatorFee]).toEqual([572_128n, 180_672n]);
    expect(s.quoteNet).toBe(59_471_149n);
  });
});

describe("worked examples on a fresh SOL curve (notes §2)", () => {
  const fresh = curve(30_000_000_000n, 1_073_000_000_000_000n);

  test("A) buy_exact_sol_in 1 SOL", () => {
    const q = quoteBuyExactQuoteIn(fresh, 1_000_000_000n, RATES);
    expect(q.quoteNet).toBe(987_654_320n);
    expect(q.protocolFee).toBe(9_382_717n);
    expect(q.buybackFee).toBe(4_691_358n);
    expect(q.creatorFee).toBe(2_962_963n);
    expect(q.totalQuote).toBe(1_000_000_000n);
    expect(q.tokenAmount).toBe(34_199_203_120_618n);
  });

  test("B) buy 10M tokens + C) sell them back", () => {
    const b = quoteBuyExactTokens(fresh, 10_000_000_000_000n, RATES);
    expect(b.quoteNet).toBe(282_220_132n);
    expect([b.protocolFee, b.creatorFee]).toEqual([2_681_092n, 846_661n]);
    expect(b.totalQuote).toBe(285_747_885n);
    expect(applySlippageUp(b.totalQuote, 100)).toBe(288_605_363n);

    const after = applyBuy(fresh, b);
    const s = quoteSell(after, 10_000_000_000_000n, RATES);
    expect(s.quoteGross).toBe(282_220_131n);
    expect([s.protocolFee, s.creatorFee]).toEqual([2_681_092n, 846_661n]);
    expect(s.quoteNet).toBe(278_692_378n);
    expect(applySlippageDown(s.quoteNet, 100)).toBe(275_905_454n);

    // D) market cap before/after B
    expect(curveMarketCap(fresh, ONE_BILLION_SUPPLY)).toBe(27_958_993_476n);
    expect(Number(curveMarketCap(after, ONE_BILLION_SUPPLY)) / 1e9).toBeCloseTo(28.49, 2);
  });

  test("E) completion state and progress", () => {
    const k = 30_000_000_000n * 1_073_000_000_000_000n;
    const vT = 279_900_000_000_000n;
    expect(k / vT).toBe(115_005_359_056n);
    expect(bondingProgressBps({ realTokenReserves: 793_100_000_000_000n, complete: false }, 793_100_000_000_000n)).toBe(0);
    expect(bondingProgressBps({ realTokenReserves: 396_834_797_138_694n, complete: false }, 793_100_000_000_000n)).toBe(4996);
    expect(bondingProgressBps({ realTokenReserves: 0n, complete: true }, 793_100_000_000_000n)).toBe(10_000);
  });

  test("buy is capped at real_token_reserves", () => {
    const nearEnd = curve(114_000_000_000n, 280_900_000_000_000n);
    const q = quoteBuyExactTokens(nearEnd, 5_000_000_000_000n, RATES);
    expect(q.capped).toBe(true);
    expect(q.tokenAmount).toBe(1_000_000_000_000n);
    expect(applyBuy(nearEnd, q).complete).toBe(true);
    const big = quoteBuyExactQuoteIn(nearEnd, 100_000_000_000n, RATES);
    expect(big.capped).toBe(true);
    expect(big.tokenAmount).toBe(1_000_000_000_000n);
  });

  test("never debits more than the budget; inverse sell helper", () => {
    for (const spend of [2n, 10n, 12_345n, 1_000_001n, 7_777_777_777n]) {
      const q = quoteBuyExactQuoteIn(fresh, spend, RATES);
      expect(q.totalQuote).toBeLessThanOrEqual(spend);
    }
    // A fresh curve has no real quote to pay out; sell against a curve that took 1 SOL in.
    const funded = applyBuy(fresh, quoteBuyExactQuoteIn(fresh, 1_000_000_000n, RATES));
    expect(() => quoteSell(fresh, 1_000_000n, RATES)).toThrow("real quote reserves");
    const want = 50_000_000n;
    const tokens = tokensForSellProceeds(funded, want, RATES);
    expect(quoteSell(funded, tokens, RATES).quoteNet).toBeGreaterThanOrEqual(want);
  });

  test("complete curve refuses to quote", () => {
    expect(() => quoteSell({ ...fresh, complete: true }, 1n, RATES)).toThrow(CurveCompleteError);
    expect(() => quoteBuyExactTokens({ ...fresh, virtualTokenReserves: 0n }, 1n, RATES)).toThrow(CurveCompleteError);
  });
});

describe("fee-rate selection", () => {
  const global = decodePumpGlobal(fixture(PUMP_GLOBAL).data);
  const feeConfig = decodeFeeConfig(fixture(PUMP_FEE_CONFIG).data);

  test("live FeeConfig: single tier 0/95/30 (2026-10-03)", () => {
    expect(feeConfig.feeTiers.length).toBeGreaterThanOrEqual(1);
    const live = curveFeeRates({ curve: curve(30_000_000_000n, 1_073_000_000_000_000n), global, feeConfig });
    expect(live).toEqual({ protocolFeeBps: 95n, creatorFeeBps: 30n, buybackBps: 5000n });
  });

  test("no creator -> creator fee 0", () => {
    const r = curveFeeRates({ curve: curve(30_000_000_000n, 1_073_000_000_000_000n, { creator: DEFAULT_PUBKEY }), global, feeConfig });
    expect(r.creatorFeeBps).toBe(0n);
  });

  const tiered: FeeConfig = {
    admin: DEFAULT_PUBKEY,
    flatFees: { lpFeeBps: 25n, protocolFeeBps: 5n, creatorFeeBps: 0n },
    feeTiers: [
      { marketCapThreshold: 0n, fees: { lpFeeBps: 0n, protocolFeeBps: 95n, creatorFeeBps: 30n } },
      { marketCapThreshold: 100_000_000_000n, fees: { lpFeeBps: 0n, protocolFeeBps: 50n, creatorFeeBps: 10n } },
    ],
    stableFeeTiers: [{ marketCapThreshold: 0n, fees: { lpFeeBps: 0n, protocolFeeBps: 70n, creatorFeeBps: 20n } }],
    exoticFlatFees: { lpFeeBps: 0n, protocolFeeBps: 0n, creatorFeeBps: 0n },
  };
  const g = { ...global, creatorFeeConfigurable: true };

  test("market-cap tiers: 1e15 basis for normal coins, real mint supply for 2B mayhem coins", () => {
    // mcap(1e15 basis) = 50 SOL -> tier 0 ; mcap(2e15 basis) = 100 SOL -> tier 1
    const c = curve(50_000_000_000n, 1_000_000_000_000_000n);
    expect(curveFeeRates({ curve: c, global: g, feeConfig: tiered, mintSupply: 2_000_000_000_000_000n }).protocolFeeBps).toBe(95n);
    expect(
      curveFeeRates({ curve: { ...c, isMayhemMode: true }, global: g, feeConfig: tiered, mintSupply: 2_000_000_000_000_000n })
        .protocolFeeBps,
    ).toBe(50n);
  });

  test("USDC-quoted curve uses stable tiers; exotic falls back to flat fees", () => {
    const c = curve(4_292_000_000n, 1_073_000_000_000_000n, { quoteMint: USDC_MINT });
    expect(curveFeeRates({ curve: c, global: g, feeConfig: tiered })).toMatchObject({ protocolFeeBps: 70n, creatorFeeBps: 20n });
    const exotic = curve(4_292_000_000n, 1_073_000_000_000_000n, { quoteMint: address("JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN") });
    expect(curveFeeRates({ curve: exotic, global: g, feeConfig: tiered })).toMatchObject({ protocolFeeBps: 5n, creatorFeeBps: 0n });
  });

  test("per-coin creator_fee_bps override only when Global.creator_fee_configurable", () => {
    const c = curve(30_000_000_000n, 1_073_000_000_000_000n, { creatorFeeBps: 200n });
    expect(curveFeeRates({ curve: c, global: g, feeConfig: tiered }).creatorFeeBps).toBe(200n);
    expect(curveFeeRates({ curve: c, global: { ...g, creatorFeeConfigurable: false }, feeConfig: tiered }).creatorFeeBps).toBe(30n);
  });

  test("decoded live curves: normal (151 B) and mayhem (2B supply, 1e15 curve supply)", async () => {
    const { CURVE_MINT, MAYHEM_MINT } = await import("./fixtures");
    const { bondingCurvePda } = await import("../src");
    const normal = decodeBondingCurve(fixture(await bondingCurvePda(CURVE_MINT)).data);
    expect(normal.dataLength).toBe(151);
    expect(normal.virtualTokenReserves - normal.realTokenReserves).toBe(279_900_000_000_000n);
    const mayhem = decodeBondingCurve(fixture(await bondingCurvePda(MAYHEM_MINT)).data);
    expect(mayhem.isMayhemMode).toBe(true);
    expect(mayhem.virtualTokenReserves - mayhem.realTokenReserves).toBe(279_900_000_000_000n);
    expect(mayhem.tokenTotalSupply).toBe(1_000_000_000_000_000n);
  });

  test("curveMintSupply: the mint of a mayhem coin holds twice the curve's token_total_supply", async () => {
    const { CURVE_MINT, MAYHEM_MINT } = await import("./fixtures");
    const { bondingCurvePda, curveMintSupply, decodeMint } = await import("../src");
    for (const m of [CURVE_MINT, MAYHEM_MINT]) {
      const c = decodeBondingCurve(fixture(await bondingCurvePda(m)).data);
      const mint = fixture(m);
      expect(curveMintSupply(c)).toBe(decodeMint(mint.data, mint.owner).supply);
    }
    expect(curveMintSupply({ tokenTotalSupply: ONE_BILLION_SUPPLY, isMayhemMode: true })).toBe(2n * ONE_BILLION_SUPPLY);
    expect(curveMintSupply({ tokenTotalSupply: ONE_BILLION_SUPPLY, isMayhemMode: false })).toBe(ONE_BILLION_SUPPLY);
  });
});

describe("slippage helpers", () => {
  test("bounds", () => {
    expect(applySlippageUp(1_000n, 0)).toBe(1_000n);
    expect(applySlippageUp(1_000n, 1_000)).toBe(1_100n);
    expect(applySlippageDown(1_000n, 1_000)).toBe(900n);
    expect(applySlippageDown(1_000n, 10_000)).toBe(0n);
    expect(() => applySlippageUp(1n, -1)).toThrow();
    expect(() => applySlippageDown(1n, 1.5)).toThrow();
  });
});
