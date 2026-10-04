import { AlertTriangle, ArrowDown, ArrowUp, ChevronsUpDown, XCircle } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";

/*
 * Data-grid primitives (DESIGN.md 4.9): sticky 28/32 px header with 11/500 text-3 sentence-case
 * labels, rows with 1 px hairline dividers, 8 px cell padding, text left, numbers right, fixed
 * column widths in ch (one flexible label column). No zebra. Grey right-aligned meta and quiet
 * group header bars after Linear: https://mobbin.com/screens/e142df2a-3527-499c-8f81-1b715947ac0c
 * Tabular numbers in every column and sortable headers after OpenSea:
 * https://mobbin.com/screens/a2072a4d-d59f-4b22-92be-ddcc3100db61
 */

/** Column width: `ch` measured at the table's data size, plus the 8 px padding on each side. */
export function colW(ch: number): CSSProperties {
  return { width: `calc(${ch}ch + 16px)` };
}

/** Table classes: fixed layout, separate borders so the sticky header keeps its bottom hairline. */
export const TABLE = "w-full table-fixed border-separate border-spacing-0 text-data";

/** Body cell: 8 px padding and the 1 px row divider. */
export const TD = "border-b border-hairline px-2 whitespace-nowrap";

/** Row states (DESIGN.md 4.9): hover surface-2; the keyboard cursor adds a 2 px accent bar (on the first cell). */
export function rowClass(opts: { cursor?: boolean; selected?: boolean; interactive?: boolean }): string {
  return cn(
    // The focus ring is inset by 1 px inside rows (DESIGN.md 6.3).
    "focus-inset",
    opts.selected ? "bg-surface-3" : opts.cursor ? "bg-surface-2" : "hover:bg-surface-2",
    opts.interactive && "cursor-pointer",
  );
}

/** The 2 px accent bar on the left edge of the keyboard-cursor row (first cell gets `relative`). */
export function CursorBar({ on }: { on: boolean }) {
  if (!on) return null;
  return <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-accent" />;
}

export type SortDir = "asc" | "desc";

/** Header cell. Sortable headers show ChevronsUpDown on hover and an arrow when sorted. */
export function Th({
  children,
  align = "left",
  sorted,
  onSort,
  className,
  style,
  title,
}: {
  children?: ReactNode;
  align?: "left" | "right" | "center";
  sorted?: SortDir | null;
  onSort?: () => void;
  className?: string;
  style?: CSSProperties;
  title?: string;
}) {
  const alignCls = align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
  const base = cn(
    "sticky top-0 z-sticky h-header-row border-b border-hairline bg-surface-1 px-2 text-label font-medium whitespace-nowrap text-fg-3",
    alignCls,
    className,
  );
  if (!onSort) {
    return (
      <th scope="col" className={base} style={style} title={title}>
        {children}
      </th>
    );
  }
  const icon =
    sorted === "asc" ? (
      <ArrowUp className="icon-xs text-fg-2" />
    ) : sorted === "desc" ? (
      <ArrowDown className="icon-xs text-fg-2" />
    ) : (
      <ChevronsUpDown className="icon-xs opacity-0 transition-opacity group-hover:opacity-100" />
    );
  return (
    <th
      scope="col"
      className={base}
      style={style}
      title={title}
      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}
    >
      <button
        type="button"
        onClick={onSort}
        className={cn(
          "group focus-inset inline-flex max-w-full items-center gap-1 rounded-xs transition-colors hover:text-fg-1",
          align === "right" && "flex-row-reverse",
          sorted && "text-fg-2",
        )}
      >
        <span className="truncate">{children}</span>
        {icon}
      </button>
    </th>
  );
}

export type SkeletonCell = "text" | "num" | "avatar" | "none";

/**
 * Loading rows at the exact row height under the real headers (DESIGN.md 4.18): 8 px bars,
 * 2 px radius, surface-3; text 60% of the column, numbers 40% right-aligned, avatars as
 * squares. No shimmer, no pulse. Skeleton rows under real headers after Square:
 * https://mobbin.com/screens/09371ef3-f0d0-4fc9-8ab1-607ab3d0e4ab
 */
export function SkeletonRows({ cells, rows = 8, rowClassName }: { cells: SkeletonCell[]; rows?: number; rowClassName: string }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
        <tr key={r} className={rowClassName}>
          {cells.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder cells
            <td key={i} className={TD}>
              {c === "avatar" ? (
                <span className="flex items-center gap-2">
                  <span className="size-4 shrink-0 rounded-xs bg-surface-3" />
                  <span className="h-2 w-3/5 rounded-xs bg-surface-3" />
                </span>
              ) : c === "text" ? (
                <span className="block h-2 w-3/5 rounded-xs bg-surface-3" />
              ) : c === "num" ? (
                <span className="ml-auto block h-2 w-2/5 rounded-xs bg-surface-3" />
              ) : null}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/**
 * Inline panel error (DESIGN.md 4.18): warn triangle, what failed and when it retries, "Retry
 * now". After three failures it turns into "<what> unavailable" with a sell icon. A failed
 * panel never replaces the page. Inline widget error after Gemini:
 * https://mobbin.com/screens/c6637b1c-7ddc-4343-b390-1840fe6dc4a5
 */
export function PanelError({
  what,
  failures,
  onRetry,
  className,
}: {
  /** Noun phrase: "wallet", "PnL history". */
  what: string;
  failures: number;
  onRetry: () => void;
  className?: string;
}) {
  const gaveUp = failures >= 3;
  return (
    <div role="alert" className={cn("flex items-center gap-2 px-3 py-2 text-data", className)}>
      {gaveUp ? <XCircle className="icon-sm shrink-0 text-sell" /> : <AlertTriangle className="icon-sm shrink-0 text-warn" />}
      <span className="min-w-0 truncate text-fg-2">
        {gaveUp ? `${what.charAt(0).toUpperCase()}${what.slice(1)} unavailable.` : `Couldn't load ${what}. Retrying in 5 s.`}
      </span>
      <Button size="xs" variant="ghost" onClick={onRetry}>
        {gaveUp ? "Retry" : "Retry now"}
      </Button>
    </div>
  );
}
