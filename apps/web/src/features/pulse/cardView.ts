import { fmtCount, fmtRiskPct, fmtSol, fmtUsd } from "../../lib/format";
import { type RiskThresholds, token2022Danger } from "../../lib/metrics";
import type { Launchpad, TokenSummary } from "../../protocol";
import type { QuoteCurrency } from "../../state/settings";
import { riskKey } from "./RiskChips";

/**
 * Display model of a Pulse card: the strings and flags it shows, computed once per flush by the
 * column. Cards are memoised on this model, so a token update re-renders only the cards whose
 * displayed strings changed (DESIGN.md 8, "Re-render scope").
 */

/** By column width (DESIGN.md 4.4): narrow under 424 px, wide to 599 px, wide+ from 600 px. */
export type CardVariant = "narrow" | "wide" | "wideplus";

export function variantFor(width: number): CardVariant {
  if (width >= 600) return "wideplus";
  if (width >= 424) return "wide";
  return "narrow";
}

export interface CardView {
  mint: string;
  symbol: string;
  name: string;
  imageUri: string | null;
  launchpad: Launchpad;
  /** Bonding progress for the avatar ring, in whole percent; -1 hides the ring. */
  ring: number;
  migrated: boolean;
  createdAt: number;
  lastTradeAt: number;
  /** Social links ("" when absent). */
  x: string;
  web: string;
  tg: string;
  holders: string;
  pros: string;
  /** Tracked wallets holding (Eye counter, shown above 0). */
  tracked: number;
  /** Changes when any risk chip's text or band changes. */
  risk: string;
  dex: boolean;
  t22: boolean;
  /** "LP 100%" on migrated non-pump pools, "" otherwise. */
  lp: string;
  lpTone: "neutral" | "warn" | "bad";
  mc: string;
  v: string;
  tx: string;
  /** Buy share of txns in whole percent; -1 with no txns. */
  buyPct: number;
  fees: string;
  /** Values are in SOL (the global quote), so MC and V get the SOL glyph. */
  sol: boolean;
}

export interface CardContext {
  quote: QuoteCurrency;
  solUsd: number;
  showRing: boolean;
  thresholds: RiskThresholds;
  tracked: number;
}

function lpFlag(t: TokenSummary): { lp: string; lpTone: CardView["lpTone"] } {
  const pumpPool = t.venue === "pumpswap" || t.venue === "pump_curve";
  if (t.migratedAt === null || pumpPool || t.lpBurnedPct === null) return { lp: "", lpTone: "neutral" };
  const pct = t.lpBurnedPct;
  return { lp: `LP ${fmtRiskPct(pct)}`, lpTone: pct >= 100 ? "neutral" : pct <= 0 ? "bad" : "warn" };
}

export function cardView(t: TokenSummary, ctx: CardContext): CardView {
  const sol = ctx.quote === "SOL" && ctx.solUsd > 0;
  const { lp, lpTone } = lpFlag(t);
  return {
    mint: t.mint,
    symbol: t.symbol,
    name: t.name,
    imageUri: t.imageUri,
    launchpad: t.launchpad,
    ring: ctx.showRing ? Math.floor(Math.max(0, Math.min(1, t.bondingProgress)) * 100) : -1,
    migrated: t.migratedAt !== null,
    createdAt: t.createdAt,
    lastTradeAt: t.lastTradeAt,
    x: t.socials.x ?? "",
    web: t.socials.website ?? "",
    tg: t.socials.telegram ?? "",
    holders: fmtCount(t.holders),
    pros: fmtCount(t.proTraders),
    tracked: ctx.tracked,
    risk: riskKey(t.risk, ctx.thresholds),
    dex: t.dexPaid,
    t22: token2022Danger(t.token2022).length > 0,
    lp,
    lpTone,
    mc: sol ? fmtSol(t.marketCapSol) : fmtUsd(t.marketCapUsd),
    v: sol ? fmtSol(t.volumeUsd / ctx.solUsd) : fmtUsd(t.volumeUsd),
    tx: fmtCount(t.txns),
    buyPct: t.txns > 0 ? Math.round((t.buys / t.txns) * 100) : -1,
    fees: fmtSol(t.feesPaidSol),
    sol,
  };
}

export function sameCardView(a: CardView, b: CardView): boolean {
  if (a === b) return true;
  for (const k of Object.keys(a) as (keyof CardView)[]) if (a[k] !== b[k]) return false;
  return true;
}
