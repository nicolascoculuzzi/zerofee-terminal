import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Launchpad } from "../../protocol";

/** UI-only preferences for the Trackers page and the docks (tabs, filters, sorts). */

/** Below 1280 px one pane shows the chosen tab; from 1280 px the wallet manager is always on the left. */
export type TrackerTab = "wallets" | "trades" | "monitor" | "x" | "copy";
/** The right pane at 1280 px and up. */
export type TrackerPane = Exclude<TrackerTab, "wallets">;
export type SideFilter = "all" | "buy" | "sell";
export type FeedScope = "all" | "mine";
export type XView = "feed" | "handles";
export type SortDir = "asc" | "desc";

export type WalletSortKey = "name" | "added" | "lastTrade";
export type MonitorSortKey = "holders" | "flow" | "firstBuy" | "mc";

export interface TradeFilters {
  side: SideFilter;
  minSol: number | null;
  /** Market cap at trade time, USD. */
  mcMin: number | null;
  mcMax: number | null;
  /** Empty = every launchpad. */
  launchpads: Launchpad[];
  /** Only tokens created less than an hour ago. */
  under1h: boolean;
}

export const NO_TRADE_FILTERS: TradeFilters = { side: "all", minSol: null, mcMin: null, mcMax: null, launchpads: [], under1h: false };

interface TrackerPrefsState {
  tab: TrackerTab;
  pane: TrackerPane;
  trades: TradeFilters;
  walletSort: { key: WalletSortKey; dir: SortDir };
  monitorSort: { key: MonitorSortKey; dir: SortDir };
  feedScope: FeedScope;
  xView: XView;
  setTab(tab: TrackerTab): void;
  setTrades(patch: Partial<TradeFilters>): void;
  resetTrades(): void;
  setWalletSort(sort: { key: WalletSortKey; dir: SortDir }): void;
  setMonitorSort(sort: { key: MonitorSortKey; dir: SortDir }): void;
  setFeedScope(scope: FeedScope): void;
  setXView(view: XView): void;
}

const TABS: readonly TrackerTab[] = ["wallets", "trades", "monitor", "x", "copy"];

export const useTrackerPrefs = create<TrackerPrefsState>()(
  persist(
    (set) => ({
      tab: "trades",
      pane: "trades",
      trades: NO_TRADE_FILTERS,
      walletSort: { key: "added", dir: "desc" },
      monitorSort: { key: "holders", dir: "desc" },
      feedScope: "all",
      xView: "feed",
      setTab: (tab) => set(tab === "wallets" ? { tab } : { tab, pane: tab }),
      setTrades: (patch) => set((s) => ({ trades: { ...s.trades, ...patch } })),
      resetTrades: () => set({ trades: NO_TRADE_FILTERS }),
      setWalletSort: (walletSort) => set({ walletSort }),
      setMonitorSort: (monitorSort) => set({ monitorSort }),
      setFeedScope: (feedScope) => set({ feedScope }),
      setXView: (xView) => set({ xView }),
    }),
    {
      name: "zerofee.trackers.ui",
      version: 2,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        tab: s.tab,
        pane: s.pane,
        trades: s.trades,
        walletSort: s.walletSort,
        monitorSort: s.monitorSort,
        feedScope: s.feedScope,
        xView: s.xView,
      }),
      // v1 stored { walletTab, xTab, mobilePanel, trades: { side, minSol, maxMc }, monitorSort: string }.
      migrate: (persisted) => {
        const p = (persisted ?? {}) as Record<string, unknown>;
        const old = (p.trades ?? {}) as Partial<TradeFilters> & { maxMc?: number | null };
        return {
          trades: { ...NO_TRADE_FILTERS, side: old.side ?? "all", minSol: old.minSol ?? null, mcMax: old.maxMc ?? null },
          feedScope: p.feedScope === "mine" ? "mine" : "all",
        } as Partial<TrackerPrefsState>;
      },
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<TrackerPrefsState>;
        const tab = p.tab && TABS.includes(p.tab) ? p.tab : current.tab;
        const pane = p.pane && p.pane !== ("wallets" as TrackerTab) && TABS.includes(p.pane) ? p.pane : current.pane;
        return {
          ...current,
          ...p,
          tab,
          pane,
          trades: { ...current.trades, ...(p.trades ?? {}) },
          walletSort: { ...current.walletSort, ...(p.walletSort ?? {}) },
          monitorSort: { ...current.monitorSort, ...(p.monitorSort ?? {}) },
        };
      },
    },
  ),
);

export function tradeFiltersActive(f: TradeFilters): boolean {
  return f.side !== "all" || f.minSol !== null || f.mcMin !== null || f.mcMax !== null || f.launchpads.length > 0 || f.under1h;
}
