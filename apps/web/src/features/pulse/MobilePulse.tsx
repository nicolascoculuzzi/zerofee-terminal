import { useVirtualizer } from "@tanstack/react-virtual";
import { SlidersHorizontal } from "lucide-react";
import { useEffect, useRef } from "react";
import { cn } from "../../lib/cn";
import { activeFilterCount, emptyFilter } from "../../lib/filters";
import { mark, trackFrames } from "../../lib/perf";
import type { PulseColumnId } from "../../protocol";
import { useMarket } from "../../state/market";
import { useSettings } from "../../state/settings";
import { ActiveFilters } from "./ActiveFilters";
import { EmptyColumn, NewBar, SkeletonCards } from "./ColumnStates";
import { cardView } from "./cardView";
import { RISK_ICON } from "./icons";
import { MobileRow } from "./MobileRow";
import { RISK_CHIPS } from "./RiskChips";
import { usePulseUi } from "./store";
import { useTrackedHolding } from "./tracked";
import { useColumnList, useIncoming } from "./useColumnList";
import { useColumnPause } from "./useColumnPause";
import { useScrollAnchor } from "./useScrollAnchor";

const ROW_H = 64;
const TAB_LABEL: Record<PulseColumnId, string> = { new: "New", final: "Final", migrated: "Migrated" };
const TABS: PulseColumnId[] = ["new", "final", "migrated"];

/** Left out until the first snapshot has arrived, so a loading tab never reads "0". */
function TabCount({ column }: { column: PulseColumnId }) {
  const n = useIncoming(column).incoming.length;
  const loaded = useMarket((s) => s.columns.new.length + s.columns.final.length + s.columns.migrated.length > 0);
  if (!loaded) return null;
  return <span className="zf-num text-label text-fg-3">{n}</span>;
}

/**
 * Column switch for phones (DESIGN.md 5.8): "New 214 | Final 38 | Migrated 61" as one segmented
 * control with 12 px gutters. The band is 44 px so every segment's hit area reaches 44 px without
 * reaching into the header above or the rows below; counts stay out until the first snapshot. While
 * no filter is active the band also carries the Filters button (the filter row carries it otherwise).
 * New / Finalizing / Migrated tabs after Binance Meme Rush: https://mobbin.com/screens/972c602f-95aa-44ba-9cd3-1f869d9a58c3
 */
function MobileTabs({ column }: { column: PulseColumnId }) {
  const setColumn = usePulseUi((s) => s.setMobileColumn);
  const filtered = useSettings((s) => activeFilterCount(s.columns[column].filters[s.columns[column].activeFilter]) > 0);
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-hairline px-3">
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
                "focus-inset relative flex h-full flex-1 items-center justify-center gap-1.5 rounded-xs text-data font-medium transition-colors after:absolute after:inset-x-0 after:-inset-y-[9px] after:content-['']",
                active ? "bg-surface-3 text-fg-1" : "text-fg-3 hover:text-fg-2",
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
          className="relative flex size-8 shrink-0 items-center justify-center rounded-sm border border-hairline-strong text-fg-2 transition-colors after:absolute after:-inset-1.5 after:content-[''] hover:text-fg-1 active:bg-surface-2"
        >
          <SlidersHorizontal className="icon-md" />
        </button>
      )}
    </div>
  );
}

const SHORT: Record<(typeof RISK_CHIPS)[number]["key"], string> = {
  top10: "T10",
  dev: "Dev",
  snipers: "Snp",
  insiders: "Ins",
  bundlers: "Bnd",
};

/**
 * Under 382 px a row's risk slots drop their glyphs to fit (RiskChips: values alone in 2.8em
 * slots), so the list gets a column header instead of a loose legend: the same 36 px avatar track
 * and 8 px gap as the rows, then one 2.8em cell per slot in the slots' own type size, so each glyph
 * and short name sits directly over its value column. A list column header like Binance Meme
 * Rush's "Age / Holders / Top 10": https://mobbin.com/screens/f9b4eff0-8083-4e54-913c-51177e462d1d
 */
function RiskColumnHeader() {
  return (
    <div
      aria-hidden="true"
      className="grid h-6 shrink-0 grid-cols-[36px_minmax(0,1fr)] items-center gap-x-2 border-b border-hairline px-3 min-[382px]:hidden"
    >
      <span />
      <div className="flex min-w-0 items-center gap-1 text-label">
        {RISK_CHIPS.map(({ key }) => {
          const Icon = RISK_ICON[key];
          return (
            <span key={key} className="min-w-[2.8em] shrink-0">
              <span className="inline-flex items-center gap-0.5 text-micro font-medium text-fg-3">
                <Icon className="icon-xs" />
                {SHORT[key]}
              </span>
            </span>
          );
        })}
      </div>
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
  // perf marks (lib/perf.ts): first rows with data on screen; frame pacing while Pulse is open
  const hasRows = list.shown.length > 0;
  useEffect(() => {
    if (hasRows) mark("zf:pulse-data");
  }, [hasRows]);
  useEffect(() => trackFrames(), []);

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
      <RiskColumnHeader />
      <MobileList key={column} column={column} />
    </div>
  );
}
