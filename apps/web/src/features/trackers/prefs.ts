import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** UI-only preferences for the trackers page and dock (tabs, feed filters). */

export type WalletTab = "manager" | "trades" | "monitor";
export type XTab = "feed" | "customize";
export type MobilePanel = "wallets" | "x";
export type SideFilter = "all" | "buy" | "sell";
export type MonitorSort = "wallets" | "net" | "recent";
export type FeedScope = "all" | "mine";

export interface TradeFilters {
  side: SideFilter;
  minSol: number | null;
  /** USD market cap at trade time. */
  maxMc: number | null;
}

export const NO_TRADE_FILTERS: TradeFilters = { side: "all", minSol: null, maxMc: null };

interface TrackerPrefsState {
  walletTab: WalletTab;
  xTab: XTab;
  mobilePanel: MobilePanel;
  trades: TradeFilters;
  monitorSort: MonitorSort;
  feedScope: FeedScope;
  setWalletTab(tab: WalletTab): void;
  setXTab(tab: XTab): void;
  setMobilePanel(panel: MobilePanel): void;
  setTrades(patch: Partial<TradeFilters>): void;
  setMonitorSort(sort: MonitorSort): void;
  setFeedScope(scope: FeedScope): void;
}

export const useTrackerPrefs = create<TrackerPrefsState>()(
  persist(
    (set) => ({
      walletTab: "trades",
      xTab: "feed",
      mobilePanel: "wallets",
      trades: NO_TRADE_FILTERS,
      monitorSort: "wallets",
      feedScope: "all",
      setWalletTab: (walletTab) => set({ walletTab }),
      setXTab: (xTab) => set({ xTab }),
      setMobilePanel: (mobilePanel) => set({ mobilePanel }),
      setTrades: (patch) => set((s) => ({ trades: { ...s.trades, ...patch } })),
      setMonitorSort: (monitorSort) => set({ monitorSort }),
      setFeedScope: (feedScope) => set({ feedScope }),
    }),
    {
      name: "zerofee.trackers.ui",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        walletTab: s.walletTab,
        xTab: s.xTab,
        mobilePanel: s.mobilePanel,
        trades: s.trades,
        monitorSort: s.monitorSort,
        feedScope: s.feedScope,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<TrackerPrefsState>;
        return { ...current, ...p, trades: { ...current.trades, ...(p.trades ?? {}) } };
      },
    },
  ),
);
