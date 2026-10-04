import { compareKnown } from "../../lib/sort";
import type { TokenRef, TrackedTrade } from "../../protocol";
import type { MonitorSortKey, SortDir } from "./prefs";

/** Net flow window for the Monitor (DESIGN.md 5.4). */
export const FLOW_WINDOW_MS = 15 * 60_000;

/** A position smaller than this share of what the wallet bought counts as exited (dust). */
const DUST = 0.005;

export interface MonitorRow {
  mint: string;
  token: TokenRef;
  /** Tracked wallets still holding (bought minus sold, in tokens), most recent buyer first. */
  holders: string[];
  /**
   * SOL bought minus SOL sold by tracked wallets over the last 15 minutes; null once a trade in the
   * window has an unknown SOL size (a quote with no known SOL value): unknown is not zero.
   */
  flowSol: number | null;
  /** Earliest tracked buy seen in the feed. */
  firstBuyAt: number | null;
  /** Latest tracked trade and the market cap (USD) it printed. */
  lastTs: number;
  lastMcUsd: number | null;
}

interface Acc {
  row: MonitorRow;
  /** Per wallet: tokens bought, tokens sold, last buy time. */
  wallets: Map<string, { bought: number; sold: number; lastBuy: number }>;
}

/**
 * Rolls the tracked-trade feed (newest first, as stored) up by token. A token stays listed while
 * at least one tracked wallet holds it or while it has tracked activity in the flow window.
 * The feed only keeps recent trades, so positions opened before it started are invisible: a
 * wallet seen only selling doesn't count as a holder.
 */
export function aggregateMonitor(
  live: readonly TrackedTrade[],
  now: number,
  blocked: (mint: string) => boolean = () => false,
): MonitorRow[] {
  const byMint = new Map<string, Acc>();
  // Oldest first, so the token ref and last market cap end on the newest trade.
  for (let i = live.length - 1; i >= 0; i--) {
    const item = live[i];
    if (!item) continue;
    const { trade, token } = item;
    if (blocked(token.mint)) continue;
    let acc = byMint.get(token.mint);
    if (!acc) {
      acc = {
        row: { mint: token.mint, token, holders: [], flowSol: 0, firstBuyAt: null, lastTs: trade.ts, lastMcUsd: trade.marketCapUsd },
        wallets: new Map(),
      };
      byMint.set(token.mint, acc);
    }
    const { row, wallets } = acc;
    row.token = token;
    row.lastTs = trade.ts;
    row.lastMcUsd = trade.marketCapUsd;
    let w = wallets.get(trade.maker);
    if (!w) {
      w = { bought: 0, sold: 0, lastBuy: 0 };
      wallets.set(trade.maker, w);
    }
    const inWindow = now - trade.ts <= FLOW_WINDOW_MS;
    if (trade.side === "buy") {
      w.bought += trade.tokenAmount;
      w.lastBuy = trade.ts;
      if (row.firstBuyAt === null) row.firstBuyAt = trade.ts;
      if (inWindow) row.flowSol = row.flowSol === null || trade.solAmount === null ? null : row.flowSol + trade.solAmount;
    } else {
      w.sold += trade.tokenAmount;
      if (inWindow) row.flowSol = row.flowSol === null || trade.solAmount === null ? null : row.flowSol - trade.solAmount;
    }
  }
  const out: MonitorRow[] = [];
  for (const { row, wallets } of byMint.values()) {
    const holding = [...wallets.entries()].filter(([, w]) => w.bought > 0 && w.bought - w.sold > w.bought * DUST);
    holding.sort((a, b) => b[1].lastBuy - a[1].lastBuy);
    row.holders = holding.map(([address]) => address);
    if (row.holders.length > 0 || now - row.lastTs <= FLOW_WINDOW_MS) out.push(row);
  }
  return out;
}

/**
 * Rows are rebuilt on every feed update; this lets a memoised row skip rendering when nothing it
 * shows changed (DESIGN.md 8: an update re-renders only the rows whose strings changed).
 */
export function sameMonitorRow(a: MonitorRow, b: MonitorRow): boolean {
  if (a === b) return true;
  if (a.mint !== b.mint || a.flowSol !== b.flowSol || a.firstBuyAt !== b.firstBuyAt || a.lastMcUsd !== b.lastMcUsd) return false;
  if (a.token.symbol !== b.token.symbol || a.token.imageUri !== b.token.imageUri || a.token.createdAt !== b.token.createdAt) return false;
  if (a.holders.length !== b.holders.length) return false;
  for (let i = 0; i < a.holders.length; i++) if (a.holders[i] !== b.holders[i]) return false;
  return true;
}

/** Sort for the Monitor. Ties fall back to tracked holders, then the latest activity. */
export function compareMonitor(
  key: MonitorSortKey,
  dir: SortDir,
  mcOf: (row: MonitorRow) => number | null,
): (a: MonitorRow, b: MonitorRow) => number {
  const sign = dir === "asc" ? 1 : -1;
  const value = (r: MonitorRow): number | null => {
    switch (key) {
      case "holders":
        return r.holders.length;
      case "flow":
        return r.flowSol;
      case "firstBuy":
        // Ascending age = most recent first buy first.
        return -(r.firstBuyAt ?? 0);
      case "mc":
        return mcOf(r);
    }
  };
  // Unknown values (null) sort last in either direction.
  return (a, b) => compareKnown(value(a), value(b), sign) || b.holders.length - a.holders.length || b.lastTs - a.lastTs;
}
