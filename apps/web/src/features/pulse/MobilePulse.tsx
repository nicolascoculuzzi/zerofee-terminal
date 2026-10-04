import { useVirtualizer } from "@tanstack/react-virtual";
import { SlidersHorizontal } from "lucide-react";
import { useRef } from "react";
import { cn } from "../../lib/cn";
import { activeFilterCount, emptyFilter } from "../../lib/filters";
import type { PulseColumnId } from "../../protocol";
import { useMarket } from "../../state/market";
import { useSettings } from "../../state/settings";
import { ActiveFilters } from "./ActiveFilters";
import { EmptyColumn, NewBar, SkeletonCards } from "./ColumnStates";
import { cardView } from "./cardView";
import { MobileRow } from "./MobileRow";
import { usePulseUi } from "./store";
import { useTrackedHolding } from "./tracked";
import { useColumnList, useIncoming } from "./useColumnList";
import { useColumnPause } from "./useColumnPause";
import { useScrollAnchor } from "./useScrollAnchor";

const ROW_H = 64;
const TAB_LABEL: Record<PulseColumnId, string> = { new: "New", final: "Final", migrated: "Migrated" };
const TABS: PulseColumnId[] = ["new", "final", "migrated"];

function TabCount({ column }: { column: PulseColumnId }) {
  const n = useIncoming(column).incoming.length;
  return <span className="zf-num text-label text-fg-3">{n}</span>;
}

/**
 * Column switch for phones (DESIGN.md 5.8): a 36 px band with 12 px gutters holding
 * "New 214 | Final 38 | Migrated 61", each segment with a 44 px hit area. While no filter is
 * active the band also carries the Filters button (the filter row carries it otherwise).
 * New / Finalizing / Migrated tabs after Binance Meme Rush: https://mobbin.com/screens/972c602f-95aa-44ba-9cd3-1f869d9a58c3
 */
function MobileTabs({ column }: { column: PulseColumnId }) {
  const setColumn = usePulseUi((s) => s.setMobileColumn);
  const filtered = useSettings((s) => activeFilterCount(s.columns[column].filters[s.columns[column].activeFilter]) > 0);
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-hairline px-3">
      <div
        role="tablist"
        aria-label="Pulse column"
        className="flex h-8 flex-1 items-center gap-px rounded-sm border border-hairline-strong p-0.5"
      >
        {TABS.map((c) => {
          const active = c === column;
          return (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => setColumn(c)}
              className={cn(
                "focus-inset relative flex h-full flex-1 items-center justify-center gap-1 rounded-xs text-data font-medium transition-colors after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-['']",
                active ? "bg-surface-3 text-fg-1" : "text-fg-3",
              )}
            >
              {TAB_LABEL[c]}
              <TabCount column={c} />
            </button>
          );
        })}
      </div>
      {!filtered && (
        <button
          type="button"
          aria-label="Filters"
          onClick={() => usePulseUi.getState().openFilters(column)}
          className="relative flex size-8 shrink-0 items-center justify-center rounded-sm text-fg-2 after:absolute after:-inset-1.5 after:content-['']"
        >
          <SlidersHorizontal className="icon-md" />
        </button>
      )}
    </div>
  );
}

function MobileList({ column }: { column: PulseColumnId }) {
  const pause = useColumnPause(column);
  const list = useColumnList(column, pause.paused);
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchor = useScrollAnchor(scrollRef, list.shown, ROW_H);
  const quickBuySol = useSettings((s) => s.columns[column].quickBuySol ?? s.quickBuySol);
  const preset = useSettings((s) => s.columns[column].preset ?? s.activePreset);
  const slot = useSettings((s) => s.columns[column].activeFilter);
  const filtered = useSettings((s) => activeFilterCount(s.columns[column].filters[s.columns[column].activeFilter]) > 0);
  const search = useSettings((s) => s.columns[column].search.trim());
  const display = useSettings((s) => s.display);
  const setColumnFilter = useSettings((s) => s.setColumnFilter);
  const setColumn = useSettings((s) => s.setColumn);
  const solUsd = useMarket((s) => s.solUsd);
  const anyTokens = useMarket((s) => s.columns.new.length + s.columns.final.length + s.columns.migrated.length > 0);
  const tracked = useTrackedHolding();
  const virtualizer = useVirtualizer({
    count: list.shown.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 4,
    getItemKey: (i) => list.shown[i] ?? i,
  });
  const ctx = { quote: display.quote, solUsd, showRing: display.showProgressRing, thresholds: display.riskThresholds };

  return (
    <section ref={pause.ref} aria-label={TAB_LABEL[column]} className="relative flex min-h-0 flex-1 flex-col" {...pause.handlers}>
      {list.frozen && list.queued > 0 ? (
        <NewBar count={list.queued} mode="paused" onClick={list.apply} />
      ) : anchor.unseen > 0 ? (
        <NewBar count={anchor.unseen} mode="scrolled" onClick={anchor.jumpToTop} />
      ) : null}
      {/* biome-ignore lint/a11y/useSemanticElements: virtualised, absolutely positioned rows can't be a table (ARIA grid pattern) */}
      <div
        ref={scrollRef}
        role="grid"
        tabIndex={-1}
        aria-label={`${TAB_LABEL[column]} tokens`}
        aria-rowcount={list.shown.length}
        onScroll={(e) => anchor.onScroll(e.currentTarget.scrollTop)}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none]"
      >
        {!anyTokens ? (
          <SkeletonCards mobile count={9} />
        ) : list.shown.length === 0 ? (
          <EmptyColumn
            column={column}
            filtered={filtered}
            search={search}
            onEditFilters={() => usePulseUi.getState().openFilters(column)}
            onReset={() => setColumnFilter(column, slot, emptyFilter())}
            onClearSearch={() => setColumn(column, { search: "" })}
          />
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const mint = list.shown[item.index];
              const t = mint ? list.token(mint) : undefined;
              if (!mint || !t) return null;
              return (
                <MobileRow
                  key={item.key}
                  view={cardView(t, { ...ctx, tracked: tracked.get(mint) ?? 0 })}
                  risk={t.risk}
                  column={column}
                  index={item.index}
                  start={item.start}
                  quickBuySol={quickBuySol}
                  preset={preset}
                  colored={display.metricColors}
                  insertedAt={list.inserted.get(mint) ?? 0}
                />
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

/** Pulse below 768 px (DESIGN.md 5.8): tabs, the filter row when filters are active, 64 px rows. */
export function MobilePulse() {
  const column = usePulseUi((s) => s.mobileColumn);
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface-1">
      <MobileTabs column={column} />
      <ActiveFilters column={column} mobile />
      <MobileList key={column} column={column} />
    </div>
  );
}
