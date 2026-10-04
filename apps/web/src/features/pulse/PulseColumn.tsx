import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { COLUMN_TITLE, columnDefinition } from "../../config";
import { cn } from "../../lib/cn";
import { useCssPx } from "../../lib/cssVar";
import { activeFilterCount, emptyFilter } from "../../lib/filters";
import { fmtMs } from "../../lib/format";
import { isTypingTarget, registerHotkey } from "../../lib/hotkeys";
import { useYoungerThan } from "../../lib/useNow";
import type { PulseColumnId } from "../../protocol";
import { useMarket } from "../../state/market";
import { useSettings } from "../../state/settings";
import { useUi } from "../../state/ui";
import { ActiveFilters } from "./ActiveFilters";
import { ColumnHeader } from "./ColumnHeader";
import { EmptyColumn, NewBar, SkeletonCards } from "./ColumnStates";
import { cardView, variantFor } from "./cardView";
import { RiskLegend } from "./RiskChips";
import { registerColumn, usePulseUi } from "./store";
import { openToken, TokenCard } from "./TokenCard";
import { useTrackedHolding } from "./tracked";
import { useColumnList } from "./useColumnList";
import { useColumnPause } from "./useColumnPause";
import { useScrollAnchor } from "./useScrollAnchor";

export const rowId = (column: PulseColumnId, mint: string) => `pulse-${column}-${mint}`;

/**
 * One Pulse column (DESIGN.md 4.3, 6.7): header, active-filter row, optional legend, then a
 * virtualised card grid (fixed 68 / 80 px rows, overscan 4). Hover or keyboard focus freezes
 * order and membership behind an "↑ N new" bar while values keep updating in place; scrolled
 * lists keep the cards in view still while rows insert above. The grid follows the ARIA grid
 * pattern with the keyboard cursor as the active descendant. A visible paused state for live
 * data after OpenSea: https://mobbin.com/screens/a2072a4d-d59f-4b22-92be-ddcc3100db61
 */
export function PulseColumn({ column, titleSlot }: { column: PulseColumnId; titleSlot?: ReactNode }) {
  const title = COLUMN_TITLE[column];
  const pause = useColumnPause(column);
  const list = useColumnList(column, pause.paused);
  const rowH = useCssPx("--zf-card", 68);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [width, setWidth] = useState(480);
  const [searchOpen, setSearchOpen] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [gridFocused, setGridFocused] = useState(false);

  const quickBuySol = useSettings((s) => s.columns[column].quickBuySol ?? s.quickBuySol);
  const preset = useSettings((s) => s.columns[column].preset ?? s.activePreset);
  const slot = useSettings((s) => s.columns[column].activeFilter);
  const filtered = useSettings((s) => activeFilterCount(s.columns[column].filters[s.columns[column].activeFilter]) > 0);
  const search = useSettings((s) => s.columns[column].search.trim());
  const fields = useSettings((s) => s.pulseLayout.cardFields);
  const legend = useSettings((s) => s.pulseLayout.legend);
  const display = useSettings((s) => s.display);
  const setColumn = useSettings((s) => s.setColumn);
  const setColumnFilter = useSettings((s) => s.setColumnFilter);
  const solUsd = useMarket((s) => s.solUsd);
  const anyTokens = useMarket((s) => s.columns.new.length + s.columns.final.length + s.columns.migrated.length > 0);
  const lag = useMarket((s) => s.feed.lagMs);
  const focusedMint = useUi((s) => s.focusedMint);
  const tracked = useTrackedHolding();
  const [mountedAt] = useState(() => Date.now());
  const slow = !useYoungerThan(mountedAt, 3000);
  const variant = variantFor(width);

  const virtualizer = useVirtualizer({
    count: list.shown.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 4,
    getItemKey: (i) => list.shown[i] ?? i,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: a density switch changes the row height the estimate returns
  useEffect(() => {
    virtualizer.measure();
  }, [rowH, virtualizer]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setWidth(Math.round(el.clientWidth));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The Instant Trade window follows the keyboard cursor too (selectPulseMint).
  useEffect(() => {
    usePulseUi.getState().setCursor(column, cursor);
  }, [column, cursor]);
  useEffect(() => () => usePulseUi.getState().setCursor(column, null), [column]);

  // Keyboard cursor (DESIGN.md 6.4): J/K, arrows, Home/End move it; the column scrolls to keep it in view.
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const shownRef = useRef(list.shown);
  shownRef.current = list.shown;
  const placeAt = useCallback(
    (index: number) => {
      const shown = shownRef.current;
      if (shown.length === 0) return;
      const next = Math.min(shown.length - 1, Math.max(0, index));
      const mint = shown[next];
      if (!mint) return;
      cursorRef.current = mint;
      setCursor(mint);
      virtualizer.scrollToIndex(next, { align: "auto" });
    },
    [virtualizer],
  );
  const cursorIndex = () => (cursorRef.current ? shownRef.current.indexOf(cursorRef.current) : -1);
  const move = useCallback(
    (to: number | "first" | "last") => {
      const at = cursorRef.current ? shownRef.current.indexOf(cursorRef.current) : -1;
      placeAt(to === "first" ? 0 : to === "last" ? shownRef.current.length - 1 : at < 0 ? 0 : at + to);
    },
    [placeAt],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: cursorIndex reads refs only
  useEffect(
    () =>
      registerColumn(column, {
        focus: (at) => {
          scrollRef.current?.focus({ preventScroll: true });
          if (at !== undefined && at >= 0) placeAt(at);
          else if (!cursorRef.current || !shownRef.current.includes(cursorRef.current)) move("first");
        },
        move: (to) => {
          if (document.activeElement !== scrollRef.current) scrollRef.current?.focus({ preventScroll: true });
          move(to);
        },
        cursor: () => cursorRef.current,
        cursorIndex,
        openSearch: () => setSearchOpen(true),
      }),
    [column, move, placeAt],
  );

  // Enter, Mod+Enter, Home and End belong to the grid only while it has focus, so they never
  // swallow Enter on a focused button elsewhere on the page.
  useEffect(() => {
    if (!gridFocused) return;
    const offs = [
      registerHotkey("pulse.open", () => {
        const mint = cursorRef.current;
        if (mint) openToken(mint, false);
        else move("first");
      }),
      registerHotkey("pulse.openNew", () => {
        const mint = cursorRef.current;
        if (mint) openToken(mint, true);
      }),
      registerHotkey("pulse.first", () => move("first")),
      registerHotkey("pulse.last", () => move("last")),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [gridFocused, move]);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const anchor = useScrollAnchor(scrollRef, list.shown, rowH);

  const ctx = { quote: display.quote, solUsd, showRing: display.showProgressRing, thresholds: display.riskThresholds };
  const cursorShown = cursor !== null && list.shown.includes(cursor);
  const loading = !anyTokens;
  const showLegend = legend || variant === "narrow";

  return (
    <section
      ref={pause.ref}
      aria-label={title}
      className="flex min-h-0 min-w-0 flex-col bg-surface-1"
      {...pause.handlers}
      onBlur={(e) => {
        pause.handlers.onBlur(e);
        const next = e.relatedTarget as Node | null;
        if (next && !e.currentTarget.contains(next)) setCursor(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget(e.target)) {
          // A column-scoped "/" search overrides the global palette while the column has focus.
          e.preventDefault();
          e.stopPropagation();
          setSearchOpen(true);
        } else if (e.key === "Escape" && e.target === scrollRef.current) {
          setCursor(null);
          scrollRef.current?.blur();
        }
      }}
    >
      <ColumnHeader
        column={column}
        count={list.incoming.length}
        paused={pause.paused}
        width={width}
        loadingNote={loading && slow ? `Still loading · feed lag ${fmtMs(lag)}` : null}
        titleSlot={titleSlot}
        searchOpen={searchOpen}
        setSearchOpen={setSearchOpen}
        searchRef={searchRef}
      />
      <ActiveFilters column={column} />
      {showLegend && <RiskLegend className="border-b border-hairline" />}
      <span id={`pulse-${column}-definition`} className="sr-only">
        {columnDefinition(column)}
      </span>

      <div className="relative min-h-0 flex-1">
        {list.frozen && list.queued > 0 ? (
          <NewBar count={list.queued} mode="paused" onClick={list.apply} />
        ) : anchor.unseen > 0 ? (
          <NewBar count={anchor.unseen} mode="scrolled" onClick={anchor.jumpToTop} />
        ) : null}
        {/* biome-ignore lint/a11y/useSemanticElements: virtualised, absolutely positioned rows can't be a table (ARIA grid pattern) */}
        <div
          ref={scrollRef}
          role="grid"
          tabIndex={0}
          aria-label={`${title} tokens`}
          aria-describedby={`pulse-${column}-definition`}
          aria-rowcount={list.shown.length}
          aria-activedescendant={cursorShown && cursor ? rowId(column, cursor) : undefined}
          onFocus={(e) => {
            if (e.target !== e.currentTarget) return;
            setGridFocused(true);
            if (e.currentTarget.matches(":focus-visible") && !cursorShown) move("first");
          }}
          onBlur={(e) => {
            if (e.target === e.currentTarget) setGridFocused(false);
          }}
          onScroll={(e) => anchor.onScroll(e.currentTarget.scrollTop)}
          className={cn(
            "group/grid h-full overflow-y-auto [overflow-anchor:none] [scrollbar-gutter:stable]",
            list.shown.length > 0 ? "focus-visible:outline-none" : "focus-visible:-outline-offset-2",
          )}
        >
          {loading ? (
            <SkeletonCards />
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
                  <TokenCard
                    key={item.key}
                    view={cardView(t, { ...ctx, tracked: tracked.get(mint) ?? 0 })}
                    risk={t.risk}
                    column={column}
                    variant={variant}
                    index={item.index}
                    start={item.start}
                    rowId={rowId(column, mint)}
                    quickBuySol={quickBuySol}
                    preset={preset}
                    socials={fields.socials}
                    counters={fields.counters}
                    miniChart={fields.miniChart}
                    feesNetBuy={fields.feesNetBuy}
                    colored={display.metricColors}
                    cursor={cursor === mint}
                    open={focusedMint === mint}
                    insertedAt={list.inserted.get(mint) ?? 0}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
