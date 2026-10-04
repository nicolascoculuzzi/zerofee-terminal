import type { CurveState, PoolState } from "../protocol";

/**
 * Display quotes computed locally from the streamed curve/pool state (SPEC: no quote API on the
 * hot path). Float math for the UI only; packages/core does the exact bigint version when
 * building transactions.
 */
export interface Quote {
  /** Tokens received (buy) or sold (sell). */
  tokens: number;
  /** SOL paid incl. venue fee (buy) or received net of it (sell). */
  sol: number;
  venueFeeSol: number;
  /** Execution price vs spot, %. Never negative. */
  impactPct: number;
  /** Buy hit the end of the curve and was capped. */
  capped: boolean;
}

export function quoteBuy(curve: CurveState | null, pool: PoolState | null, sol: number): Quote | null {
  if (!(sol > 0)) return null;
  if (pool) {
    const fee = 1 + pool.feeBps / 10_000;
    const net = sol / fee;
    const tokens = (pool.baseReserves * net) / (pool.quoteReserves + net);
    const spot = pool.quoteReserves / pool.baseReserves;
    return { tokens, sol, venueFeeSol: sol - net, impactPct: Math.max(0, (sol / tokens / spot - 1) * 100), capped: false };
  }
  if (curve && !curve.complete) {
    const fee = 1 + curve.feeBps / 10_000;
    let net = sol / fee;
    let tokens = (net * curve.virtualTokenReserves) / (curve.virtualQuoteReserves + net);
    let capped = false;
    if (tokens >= curve.realTokenReserves) {
      tokens = curve.realTokenReserves;
      net = (curve.virtualQuoteReserves * tokens) / (curve.virtualTokenReserves - tokens);
      capped = true;
    }
    const gross = net * fee;
    const spot = curve.virtualQuoteReserves / curve.virtualTokenReserves;
    return { tokens, sol: gross, venueFeeSol: gross - net, impactPct: Math.max(0, (gross / tokens / spot - 1) * 100), capped };
  }
  return null;
}

export function quoteSell(curve: CurveState | null, pool: PoolState | null, tokens: number): Quote | null {
  if (!(tokens > 0)) return null;
  if (pool) {
    const gross = (pool.quoteReserves * tokens) / (pool.baseReserves + tokens);
    const fee = (gross * pool.feeBps) / 10_000;
    const spot = pool.quoteReserves / pool.baseReserves;
    return { tokens, sol: gross - fee, venueFeeSol: fee, impactPct: Math.max(0, (1 - (gross - fee) / tokens / spot) * 100), capped: false };
  }
  if (curve && !curve.complete) {
    const gross = Math.min((tokens * curve.virtualQuoteReserves) / (curve.virtualTokenReserves + tokens), curve.realQuoteReserves);
    const fee = (gross * curve.feeBps) / 10_000;
    const spot = curve.virtualQuoteReserves / curve.virtualTokenReserves;
    return { tokens, sol: gross - fee, venueFeeSol: fee, impactPct: Math.max(0, (1 - (gross - fee) / tokens / spot) * 100), capped: false };
  }
  return null;
}
