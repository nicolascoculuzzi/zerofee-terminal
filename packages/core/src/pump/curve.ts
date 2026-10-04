/**
 * Pure bigint bonding-curve math for the pump.fun program.
 *
 * Virtual-reserve constant product over (virtual_quote_reserves, virtual_token_reserves).
 * Every formula here reproduced real mainnet trades to the lamport (notes §2):
 *   buy (exact tokens):      sol = floor(amount*vQ/(vT-amount)) + 1           tx 2vVpDi4t…
 *   sell:                    sol = floor(amount*vQ/(vT+amount))               tx 2K5JEfHo…
 *   buy_exact_sol_in / buy_exact_quote_in_v2:
 *                            net = floor((spendable-1)*10000/(10000+bps))
 *                            tokens = floor((net-1)*vT/(vQ+net-1))            tx FpgAR3QK…, 2nbzqZM2…
 *   fees: protocol and creator each ceil(amount*bps/10000); creator only if creator != default.
 *   buyback = 50% of the protocol fee (carved out, NOT an extra charge).
 *
 * Quote mint agnostic: amounts are in the curve's quote base units (lamports for SOL curves,
 * USDC base units for USDC curves). Fee schedule selection by quote mint lives in ../fees.ts.
 */
import { BPS_DENOMINATOR, DEFAULT_PUBKEY, ONE_BILLION_SUPPLY } from "../constants";
import { applyCreatorFeeOverride, type FeeConfig, feesForQuoteMint } from "../fees";
import { ceilDiv, feeCeil, minBig } from "../util/math";
import type { BondingCurve, PumpGlobal } from "./accounts";

export { applySlippageDown, applySlippageUp } from "../util/math";

export type CurveState = Pick<
  BondingCurve,
  | "virtualTokenReserves"
  | "virtualQuoteReserves"
  | "realTokenReserves"
  | "realQuoteReserves"
  | "complete"
  | "creator"
  | "isMayhemMode"
  | "quoteMint"
  | "creatorFeeBps"
>;

export interface CurveFeeRates {
  protocolFeeBps: bigint;
  /** 0 when the curve has no creator (creator == default pubkey). */
  creatorFeeBps: bigint;
  /** Share of the protocol fee routed to the buyback recipient (5000 = 50%; 0 for mayhem coins). Informational. */
  buybackBps: bigint;
}

export class CurveCompleteError extends Error {
  constructor() {
    super("bonding curve is complete/migrated - trade on PumpSwap instead");
  }
}

function assertTradable(curve: CurveState): void {
  // The SDK treats virtual_token_reserves == 0 as migrated.
  if (curve.complete || curve.virtualTokenReserves === 0n) throw new CurveCompleteError();
}

/** `market_cap = virtual_quote_reserves * supply / virtual_token_reserves` (quote base units). */
export function curveMarketCap(curve: Pick<CurveState, "virtualQuoteReserves" | "virtualTokenReserves">, supply: bigint): bigint {
  if (curve.virtualTokenReserves === 0n) throw new RangeError("virtual token reserves are zero");
  return (curve.virtualQuoteReserves * supply) / curve.virtualTokenReserves;
}

/**
 * Fee rates a trade on this curve pays right now.
 *
 * - Tier market-cap basis: fixed 1e15 supply for normal coins, the real mint supply for mayhem coins
 *   (2B-supply) - pump-sdk src/fees.ts `getFee`.
 * - Schedule by quote mint: SOL-like -> fee_tiers, USDC -> stable_fee_tiers, other -> exotic/flat.
 * - Per-coin creator_fee_bps overrides the schedule's creator rate when Global.creator_fee_configurable.
 * - No FeeConfig -> Global fallback rates (not reachable on mainnet: the fee program is mandatory).
 */
export function curveFeeRates(args: {
  curve: CurveState;
  global: Pick<PumpGlobal, "feeBasisPoints" | "creatorFeeBasisPoints" | "creatorFeeConfigurable" | "buybackBasisPoints">;
  feeConfig: FeeConfig | null;
  /** Live mint supply; only used for mayhem coins. Defaults to 2x the 1B basis if omitted for mayhem. */
  mintSupply?: bigint;
}): CurveFeeRates {
  const { curve, global, feeConfig } = args;
  let protocolFeeBps: bigint;
  let creatorFeeBps: bigint;
  if (feeConfig) {
    const supply = curve.isMayhemMode ? (args.mintSupply ?? ONE_BILLION_SUPPLY * 2n) : ONE_BILLION_SUPPLY;
    const marketCap = curve.virtualTokenReserves === 0n ? 0n : curveMarketCap(curve, supply);
    const schedule = applyCreatorFeeOverride(
      feesForQuoteMint({ feeConfig, quoteMint: curve.quoteMint, marketCap, isPumpPool: true }),
      global.creatorFeeConfigurable,
      curve.creatorFeeBps,
    );
    protocolFeeBps = schedule.protocolFeeBps;
    creatorFeeBps = schedule.creatorFeeBps;
  } else {
    protocolFeeBps = global.feeBasisPoints;
    creatorFeeBps = global.creatorFeeBasisPoints;
  }
  if (curve.creator === DEFAULT_PUBKEY) creatorFeeBps = 0n;
  // Mayhem coins pay the whole protocol fee to the reserved fee recipient: no buyback carve-out (observed on a
  // mainnet fork 2026-10-03, packages/core/e2e/mayhem.e2e.ts; the buyback account is passed but not credited).
  return { protocolFeeBps, creatorFeeBps, buybackBps: curve.isMayhemMode ? 0n : global.buybackBasisPoints };
}

export interface CurveFeeBreakdown {
  protocolFee: bigint;
  creatorFee: bigint;
  /** Portion of protocolFee that goes to the buyback recipient: floor(protocolFee*buybackBps/1e4). */
  buybackFee: bigint;
  totalFee: bigint;
}

export function curveFees(amount: bigint, rates: CurveFeeRates): CurveFeeBreakdown {
  const protocolFee = feeCeil(amount, rates.protocolFeeBps);
  const creatorFee = feeCeil(amount, rates.creatorFeeBps);
  return {
    protocolFee,
    creatorFee,
    buybackFee: (protocolFee * rates.buybackBps) / BPS_DENOMINATOR,
    totalFee: protocolFee + creatorFee,
  };
}

export interface CurveBuyQuote extends CurveFeeBreakdown {
  /** Base units the buyer receives. */
  tokenAmount: bigint;
  /** Quote that enters the curve (event `sol_amount`), excluding fees. */
  quoteNet: bigint;
  /** Total debited from the buyer: quoteNet + fees. */
  totalQuote: bigint;
  /** True if the request was capped at real_token_reserves (curve completes). */
  capped: boolean;
}

/** `buy_v2` / legacy `buy`: cost of exactly `tokenAmount` base units (capped at real reserves). */
export function quoteBuyExactTokens(curve: CurveState, tokenAmount: bigint, rates: CurveFeeRates): CurveBuyQuote {
  assertTradable(curve);
  if (tokenAmount <= 0n) throw new RangeError("tokenAmount must be > 0");
  const amount = minBig(tokenAmount, curve.realTokenReserves);
  if (amount >= curve.virtualTokenReserves) throw new RangeError("amount exceeds virtual token reserves");
  const quoteNet = (amount * curve.virtualQuoteReserves) / (curve.virtualTokenReserves - amount) + 1n;
  const fees = curveFees(quoteNet, rates);
  return { tokenAmount: amount, quoteNet, ...fees, totalQuote: quoteNet + fees.totalFee, capped: amount < tokenAmount };
}

/**
 * `buy_exact_quote_in_v2` / legacy `buy_exact_sol_in`: tokens received for a total budget
 * `spendable` (fees included). Matches the on-chain `(net-1)` rounding - the SDK's
 * getBuyTokenAmountFromSolAmount over-quotes by ~1e-8 because it uses `net` (notes §2).
 *
 * If the budget would buy past real_token_reserves the program caps the purchase; we then
 * re-quote the capped amount via the exact-tokens path (edge case not verified on mainnet).
 */
export function quoteBuyExactQuoteIn(curve: CurveState, spendable: bigint, rates: CurveFeeRates): CurveBuyQuote {
  assertTradable(curve);
  if (spendable <= 1n) throw new RangeError("spendable must be > 1");
  const totalBps = rates.protocolFeeBps + rates.creatorFeeBps;
  let quoteNet = ((spendable - 1n) * BPS_DENOMINATOR) / (BPS_DENOMINATOR + totalBps);
  let fees = curveFees(quoteNet, rates);
  // Each ceil can add a lamport; never debit more than the budget (same guard as pump-swap-sdk).
  if (quoteNet + fees.totalFee > spendable) {
    quoteNet -= quoteNet + fees.totalFee - spendable;
    fees = curveFees(quoteNet, rates);
  }
  const inputAmount = quoteNet - 1n;
  const tokens = (inputAmount * curve.virtualTokenReserves) / (curve.virtualQuoteReserves + inputAmount);
  if (tokens > curve.realTokenReserves) {
    return { ...quoteBuyExactTokens(curve, curve.realTokenReserves, rates), capped: true };
  }
  return { tokenAmount: tokens, quoteNet, ...fees, totalQuote: quoteNet + fees.totalFee, capped: false };
}

export interface CurveSellQuote extends CurveFeeBreakdown {
  tokenAmount: bigint;
  /** Quote leaving the curve before fees (event `sol_amount`). */
  quoteGross: bigint;
  /** What the seller receives: quoteGross - fees. */
  quoteNet: bigint;
}

/** `sell_v2` / legacy `sell`: proceeds for selling `tokenAmount` base units. */
export function quoteSell(curve: CurveState, tokenAmount: bigint, rates: CurveFeeRates): CurveSellQuote {
  assertTradable(curve);
  if (tokenAmount <= 0n) throw new RangeError("tokenAmount must be > 0");
  const quoteGross = (tokenAmount * curve.virtualQuoteReserves) / (curve.virtualTokenReserves + tokenAmount);
  if (quoteGross > curve.realQuoteReserves) throw new RangeError("sell exceeds real quote reserves");
  const fees = curveFees(quoteGross, rates);
  const quoteNet = quoteGross - fees.totalFee;
  if (quoteNet < 0n) throw new RangeError("fees exceed sell output");
  return { tokenAmount, quoteGross, ...fees, quoteNet };
}

/** Curve state after a buy (virtual and real reserves move by the same amounts - notes §2). */
export function applyBuy<T extends CurveState>(curve: T, q: Pick<CurveBuyQuote, "tokenAmount" | "quoteNet">): T {
  const realTokenReserves = curve.realTokenReserves - q.tokenAmount;
  return {
    ...curve,
    virtualTokenReserves: curve.virtualTokenReserves - q.tokenAmount,
    virtualQuoteReserves: curve.virtualQuoteReserves + q.quoteNet,
    realTokenReserves,
    realQuoteReserves: curve.realQuoteReserves + q.quoteNet,
    complete: realTokenReserves === 0n,
  };
}

/** Curve state after a sell. */
export function applySell<T extends CurveState>(curve: T, q: Pick<CurveSellQuote, "tokenAmount" | "quoteGross">): T {
  return {
    ...curve,
    virtualTokenReserves: curve.virtualTokenReserves + q.tokenAmount,
    virtualQuoteReserves: curve.virtualQuoteReserves - q.quoteGross,
    realTokenReserves: curve.realTokenReserves + q.tokenAmount,
    realQuoteReserves: curve.realQuoteReserves - q.quoteGross,
  };
}

/**
 * Bonding progress in basis points (0..10000):
 *   (initial_real_token_reserves - real_token_reserves) / initial_real_token_reserves.
 * No official formula exists; this follows the completion condition (real_token_reserves == 0).
 * Do NOT derive progress from SOL raised - mayhem curves have non-standard virtual SOL (notes §2).
 * `initialRealTokenReserves` should come from the live Global (793.1e12 for standard coins).
 */
export function bondingProgressBps(curve: Pick<CurveState, "realTokenReserves" | "complete">, initialRealTokenReserves: bigint): number {
  if (curve.complete || curve.realTokenReserves === 0n) return 10_000;
  if (initialRealTokenReserves <= 0n) throw new RangeError("initialRealTokenReserves must be > 0");
  const sold = initialRealTokenReserves - curve.realTokenReserves;
  if (sold <= 0n) return 0;
  return Number((sold * BPS_DENOMINATOR) / initialRealTokenReserves);
}

/**
 * Spot price as a float in quote UI units per token UI unit (display only - never use floats for
 * amounts). e.g. SOL per token for SOL curves: (vQ/1e9)/(vT/1e6).
 */
export function curveSpotPrice(
  curve: Pick<CurveState, "virtualQuoteReserves" | "virtualTokenReserves">,
  quoteDecimals: number,
  baseDecimals: number,
): number {
  if (curve.virtualTokenReserves === 0n) return 0;
  return Number(curve.virtualQuoteReserves) / 10 ** quoteDecimals / (Number(curve.virtualTokenReserves) / 10 ** baseDecimals);
}

/** Market cap in quote base units using the real mint supply (1e15 normal, 2e15 mayhem). */
export function curveMarketCapForDisplay(
  curve: Pick<CurveState, "virtualQuoteReserves" | "virtualTokenReserves">,
  mintSupply: bigint,
): bigint {
  return curveMarketCap(curve, mintSupply);
}

/** Smallest token amount whose sale yields at least `quoteNetWanted` (inverse of quoteSell; ceil). */
export function tokensForSellProceeds(curve: CurveState, quoteNetWanted: bigint, rates: CurveFeeRates): bigint {
  assertTradable(curve);
  const totalBps = rates.protocolFeeBps + rates.creatorFeeBps;
  // gross >= net / (1 - bps) (+2 for the two ceil roundings)
  const gross = ceilDiv(quoteNetWanted * BPS_DENOMINATOR, BPS_DENOMINATOR - totalBps) + 2n;
  if (gross >= curve.virtualQuoteReserves) throw new RangeError("requested proceeds exceed curve reserves");
  return ceilDiv(gross * curve.virtualTokenReserves, curve.virtualQuoteReserves - gross);
}
