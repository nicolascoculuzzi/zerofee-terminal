import { fmtSol } from "../../lib/format";
import type { Quote } from "../../lib/quote";
import type { CurveState, Venue } from "../../protocol";
import type { ExecutionSettings } from "../../services/tradeService";

/*
 * Pure trade-panel math: the cost breakdown (DESIGN.md 4.11 item 7), Max, amount validation
 * (4.7), the exit-ladder nonce count, line snapping (4.10) and migration MC. Kept free of React
 * so it is unit tested. (The 1.7 countdown confirm for flagged buys lives in lib/tradeActions.)
 */

/** Solana base fee per signature. */
export const NETWORK_FEE_SOL = 0.000005;
/** Associated token account rent, refundable when the account closes (first buy only). */
export const ATA_RENT_SOL = 0.00203928;
export const MIN_BUY_SOL = 0.001;

const VENUE_SHORT: Record<Venue, string> = {
  pump_curve: "pump.fun",
  pumpswap: "PumpSwap",
  launchlab: "LaunchLab",
  raydium_cpmm: "Raydium",
  meteora_dbc: "Meteora DBC",
  meteora_damm_v2: "Meteora",
  other: "venue",
};

export function venueShort(venue: Venue): string {
  return VENUE_SHORT[venue];
}

export interface CostLines {
  /** SOL in (buy, incl. the venue fee) or gross SOL out (sell). */
  amountSol: number;
  venueFeeSol: number;
  /** Venue fee rate, % (pump.fun curve 1.25). */
  venuePct: number;
  priorityFeeSol: number;
  tipSol: number;
  baseFeeSol: number;
  /** ATA rent on a first buy, else 0. */
  rentSol: number;
  /** Buy: tokens received (est.). Sell: tokens sold. */
  tokens: number;
  impactPct: number;
  /** Buy: total SOL leaving the wallet. Sell: net SOL arriving. */
  totalSol: number;
}

export function buyCost(quote: Quote | null, sol: number, settings: ExecutionSettings, firstBuy: boolean, feeBps: number): CostLines {
  const rentSol = firstBuy ? ATA_RENT_SOL : 0;
  return {
    amountSol: sol,
    venueFeeSol: quote?.venueFeeSol ?? 0,
    venuePct: feeBps / 100,
    priorityFeeSol: settings.priorityFeeSol,
    tipSol: settings.tipSol,
    baseFeeSol: NETWORK_FEE_SOL,
    rentSol,
    tokens: quote?.tokens ?? 0,
    impactPct: quote?.impactPct ?? 0,
    totalSol: sol + settings.priorityFeeSol + settings.tipSol + NETWORK_FEE_SOL + rentSol,
  };
}

export function sellCost(quote: Quote | null, settings: ExecutionSettings, feeBps: number): CostLines {
  const gross = quote ? quote.sol + quote.venueFeeSol : 0;
  const net = quote ? quote.sol - settings.priorityFeeSol - settings.tipSol - NETWORK_FEE_SOL : 0;
  return {
    amountSol: gross,
    venueFeeSol: quote?.venueFeeSol ?? 0,
    venuePct: feeBps / 100,
    priorityFeeSol: settings.priorityFeeSol,
    tipSol: settings.tipSol,
    baseFeeSol: NETWORK_FEE_SOL,
    rentSol: 0,
    tokens: quote?.tokens ?? 0,
    impactPct: quote?.impactPct ?? 0,
    totalSol: Math.max(0, net),
  };
}

/** Max buy: the available balance minus fees, tip and (first buy) rent, floored to 0.0001 SOL. */
export function maxBuySol(available: number, settings: ExecutionSettings, firstBuy: boolean): number {
  const reserve = settings.priorityFeeSol + settings.tipSol + NETWORK_FEE_SOL + (firstBuy ? ATA_RENT_SOL : 0);
  const v = Math.floor(Math.max(0, available - reserve) * 10_000) / 10_000;
  return Math.round(v * 10_000) / 10_000;
}

export type IssueAction = "caps" | "fund";

export interface AmountIssue {
  /** Helper line colour under the input. */
  tone: "sell" | "warn";
  /** The 11 px helper line ("Exceeds balance by 0.12 SOL"). */
  text: string;
  /** Short reason on the disabled CTA ("Exceeds balance"). */
  cta: string;
  action?: IssueAction;
}

/** Validation for a buy amount (DESIGN.md 4.7): balance, per-trade cap, daily cap, minimum. */
export function buyIssue(args: {
  sol: number | null;
  available: number;
  settings: ExecutionSettings;
  firstBuy: boolean;
  perTradeCap: number;
  dailyCap: number;
  spentToday: number;
}): AmountIssue | null {
  const { sol } = args;
  if (sol === null || !(sol > 0)) return null;
  if (sol > args.perTradeCap) {
    return { tone: "warn", text: `Above your ${fmtSol(args.perTradeCap)} SOL per-trade cap`, cta: "Above per-trade cap", action: "caps" };
  }
  if (args.spentToday + sol > args.dailyCap) {
    return { tone: "warn", text: `Above your ${fmtSol(args.dailyCap)} SOL daily cap`, cta: "Above daily cap", action: "caps" };
  }
  const need = sol + args.settings.priorityFeeSol + args.settings.tipSol + NETWORK_FEE_SOL + (args.firstBuy ? ATA_RENT_SOL : 0);
  if (need > args.available + 1e-12) {
    return { tone: "sell", text: `Exceeds balance by ${fmtSol(need - args.available)} SOL`, cta: "Exceeds balance", action: "fund" };
  }
  if (sol < MIN_BUY_SOL) return { tone: "warn", text: `Minimum ${MIN_BUY_SOL} SOL`, cta: `Minimum ${MIN_BUY_SOL} SOL` };
  return null;
}

/** Nonce slots an exit ladder needs: OCO pairs TP[i] with SL[i] on one nonce (SPEC "Armed orders"). */
export function ladderNonceSlots(legs: readonly { kind: "take_profit" | "stop_loss" }[], oco: boolean): number {
  const tps = legs.filter((l) => l.kind === "take_profit").length;
  const sls = legs.length - tps;
  return legs.length - (oco ? Math.min(tps, sls) : 0);
}

/** Snaps `price` to 0.5% steps of the current price (DESIGN.md 4.10); Alt disables snapping. */
export function snapPrice(price: number, current: number, stepPct = 0.5): number {
  if (!(current > 0) || !(price > 0)) return price;
  const pct = (price / current - 1) * 100;
  const snapped = Math.round(pct / stepPct) * stepPct;
  return Math.max(current * 0.001, current * (1 + snapped / 100));
}

/** Moves `price` by `stepPct` of the current price (keyboard Up/Down on a line handle). */
export function nudgePrice(price: number, current: number, stepPct: number): number {
  if (!(current > 0)) return price;
  const pct = (price / current - 1) * 100;
  const next = Math.round((pct + stepPct) / 0.5) * 0.5;
  return Math.max(current * 0.001, current * (1 + next / 100));
}

/** Signed distance of a target from the current price, %. */
export function distancePct(target: number, current: number): number {
  return current > 0 ? (target / current - 1) * 100 : 0;
}

/**
 * Spot price (SOL per token) at which the bonding curve completes: the constant product with
 * the remaining real tokens bought out. Null once complete or without a curve.
 */
export function migrationPriceSol(curve: CurveState | null): number | null {
  if (!curve || curve.complete) return null;
  const k = curve.virtualQuoteReserves * curve.virtualTokenReserves;
  const finalTokens = curve.virtualTokenReserves - curve.realTokenReserves;
  if (!(finalTokens > 0) || !(k > 0)) return null;
  return k / (finalTokens * finalTokens);
}

/** Trade-size bar width behind a tape row, % of the row (10 SOL fills 60%). */
export function sizeBarPct(sol: number): number {
  if (!(sol > 0)) return 0;
  return 60 * Math.min(1, Math.log10(1 + sol) / Math.log10(11));
}
