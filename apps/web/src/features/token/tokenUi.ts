import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Timeframe } from "../../protocol";

export type ChartMode = "mc" | "price";
export type ChartCurrency = "usd" | "sol";

export interface LimitTarget {
  /** True while the Limit tab is open: the chart shows a draggable target line. */
  active: boolean;
  side: "buy" | "sell";
  /** Target price in SOL per token (the chart converts to MC/USD for display). */
  priceSol: number | null;
}

export interface TokenUiState {
  tf: Timeframe;
  mode: ChartMode;
  currency: ChartCurrency;
  limit: LimitTarget;
  /** Clicked candle (Unix seconds, [from, to)); filters the trades table. */
  candle: { from: number; to: number } | null;
  /** Filters the trades table to one maker. */
  maker: string | null;
  setTf(tf: Timeframe): void;
  setMode(mode: ChartMode): void;
  setCurrency(currency: ChartCurrency): void;
  setLimit(patch: Partial<LimitTarget>): void;
  setCandle(candle: TokenUiState["candle"]): void;
  setMaker(maker: string | null): void;
  resetForToken(): void;
}

export const useTokenUi = create<TokenUiState>()(
  persist(
    (set) => ({
      tf: "15s",
      mode: "mc",
      currency: "usd",
      limit: { active: false, side: "buy", priceSol: null },
      candle: null,
      maker: null,
      setTf: (tf) => set({ tf, candle: null }),
      setMode: (mode) => set({ mode }),
      setCurrency: (currency) => set({ currency }),
      setLimit: (patch) => set((s) => ({ limit: { ...s.limit, ...patch } })),
      setCandle: (candle) => set({ candle }),
      setMaker: (maker) => set({ maker }),
      resetForToken: () => set({ limit: { active: false, side: "buy", priceSol: null }, candle: null, maker: null }),
    }),
    {
      name: "zerofee.tokenUi",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ tf: s.tf, mode: s.mode, currency: s.currency }),
    },
  ),
);
