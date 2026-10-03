import { type ReactNode, useMemo } from "react";
import { Button } from "../../components/ui/Button";
import { NumberInput, Segmented } from "../../components/ui/controls";
import { useSettings } from "../../state/settings";
import { useTrackedMap, useTrackers } from "../../state/trackers";
import { PauseStatus } from "./bits";
import { filterTrades, tokenBlocker, tradeFiltersActive } from "./feedFilters";
import { useArrivals, useHoverPause, useMarkRead, useRowHeight } from "./hooks";
import { NO_TRADE_FILTERS, type SideFilter, useTrackerPrefs } from "./prefs";
import { TradeHeader, TradeRow, tradeId } from "./TradeRow";
import { VirtualList } from "./VirtualList";

function TradeFiltersBar({ status }: { status: ReactNode }) {
  const f = useTrackerPrefs((s) => s.trades);
  const set = useTrackerPrefs((s) => s.setTrades);
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line p-2">
      <Segmented<SideFilter>
        value={f.side}
        onChange={(side) => set({ side })}
        options={[
          { value: "all", label: "All" },
          { value: "buy", label: "Buys" },
          { value: "sell", label: "Sells" },
        ]}
        tone={(v) => (v === "buy" ? "buy" : v === "sell" ? "sell" : "neutral")}
        label="Trade side"
      />
      <NumberInput
        value={f.minSol}
        onChange={(minSol) => set({ minSol })}
        prefix="Min"
        suffix="SOL"
        min={0}
        placeholder="0"
        alignRight
        className="w-28"
        ariaLabel="Minimum trade size in SOL"
      />
      <NumberInput
        value={f.maxMc}
        onChange={(maxMc) => set({ maxMc })}
        prefix="Max MC $"
        min={0}
        placeholder="any"
        alignRight
        className="w-32"
        ariaLabel="Maximum market cap in USD (accepts 50k, 2m)"
      />
      {tradeFiltersActive(f) && (
        <Button size="md" variant="ghost" onClick={() => set(NO_TRADE_FILTERS)}>
          Reset
        </Button>
      )}
      <span className="ml-auto">{status}</span>
    </div>
  );
}

/*
 * Live Trades: every fill by a tracked wallet, newest first, with the global quick-buy amount.
 * Row anatomy is documented on TradeRow (Base Activity list / Copilot Money density).
 */
export function LiveTrades() {
  const live = useTrackers((s) => s.live);
  const walletCount = useTrackers((s) => s.wallets.length);
  const tracked = useTrackedMap();
  const filters = useTrackerPrefs((s) => s.trades);
  const blacklists = useSettings((s) => s.blacklists);
  const filtered = useMemo(() => filterTrades(live, filters, tokenBlocker(blacklists)), [live, filters, blacklists]);
  const { shown, paused, pending, bind } = useHoverPause(filtered);
  const isFresh = useArrivals(live, tradeId);
  const rowHeight = useRowHeight();
  useMarkRead("trades");

  const empty =
    walletCount === 0
      ? "Track wallets in Wallet Manager to see their trades here."
      : live.length === 0
        ? "Waiting for tracked wallets to trade."
        : "No trades match these filters.";

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <TradeFiltersBar
        status={<PauseStatus paused={paused} pending={pending} idle={`${filtered.length.toLocaleString("en-US")} trades`} />}
      />
      <TradeHeader />
      <div className="flex min-h-0 flex-1 flex-col" {...bind}>
        {shown.length === 0 ? (
          <p className="px-3 py-4 text-sm text-dim">{empty}</p>
        ) : (
          <VirtualList
            label="Tracked wallet trades"
            count={shown.length}
            rowHeight={rowHeight}
            getKey={(i) => shown[i]?.trade.id ?? i}
            renderRow={(i) => {
              const item = shown[i];
              return item ? <TradeRow item={item} wallet={tracked.get(item.trade.maker)} fresh={isFresh(item.trade.id)} /> : null;
            }}
          />
        )}
      </div>
    </div>
  );
}
