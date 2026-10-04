import { isKnown } from "../../lib/format";
import type { TokenSummary } from "../../protocol";

export type TrendWindow = "5m" | "1h" | "6h" | "24h";

export const TREND_WINDOWS: TrendWindow[] = ["5m", "1h", "6h", "24h"];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const WINDOW_MS: Record<TrendWindow, number> = {
  "5m": 5 * MINUTE,
  "1h": HOUR,
  "6h": 6 * HOUR,
  "24h": 24 * HOUR,
};

/**
 * Trending heuristic. The live set only carries cumulative stats (volume and txns since launch,
 * a rolling 24 h volume past one day, plus a 5-minute price change), so per-window activity is
 * estimated:
 *
 * 5m:        score = change5mPct × activity × confidence
 *            activity   = e^(−secondsSinceLastTrade / 90)   1 for a trade just now, about 0.5
 *                                                           after a minute, 0.04 after five
 *            confidence = min(1, txns / 25)                  so a two-trade coin can't top the
 *                                                           list on a single print
 *
 * 1h/6h/24h: score = log10(1 + volumeInWindow) + 0.6 × log10(1 + txnsInWindow), and 0 when the
 *            last trade is older than the window
 *            share          = min(1, window / min(age, 24 h))   the age factor: a coin younger
 *                                                               than the window contributes all
 *                                                               of its volume; an older one is
 *                                                               assumed to have traded evenly
 *                                                               over its life (or over the last
 *                                                               24 h, which volumeUsd already is)
 *            volumeInWindow = volumeUsd × share
 *            txnsInWindow   = txns × share
 *
 * A tiny log-volume term breaks ties. When the gateway serves real windowed stats this module
 * is the only thing to replace. Unknown inputs (null from the live server) contribute nothing: a coin
 * with an unknown volume or 5-minute change cannot trend on it.
 */
export function trendScore(t: TokenSummary, window: TrendWindow, now: number): number {
  const knownVolume = isKnown(t.volumeUsd) ? Math.max(0, t.volumeUsd) : 0;
  const tieBreak = Math.log10(1 + knownVolume) * 1e-4;
  const sinceTrade = Math.max(0, now - t.lastTradeAt);
  if (window === "5m") {
    if (!isKnown(t.change5mPct)) return tieBreak;
    const activity = Math.exp(-sinceTrade / 90_000);
    const confidence = Math.min(1, t.txns / 25);
    return t.change5mPct * activity * confidence + tieBreak;
  }
  const span = WINDOW_MS[window];
  if (sinceTrade > span) return tieBreak;
  // A creation the server did not observe is older than its window: treat it as a day old.
  const age = isKnown(t.createdAt) ? Math.max(MINUTE, now - t.createdAt) : 24 * HOUR;
  const share = Math.min(1, span / Math.min(age, 24 * HOUR));
  const volume = knownVolume * share;
  const txns = Math.max(0, t.txns) * share;
  return Math.log10(1 + volume) + 0.6 * Math.log10(1 + txns) + tieBreak;
}

export const TREND_EXPLAINER: Record<TrendWindow, string> = {
  "5m": "5m: price change over the last 5 minutes, weighted by how recently the coin traded and damped for coins with very few trades.",
  "1h": "1h: estimated volume and trade count in the last hour. Coins younger than an hour count in full; older ones are pro-rated by age. Coins idle for the whole window drop out.",
  "6h": "6h: estimated volume and trade count in the last 6 hours, pro-rated by age for older coins. Coins idle for the whole window drop out.",
  "24h": "24h: volume and trade count over the last day (rolling 24 h for older coins). Coins idle all day drop out.",
};

export type SortKey = "rank" | "price" | "change" | "mc" | "liq" | "vol" | "txns" | "holders" | "top10";
export type SortDir = "asc" | "desc";

const SORT_VALUE: Record<Exclude<SortKey, "rank">, (t: TokenSummary) => number | null> = {
  price: (t) => t.priceUsd,
  change: (t) => t.change5mPct,
  mc: (t) => t.marketCapUsd,
  liq: (t) => t.liquidityUsd,
  vol: (t) => t.volumeUsd,
  txns: (t) => t.txns,
  holders: (t) => t.holders,
  top10: (t) => t.risk.top10Pct,
};

/** First click direction: lower is better for holder concentration, higher for the rest. */
export function defaultDir(key: SortKey): SortDir {
  return key === "top10" || key === "rank" ? "asc" : "desc";
}

export interface RankedToken {
  token: TokenSummary;
  rank: number;
  score: number;
}

export interface TrendFilters {
  query: string;
  dexPaid: boolean;
  minLiq: number | null;
  minVol: number | null;
  maxTop10: number | null;
}

export function matchesTrendFilters(t: TokenSummary, f: TrendFilters): boolean {
  if (f.dexPaid && !t.dexPaid) return false;
  // Unknown is not zero: an unknown value fails a min or a max (DESIGN.md 4.16).
  if (f.minLiq !== null && !(isKnown(t.liquidityUsd) && t.liquidityUsd >= f.minLiq)) return false;
  if (f.minVol !== null && !(isKnown(t.volumeUsd) && t.volumeUsd >= f.minVol)) return false;
  if (f.maxTop10 !== null && !(isKnown(t.risk.top10Pct) && t.risk.top10Pct <= f.maxTop10)) return false;
  const q = f.query.trim().toLowerCase().replace(/^\$/, "");
  if (q) {
    const hay = `${t.symbol} ${t.name}`.toLowerCase();
    if (!hay.includes(q) && !(q.length >= 4 && t.mint.toLowerCase().startsWith(q))) return false;
  }
  return true;
}

/** Scores, filters and ranks; rank is the position by score among the tokens that pass. */
export function rankTrending(tokens: TokenSummary[], window: TrendWindow, now: number, keep: (t: TokenSummary) => boolean): RankedToken[] {
  return tokens
    .filter(keep)
    .map((token) => ({ token, score: trendScore(token, window, now), rank: 0 }))
    .sort((a, b) => b.score - a.score)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

export function sortRanked(rows: RankedToken[], key: SortKey, dir: SortDir): RankedToken[] {
  const sign = dir === "asc" ? 1 : -1;
  if (key === "rank") return dir === "asc" ? rows : [...rows].reverse();
  const value = SORT_VALUE[key];
  return [...rows].sort((a, b) => {
    const x = value(a.token);
    const y = value(b.token);
    // Unknown values sort last in either direction.
    if (!isKnown(x) || !isKnown(y)) return (isKnown(x) ? 0 : 1) - (isKnown(y) ? 0 : 1) || a.rank - b.rank;
    return (x - y) * sign || a.rank - b.rank;
  });
}
