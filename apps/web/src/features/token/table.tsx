import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { type FocusEvent, type ReactNode, type UIEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";

/*
 * Token-page table kit (DESIGN.md 4.9): fixed column widths in ch (one flexible label column),
 * a sticky 28/32 px header with 11/500 text-3 sentence-case labels and units, 24/28 px rows for
 * data grids (hairline dividers) and 20/24 px rows for tapes (no dividers), numbers right
 * aligned, no zebra. Grey right-aligned meta after Linear:
 * https://mobbin.com/screens/e142df2a-3527-499c-8f81-1b715947ac0c
 * Sortable headers and tabular numbers in every column after OpenSea:
 * https://mobbin.com/screens/a2072a4d-d59f-4b22-92be-ddcc3100db61
 */

export type Align = "left" | "right" | "center";

export interface Col<K extends string = string> {
  key: K;
  label: ReactNode;
  /** CSS grid track, normally from `ch()` or `flex()`. */
  width: string;
  align?: Align;
  sortable?: boolean;
  /** Header tooltip (plain text). */
  title?: string;
}

/** A fixed column: n characters of data text plus the 8 px cell padding on each side. */
export function ch(n: number): string {
  return `calc(${n}ch + 16px)`;
}

/**
 * A fixed column that may widen from `min` to `max` characters when the panel has room, so a wide
 * tape spreads its numbers instead of bunching them at the left edge. Header and rows share the
 * template, so columns still line up and never move with the data.
 */
export function fit(min: number, max: number): string {
  return `minmax(calc(${min}ch + 16px), calc(${max}ch + 16px))`;
}

/** The one flexible label column, with a minimum width in characters. */
export function flex(minCh: number): string {
  return `minmax(calc(${minCh}ch + 16px), 1fr)`;
}

export function template(cols: readonly Col[]): string {
  return cols.map((c) => c.width).join(" ");
}

export const ALIGN: Record<Align, string> = {
  left: "justify-start text-left",
  right: "justify-end text-right",
  center: "justify-center text-center",
};

export interface SortState<K extends string = string> {
  key: K;
  dir: "asc" | "desc";
}

/** Cycles desc, asc, then off for a column. */
export function nextSort<K extends string>(current: SortState<K> | null, key: K): SortState<K> | null {
  if (!current || current.key !== key) return { key, dir: "desc" };
  if (current.dir === "desc") return { key, dir: "asc" };
  return null;
}

function SortButton<K extends string>({ col, sort, onSort }: { col: Col<K>; sort?: SortState<K> | null; onSort: (key: K) => void }) {
  const active = sort?.key === col.key;
  return (
    <button
      type="button"
      title={col.title}
      onClick={() => onSort(col.key)}
      className={cn(
        "group focus-inset inline-flex min-w-0 items-center gap-1 rounded-xs transition-colors hover:text-fg-1",
        active && "text-fg-2",
        col.align === "right" && "flex-row-reverse",
      )}
    >
      <span className="truncate">{col.label}</span>
      {active ? (
        sort?.dir === "asc" ? (
          <ArrowUp className="icon-xs text-fg-2" />
        ) : (
          <ArrowDown className="icon-xs text-fg-2" />
        )
      ) : (
        <ChevronsUpDown className="icon-xs opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
      )}
    </button>
  );
}

function ariaSort<K extends string>(col: Col<K>, sort?: SortState<K> | null): "ascending" | "descending" | "none" | undefined {
  if (!col.sortable) return undefined;
  if (sort?.key !== col.key) return "none";
  return sort.dir === "asc" ? "ascending" : "descending";
}

/**
 * Sticky header row for the virtualised tape (the ARIA grid pattern, DESIGN.md 7): 28 / 32 px,
 * surface-1, hairline bottom.
 */
export function TableHeader<K extends string>({
  cols,
  sort,
  onSort,
  className,
}: {
  cols: readonly Col<K>[];
  sort?: SortState<K> | null;
  onSort?: (key: K) => void;
  className?: string;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern for a virtualised list (DESIGN.md 7)
    // biome-ignore lint/a11y/useFocusableInteractive: the grid container owns focus and the row cursor
    <div
      role="row"
      className={cn(
        "sticky top-0 z-sticky grid h-header-row items-center border-b border-hairline bg-surface-1 text-label font-medium text-fg-3",
        className,
      )}
      style={{ gridTemplateColumns: template(cols) }}
    >
      {cols.map((c) => (
        // biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern for a virtualised list (DESIGN.md 7)
        // biome-ignore lint/a11y/useFocusableInteractive: header cells are not focus stops in the tape
        <span
          key={c.key}
          role="columnheader"
          aria-sort={ariaSort(c, sort)}
          title={c.sortable && onSort ? undefined : c.title}
          className={cn("flex min-w-0 items-center truncate px-2", ALIGN[c.align ?? "left"])}
        >
          {c.sortable && onSort ? <SortButton col={c} sort={sort} onSort={onSort} /> : c.label}
        </span>
      ))}
    </div>
  );
}

/** A column's width for <col>: fixed ch columns keep theirs, the flexible one takes the rest. */
function colWidth(c: Col): string | undefined {
  return c.width.startsWith("minmax(") ? undefined : c.width;
}

/**
 * Data grid as a real table (DESIGN.md 4.9, 7): sticky <th scope="col"> headers at 28 / 32 px,
 * 24 / 28 px rows with hairline dividers, fixed ch widths through <colgroup>, values that never
 * wrap. For lists under the virtualisation threshold (holders, top traders, positions, orders).
 */
export function DataTable<T, K extends string>({
  cols,
  rows,
  rowKey,
  cell,
  rowClassName,
  sort,
  onSort,
  label,
  minWidth,
}: {
  cols: readonly Col<K>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  cell: (row: T, key: K, index: number) => ReactNode;
  rowClassName?: (row: T) => string | false | undefined;
  sort?: SortState<K> | null;
  onSort?: (key: K) => void;
  label: string;
  minWidth: number;
}) {
  return (
    <table aria-label={label} className="w-full table-fixed border-separate border-spacing-0 text-data" style={{ minWidth }}>
      <colgroup>
        {cols.map((c) => (
          <col key={c.key} style={{ width: colWidth(c) }} />
        ))}
      </colgroup>
      <thead>
        <tr className="h-header-row">
          {cols.map((c) => (
            <th
              key={c.key}
              scope="col"
              aria-sort={ariaSort(c, sort)}
              title={c.sortable && onSort ? undefined : c.title}
              className={cn(
                "sticky top-0 z-sticky overflow-hidden border-b border-hairline bg-surface-1 px-2 text-label font-medium whitespace-nowrap text-fg-3",
                c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : "text-left",
              )}
            >
              {c.sortable && onSort ? <SortButton col={c} sort={sort} onSort={onSort} /> : c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={rowKey(r)} className={cn("h-row hover:bg-surface-2", rowClassName?.(r))}>
            {cols.map((c) => (
              <td key={c.key} className="overflow-hidden border-b border-hairline px-2 align-middle whitespace-nowrap">
                <div className={cn("flex min-w-0 items-center", ALIGN[c.align ?? "left"])}>{cell(r, c.key, i)}</div>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Freeze-and-queue for live lists (DESIGN.md 6.7, 1.4): while `frozen`, the list keeps its order
 * and membership (values still update in place; removed rows stay with their last data) and new
 * keys are counted as queued. When live, a changed order is adopted at most every `resortMs`
 * (tapes pass 0 and insert at the feed rate).
 */
export function useLiveOrder<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  { frozen, resortMs = 0 }: { frozen: boolean; resortMs?: number },
): { rows: T[]; queued: number } {
  const orderRef = useRef<string[] | null>(null);
  const lastRef = useRef(new Map<string, T>());
  const sortedAt = useRef(0);
  const [, force] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const byKey = new Map<string, T>();
  for (const r of rows) byKey.set(keyOf(r), r);
  for (const [k, v] of byKey) lastRef.current.set(k, v);

  const liveKeys = rows.map(keyOf);
  let order = orderRef.current;
  let queued = 0;
  const now = Date.now();

  if (frozen && order) {
    const shown = new Set(order);
    for (const k of liveKeys) if (!shown.has(k)) queued++;
  } else if (!order || resortMs === 0 || now - sortedAt.current >= resortMs) {
    order = liveKeys;
    sortedAt.current = now;
  } else {
    // Between re-sorts: keep the previous order for rows still present, append newcomers.
    const live = new Set(liveKeys);
    const kept = order.filter((k) => live.has(k));
    const keptSet = new Set(kept);
    const fresh = liveKeys.filter((k) => !keptSet.has(k));
    const changed = fresh.length > 0 || kept.length !== order.length || kept.some((k, i) => k !== liveKeys[i]);
    order = [...kept, ...fresh];
    if (changed && !timer.current) {
      timer.current = setTimeout(
        () => {
          timer.current = null;
          force((n) => n + 1);
        },
        Math.max(16, resortMs - (now - sortedAt.current)),
      );
    }
  }
  orderRef.current = order;

  const out: T[] = [];
  for (const k of order) {
    const row = byKey.get(k) ?? (frozen ? lastRef.current.get(k) : undefined);
    if (row !== undefined) out.push(row);
  }
  // Forget rows that are neither live nor shown.
  if (lastRef.current.size > rows.length + 400) {
    const keep = new Set(order);
    for (const k of lastRef.current.keys()) if (!byKey.has(k) && !keep.has(k)) lastRef.current.delete(k);
  }
  return { rows: out, queued };
}

/**
 * Pause state for a live list: frozen while hovered, focused, scrolled away from the top or
 * paused by its toggle. Leaving applies the queue after 300 ms in one batch (DESIGN.md 6.7).
 */
export function usePauseOnHover(paused = false): {
  frozen: boolean;
  bind: {
    onPointerEnter: () => void;
    onPointerLeave: () => void;
    onFocus: () => void;
    onBlur: (e: FocusEvent<HTMLElement>) => void;
  };
  onScroll: (e: UIEvent<HTMLElement>) => void;
  release: () => void;
} {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [held, setHeld] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = hover || focus || scrolled || paused;

  useEffect(() => {
    if (active) {
      if (leaveTimer.current) clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
      setHeld(true);
      return;
    }
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = null;
      setHeld(false);
    }, 300);
    return () => {
      if (leaveTimer.current) clearTimeout(leaveTimer.current);
    };
  }, [active]);

  const release = useCallback(() => {
    setHover(false);
    setFocus(false);
    setHeld(false);
  }, []);

  const bind = useMemo(
    () => ({
      onPointerEnter: () => setHover(true),
      onPointerLeave: () => setHover(false),
      onFocus: () => setFocus(true),
      onBlur: (e: FocusEvent<HTMLElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocus(false);
      },
    }),
    [],
  );
  const onScroll = useCallback((e: UIEvent<HTMLElement>) => setScrolled(e.currentTarget.scrollTop > 2), []);
  return { frozen: held || active, bind, onScroll, release };
}

/**
 * "↑ N new" bar (DESIGN.md 4.3, 6.7): 24 px, surface-2, overlaid at the top of the list so the
 * rows under the cursor never move. A click applies the queue now.
 */
export function NewRowsBar({ count, onApply, className }: { count: number; onApply: () => void; className?: string }) {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      onClick={onApply}
      className={cn(
        "absolute inset-x-0 z-sticky flex h-6 items-center gap-1 border-b border-hairline bg-surface-2 px-2 text-left text-label font-medium text-fg-1",
        className,
      )}
    >
      ↑ {count} new
      <span className="font-normal text-fg-3">· click or move away to show</span>
    </button>
  );
}

/** Loading skeleton rows under the real header (DESIGN.md 4.18): 8 px bars, no shimmer. */
export function SkeletonRows({ cols, rows = 8, dense = false }: { cols: readonly Col[]; rows?: number; dense?: boolean }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: rows }, (_, r) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
          key={r}
          className={cn("grid items-center", dense ? "h-row-dense" : "h-row border-b border-hairline")}
          style={{ gridTemplateColumns: template(cols) }}
        >
          {cols.map((c) => (
            <span key={c.key} className={cn("flex px-2", ALIGN[c.align ?? "left"])}>
              <span className={cn("h-2 rounded-xs bg-surface-3", c.align === "right" ? "w-2/5" : "w-3/5")} />
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
