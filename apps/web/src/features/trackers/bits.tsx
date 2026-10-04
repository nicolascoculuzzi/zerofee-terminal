import { Pause, Search, X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/** Small presentational pieces shared by the Trackers page, the docks and Discover. */

/**
 * "Paused" chip while hover or focus freezes a live list (DESIGN.md 4.3): Pause 12 px and the
 * word in micro type, text-2 on surface-3. Quiet on purpose, after Canny's paused-source chip:
 * https://mobbin.com/screens/8794989c-4116-4894-9684-2fd8f4761652
 */
export function PausedChip({ paused, className }: { paused: boolean; className?: string }) {
  if (!paused) return null;
  return (
    <span
      title="Paused while the pointer or focus is on the list. New rows wait above it."
      className={cn("inline-flex h-4 shrink-0 items-center gap-1 rounded-xs bg-surface-3 px-1 text-micro font-medium text-fg-2", className)}
    >
      <Pause className="icon-xs" />
      Paused
    </span>
  );
}

/**
 * "↑ N new" above a paused or scrolled live list (DESIGN.md 6.7). A small floating control, so
 * it takes no space and never pushes the rows under the cursor.
 */
export function NewRowsPill({
  count,
  paused,
  onClick,
  className,
}: {
  count: number;
  paused: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "absolute left-1/2 z-sticky flex h-5 -translate-x-1/2 items-center gap-1 rounded-sm border border-hairline-strong bg-floating px-2 text-label font-medium whitespace-nowrap text-fg-1 shadow-e1 transition-colors hover:bg-surface-3",
        className,
      )}
    >
      ↑ {count} new
      {paused && <span className="font-normal text-fg-3">· click or move away to show</span>}
    </button>
  );
}

/**
 * Search input (DESIGN.md 4.23): control height, surface-2, hairline-strong, Search 14 px in
 * text-3, placeholder in text-4, the focus ring outside. An X clears it.
 */
export function SearchField({
  value,
  onChange,
  placeholder,
  label,
  className,
  mobile,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  className?: string;
  /** 44 px tall with a 16 px input (iOS doesn't zoom), DESIGN.md 2.10. */
  mobile?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex min-w-0 items-center gap-1 rounded-sm border border-hairline-strong bg-surface-2 pl-2 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus",
        mobile ? "h-11 text-title" : "h-control text-data",
        className,
      )}
    >
      <Search className="icon-sm shrink-0 text-fg-3" />
      <input
        type="search"
        className="min-w-0 flex-1 bg-transparent placeholder:text-fg-4 focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.stopPropagation();
            onChange("");
          }
        }}
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          title="Clear search (Esc)"
          onClick={() => onChange("")}
          className={cn(
            "flex shrink-0 items-center justify-center text-fg-3 transition-colors hover:text-fg-1",
            mobile ? "size-11" : "size-6",
          )}
        >
          <X className="icon-xs" />
        </button>
      ) : (
        <span className="w-1 shrink-0" />
      )}
    </label>
  );
}

/** 1 × 16 px hairline between control groups in a toolbar. */
export function ToolbarSep({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("h-4 w-px shrink-0 bg-hairline", className)} />;
}

/** Pane toolbar above a table (DESIGN.md 4.9 and 5.4: 28 / 32 px), hairline under it. */
export function PaneToolbar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex h-header-row shrink-0 items-center gap-2 overflow-x-auto border-b border-hairline px-2 whitespace-nowrap max-md:h-auto max-md:min-h-11 max-md:px-3 max-md:py-1",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Count after a label in text-3 ("128 trades"), tabular. */
export function MetaCount({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("zf-num shrink-0 text-label text-fg-3", className)}>{children}</span>;
}

export type SkeletonKind = "text" | "num" | "avatar" | "none";

/**
 * Loading rows for the flex grids (DESIGN.md 4.18): exact row height, the real column classes,
 * 8 px surface-3 bars with a 2 px radius; text at 60% of its column, numbers at 40% on the right,
 * avatars as squares. Static: no shimmer, no pulse. Skeleton rows under real headers after Square:
 * https://mobbin.com/screens/09371ef3-f0d0-4fc9-8ab1-607ab3d0e4ab
 */
export function SkeletonGridRows({
  cols,
  rows = 12,
  rowClassName,
}: {
  cols: readonly { className: string; kind: SkeletonKind }[];
  rows?: number;
  rowClassName: string;
}) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: rows }, (_, r) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
        <div key={r} className={rowClassName}>
          {cols.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder cells
            <div key={i} className={cn("flex shrink-0 items-center", c.className)}>
              {c.kind === "avatar" ? (
                <span className="flex w-full items-center gap-1">
                  <span className="size-4 shrink-0 rounded-xs bg-surface-3" />
                  <span className="h-2 w-2/5 rounded-xs bg-surface-3" />
                </span>
              ) : c.kind === "text" ? (
                <span className="h-2 w-3/5 rounded-xs bg-surface-3" />
              ) : c.kind === "num" ? (
                <span className="ml-auto h-2 w-2/5 rounded-xs bg-surface-3" />
              ) : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
