import { useVirtualizer } from "@tanstack/react-virtual";
import { type RefObject, useRef } from "react";
import { fmtUsd } from "../../lib/format";
import type { Position } from "../../protocol";

/** Positions worth less than this are "dust" and hidden until "Show hidden" is on. */
export const DUST_SOL = 0.001;

/** Lists longer than this render through @tanstack/react-virtual inside their own scroll box. */
export const VIRTUALIZE_AT = 150;

export type Currency = "SOL" | "USD";

/** Realized + unrealized PnL of a position, SOL. */
export function positionPnl(p: Position): number {
  return p.realizedPnlSol + p.unrealizedPnlSol;
}

/** Text colour for a signed amount: buy green above zero, sell red below, muted at zero. */
export function pnlTone(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) < 1e-9) return "text-muted";
  return value > 0 ? "text-buy" : "text-sell";
}

export function fmtSignedUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : "-"}${fmtUsd(Math.abs(n))}`;
}

export interface LongList<T> {
  /** True once the list is long enough to be virtualized. */
  virtual: boolean;
  /** Attach to the scroll box; give it a max height and `overflow-y-auto` while `virtual`. */
  scrollRef: RefObject<HTMLDivElement | null>;
  rows: { item: T; index: number }[];
  /** Spacer sizes above and below the rendered window (0 when not virtual). */
  padTop: number;
  padBottom: number;
  /** Ref callback for each rendered row (with `data-index`) so real heights are measured. */
  measure: (el: Element | null) => void;
}

const noMeasure = () => {};

/**
 * Renders every row for short lists; past VIRTUALIZE_AT rows only the visible window (plus
 * overscan) is rendered, with measured heights so hairline borders don't drift.
 */
export function useLongList<T>(items: readonly T[], getKey: (item: T) => string, estimatePx: number): LongList<T> {
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
    enabled: virtual,
    useFlushSync: false,
  });
  if (!virtual) {
    return { virtual, scrollRef, rows: items.map((item, index) => ({ item, index })), padTop: 0, padBottom: 0, measure: noMeasure };
  }
  const visible = virtualizer.getVirtualItems();
  const rows: { item: T; index: number }[] = [];
  for (const v of visible) {
    const item = items[v.index];
    if (item !== undefined) rows.push({ item, index: v.index });
  }
  const first = visible[0];
  const last = visible[visible.length - 1];
  return {
    virtual,
    scrollRef,
    rows,
    padTop: first ? first.start : 0,
    padBottom: last ? Math.max(0, virtualizer.getTotalSize() - last.end) : 0,
    measure: virtualizer.measureElement,
  };
}
