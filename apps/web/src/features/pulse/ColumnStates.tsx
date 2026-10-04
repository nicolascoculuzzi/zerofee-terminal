import { SearchX, SlidersHorizontal } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/bits";
import { FINAL_STRETCH_PROGRESS } from "../../config";
import { cn } from "../../lib/cn";
import type { PulseColumnId } from "../../protocol";
import { AVATAR_TRACK } from "./cardView";

/**
 * Loading skeleton (DESIGN.md 4.18): rows at the exact card height under the real header, shaped
 * like the card they stand in for: the framed avatar square, the three lines (ticker and name;
 * age and counters; five chip-sized bars), the right-aligned MC / V / TX stack and the pill.
 * 8 px bars at 2 px radius in surface-3; static, no shimmer, no pulse. Widths vary a little from
 * row to row so the column doesn't read as a grid of identical blocks. After Square's skeleton rows:
 * https://mobbin.com/screens/09371ef3-f0d0-4fc9-8ab1-607ab3d0e4ab
 */
const BAR = "h-2 rounded-xs bg-surface-3";
const TICKER_W = ["w-10", "w-14", "w-12", "w-16"];
const NAME_W = ["w-20", "w-14", "w-24", "w-16"];

export function SkeletonCards({ count = 8, mobile }: { count?: number; mobile?: boolean }) {
  if (mobile) {
    return (
      <div aria-hidden="true">
        {Array.from({ length: count }, (_, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders with no identity
            key={i}
            className="grid h-16 grid-cols-[36px_minmax(0,1fr)_72px] items-center gap-x-2 border-b border-hairline px-3"
          >
            <span className="size-9 rounded-sm bg-surface-3" />
            <span className="flex flex-col gap-2">
              <span className={cn(BAR, TICKER_W[i % 4])} />
              <span className={cn(BAR, "w-3/5")} />
            </span>
            <span className="flex flex-col items-end gap-2">
              <span className={cn(BAR, "w-12")} />
              <span className="h-6 w-[60px] rounded-full bg-surface-3" />
            </span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders with no identity
          key={i}
          className={cn(
            "grid h-card grid-cols-[var(--zf-card-avatar)_minmax(0,1fr)_72px_60px] items-center gap-x-2 border-b border-hairline px-2 in-data-[density=comfortable]:px-2.5",
            AVATAR_TRACK,
          )}
        >
          <span className="size-card-avatar rounded-md border-2 border-surface-3 p-px">
            <span className="block size-full rounded-sm bg-surface-3" />
          </span>
          <span className="flex min-w-0 flex-col justify-center gap-2.5 overflow-hidden">
            <span className="flex gap-1.5">
              <span className={cn(BAR, TICKER_W[i % 4])} />
              <span className={cn(BAR, "bg-surface-2", NAME_W[i % 4])} />
            </span>
            <span className="flex gap-1.5">
              <span className={cn(BAR, "w-5")} />
              <span className={cn(BAR, "w-8 bg-surface-2")} />
              <span className={cn(BAR, "w-8 bg-surface-2")} />
            </span>
            <span className="flex gap-1">
              {[0, 1, 2, 3, 4].map((c) => (
                <span key={c} className={cn(BAR, "w-11 bg-surface-2")} />
              ))}
            </span>
          </span>
          <span className="flex flex-col items-end gap-2.5">
            <span className={cn(BAR, "w-14")} />
            <span className={cn(BAR, "w-12 bg-surface-2")} />
            <span className={cn(BAR, "w-10 bg-surface-2")} />
          </span>
          <span className="h-6 w-[60px] rounded-full bg-surface-3" />
        </div>
      ))}
    </div>
  );
}

const EMPTY_BODY: Record<PulseColumnId, string> = {
  new: "New launches appear here as soon as the feed reports them.",
  final: `Tokens appear here once bonding progress reaches ${Math.round(FINAL_STRETCH_PROGRESS * 100)}%.`,
  migrated: "Tokens appear here when they graduate to an AMM pool.",
};

/** Empty column (DESIGN.md 4.3, 4.18): why it's empty, and the one or two ways out. */
export function EmptyColumn({
  column,
  filtered,
  search,
  onEditFilters,
  onReset,
  onClearSearch,
}: {
  column: PulseColumnId;
  filtered: boolean;
  search: string;
  onEditFilters: () => void;
  onReset: () => void;
  onClearSearch: () => void;
}) {
  if (search) {
    return (
      <EmptyState
        icon={<SearchX />}
        title={`No tokens match "${search}"`}
        body="Search covers name, ticker and contract address in this column."
        action={
          <Button size="sm" variant="secondary" onClick={onClearSearch}>
            Clear search
          </Button>
        }
      />
    );
  }
  if (filtered) {
    return (
      <EmptyState
        icon={<SlidersHorizontal />}
        title="No tokens match these filters"
        body="Loosen a range or reset the column to see every token."
        action={
          <span className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={onEditFilters}>
              Edit filters
            </Button>
            <Button size="sm" variant="ghost" onClick={onReset}>
              Reset
            </Button>
          </span>
        }
      />
    );
  }
  return <EmptyState title="Nothing here yet" body={EMPTY_BODY[column]} />;
}

/**
 * "↑ N new" bar (DESIGN.md 4.3, 6.7): 24 px, surface-2, over the top of the list. While the
 * column is paused it counts queued cards and a click applies them; while scrolled away from
 * the top it counts cards inserted above and a click jumps back up.
 */
export function NewBar({ count, mode, onClick }: { count: number; mode: "paused" | "scrolled"; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-inset absolute inset-x-0 top-0 z-sticky flex h-6 items-center gap-1 border-b border-hairline bg-surface-2 px-2 text-left text-label transition-colors hover:bg-surface-3"
    >
      <span className="zf-num shrink-0 font-medium text-fg-1">↑ {count} new</span>
      <span className="truncate text-fg-3">· {mode === "paused" ? "click or move away to show" : "click to jump to the top"}</span>
    </button>
  );
}
