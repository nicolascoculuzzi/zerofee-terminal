import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import type { ReactNode } from "react";
import { MetricTip } from "../../components/ui/bits";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import type { MetricKey } from "../../lib/metrics";
import type { SortDir } from "./prefs";

/*
 * Table primitives for the Trackers and Discover grids (DESIGN.md 4.9). Rows are flex rows with
 * fixed `ch` widths and one flexible label column, so hidden columns leave no empty tracks.
 * Cells sit at data size, so `ch` means the same width in the header and the rows; header
 * labels are an inner 11/500 text-3 span. Sortable headers after OpenSea's tokens table:
 * https://mobbin.com/screens/a2072a4d-d59f-4b22-92be-ddcc3100db61
 */

export type Align = "left" | "right" | "center";

const ALIGN: Record<Align, string> = {
  left: "justify-start text-left",
  right: "justify-end text-right",
  center: "justify-center text-center",
};

export function alignClass(align: Align = "left"): string {
  return ALIGN[align];
}

/*
 * The grids are virtualised (absolutely positioned rows), so they can't be <table> elements:
 * they use the ARIA grid pattern instead (DESIGN.md 7.7). Focus stays on the grid itself
 * (aria-activedescendant), so cells and headers are never tab stops.
 */

/** A grid cell: flex, fixed width from its column class. */
export function Cell({ children, className, title }: { children?: ReactNode; className?: string; title?: string }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: ARIA grid cell in a virtualised grid; focus stays on the grid
    <div role="gridcell" title={title} className={cn("flex", className)}>
      {children}
    </div>
  );
}

/**
 * Sticky header row: 28 / 32 px, the pane's surface, a hairline under it. The scrollbar gutter
 * matches the scrolling body below, so right-aligned numbers line up with their header.
 */
export function HeaderRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: header row of an ARIA grid (see above)
    <div
      role="row"
      aria-rowindex={1}
      className={cn(
        "flex h-header-row shrink-0 items-center gap-2 overflow-hidden border-b border-hairline px-2 text-data [scrollbar-gutter:stable]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A definition for a column that isn't a published SPEC metric (e.g. the Monitor's tracker-derived columns). */
export interface Definition {
  label: string;
  text: string;
}

/**
 * A metric header carries its definition (and bands) on a dotted underline (DESIGN.md 4.14):
 * SPEC metrics through MetricTip, tracker-derived columns through the same layout.
 */
function LabelText({ children, metric, bands, define }: { children: ReactNode; metric?: MetricKey; bands?: string; define?: Definition }) {
  if (!metric && !define) return <span className="truncate">{children}</span>;
  const content = metric ? (
    <MetricTip metric={metric} bands={bands} />
  ) : (
    <span className="block">
      <span className="block text-data font-semibold text-fg-1">{define?.label}</span>
      <span className="mt-1 line-clamp-3 block text-label text-fg-2">{define?.text}</span>
    </span>
  );
  return (
    <Tooltip content={content} wrapperClassName="min-w-0">
      <span className="zf-metric truncate">{children}</span>
    </Tooltip>
  );
}

export function HeaderCell({
  children,
  className,
  align = "left",
  title,
  metric,
  bands,
  define,
  raw,
}: {
  children?: ReactNode;
  className?: string;
  align?: Align;
  title?: string;
  metric?: MetricKey;
  bands?: string;
  define?: Definition;
  /** Render children as they are (a control such as the select-all checkbox), not as a label. */
  raw?: boolean;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: column header of an ARIA grid (see above)
    <div role="columnheader" title={title} className={cn("flex min-w-0 shrink-0 items-center", alignClass(align), className)}>
      {raw
        ? children
        : children !== undefined && (
            <span className="zf-label flex min-w-0">
              <LabelText metric={metric} bands={bands} define={define}>
                {children}
              </LabelText>
            </span>
          )}
    </div>
  );
}

/**
 * Sortable header (DESIGN.md 4.9): ChevronsUpDown 12 px on hover, ArrowUp / ArrowDown 12 px in
 * text-2 when sorted. The icon always takes its space, so the label never shifts.
 */
export function SortHeaderCell<K extends string>({
  k,
  label,
  sort,
  onSort,
  defaultDir = "desc",
  className,
  align = "left",
  title,
  metric,
  bands,
  define,
}: {
  k: K;
  label: ReactNode;
  sort: { key: K; dir: SortDir };
  onSort: (next: { key: K; dir: SortDir }) => void;
  defaultDir?: SortDir;
  className?: string;
  align?: Align;
  title?: string;
  metric?: MetricKey;
  bands?: string;
  define?: Definition;
}) {
  const active = sort.key === k;
  const Icon = active ? (sort.dir === "asc" ? ArrowUp : ArrowDown) : ChevronsUpDown;
  const icon = (
    <Icon
      aria-hidden="true"
      className={cn("icon-xs", active ? "text-fg-2" : "opacity-0 group-hover/sort:opacity-100 group-focus-visible/sort:opacity-100")}
    />
  );
  return (
    // biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: column header of an ARIA grid; its sort button is the focus target
    <div
      role="columnheader"
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      className={cn("flex min-w-0 shrink-0 items-center", alignClass(align), className)}
    >
      <button
        type="button"
        title={title}
        aria-label={typeof label === "string" ? `Sort by ${label}` : undefined}
        onClick={() => onSort(active ? { key: k, dir: sort.dir === "asc" ? "desc" : "asc" } : { key: k, dir: defaultDir })}
        className={cn(
          "group/sort focus-inset zf-label inline-flex h-5 max-w-full min-w-0 items-center gap-1 rounded-xs transition-colors hover:text-fg-2",
          active && "text-fg-2",
        )}
      >
        {align === "right" && icon}
        <LabelText metric={metric} bands={bands} define={define}>
          {label}
        </LabelText>
        {align !== "right" && icon}
      </button>
    </div>
  );
}

/**
 * Row background states (DESIGN.md 4.9): hover surface-2, selected surface-3. Inside a floating
 * dock (surface-2) the hover steps up to surface-3.
 */
export function rowTone({ selected, floating }: { selected?: boolean; floating?: boolean }): string {
  if (selected) return "bg-surface-3";
  return floating ? "hover:bg-surface-3" : "hover:bg-surface-2";
}

/** 2 px accent bar on the left edge of the keyboard-cursor row (DESIGN.md 4.9). */
export function CursorBar({ show }: { show: boolean }) {
  if (!show) return null;
  return <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-accent" />;
}
