import { Check, ChevronDown, ListFilter, SlidersHorizontal, Wallet } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/bits";
import { Checkbox, NumberInput, Segmented } from "../../components/ui/controls";
import { PlatformName } from "../../components/ui/Logo";
import { BottomSheet } from "../../components/ui/Modal";
import { MenuItem, MenuSeparator, Popover } from "../../components/ui/Popover";
import { copyText } from "../../lib/clipboard";
import { useCssPx } from "../../lib/cssVar";
import { fmtInt } from "../../lib/format";
import { LAUNCHPADS } from "../../lib/metrics";
import { navigateTo } from "../../lib/nav";
import type { Launchpad, TrackedTrade } from "../../protocol";
import { useSettings } from "../../state/settings";
import { useTrackedMap, useTrackers } from "../../state/trackers";
import { MetaCount, PaneToolbar, PausedChip } from "./bits";
import { MenuList } from "./ExportMenu";
import { filterTrades, normalizeQuery, tokenBlocker } from "./feedFilters";
import { MOBILE_ROW_PX, useInsertions, useIsMobile, useLivePause, useMarkRead } from "./hooks";
import { type SideFilter, type TradeFilters as TradeFilterState, tradeFiltersActive, useTrackerPrefs } from "./prefs";
import { MobileTradeRow, TradeHeader, TradeRow, tradeId, tradeMint } from "./TradeRow";
import { VirtualGrid } from "./VirtualList";

const SIDES: { value: SideFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "buy", label: "Buys" },
  { value: "sell", label: "Sells" },
];

function launchpadLabel(selected: Launchpad[]): string {
  if (selected.length === 0) return "All launchpads";
  const first = LAUNCHPADS.find((l) => l.id === selected[0]);
  return selected.length === 1 ? (first?.label ?? "1 launchpad") : `${selected.length} launchpads`;
}

/** Launchpad filter menu: checkbox items, "All launchpads" clears (DESIGN.md 4.17 menus). */
function LaunchpadMenu() {
  const selected = useTrackerPrefs((s) => s.trades.launchpads);
  const set = useTrackerPrefs((s) => s.setTrades);
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const toggle = (id: Launchpad) => set({ launchpads: selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id] });
  return (
    <>
      <Button
        ref={anchor}
        size="xs"
        variant={selected.length > 0 ? "secondary" : "ghost"}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {launchpadLabel(selected)}
        <ChevronDown className="icon-xs" />
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} width={208}>
        <MenuList label="Launchpads">
          <MenuItem
            checked={selected.length === 0}
            onSelect={() => set({ launchpads: [] })}
            icon={<Check className={selected.length === 0 ? "text-fg-1" : "opacity-0"} />}
          >
            All launchpads
          </MenuItem>
          <MenuSeparator />
          {LAUNCHPADS.map((l) => (
            <MenuItem
              key={l.id}
              checked={selected.includes(l.id)}
              onSelect={() => toggle(l.id)}
              icon={<Check className={selected.includes(l.id) ? "text-fg-1" : "opacity-0"} />}
            >
              <PlatformName id={l.id} label={l.label} />
            </MenuItem>
          ))}
        </MenuList>
      </Popover>
    </>
  );
}

/** Live trades toolbar (DESIGN.md 5.4, 28 px): side, Min SOL, MC range, launchpads, under 1 h. */
function TradeFilters({ count, paused }: { count: number; paused: boolean }) {
  const f = useTrackerPrefs((s) => s.trades);
  const set = useTrackerPrefs((s) => s.setTrades);
  const reset = useTrackerPrefs((s) => s.resetTrades);
  return (
    <PaneToolbar>
      <Segmented<SideFilter> size="xs" value={f.side} onChange={(side) => set({ side })} options={SIDES} label="Trade side" />
      <NumberInput
        value={f.minSol}
        onChange={(minSol) => set({ minSol })}
        prefix="Min"
        suffix="SOL"
        placeholder="0"
        min={0}
        step={(v) => (v < 1 ? 0.01 : 0.1)}
        className="w-24"
        ariaLabel="Minimum trade size in SOL"
      />
      <span className="flex items-center gap-1">
        <span className="zf-label">MC</span>
        <NumberInput
          value={f.mcMin}
          onChange={(mcMin) => set({ mcMin })}
          prefix="$"
          placeholder="Min"
          min={0}
          invalid={f.mcMin !== null && f.mcMax !== null && f.mcMin > f.mcMax}
          className="w-20"
          ariaLabel="Minimum market cap at trade, USD (accepts 5k, 1.2m)"
        />
        <span className="text-fg-3">–</span>
        <NumberInput
          value={f.mcMax}
          onChange={(mcMax) => set({ mcMax })}
          prefix="$"
          placeholder="Max"
          min={0}
          invalid={f.mcMin !== null && f.mcMax !== null && f.mcMin > f.mcMax}
          className="w-20"
          ariaLabel="Maximum market cap at trade, USD (accepts 50k, 2m)"
        />
      </span>
      <LaunchpadMenu />
      <Checkbox checked={f.under1h} onChange={(under1h) => set({ under1h })} label="Only tokens under 1h" className="shrink-0" />
      {tradeFiltersActive(f) && (
        <Button size="xs" variant="ghost" onClick={reset}>
          Reset filters
        </Button>
      )}
      <span className="ml-auto flex items-center gap-2 pl-2">
        <PausedChip paused={paused} />
        <MetaCount>{count === 1 ? "1 trade" : `${fmtInt(count)} trades`}</MetaCount>
      </span>
    </PaneToolbar>
  );
}

/** Active filters other than the side switch (the side stays on the toolbar on phones). */
function sheetFilterCount(f: TradeFilterState): number {
  return (
    (f.minSol !== null ? 1 : 0) + (f.mcMin !== null || f.mcMax !== null ? 1 : 0) + (f.launchpads.length > 0 ? 1 : 0) + (f.under1h ? 1 : 0)
  );
}

/**
 * Phones: the side switch at a 44 px height plus a Filters button that opens a bottom sheet with
 * touch-size fields (44 px rows, 16 px inputs so iOS doesn't zoom), DESIGN.md 2.10 and 5.8.
 * An amount-preset sheet after Cash App's buy sheet:
 * https://mobbin.com/screens/3c393e1e-5d4a-4387-874f-281996eead50
 */
function MobileTradeFilters({ count, paused }: { count: number; paused: boolean }) {
  const f = useTrackerPrefs((s) => s.trades);
  const set = useTrackerPrefs((s) => s.setTrades);
  const reset = useTrackerPrefs((s) => s.resetTrades);
  const [open, setOpen] = useState(false);
  const active = sheetFilterCount(f);
  const rangeBad = f.mcMin !== null && f.mcMax !== null && f.mcMin > f.mcMax;
  const toggle = (id: Launchpad) =>
    set({ launchpads: f.launchpads.includes(id) ? f.launchpads.filter((x) => x !== id) : [...f.launchpads, id] });
  return (
    <PaneToolbar>
      <Segmented<SideFilter> value={f.side} onChange={(side) => set({ side })} options={SIDES} label="Trade side" className="max-md:h-13" />
      <Button
        size="md"
        variant={active > 0 ? "secondary" : "ghost"}
        icon={<SlidersHorizontal />}
        className="max-md:h-11"
        onClick={() => setOpen(true)}
      >
        Filters
        {active > 0 && <span className="zf-num text-fg-2">{active}</span>}
      </Button>
      <span className="ml-auto flex items-center gap-2 pl-2">
        <PausedChip paused={paused} />
        <MetaCount>{count === 1 ? "1 trade" : `${fmtInt(count)} trades`}</MetaCount>
      </span>
      <BottomSheet open={open} onClose={() => setOpen(false)} title="Trade filters">
        <div className="flex flex-col gap-4 p-4">
          <div className="flex flex-col gap-1">
            <span className="zf-label">Minimum trade size</span>
            <NumberInput
              size="amount"
              value={f.minSol}
              onChange={(minSol) => set({ minSol })}
              suffix="SOL"
              placeholder="0"
              min={0}
              inputClassName="text-title"
              ariaLabel="Minimum trade size in SOL"
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="zf-label">Market cap at trade, USD</span>
            <div className="flex items-center gap-2">
              <NumberInput
                size="amount"
                value={f.mcMin}
                onChange={(mcMin) => set({ mcMin })}
                prefix="$"
                placeholder="Min"
                min={0}
                invalid={rangeBad}
                inputClassName="text-title"
                className="flex-1"
                ariaLabel="Minimum market cap at trade, USD (accepts 5k, 1.2m)"
              />
              <span className="text-fg-3">–</span>
              <NumberInput
                size="amount"
                value={f.mcMax}
                onChange={(mcMax) => set({ mcMax })}
                prefix="$"
                placeholder="Max"
                min={0}
                invalid={rangeBad}
                inputClassName="text-title"
                className="flex-1"
                ariaLabel="Maximum market cap at trade, USD (accepts 50k, 2m)"
              />
            </div>
            {rangeBad && <span className="text-label text-sell">Min is above max</span>}
          </div>
          <fieldset className="flex flex-col gap-1">
            <legend className="zf-label mb-1">Launchpads (none checked means all)</legend>
            <div className="grid grid-cols-2 gap-x-4">
              {LAUNCHPADS.map((l) => (
                <Checkbox
                  key={l.id}
                  checked={f.launchpads.includes(l.id)}
                  onChange={() => toggle(l.id)}
                  label={<PlatformName id={l.id} label={l.label} />}
                  className="py-3.5"
                />
              ))}
            </div>
          </fieldset>
          <Checkbox checked={f.under1h} onChange={(under1h) => set({ under1h })} label="Only tokens under 1h" className="py-3.5" />
          <div className="grid grid-cols-2 gap-2">
            <Button size="xl" variant="secondary" onClick={reset}>
              Reset filters
            </Button>
            <Button size="xl" variant="primary" onClick={() => setOpen(false)}>
              Show {count === 1 ? "1 trade" : `${fmtInt(count)} trades`}
            </Button>
          </div>
        </div>
      </BottomSheet>
    </PaneToolbar>
  );
}

/**
 * Live trades pane: every fill by a tracked wallet, newest first, in dense rows with the
 * quick-buy pill. Hover or focus pauses it; new rows flash in their side colour.
 */
export function LiveTrades({ query, onAddWallet }: { query: string; onAddWallet?: () => void }) {
  const live = useTrackers((s) => s.live);
  const walletCount = useTrackers((s) => s.wallets.length);
  const tracked = useTrackedMap();
  const filters = useTrackerPrefs((s) => s.trades);
  const reset = useTrackerPrefs((s) => s.resetTrades);
  const blacklists = useSettings((s) => s.blacklists);
  const mobile = useIsMobile();
  const dense = useCssPx("--zf-row-dense", 20);
  const q = normalizeQuery(query);
  const filtered = useMemo(
    () => filterTrades(live, filters, tokenBlocker(blacklists), { query: q, wallets: tracked }),
    [live, filters, blacklists, q, tracked],
  );
  const { shown, paused, pending, bind, release } = useLivePause(filtered, tradeId);
  const isFresh = useInsertions(shown, tradeId);
  useMarkRead("trades");

  const open = useCallback((item: TrackedTrade, how: { newTab: boolean }) => {
    const to = `/t/${item.token.mint}`;
    if (how.newTab) window.open(to, "_blank", "noopener");
    else navigateTo(to);
  }, []);
  const copy = useCallback((item: TrackedTrade) => void copyText(item.token.mint), []);

  const filteredOut = tradeFiltersActive(filters) || q !== "";
  const empty =
    walletCount === 0 ? (
      <EmptyState
        className="text-balance"
        icon={<Wallet />}
        title="No wallets tracked"
        body="Add a wallet or import a list. Its trades appear here within about a second of landing."
        action={
          onAddWallet && (
            <Button size="sm" variant="secondary" onClick={onAddWallet}>
              Add wallet
            </Button>
          )
        }
      />
    ) : live.length === 0 ? (
      <EmptyState
        className="text-balance"
        title="No trades yet"
        body="Trades by your tracked wallets appear within about a second of landing."
      />
    ) : (
      <EmptyState
        className="text-balance"
        icon={<ListFilter />}
        title={q ? `No trades match “${query.trim()}”` : "No trades match these filters"}
        body="Loosen a filter or clear the search."
        action={
          filteredOut && tradeFiltersActive(filters) ? (
            <Button size="sm" variant="secondary" onClick={reset}>
              Reset filters
            </Button>
          ) : undefined
        }
      />
    );

  return (
    <div className="@container flex min-h-0 min-w-0 flex-1 flex-col">
      {mobile ? <MobileTradeFilters count={filtered.length} paused={paused} /> : <TradeFilters count={filtered.length} paused={paused} />}
      <VirtualGrid
        items={shown}
        getKey={tradeId}
        rowHeight={mobile ? MOBILE_ROW_PX : dense}
        label="Trades by tracked wallets"
        header={mobile ? undefined : <TradeHeader />}
        empty={empty}
        paused={paused}
        pending={pending}
        onRelease={release}
        bind={bind}
        onOpen={open}
        onCopy={copy}
        mintOf={tradeMint}
        renderRow={(item, { active }) =>
          mobile ? (
            <MobileTradeRow item={item} wallet={tracked.get(item.trade.maker)} fresh={isFresh(item.trade.id)} />
          ) : (
            <TradeRow item={item} wallet={tracked.get(item.trade.maker)} fresh={isFresh(item.trade.id)} active={active} />
          )
        }
      />
    </div>
  );
}
