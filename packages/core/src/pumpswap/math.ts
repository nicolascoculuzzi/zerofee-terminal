/**
 * PumpSwap constant-product quote math (pure bigint).
 *
 * CRITICAL: price off EFFECTIVE quote reserves = pool_quote_token_account.amount +
 * Pool.virtual_quote_reserves (signed i128). Raw-vault math under-quotes boost-pool buys by ~18%.
 * Verified to the lamport on mainnet tx 4kQsV2g3… (notes §4). Fees: lp, protocol, creator each
 * ceil(amount*bps/1e4); creator 0 when coin_creator is the default key; buyback is carved out of
 * the protocol fee. Mirrors pump-swap-sdk 1.20.0 src/sdk/buy.ts, sell.ts, fees.ts, util.ts.
 */
import { BPS_DENOMINATOR, DEFAULT_PUBKEY, PUMP_AMM_TOTAL_TOKEN_SUPPLY } from "../constants";
import { applyCreatorFeeOverride, type FeeConfig, feesForQuoteMint } from "../fees";
import { ceilDiv, feeCeil } from "../util/math";
import type { AmmGlobalConfig, Pool } from "./accounts";

export interface AmmReserves {
  /** Raw base vault amount. */
  baseReserve: bigint;
  /** Raw quote vault amount (real liquidity - sells cannot take more than this). */
  quoteVaultReserve: bigint;
  /** Signed Pool.virtual_quote_reserves. */
  virtualQuoteReserves: bigint;
}

/** vault + virtual; guaranteed non-negative and to fit u64 by the program (NEGATIVE_VIRTUAL_QUOTE_RESERVES.md). */
export function effectiveQuoteReserve(r: Pick<AmmReserves, "quoteVaultReserve" | "virtualQuoteReserves">): bigint {
  const eff = r.quoteVaultReserve + r.virtualQuoteReserves;
  if (eff < 0n) throw new RangeError(`negative effective quote reserves (${eff})`);
  return eff;
}

export interface AmmFeeRates {
  lpFeeBps: bigint;
  protocolFeeBps: bigint;
  /** 0 when pool.coin_creator is the default key. */
  creatorFeeBps: bigint;
  buybackBps: bigint;
}

/**
 * Pool market cap (pump-amm Pool::market_cap): effQ * supply / baseReserve where supply is the live
 * base mint supply for normal pools and a fixed 1e15 for MAYHEM pools. Note this is the opposite
 * convention to the curve's pump-sdk getFee (notes §4 "market-cap basis conflict").
 */
export function poolMarketCap(args: {
  baseReserve: bigint;
  effectiveQuoteReserve: bigint;
  baseMintSupply: bigint;
  isMayhemMode: boolean;
}): bigint {
  if (args.baseReserve === 0n) throw new RangeError("pool base reserve is zero");
  const supply = args.isMayhemMode ? PUMP_AMM_TOTAL_TOKEN_SUPPLY : args.baseMintSupply;
  return (args.effectiveQuoteReserve * supply) / args.baseReserve;
}

export function ammFeeRates(args: {
  pool: Pick<Pool, "quoteMint" | "isMayhemMode" | "coinCreator" | "creatorFeeBps">;
  /** pool.creator == pool_authority PDA(base_mint) - see isCanonicalPumpPool(). */
  isCanonical: boolean;
  reserves: AmmReserves;
  baseMintSupply: bigint;
  feeConfig: FeeConfig | null;
  globalConfig: Pick<
    AmmGlobalConfig,
    "lpFeeBasisPoints" | "protocolFeeBasisPoints" | "coinCreatorFeeBasisPoints" | "creatorFeeConfigurable" | "buybackBasisPoints"
  >;
}): AmmFeeRates {
  const { pool, feeConfig, globalConfig } = args;
  let lpFeeBps: bigint;
  let protocolFeeBps: bigint;
  let creatorFeeBps: bigint;
  if (feeConfig) {
    const marketCap = poolMarketCap({
      baseReserve: args.reserves.baseReserve,
      effectiveQuoteReserve: effectiveQuoteReserve(args.reserves),
      baseMintSupply: args.baseMintSupply,
      isMayhemMode: pool.isMayhemMode,
    });
    const f = applyCreatorFeeOverride(
      feesForQuoteMint({ feeConfig, quoteMint: pool.quoteMint, marketCap, isPumpPool: args.isCanonical }),
      globalConfig.creatorFeeConfigurable,
      pool.creatorFeeBps,
    );
    lpFeeBps = f.lpFeeBps;
    protocolFeeBps = f.protocolFeeBps;
    creatorFeeBps = f.creatorFeeBps;
  } else {
    lpFeeBps = globalConfig.lpFeeBasisPoints;
    protocolFeeBps = globalConfig.protocolFeeBasisPoints;
    creatorFeeBps = globalConfig.coinCreatorFeeBasisPoints;
  }
  if (pool.coinCreator === DEFAULT_PUBKEY) creatorFeeBps = 0n;
  return { lpFeeBps, protocolFeeBps, creatorFeeBps, buybackBps: globalConfig.buybackBasisPoints };
}

export interface AmmFeeBreakdown {
  lpFee: bigint;
  protocolFee: bigint;
  creatorFee: bigint;
  /** floor(protocolFee * buybackBps / 1e4) - part of protocolFee (verified ≈50%, floor). */
  buybackFee: bigint;
  totalFee: bigint;
}

export function ammFees(amount: bigint, r: AmmFeeRates): AmmFeeBreakdown {
  const lpFee = feeCeil(amount, r.lpFeeBps);
  const protocolFee = feeCeil(amount, r.protocolFeeBps);
  const creatorFee = feeCeil(amount, r.creatorFeeBps);
  return {
    lpFee,
    protocolFee,
    creatorFee,
    buybackFee: (protocolFee * r.buybackBps) / BPS_DENOMINATOR,
    totalFee: lpFee + protocolFee + creatorFee,
  };
}

export interface AmmBuyQuote extends AmmFeeBreakdown {
  baseOut: bigint;
  /** Quote entering the pool before fees (BuyEvent quote_amount_in). */
  quoteIn: bigint;
  /** Total the user pays: quoteIn + fees (BuyEvent user_quote_amount_in). */
  totalQuote: bigint;
}

/** `buy` (exact base out): quote_in = ceil(effQ*base/(baseR-base)). */
export function quoteAmmBuyExactBase(reserves: AmmReserves, baseOut: bigint, rates: AmmFeeRates): AmmBuyQuote {
  if (baseOut <= 0n) throw new RangeError("baseOut must be > 0");
  if (reserves.baseReserve === 0n) throw new RangeError("empty pool");
  if (baseOut >= reserves.baseReserve) throw new RangeError("cannot buy the whole base reserve");
  const effQ = effectiveQuoteReserve(reserves);
  const quoteIn = ceilDiv(effQ * baseOut, reserves.baseReserve - baseOut);
  const fees = ammFees(quoteIn, rates);
  return { baseOut, quoteIn, ...fees, totalQuote: quoteIn + fees.totalFee };
}

/**
 * `buy_exact_quote_in` (spend a fixed budget, fees deducted from it):
 *   eff = floor(spendable*1e4/(1e4+totalBps)), reduced if the ceil-rounded fees overshoot;
 *   base_out = floor(baseR*(eff-1)/(effQ+eff-1)).
 */
export function quoteAmmBuyExactQuoteIn(reserves: AmmReserves, spendable: bigint, rates: AmmFeeRates): AmmBuyQuote {
  if (spendable <= 1n) throw new RangeError("spendable must be > 1");
  const effQ = effectiveQuoteReserve(reserves);
  const totalBps = rates.lpFeeBps + rates.protocolFeeBps + rates.creatorFeeBps;
  let quoteIn = (spendable * BPS_DENOMINATOR) / (BPS_DENOMINATOR + totalBps);
  let fees = ammFees(quoteIn, rates);
  if (quoteIn + fees.totalFee > spendable) {
    quoteIn -= quoteIn + fees.totalFee - spendable;
    fees = ammFees(quoteIn, rates);
  }
  const input = quoteIn - 1n;
  const baseOut = (reserves.baseReserve * input) / (effQ + input);
  return { baseOut, quoteIn, ...fees, totalQuote: quoteIn + fees.totalFee };
}

export interface AmmSellQuote extends AmmFeeBreakdown {
  baseIn: bigint;
  /** Quote leaving the pool before fees. */
  quoteOutGross: bigint;
  /** What the seller receives. */
  quoteOutNet: bigint;
}

/** `sell` (exact base in): quote_out = floor(effQ*base/(baseR+base)); user gets quote_out - fees. */
export function quoteAmmSell(reserves: AmmReserves, baseIn: bigint, rates: AmmFeeRates): AmmSellQuote {
  if (baseIn <= 0n) throw new RangeError("baseIn must be > 0");
  const effQ = effectiveQuoteReserve(reserves);
  const quoteOutGross = (effQ * baseIn) / (reserves.baseReserve + baseIn);
  const fees = ammFees(quoteOutGross, rates);
  // The SDK refuses if the REAL vault cannot cover the output (boost liquidity is virtual).
  if (reserves.quoteVaultReserve < quoteOutGross - fees.lpFee) {
    throw new RangeError("insufficient real quote reserves to cover the sell output");
  }
  const quoteOutNet = quoteOutGross - fees.totalFee;
  if (quoteOutNet < 0n) throw new RangeError("fees exceed sell output");
  return { baseIn, quoteOutGross, ...fees, quoteOutNet };
}

/** Display-only spot price in quote UI per base UI. */
export function ammSpotPrice(reserves: AmmReserves, quoteDecimals: number, baseDecimals: number): number {
  if (reserves.baseReserve === 0n) return 0;
  return Number(effectiveQuoteReserve(reserves)) / 10 ** quoteDecimals / (Number(reserves.baseReserve) / 10 ** baseDecimals);
}
