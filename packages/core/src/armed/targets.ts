/**
 * Price / market-cap targets -> armed-order quote-out thresholds.
 *
 * Triggers and min-out grids are in the order's own quote-out units (tokens for a fixed spend,
 * quote for fixed tokens), which already include price impact and fees. The UI sets limit orders
 * by market cap or price, so this moves the venue's constant product (x*y = k; pump, LaunchLab and
 * CPMM fees sit outside the reserves) to the reserves at which the market cap equals the target, then
 * quotes the order there with the fee tier of that state.
 */
import type { Address } from "@solana/kit";
import { PUMP_AMM_TOTAL_TOKEN_SUPPLY } from "../constants";
import type { CurveState } from "../pump/curve";
import { type AmmReserves, effectiveQuoteReserve } from "../pumpswap/math";
import { type CpmmPoolState, cpmmVaultAmountsWithoutFees } from "../raydium/cpmm/math";
import type { LaunchLabCurveState } from "../raydium/launchlab/math";
import type { ArmedSide } from "./model";
import { type LiveMarketState, liveQuoteOut } from "./trigger";

/** Integer square root (floor). */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError("isqrt of a negative number");
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  // Newton steps from the float estimate, then settle on the floor.
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) break;
    x = y;
  }
  while (x * x > n) x -= 1n;
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  return x;
}

/**
 * Curve state at `targetMarketCap` (quote base units, on `supply`, as curveMarketCap computes it).
 * Throws RangeError for a target the curve cannot reach (below its virtual floor or past completion).
 */
export function curveAtMarketCap<T extends CurveState>(curve: T, targetMarketCap: bigint, supply: bigint): T {
  if (targetMarketCap <= 0n || supply <= 0n) throw new RangeError("market cap and supply must be > 0");
  const k = curve.virtualQuoteReserves * curve.virtualTokenReserves;
  const vQ = isqrt((k * targetMarketCap) / supply);
  if (vQ === 0n) throw new RangeError("target market cap is too small");
  const vT = k / vQ;
  const realTokenReserves = curve.realTokenReserves + (vT - curve.virtualTokenReserves);
  const realQuoteReserves = curve.realQuoteReserves + (vQ - curve.virtualQuoteReserves);
  if (realTokenReserves <= 0n) throw new RangeError("target market cap is past the curve's completion");
  if (realQuoteReserves < 0n) throw new RangeError("target market cap is below the curve's starting price");
  return { ...curve, virtualQuoteReserves: vQ, virtualTokenReserves: vT, realTokenReserves, realQuoteReserves };
}

/** PumpSwap reserves at `targetMarketCap` (effective quote x base = k; virtual quote reserves unchanged). */
export function reservesAtMarketCap(reserves: AmmReserves, targetMarketCap: bigint, supply: bigint): AmmReserves {
  if (targetMarketCap <= 0n || supply <= 0n) throw new RangeError("market cap and supply must be > 0");
  const k = effectiveQuoteReserve(reserves) * reserves.baseReserve;
  const effQ = isqrt((k * targetMarketCap) / supply);
  if (effQ === 0n) throw new RangeError("target market cap is too small");
  const quoteVaultReserve = effQ - reserves.virtualQuoteReserves;
  if (quoteVaultReserve < 0n) throw new RangeError("target market cap needs a negative quote vault");
  return { ...reserves, baseReserve: k / effQ, quoteVaultReserve };
}

/**
 * LaunchLab curve at `targetMarketCap` (launchLabMarketCap: supply x (vQ + rQ) / (vB - rB); the product
 * (vQ + rQ)(vB - rB) is constant). Throws RangeError past the curve's end or below its starting price.
 */
export function launchLabAtMarketCap<T extends LaunchLabCurveState>(pool: T, targetMarketCap: bigint, supply: bigint): T {
  if (targetMarketCap <= 0n || supply <= 0n) throw new RangeError("market cap and supply must be > 0");
  const k = (pool.virtualQuote + pool.realQuote) * (pool.virtualBase - pool.realBase);
  const quoteSide = isqrt((k * targetMarketCap) / supply);
  if (quoteSide === 0n) throw new RangeError("target market cap is too small");
  const realBase = pool.virtualBase - k / quoteSide;
  const realQuote = quoteSide - pool.virtualQuote;
  if (realBase >= pool.totalBaseSell) throw new RangeError("target market cap is past the curve's completion");
  if (realBase < 0n || realQuote < 0n) throw new RangeError("target market cap is below the curve's starting price");
  return { ...pool, realBase, realQuote };
}

/**
 * CPMM vault balances at `targetMarketCap` of `baseMint` (fee-net reserves keep their product; the fees
 * owed stay in the vaults on top).
 */
export function cpmmAtMarketCap(
  pool: CpmmPoolState,
  vaults: { vault0Amount: bigint; vault1Amount: bigint },
  baseMint: Address,
  targetMarketCap: bigint,
  supply: bigint,
): { vault0Amount: bigint; vault1Amount: bigint } {
  if (targetMarketCap <= 0n || supply <= 0n) throw new RangeError("market cap and supply must be > 0");
  const net = cpmmVaultAmountsWithoutFees(pool, vaults.vault0Amount, vaults.vault1Amount);
  const baseIs0 = baseMint === pool.token0Mint;
  if (!baseIs0 && baseMint !== pool.token1Mint) throw new RangeError(`${baseMint} is not in this CPMM pool`);
  const [base, quote] = baseIs0 ? [net.token0, net.token1] : [net.token1, net.token0];
  const k = base * quote;
  const quote2 = isqrt((k * targetMarketCap) / supply);
  if (quote2 === 0n) throw new RangeError("target market cap is too small");
  const base2 = k / quote2;
  const owed0 = vaults.vault0Amount - net.token0;
  const owed1 = vaults.vault1Amount - net.token1;
  return baseIs0
    ? { vault0Amount: base2 + owed0, vault1Amount: quote2 + owed1 }
    : { vault0Amount: quote2 + owed0, vault1Amount: base2 + owed1 };
}

/** The market as it would be at `targetMarketCap`. */
export function marketAtMarketCap(market: LiveMarketState, targetMarketCap: bigint): LiveMarketState {
  if (market.venue === "pump") return { ...market, curve: curveAtMarketCap(market.curve, targetMarketCap, market.mintSupply) };
  if (market.venue === "launchlab") return { ...market, pool: launchLabAtMarketCap(market.pool, targetMarketCap, market.mintSupply) };
  if (market.venue === "cpmm") {
    return { ...market, ...cpmmAtMarketCap(market.pool, market, market.baseMint, targetMarketCap, market.baseMintSupply) };
  }
  // Pool::market_cap uses the real mint supply, except a fixed 1e15 for mayhem pools.
  const supply = market.pool.isMayhemMode ? PUMP_AMM_TOTAL_TOKEN_SUPPLY : market.baseMintSupply;
  return { ...market, reserves: reservesAtMarketCap(market.reserves, targetMarketCap, supply) };
}

/**
 * The order's quote-out if the market cap were `targetMarketCap`: the trigger threshold of a limit
 * order at that market cap, and the reference for its min-out grid. Null when unreachable.
 */
export function quoteOutAtMarketCap(side: ArmedSide, amount: bigint, market: LiveMarketState, targetMarketCap: bigint): bigint | null {
  try {
    return liveQuoteOut(side, amount, marketAtMarketCap(market, targetMarketCap));
  } catch (e) {
    if (e instanceof RangeError) return null;
    throw e;
  }
}
