/**
 * Pump-style bonding curve and constant-product pool math for the simulation.
 * Constants match the live pump.fun Global account (research notes, 2026-10-03):
 * 30 SOL virtual quote, 1,073,000,000 virtual tokens, 793,100,000 real tokens, 1B supply,
 * 1.25% fee per side, 0.015 SOL migration fee. The real engine lives in `packages/core`
 * and works in bigint base units; this float version only drives the mock feed.
 */
export const PUMP = {
  initialVirtualSol: 30,
  initialVirtualTokens: 1_073_000_000,
  initialRealTokens: 793_100_000,
  totalSupply: 1_000_000_000,
  feeBps: 125,
  migrationFeeSol: 0.015,
} as const;

export interface SimCurve {
  vSol: number;
  vTok: number;
  realSol: number;
  realTok: number;
  initialRealTok: number;
  /** Tokens reserved for the pool at migration (supply − initial real tokens). */
  reservedTok: number;
  complete: boolean;
  feeBps: number;
}

export interface SimPool {
  sol: number;
  tok: number;
  feeBps: number;
  address: string;
}

/** `scale` = 2 for mayhem coins (2B supply). */
export function newCurve(scale = 1): SimCurve {
  return {
    vSol: PUMP.initialVirtualSol,
    vTok: PUMP.initialVirtualTokens * scale,
    realSol: 0,
    realTok: PUMP.initialRealTokens * scale,
    initialRealTok: PUMP.initialRealTokens * scale,
    reservedTok: (PUMP.totalSupply - PUMP.initialRealTokens) * scale,
    complete: false,
    feeBps: PUMP.feeBps,
  };
}

export function curvePrice(c: SimCurve): number {
  return c.vSol / c.vTok;
}

export function curveProgress(c: SimCurve): number {
  return Math.min(1, Math.max(0, 1 - c.realTok / c.initialRealTok));
}

export interface SwapResult {
  /** SOL paid by the buyer incl. venue fee, or SOL received by the seller net of the fee. */
  sol: number;
  tokens: number;
  feeSol: number;
  /** True when a buy hit the end of the curve and was capped. */
  capped: boolean;
}

export function quoteCurveBuy(c: SimCurve, grossSol: number): SwapResult {
  const fee = 1 + c.feeBps / 10_000;
  let net = grossSol / fee;
  let tokens = (net * c.vTok) / (c.vSol + net);
  let capped = false;
  if (tokens >= c.realTok) {
    tokens = c.realTok;
    net = (c.vSol * tokens) / (c.vTok - tokens);
    capped = true;
  }
  const gross = net * fee;
  return { sol: gross, tokens, feeSol: gross - net, capped };
}

export function applyCurveBuy(c: SimCurve, q: SwapResult): void {
  const net = q.sol - q.feeSol;
  c.vSol += net;
  c.vTok -= q.tokens;
  c.realSol += net;
  c.realTok -= q.tokens;
  if (c.realTok <= 1e-6) {
    c.realTok = 0;
    c.complete = true;
  }
}

export function quoteCurveSell(c: SimCurve, tokens: number): SwapResult {
  const gross = (tokens * c.vSol) / (c.vTok + tokens);
  const bounded = Math.min(gross, c.realSol);
  const feeSol = (bounded * c.feeBps) / 10_000;
  return { sol: bounded - feeSol, tokens, feeSol, capped: false };
}

export function applyCurveSell(c: SimCurve, q: SwapResult): void {
  const gross = q.sol + q.feeSol;
  c.vSol -= gross;
  c.vTok += q.tokens;
  c.realSol = Math.max(0, c.realSol - gross);
  c.realTok += q.tokens;
}

/** Pool created at migration: curve SOL minus the migration fee against the reserved tokens. */
export function poolFromCurve(c: SimCurve, address: string): SimPool {
  return {
    sol: Math.max(1, c.realSol - PUMP.migrationFeeSol),
    tok: c.reservedTok,
    feeBps: 125,
    address,
  };
}

export function poolPrice(p: SimPool): number {
  return p.sol / p.tok;
}

/** PumpSwap canonical-pool fee tiers by pool market cap in SOL (simplified). */
export function poolFeeBps(marketCapSol: number): number {
  if (marketCapSol < 420) return 125;
  if (marketCapSol < 1_470) return 120;
  if (marketCapSol < 4_420) return 110;
  if (marketCapSol < 9_820) return 100;
  return 90;
}

export function quotePoolBuy(p: SimPool, grossSol: number): SwapResult {
  const fee = 1 + p.feeBps / 10_000;
  const net = grossSol / fee;
  const tokens = (p.tok * net) / (p.sol + net);
  return { sol: grossSol, tokens, feeSol: grossSol - net, capped: false };
}

export function applyPoolBuy(p: SimPool, q: SwapResult): void {
  p.sol += q.sol - q.feeSol;
  p.tok -= q.tokens;
}

export function quotePoolSell(p: SimPool, tokens: number): SwapResult {
  const gross = (p.sol * tokens) / (p.tok + tokens);
  const feeSol = (gross * p.feeBps) / 10_000;
  return { sol: gross - feeSol, tokens, feeSol, capped: false };
}

export function applyPoolSell(p: SimPool, q: SwapResult): void {
  p.sol -= q.sol + q.feeSol;
  p.tok += q.tokens;
}
