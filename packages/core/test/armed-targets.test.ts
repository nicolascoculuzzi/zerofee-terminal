/** Market-cap targets -> quote-out thresholds, on the live fixture curve and canonical pool; the migration-pool estimate. */
import { describe, expect, test } from "bun:test";
import {
  bondingCurvePda,
  curveAtMarketCap,
  curveMarketCap,
  decodeBondingCurve,
  decodeFeeConfig,
  decodeMint,
  decodePool,
  decodeTokenAccount,
  effectiveQuoteReserve,
  estimateMigrationPoolReserves,
  isCanonicalPumpPool,
  isqrt,
  type LiveMarketState,
  liveQuoteOut,
  PUMP_AMM_FEE_CONFIG,
  PUMP_FEE_CONFIG,
  poolMarketCap,
  quoteOutAtMarketCap,
  reservesAtMarketCap,
} from "../src";
import { ammGlobalConfig, pumpGlobal } from "./armedTestKit";
import { CURVE_MINT, fixture, POOL } from "./fixtures";

const close = (a: bigint, b: bigint, ppm: bigint) => (a > b ? a - b : b - a) * 1_000_000n <= b * ppm;

describe("isqrt", () => {
  test("floor square root for small, large and random values", () => {
    expect([0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n].map(isqrt)).toEqual([0n, 1n, 1n, 1n, 2n, 3n, 4n, 4n]);
    for (let i = 0; i < 200; i++) {
      const n = BigInt(Math.floor(Math.random() * 1e15)) * 10n ** BigInt(Math.floor(Math.random() * 25));
      const r = isqrt(n);
      expect(r * r <= n && (r + 1n) * (r + 1n) > n).toBe(true);
    }
    expect(() => isqrt(-1n)).toThrow();
  });
});

describe("pump curve", async () => {
  const curve = decodeBondingCurve(fixture(await bondingCurvePda(CURVE_MINT)).data);
  const supply = decodeMint(fixture(CURVE_MINT).data, fixture(CURVE_MINT).owner).supply;
  const market: LiveMarketState = {
    venue: "pump",
    curve,
    global: pumpGlobal(),
    feeConfig: decodeFeeConfig(fixture(PUMP_FEE_CONFIG).data),
    mintSupply: supply,
  };
  const mcNow = curveMarketCap(curve, supply);

  test("the state at today's market cap is today's state; k is preserved", () => {
    const at = curveAtMarketCap(curve, mcNow, supply);
    expect(close(at.virtualQuoteReserves, curve.virtualQuoteReserves, 1n)).toBe(true);
    expect(close(at.virtualTokenReserves, curve.virtualTokenReserves, 1n)).toBe(true);
    const up = curveAtMarketCap(curve, mcNow * 2n, supply);
    expect(close(up.virtualQuoteReserves * up.virtualTokenReserves, curve.virtualQuoteReserves * curve.virtualTokenReserves, 1n)).toBe(
      true,
    );
    expect(close(curveMarketCap(up, supply), mcNow * 2n, 10n)).toBe(true);
  });

  test("thresholds: at today's cap they equal the live quote; sells grow and buys shrink with the cap", () => {
    for (const [side, amount] of [
      ["sell", 10_000_000_000n],
      ["buy", 50_000_000n],
    ] as const) {
      expect(close(quoteOutAtMarketCap(side, amount, market, mcNow) as bigint, liveQuoteOut(side, amount, market) as bigint, 10n)).toBe(
        true,
      );
    }
    const sellUp = quoteOutAtMarketCap("sell", 10_000_000_000n, market, (mcNow * 3n) / 2n) as bigint;
    const sellNow = quoteOutAtMarketCap("sell", 10_000_000_000n, market, mcNow) as bigint;
    expect(sellUp).toBeGreaterThan(sellNow);
    const buyDown = quoteOutAtMarketCap("buy", 50_000_000n, market, (mcNow * 2n) / 3n) as bigint;
    expect(buyDown).toBeGreaterThan(quoteOutAtMarketCap("buy", 50_000_000n, market, mcNow) as bigint);
  });

  test("unreachable targets: past completion or below the starting price", () => {
    expect(quoteOutAtMarketCap("sell", 1_000n, market, mcNow * 1_000n)).toBeNull();
    expect(quoteOutAtMarketCap("sell", 1_000n, market, mcNow / 1_000n)).toBeNull();
    expect(() => curveAtMarketCap(curve, 0n, supply)).toThrow();
  });
});

describe("PumpSwap canonical pool", async () => {
  const pool = decodePool(fixture(POOL).data);
  const reserves = {
    baseReserve: decodeTokenAccount(fixture(pool.poolBaseTokenAccount).data).amount,
    quoteVaultReserve: decodeTokenAccount(fixture(pool.poolQuoteTokenAccount).data).amount,
    virtualQuoteReserves: pool.virtualQuoteReserves,
  };
  const supply = decodeMint(fixture(pool.baseMint).data, fixture(pool.baseMint).owner).supply;
  const market: LiveMarketState = {
    venue: "pumpswap",
    pool,
    reserves,
    isCanonical: await isCanonicalPumpPool(pool),
    baseMintSupply: supply,
    feeConfig: decodeFeeConfig(fixture(PUMP_AMM_FEE_CONFIG).data),
    globalConfig: ammGlobalConfig(),
  };
  const mcNow = poolMarketCap({
    baseReserve: reserves.baseReserve,
    effectiveQuoteReserve: effectiveQuoteReserve(reserves),
    baseMintSupply: supply,
    isMayhemMode: false,
  });

  test("effective-reserve product preserved, virtual reserves kept, threshold matches the live quote at today's cap", () => {
    const at = reservesAtMarketCap(reserves, mcNow * 2n, supply);
    expect(at.virtualQuoteReserves).toBe(reserves.virtualQuoteReserves);
    expect(close(effectiveQuoteReserve(at) * at.baseReserve, effectiveQuoteReserve(reserves) * reserves.baseReserve, 1n)).toBe(true);
    const amount = 1_000_000_000_000n;
    expect(close(quoteOutAtMarketCap("sell", amount, market, mcNow) as bigint, liveQuoteOut("sell", amount, market) as bigint, 10n)).toBe(
      true,
    );
    expect(quoteOutAtMarketCap("sell", amount, market, mcNow * 2n) as bigint).toBeGreaterThan(
      liveQuoteOut("sell", amount, market) as bigint,
    );
    // A cap low enough to need a negative quote vault (boost pool) is unreachable.
    expect(quoteOutAtMarketCap("sell", amount, market, mcNow / 100n)).toBeNull();
  });
});

describe("migration snipe: opening-pool estimate", async () => {
  const curve = decodeBondingCurve(fixture(await bondingCurvePda(CURVE_MINT)).data);
  const global = pumpGlobal();

  test("a boost only splits the migrated quote into real and virtual; the effective quote and the base stay the same", () => {
    // migrate books the boost as virtual quote reserves taken out of the real vault (mainnet fork, 2026-10-03).
    const boost = 17_584_505_555n;
    const plain = estimateMigrationPoolReserves(curve, global);
    const boosted = estimateMigrationPoolReserves(curve, global, boost);
    expect(plain.virtualQuoteReserves).toBe(0n);
    expect(boosted.baseReserve).toBe(plain.baseReserve);
    expect(boosted.virtualQuoteReserves).toBe(boost);
    expect(boosted.quoteVaultReserve).toBe(plain.quoteVaultReserve - boost);
    expect(effectiveQuoteReserve(boosted)).toBe(effectiveQuoteReserve(plain));
    expect(() => estimateMigrationPoolReserves(curve, global, plain.quoteVaultReserve)).toThrow(RangeError);
  });
});
