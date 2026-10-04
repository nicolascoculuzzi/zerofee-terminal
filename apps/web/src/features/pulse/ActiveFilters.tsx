import { SlidersHorizontal, X } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import type { PulseColumnId } from "../../protocol";
import { useSettings } from "../../state/settings";
import { type FilterChip, filterChips } from "./filterChips";
import { usePulseUi } from "./store";

const GAP = 4;
/** Room kept at the end of the row: "+N" on desktop, "+N" and the Filters button on phones. */
const MORE_W = 32;
const MOBILE_TAIL_W = 76;

function Chip({ chip, onClear }: { chip: FilterChip; onClear?: () => void }) {
  return (
    <span className="inline-flex h-5 shrink-0 items-center rounded-xs border border-hairline bg-surface-2 text-label">
      <span className="px-1.5 text-fg-3">{chip.label}</span>
      <span className="zf-num max-w-32 truncate border-l border-hairline px-1.5 text-fg-1">{chip.value}</span>
      {onClear !== undefined && (
        <button
          type="button"
          aria-label={`Clear the ${chip.label} ${chip.value} filter`}
          onClick={onClear}
          className="focus-inset flex h-full w-5 items-center justify-center border-l border-hairline text-fg-3 transition-colors hover:bg-surface-3 hover:text-fg-1"
        >
          <X className="icon-xs" />
        </button>
      )}
    </span>
  );
}

/**
 * Active-filter row (DESIGN.md 4.3, 5.8): shown only while a filter is active. Desktop: 24 px
 * under the header, "label | value ×" chips (20 px, 2 px radius, surface-2, hairlines), the X
 * clears that one condition, and what doesn't fit collapses into "+N", which opens the filters.
 * Phones: a 32 px row of the same chips (no 20 px X targets) ending in a Filters button with a
 * 44 px hit area. Segmented chips after Fey's screener: https://mobbin.com/screens/0caf65f6-dcdc-451d-ae2c-5e8c47e1efff
 */
export function ActiveFilters({ column, mobile }: { column: PulseColumnId; mobile?: boolean }) {
  const slot = useSettings((s) => s.columns[column].activeFilter);
  const filter = useSettings((s) => s.columns[column].filters[s.columns[column].activeFilter]);
  const setColumnFilter = useSettings((s) => s.setColumnFilter);
  const chips = useMemo(() => filterChips(filter), [filter]);
  const row = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(chips.length);
  const clear = (c: FilterChip) => () => setColumnFilter(column, slot, c.clear(filter));

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure the rendered chips whenever they change
  useLayoutEffect(() => {
    const el = row.current;
    const box = measure.current;
    if (!el || !box) return;
    const update = () => {
      const widths = Array.from(box.children).map((c) => (c as HTMLElement).offsetWidth);
      const style = getComputedStyle(el);
      const tail = mobile ? MOBILE_TAIL_W : 0;
      const avail = el.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight) - tail;
      const total = widths.reduce((s, w, i) => s + w + (i > 0 ? GAP : 0), 0);
      if (total <= avail) {
        setFit(widths.length);
        return;
      }
      let used = 0;
      let n = 0;
      for (const w of widths) {
        const next = used + (n > 0 ? GAP : 0) + w;
        if (next + GAP + MORE_W > avail) break;
        used = next;
        n++;
      }
      setFit(n);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [chips, mobile]);

  if (chips.length === 0) return null;
  const hidden = chips.length - fit;
  const openFilters = () => usePulseUi.getState().openFilters(column);
  return (
    <div
      ref={row}
      className={cn("relative flex shrink-0 items-center gap-1 overflow-hidden border-b border-hairline", mobile ? "h-8 px-3" : "h-6 px-2")}
    >
      <div ref={measure} aria-hidden="true" className="invisible absolute top-0 left-0 flex gap-1">
        {chips.map((c) => (
          <Chip key={c.id} chip={c} onClear={mobile ? undefined : () => {}} />
        ))}
      </div>
      {chips.slice(0, fit).map((c) => (
        <Chip key={c.id} chip={c} onClear={mobile ? undefined : clear(c)} />
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={openFilters}
          aria-label={`${hidden} more filters`}
          className="zf-num inline-flex h-5 shrink-0 items-center rounded-xs border border-hairline bg-surface-2 px-1.5 text-label text-fg-1 transition-colors hover:bg-surface-3"
        >
          +{hidden}
        </button>
      )}
      {mobile && (
        <button
          type="button"
          onClick={openFilters}
          className="relative ml-auto inline-flex h-6 shrink-0 items-center gap-1 rounded-sm px-2 text-data font-medium text-fg-1 after:absolute after:inset-x-0 after:-inset-y-2.5 after:content-['']"
        >
          <SlidersHorizontal className="icon-sm" />
          Filters
        </button>
      )}
    </div>
  );
}
