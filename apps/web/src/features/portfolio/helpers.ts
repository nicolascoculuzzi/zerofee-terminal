import { useVirtualizer } from "@tanstack/react-virtual";
import { type RefObject, useRef } from "react";
import type { ActivityItem, PnlPoint, Position, WalletStatus } from "../../protocol";

/** Positions worth less than this are dust and stay hidden until "Show hidden" is on. */
export const DUST_SOL = 0.001;

/** Lists longer than this render through @tanstack/react-virtual (DESIGN.md 4.9: above 100 rows). */
export const VIRTUALIZE_AT = 100;

/** Display currency. Pages follow the one global quote (settings.display.quote, DESIGN.md 3.9). */
export type Currency = "SOL" | "USD";

export type PnlRange = "7d" | "30d" | "max";
export const RANGES: readonly PnlRange[] = ["7d", "30d", "max"];
export const RANGE_LABEL: Record<PnlRange, string> = { "7d": "7d", "30d": "30d", max: "Max" };
/** Spelled-out range for tooltips ("in the last 30 days"). */
export const RANGE_WORDS: Record<PnlRange, string> = {
  "7d": "in the last 7 days",
  "30d": "in the last 30 days",
  max: "since the first trade",
};

const DAY_MS = 86_400_000;
const RANGE_MS: Record<PnlRange, number> = { "7d": 7 * DAY_MS, "30d": 30 * DAY_MS, max: Number.POSITIVE_INFINITY };

export function rangeStart(range: PnlRange, now: number): number {
  return range === "max" ? Number.NEGATIVE_INFINITY : now - RANGE_MS[range];
}

/** Realized + unrealized PnL of a position, SOL. */
export function positionPnl(p: Position): number {
  return p.realizedPnlSol + p.unrealizedPnlSol;
}

export function isDust(p: Position): boolean {
  return !p.closed && p.valueSol < DUST_SOL;
}

/** Return buckets of the Performance panel (DESIGN.md 5.3): three profitable, two losing. */
export const PNL_BUCKETS: readonly { label: string; tone: "buy" | "sell"; test: (pct: number) => boolean }[] = [
  { label: "Over 500%", tone: "buy", test: (r) => r > 500 },
  { label: "200% to 500%", tone: "buy", test: (r) => r > 200 },
  { label: "0% to 200%", tone: "buy", test: (r) => r >= 0 },
  { label: "0% to −50%", tone: "sell", test: (r) => r >= -50 },
  { label: "Under −50%", tone: "sell", test: () => true },
];

export interface WalletSummary {
  /** Value of open positions at the live price, SOL. */
  positionsSol: number;
  openCount: number;
  unrealizedSol: number;
  /** Realized PnL of positions traded inside the range, SOL. */
  realizedSol: number;
  /** Realized + unrealized PnL of positions traded inside the range, SOL. */
  totalPnlSol: number;
  /** Closed positions inside the range, and how many ended in profit (win rate counts closed only). */
  closed: number;
  wins: number;
  buckets: number[];
  buys: number;
  sells: number;
}

/** Numbers behind the header strip and the Performance panel, scoped to the selected range. */
export function summarize(status: WalletStatus, range: PnlRange, now: number): WalletSummary {
  const since = rangeStart(range, now);
  const buckets = PNL_BUCKETS.map(() => 0);
  let positionsSol = 0;
  let openCount = 0;
  let unrealizedSol = 0;
  let realizedSol = 0;
  let totalPnlSol = 0;
  let closed = 0;
  let wins = 0;
  for (const p of status.positions) {
    if (!p.closed) {
      positionsSol += p.valueSol;
      unrealizedSol += p.unrealizedPnlSol;
      openCount++;
    }
    if (p.lastTradeAt < since) continue;
    const pnl = positionPnl(p);
    realizedSol += p.realizedPnlSol;
    totalPnlSol += pnl;
    if (p.closed && p.boughtSol > 0) {
      closed++;
      if (p.realizedPnlSol > 0) wins++;
    }
    if (p.boughtSol > 0) {
      const pct = (pnl / p.boughtSol) * 100;
      const i = PNL_BUCKETS.findIndex((b) => b.test(pct));
      if (i >= 0) buckets[i] = (buckets[i] ?? 0) + 1;
    }
  }
  let buys = 0;
  let sells = 0;
  for (const a of status.activity) {
    if (a.ts < since) continue;
    if (a.kind === "buy") buys++;
    else if (a.kind === "sell") sells++;
  }
  return { positionsSol, openCount, unrealizedSol, realizedSol, totalPnlSol, closed, wins, buckets, buys, sells };
}

export interface FillMarketCaps {
  /** SOL-weighted average market cap (USD) at the buys in the activity log. */
  entryUsd: number | null;
  /** Same for the sells. */
  exitUsd: number | null;
}

/**
 * Average market cap at entry and exit per mint, from the fills in the activity log (the MC is
 * recorded with each fill). Used when the token has left the live set, so its supply is unknown.
 */
export function fillMarketCaps(activity: readonly ActivityItem[]): Map<string, FillMarketCaps> {
  const acc = new Map<string, { buySol: number; buyMc: number; sellSol: number; sellMc: number }>();
  for (const a of activity) {
    if (!a.mint || a.marketCapUsd === null || !(a.solAmount > 0)) continue;
    if (a.kind !== "buy" && a.kind !== "sell") continue;
    const e = acc.get(a.mint) ?? { buySol: 0, buyMc: 0, sellSol: 0, sellMc: 0 };
    if (a.kind === "buy") {
      e.buySol += a.solAmount;
      e.buyMc += a.marketCapUsd * a.solAmount;
    } else {
      e.sellSol += a.solAmount;
      e.sellMc += a.marketCapUsd * a.solAmount;
    }
    acc.set(a.mint, e);
  }
  const out = new Map<string, FillMarketCaps>();
  for (const [mint, e] of acc) {
    out.set(mint, {
      entryUsd: e.buySol > 0 ? e.buyMc / e.buySol : null,
      exitUsd: e.sellSol > 0 ? e.sellMc / e.sellSol : null,
    });
  }
  return out;
}

/**
 * Market cap for a per-token price, in SOL: from the live supply when the token is in the live
 * set, otherwise from the MC recorded with the fills (converted at the live SOL/USD).
 */
export function marketCapSol(priceSol: number | null, supply: number | null, fallbackUsd: number | null, solUsd: number): number | null {
  if (priceSol !== null && priceSol > 0 && supply !== null && supply > 0) return priceSol * supply;
  if (fallbackUsd !== null && solUsd > 0) return fallbackUsd / solUsd;
  return null;
}

export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Calendar weeks (Sunday first, en-US): day numbers with null blanks before the 1st and after the last day. */
export function monthWeeks(startDow: number, days: number): (number | null)[][] {
  const weeks: (number | null)[][] = [];
  let week: (number | null)[] = Array.from({ length: startDow }, () => null);
  for (let d = 1; d <= days; d++) {
    week.push(d);
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  if (week.length > 0) {
    while (week.length < 7) week.push(null);
    weeks.push(week);
  }
  return weeks;
}

/** Daily PnL (SOL) from the cumulative daily series: each day's change against the day before. */
export function dailyPnl(points: readonly PnlPoint[]): Map<string, number> {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const out = new Map<string, number>();
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (!prev || !cur) continue;
    out.set(dayKey(cur.t), cur.pnlSol - prev.pnlSol);
  }
  return out;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "October 2026" (fixed en-US, like every date in the app). */
export function fmtMonthYear(year: number, month: number): string {
  return `${MONTHS[month] ?? ""} ${year}`;
}

/** "Oct 3, 2026 · 14:22 UTC" for the share card. */
export function fmtUtcStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (v: number) => String(v).padStart(2, "0");
  const month = (MONTHS[d.getUTCMonth()] ?? "").slice(0, 3);
  return `${month} ${d.getUTCDate()}, ${d.getUTCFullYear()} · ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export interface LongList<T> {
  /** True once the list is long enough to be virtualised. */
  virtual: boolean;
  /** Attach to the scroll box (it needs a bounded height and overflow-y auto). */
  scrollRef: RefObject<HTMLDivElement | null>;
  rows: { item: T; index: number }[];
  /** Spacer sizes above and below the rendered window (0 when not virtual). */
  padTop: number;
  padBottom: number;
  /** Ref callback for each rendered row (with `data-index`) so real heights are measured. */
  measure: (el: Element | null) => void;
  /** Brings a row into the rendered window (keyboard cursor). */
  scrollToIndex: (index: number) => void;
}

const noMeasure = () => {};

/**
 * Renders every row for short lists; past VIRTUALIZE_AT rows only the visible window (plus
 * overscan) is rendered, with measured heights so hairline dividers don't drift. `estimatePx`
 * should come from the density tokens (useCssPx), so a density switch re-measures; `offsetPx`
 * is the height of what sits above the first row inside the scroll box (the sticky header).
 */
export function useLongList<T>(items: readonly T[], getKey: (item: T) => string, estimatePx: number, offsetPx = 0): LongList<T> {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = items.length > VIRTUALIZE_AT;
  const virtualizer = useVirtualizer<HTMLDivElement, Element>({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimatePx,
    getItemKey: (index) => {
      const item = items[index];
      return item === undefined ? index : getKey(item);
    },
    overscan: 12,
    scrollMargin: offsetPx,
    scrollPaddingStart: offsetPx,
    enabled: virtual,
    useFlushSync: false,
  });
  if (!virtual) {
    return {
      virtual,
      scrollRef,
      rows: items.map((item, index) => ({ item, index })),
      padTop: 0,
      padBottom: 0,
      measure: noMeasure,
      scrollToIndex: noMeasure,
    };
  }
  const visible = virtualizer.getVirtualItems();
  const rows: { item: T; index: number }[] = [];
  for (const v of visible) {
    const item = items[v.index];
    if (item !== undefined) rows.push({ item, index: v.index });
  }
  const first = visible[0];
  const last = visible[visible.length - 1];
  // With a scroll margin, item offsets include it; spacers are relative to the first row.
  return {
    virtual,
    scrollRef,
    rows,
    padTop: first ? first.start - offsetPx : 0,
    padBottom: last ? Math.max(0, virtualizer.getTotalSize() - (last.end - offsetPx)) : 0,
    measure: virtualizer.measureElement,
    scrollToIndex: (index) => virtualizer.scrollToIndex(index, { align: "auto" }),
  };
}
