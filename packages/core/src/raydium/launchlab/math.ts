/**
 * Raydium LaunchLab bonding-curve math (pure bigint), constant-product curves only.
 *
 * The LaunchLab program source is not public; this ports the official SDK's Curve /
 * LaunchConstantProductCurve (raydium-sdk-V2 cc33ec2, src/raydium/launchpad/curve/*.ts) and was
 * verified to the unit against mainnet TradeEvents on 2026-10-03 (test/raydium-launchlab.test.ts):
 *
 *   reserves:  base side  = virtual_base - real_base     (real_base = base sold so far)
 *              quote side = virtual_quote + real_quote   (real_quote = quote raised, net of fees)
 *   buy  (exact quote in):  fee = ceil(in * totalRate / 1e6); net = in - fee
 *                           base_out = floor(net * baseSide / (quoteSide + net))
 *   sell (exact base in):   gross = floor(in * quoteSide / (baseSide + in))
 *                           fee = ceil(gross * totalRate / 1e6); out = gross - fee
 *   fee split (floor, protocol takes the remainder):
 *                           platform = floor(fee * platformRate / totalRate), creator, share likewise
 *   totalRate = GlobalConfig.trade_fee_rate (protocol) + PlatformConfig.fee_rate + creator_fee_rate + share
 *
 * Token-2022 transfer fees (StonkFun coins carry 300 bps) are applied on the user->vault and
 * vault->user legs: e.g. a sell of `in` puts `in - transferFee(in)` on the curve (mainnet tx 2n9RK58Y…).
 * Only curve type 0 exists on mainnet (585/585 GlobalConfigs, 2026-10-03); other types are refused.
 */
import { LAUNCHLAB_CURVE_TYPE, LAUNCHLAB_POOL_STATUS, RAYDIUM_FEE_RATE_DENOMINATOR } from "../../constants";
import { calculatePreFeeAmount, getEpochFee, type TransferFeeConfig, transferFeeFor } from "../../token2022";
import { ceilDiv } from "../../util/math";
import type { LaunchLabGlobalConfig, LaunchLabPlatformConfig, LaunchLabPool } from "./accounts";

export type LaunchLabCurveState = Pick<
  LaunchLabPool,
  "status" | "virtualBase" | "virtualQuote" | "realBase" | "realQuote" | "totalBaseSell" | "totalQuoteFundRaising"
>;

export interface LaunchLabTradeParams {
  /** GlobalConfig.curve_type (only 0 is supported). */
  curveType: number;
  /** GlobalConfig.trade_fee_rate: protocol fee, ppm. */
  protocolFeeRate: bigint;
  /** PlatformConfig.fee_rate, ppm. */
  platformFeeRate: bigint;
  /** PlatformConfig.creator_fee_rate, ppm. */
  creatorFeeRate: bigint;
  /** Referral share passed as the `share_fee_rate` argument (we always pass 0), ppm. */
  shareFeeRate: bigint;
}

/** Live fee/curve parameters for a pool (the SDK reads the same three accounts). */
export function launchLabTradeParams(args: {
  globalConfig: Pick<LaunchLabGlobalConfig, "curveType" | "tradeFeeRate" | "maxShareFeeRate">;
  platformConfig: Pick<LaunchLabPlatformConfig, "feeRate" | "creatorFeeRate">;
  shareFeeRate?: bigint;
}): LaunchLabTradeParams {
  const shareFeeRate = args.shareFeeRate ?? 0n;
  if (shareFeeRate < 0n || shareFeeRate > args.globalConfig.maxShareFeeRate) {
    throw new RangeError(`share_fee_rate ${shareFeeRate} exceeds max_share_fee_rate ${args.globalConfig.maxShareFeeRate}`);
  }
  const params = {
    curveType: args.globalConfig.curveType,
    protocolFeeRate: args.globalConfig.tradeFeeRate,
    platformFeeRate: args.platformConfig.feeRate,
    creatorFeeRate: args.platformConfig.creatorFeeRate,
    shareFeeRate,
  };
  launchLabTotalFeeRate(params);
  return params;
}

/** Sum of all fee rates (ppm); the SDK rejects > 1e6. */
export function launchLabTotalFeeRate(p: Omit<LaunchLabTradeParams, "curveType">): bigint {
  const total = p.protocolFeeRate + p.platformFeeRate + p.creatorFeeRate + p.shareFeeRate;
  if (total > RAYDIUM_FEE_RATE_DENOMINATOR) throw new RangeError(`total fee rate ${total} > 1e6`);
  return total;
}

/** Curve.calculateFee: ceil(amount * rate / 1e6). */
export function launchLabFee(amount: bigint, rate: bigint): bigint {
  return ceilDiv(amount * rate, RAYDIUM_FEE_RATE_DENOMINATOR);
}

/** Curve.calculatePreFee: smallest gross amount whose net after `rate` is >= post: ceil(post * 1e6 / (1e6 - rate)). */
export function launchLabPreFeeAmount(postFeeAmount: bigint, rate: bigint): bigint {
  if (rate === 0n) return postFeeAmount;
  return ceilDiv(postFeeAmount * RAYDIUM_FEE_RATE_DENOMINATOR, RAYDIUM_FEE_RATE_DENOMINATOR - rate);
}

export interface LaunchLabFeeSplit {
  protocolFee: bigint;
  platformFee: bigint;
  creatorFee: bigint;
  shareFee: bigint;
  totalFee: bigint;
}

/** Curve.splitFee: platform/share/creator floor-proportional, protocol gets the remainder. */
export function splitLaunchLabFee(totalFee: bigint, p: Omit<LaunchLabTradeParams, "curveType">): LaunchLabFeeSplit {
  const totalRate = launchLabTotalFeeRate(p);
  if (totalRate === 0n) return { protocolFee: totalFee, platformFee: 0n, creatorFee: 0n, shareFee: 0n, totalFee };
  const platformFee = (totalFee * p.platformFeeRate) / totalRate;
  const shareFee = (totalFee * p.shareFeeRate) / totalRate;
  const creatorFee = (totalFee * p.creatorFeeRate) / totalRate;
  return { protocolFee: totalFee - platformFee - shareFee - creatorFee, platformFee, creatorFee, shareFee, totalFee };
}

export class LaunchLabCurveCompleteError extends Error {
  constructor(status: number) {
    super(
      status === LAUNCHLAB_POOL_STATUS.migrate
        ? "LaunchLab curve is complete and waiting for migration to CPMM (Raydium's migration wallet signs it)"
        : "LaunchLab pool has migrated - trade on its CPMM pool instead",
    );
  }
}

function assertTradable(pool: LaunchLabCurveState, params: Pick<LaunchLabTradeParams, "curveType">): void {
  if (pool.status !== LAUNCHLAB_POOL_STATUS.fund) throw new LaunchLabCurveCompleteError(pool.status);
  if (params.curveType !== LAUNCHLAB_CURVE_TYPE.constantProduct) {
    throw new Error(`LaunchLab curve type ${params.curveType} is not supported (only constant product exists on mainnet)`);
  }
}

const baseSide = (p: LaunchLabCurveState) => p.virtualBase - p.realBase;
const quoteSide = (p: LaunchLabCurveState) => p.virtualQuote + p.realQuote;

/** LaunchConstantProductCurve.buyExactIn: base out for `quoteIn` net of fees (floor). */
export function launchLabCurveBuyExactIn(pool: LaunchLabCurveState, quoteIn: bigint): bigint {
  return (quoteIn * baseSide(pool)) / (quoteSide(pool) + quoteIn);
}

/** LaunchConstantProductCurve.buyExactOut: net quote needed for `baseOut` (ceil). */
export function launchLabCurveBuyExactOut(pool: LaunchLabCurveState, baseOut: bigint): bigint {
  const out = baseSide(pool);
  if (baseOut >= out) throw new RangeError("baseOut exceeds the curve's base side");
  return ceilDiv(quoteSide(pool) * baseOut, out - baseOut);
}

/** LaunchConstantProductCurve.sellExactIn: gross quote out for `baseIn` (floor). */
export function launchLabCurveSellExactIn(pool: LaunchLabCurveState, baseIn: bigint): bigint {
  return (baseIn * quoteSide(pool)) / (baseSide(pool) + baseIn);
}

/** LaunchConstantProductCurve.sellExactOut: base needed for `quoteOut` gross (ceil). */
export function launchLabCurveSellExactOut(pool: LaunchLabCurveState, quoteOut: bigint): bigint {
  const q = quoteSide(pool);
  if (quoteOut >= q) throw new RangeError("quoteOut exceeds the curve's quote side");
  return ceilDiv(baseSide(pool) * quoteOut, q - quoteOut);
}

/** Token-2022 transfer-fee context: configs of the mints that have one, and the current epoch. */
export interface LaunchLabTransferFees {
  base?: TransferFeeConfig | null;
  quote?: TransferFeeConfig | null;
  epoch: bigint;
}

const NO_TRANSFER_FEES: LaunchLabTransferFees = { epoch: 0n };

/** Gross amount whose post-transfer-fee value is `post` (SDK getTransferAmountFeeFromPost). */
function grossForNet(cfg: TransferFeeConfig | null | undefined, epoch: bigint, post: bigint): bigint {
  return cfg ? calculatePreFeeAmount(getEpochFee(cfg, epoch), post) : post;
}

export interface LaunchLabBuyQuote extends LaunchLabFeeSplit {
  /** Quote debited from the user = instruction amount (lower than requested only when `capped`). */
  quoteIn: bigint;
  /** Token-2022 fee withheld on the user -> vault quote transfer. */
  quoteTransferFee: bigint;
  /** Quote reaching the vault = TradeEvent.amount_in. */
  quoteToVault: bigint;
  /** Quote entering the curve (real_quote delta): quoteToVault - totalFee. */
  quoteToCurve: bigint;
  /** Base leaving the vault = TradeEvent.amount_out (real_base delta). */
  baseOut: bigint;
  /** Token-2022 fee withheld on the vault -> user base transfer. */
  baseTransferFee: bigint;
  /** What the user receives: baseOut - baseTransferFee. */
  baseReceived: bigint;
  /** The request exceeded the remaining base; the buy completes the curve (SDK logic, not seen on mainnet). */
  capped: boolean;
}

/** `buy_exact_in(amount_in = quoteIn)`: tokens for a quote budget (fees included), SDK Curve.buyExactIn. */
export function quoteLaunchLabBuyExactIn(
  pool: LaunchLabCurveState,
  quoteIn: bigint,
  params: LaunchLabTradeParams,
  transferFees: LaunchLabTransferFees = NO_TRANSFER_FEES,
): LaunchLabBuyQuote {
  assertTradable(pool, params);
  if (quoteIn <= 0n) throw new RangeError("quoteIn must be > 0");
  const { epoch } = transferFees;
  const totalRate = launchLabTotalFeeRate(params);
  let quoteTransferFee = transferFeeFor(transferFees.quote, epoch, quoteIn);
  let quoteToVault = quoteIn - quoteTransferFee;
  let totalFee = launchLabFee(quoteToVault, totalRate);
  let quoteToCurve = quoteToVault - totalFee;
  let baseOut = launchLabCurveBuyExactIn(pool, quoteToCurve);
  let amountIn = quoteIn;
  let capped = false;
  const remaining = pool.totalBaseSell - pool.realBase;
  if (baseOut > remaining) {
    // Buys past the curve's end are cut to the remaining base and charged its exact-out price.
    capped = true;
    baseOut = remaining;
    quoteToCurve = launchLabCurveBuyExactOut(pool, baseOut);
    quoteToVault = launchLabPreFeeAmount(quoteToCurve, totalRate);
    totalFee = quoteToVault - quoteToCurve;
    amountIn = grossForNet(transferFees.quote, epoch, quoteToVault);
    quoteTransferFee = amountIn - quoteToVault;
  }
  if (baseOut <= 0n) throw new RangeError("buy too small: zero tokens out");
  const baseTransferFee = transferFeeFor(transferFees.base, epoch, baseOut);
  return {
    quoteIn: amountIn,
    quoteTransferFee,
    quoteToVault,
    quoteToCurve,
    ...splitLaunchLabFee(totalFee, params),
    baseOut,
    baseTransferFee,
    baseReceived: baseOut - baseTransferFee,
    capped,
  };
}

/**
 * `buy_exact_out(amount_out = baseWanted)`: quote cost of receiving `baseWanted` (post transfer fee,
 * as the SDK passes it), SDK Curve.buyExactOut. Capped at the remaining base like the SDK.
 */
export function quoteLaunchLabBuyExactOut(
  pool: LaunchLabCurveState,
  baseWanted: bigint,
  params: LaunchLabTradeParams,
  transferFees: LaunchLabTransferFees = NO_TRANSFER_FEES,
): LaunchLabBuyQuote {
  assertTradable(pool, params);
  if (baseWanted <= 0n) throw new RangeError("baseWanted must be > 0");
  const { epoch } = transferFees;
  const totalRate = launchLabTotalFeeRate(params);
  const remaining = pool.totalBaseSell - pool.realBase;
  let baseOut = grossForNet(transferFees.base, epoch, baseWanted);
  const capped = baseWanted > remaining;
  if (capped) baseOut = remaining;
  const quoteToCurve = launchLabCurveBuyExactOut(pool, baseOut);
  const quoteToVault = launchLabPreFeeAmount(quoteToCurve, totalRate);
  const totalFee = quoteToVault - quoteToCurve;
  const quoteIn = grossForNet(transferFees.quote, epoch, quoteToVault);
  const baseTransferFee = transferFeeFor(transferFees.base, epoch, baseOut);
  return {
    quoteIn,
    quoteTransferFee: quoteIn - quoteToVault,
    quoteToVault,
    quoteToCurve,
    ...splitLaunchLabFee(totalFee, params),
    baseOut,
    baseTransferFee,
    baseReceived: baseOut - baseTransferFee,
    capped,
  };
}

export interface LaunchLabSellQuote extends LaunchLabFeeSplit {
  /** Base debited from the user = instruction amount. */
  baseIn: bigint;
  /** Token-2022 fee withheld on the user -> vault base transfer. */
  baseTransferFee: bigint;
  /** Base reaching the curve = TradeEvent.amount_in (real_base decreases by this). */
  baseToVault: bigint;
  /** Quote leaving the curve before fees (real_quote decreases by this). */
  quoteGross: bigint;
  /** Quote leaving the vault to the user = TradeEvent.amount_out. */
  quoteFromVault: bigint;
  /** Token-2022 fee withheld on the vault -> user quote transfer. */
  quoteTransferFee: bigint;
  /** What the user receives. */
  quoteReceived: bigint;
}

/** `sell_exact_in(amount_in = baseIn)`: proceeds of selling `baseIn` (SDK Curve.sellExactIn). */
export function quoteLaunchLabSellExactIn(
  pool: LaunchLabCurveState,
  baseIn: bigint,
  params: LaunchLabTradeParams,
  transferFees: LaunchLabTransferFees = NO_TRANSFER_FEES,
): LaunchLabSellQuote {
  assertTradable(pool, params);
  if (baseIn <= 0n) throw new RangeError("baseIn must be > 0");
  const { epoch } = transferFees;
  const baseTransferFee = transferFeeFor(transferFees.base, epoch, baseIn);
  const baseToVault = baseIn - baseTransferFee;
  const quoteGross = launchLabCurveSellExactIn(pool, baseToVault);
  if (quoteGross > pool.realQuote) throw new RangeError("sell exceeds the quote raised by the curve");
  const totalFee = launchLabFee(quoteGross, launchLabTotalFeeRate(params));
  const quoteFromVault = quoteGross - totalFee;
  const quoteTransferFee = transferFeeFor(transferFees.quote, epoch, quoteFromVault);
  return {
    baseIn,
    baseTransferFee,
    baseToVault,
    quoteGross,
    ...splitLaunchLabFee(totalFee, params),
    quoteFromVault,
    quoteTransferFee,
    quoteReceived: quoteFromVault - quoteTransferFee,
  };
}

/** `sell_exact_out(amount_out = quoteWanted)`: base needed to receive `quoteWanted` (SDK Curve.sellExactOut). */
export function quoteLaunchLabSellExactOut(
  pool: LaunchLabCurveState,
  quoteWanted: bigint,
  params: LaunchLabTradeParams,
  transferFees: LaunchLabTransferFees = NO_TRANSFER_FEES,
): LaunchLabSellQuote {
  assertTradable(pool, params);
  if (quoteWanted <= 0n) throw new RangeError("quoteWanted must be > 0");
  const { epoch } = transferFees;
  const quoteFromVault = grossForNet(transferFees.quote, epoch, quoteWanted);
  const quoteGross = launchLabPreFeeAmount(quoteFromVault, launchLabTotalFeeRate(params));
  if (quoteGross > pool.realQuote) throw new RangeError("insufficient liquidity: sell exceeds the quote raised");
  const baseToVault = launchLabCurveSellExactOut(pool, quoteGross);
  if (baseToVault > pool.realBase) throw new RangeError("sell exceeds the base sold by the curve");
  const baseIn = grossForNet(transferFees.base, epoch, baseToVault);
  return {
    baseIn,
    baseTransferFee: baseIn - baseToVault,
    baseToVault,
    quoteGross,
    ...splitLaunchLabFee(quoteGross - quoteFromVault, params),
    quoteFromVault,
    quoteTransferFee: quoteFromVault - quoteWanted,
    quoteReceived: quoteWanted,
  };
}

/** Pool state after a buy (TradeEvent real_*_after). Status flips when the last base is sold (inferred). */
export function applyLaunchLabBuy<T extends LaunchLabCurveState>(pool: T, q: Pick<LaunchLabBuyQuote, "baseOut" | "quoteToCurve">): T {
  const realBase = pool.realBase + q.baseOut;
  return {
    ...pool,
    realBase,
    realQuote: pool.realQuote + q.quoteToCurve,
    status: realBase >= pool.totalBaseSell ? LAUNCHLAB_POOL_STATUS.migrate : pool.status,
  };
}

/** Pool state after a sell. */
export function applyLaunchLabSell<T extends LaunchLabCurveState>(pool: T, q: Pick<LaunchLabSellQuote, "baseToVault" | "quoteGross">): T {
  return { ...pool, realBase: pool.realBase - q.baseToVault, realQuote: pool.realQuote - q.quoteGross };
}

/**
 * Bonding progress in basis points. `base` (default, the SPEC's definition) = base sold / total_base_sell;
 * `quote` = quote raised / total_quote_fund_raising (the graduation target). Both reach 10,000 together.
 */
export function launchLabProgressBps(pool: LaunchLabCurveState, basis: "base" | "quote" = "base"): number {
  if (pool.status !== LAUNCHLAB_POOL_STATUS.fund) return 10_000;
  const [done, target] = basis === "base" ? [pool.realBase, pool.totalBaseSell] : [pool.realQuote, pool.totalQuoteFundRaising];
  if (target <= 0n) return 0;
  const bps = (done * 10_000n) / target;
  return Number(bps > 10_000n ? 10_000n : bps);
}

/** Display-only spot price (quote UI per base UI): (vQ + rQ) / (vB - rB). */
export function launchLabSpotPrice(pool: LaunchLabCurveState, baseDecimals: number, quoteDecimals: number): number {
  const b = baseSide(pool);
  if (b <= 0n) return 0;
  return Number(quoteSide(pool)) / 10 ** quoteDecimals / (Number(b) / 10 ** baseDecimals);
}

/** Market cap in quote base units at the spot price: supply * (vQ + rQ) / (vB - rB). */
export function launchLabMarketCap(pool: LaunchLabCurveState, supply: bigint): bigint {
  const b = baseSide(pool);
  if (b <= 0n) throw new RangeError("curve base side is zero");
  return (supply * quoteSide(pool)) / b;
}
