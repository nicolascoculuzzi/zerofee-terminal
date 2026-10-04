/**
 * Quote-mint handling. pump curves store `Pubkey::default()` as the quote of SOL coins; PumpSwap pools
 * use wSOL. We normalize both to wSOL. Values are converted to SOL for display: 1:1 for SOL-like
 * quotes, via SOL/USD for USD stables, and not at all for unknown quotes (conversion = null).
 */
import { DEFAULT_PUBKEY, NATIVE_MINT_2022, STABLE_QUOTE_MINTS, USDC_MINT, WSOL_MINT } from "@zerofee/core";

export function normalizeQuoteMint(mint: string | null | undefined): string {
  if (!mint || mint === DEFAULT_PUBKEY || mint === WSOL_MINT || mint === NATIVE_MINT_2022) return WSOL_MINT;
  return mint;
}

export function isSolQuote(mint: string): boolean {
  return normalizeQuoteMint(mint) === WSOL_MINT;
}

const STABLES = new Set<string>(STABLE_QUOTE_MINTS);

/** Decimals of the quotes we know without an RPC read (pump coins are always 6 dp). */
export function knownQuoteDecimals(mint: string): number | null {
  if (isSolQuote(mint)) return 9;
  if (mint === USDC_MINT) return 6;
  return null;
}

/** SOL per 1 UI unit of the quote mint, or null when unknown. */
export function quoteSolRate(quoteMint: string, solUsd: number | null): number | null {
  if (isSolQuote(quoteMint)) return 1;
  if (STABLES.has(quoteMint)) return solUsd && solUsd > 0 ? 1 / solUsd : null;
  return null;
}

/** Base units -> UI float (display only). */
export function ui(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}
