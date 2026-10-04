import { cn } from "../../lib/cn";
import { fmtInt } from "../../lib/format";
import { BREAKPOINT, useMediaQuery } from "../../lib/useMediaQuery";
import { useSettings } from "../../state/settings";
import { useIsMobile, useQuickBuyHotkey } from "../trackers/hooks";
import { TabBar } from "../trackers/TabBar";
import { type DiscoverView, useDiscoverPrefs } from "./prefs";
import { NewPairsPanel, WatchlistPanel } from "./SidePanels";
import { TrendingPanel } from "./Trending";

const ID = "discover";

/*
 * Discover: the trending table beside a narrow column with the watchlist over new pairs, tiled
 * with 1 px hairlines and no gutters (DESIGN.md 2.3, 2.5), like Coinbase Advanced's panels:
 * https://mobbin.com/screens/f8afc154-e5c8-4587-ab43-93c4799a979a
 * The side column is 320 px from 1024 px and 360 px from 1280 px. Below 1024 px panel tabs pick
 * one panel. Space+B buys the hovered or keyboard-selected row.
 */
export default function DiscoverPage() {
  const wide = useMediaQuery(BREAKPOINT.lg);
  const xl = useMediaQuery(BREAKPOINT.xl);
  const mobile = useIsMobile();
  const view = useDiscoverPrefs((s) => s.view);
  const setView = useDiscoverPrefs((s) => s.setView);
  const watchCount = useSettings((s) => s.watchlist.length);
  useQuickBuyHotkey();

  if (wide) {
    return (
      <div
        className={cn("grid h-full min-h-0 gap-px bg-hairline", xl ? "grid-cols-[minmax(0,1fr)_360px]" : "grid-cols-[minmax(0,1fr)_320px]")}
      >
        <h1 className="sr-only">Discover</h1>
        <section aria-label="Trending" className="flex min-h-0 min-w-0 flex-col bg-surface-1">
          <TrendingPanel />
        </section>
        <div className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-px">
          <WatchlistPanel />
          <NewPairsPanel />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <h1 className="sr-only">Discover</h1>
      <div className={cn("shrink-0 overflow-x-auto border-b border-hairline bg-surface-1", mobile ? "h-11 px-1" : "h-topbar px-2")}>
        <TabBar<DiscoverView>
          tabs={[
            { id: "trending", label: "Trending" },
            { id: "watchlist", label: "Watchlist", count: fmtInt(watchCount) },
            { id: "new", label: "New pairs" },
          ]}
          value={view}
          onChange={setView}
          label="Discover"
          idPrefix={ID}
        />
      </div>
      <div
        role="tabpanel"
        id={`${ID}-panel-${view}`}
        aria-labelledby={`${ID}-tab-${view}`}
        className="flex min-h-0 flex-1 flex-col bg-surface-1"
      >
        {view === "trending" ? (
          <TrendingPanel />
        ) : view === "watchlist" ? (
          <WatchlistPanel header={false} />
        ) : (
          <NewPairsPanel header={false} />
        )}
      </div>
    </div>
  );
}
