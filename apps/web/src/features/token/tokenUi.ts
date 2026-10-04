import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { uid } from "../../lib/cn";
import { TIMEFRAMES, type Timeframe } from "../../protocol";

/*
 * Token-page UI state shared by the chart, the bottom tables, the trade panel and the page
 * hotkeys (B/S, M/L/A, [ ], Shift+M, Shift+1…6). Preferences persist; per-token session state
 * (side, order type, drafts, filters) resets when another token opens.
 */

export type ChartMode = "mc" | "price";
export type ChartType = "candles" | "bars" | "line";
export type TradeSide = "buy" | "sell";
export type OrderType = "market" | "limit" | "advanced";
export type SellUnit = "pct" | "sol";
export type TriggerMetric = "mc" | "price";
export type LadderMode = "pct" | "mc";
export type BottomTab = "trades" | "positions" | "orders" | "holders" | "traders" | "dev" | "info";

/** Markers menu items (DESIGN.md 4.10). */
export type MarkerKey = "you" | "dev" | "tracked" | "snipers" | "avgLines" | "orderLines" | "migration" | "candleClick";

export const MARKER_LABEL: Record<MarkerKey, string> = {
  you: "My trades",
  dev: "Dev trades",
  tracked: "Tracked wallets",
  snipers: "Snipers and bundlers",
  avgLines: "Average entry/exit lines",
  orderLines: "Open order lines",
  migration: "Migration line",
  candleClick: "Click a candle to filter trades",
};

export interface LadderLeg {
  id: string;
  kind: "take_profit" | "stop_loss";
  /** Distance from the entry, % (TP up, SL down). */
  triggerPct: number;
  /** Share of the holding to sell, %. */
  sellPct: number;
}

/** A price alert drawn as a dashed line; fires once while the token page is open. */
export interface TokenAlert {
  id: string;
  mint: string;
  /** SOL per token (unit-free across the USD/SOL quote). */
  priceSol: number;
  /** True when the alert fires on a cross from below. */
  above: boolean;
  createdAt: number;
}

export interface TokenUiState {
  // Preferences (persisted)
  tf: Timeframe;
  mode: ChartMode;
  chartType: ChartType;
  volume: boolean;
  movingAverage: boolean;
  markers: Record<MarkerKey, boolean>;
  /** Chart share of the main column (DESIGN.md 5.2 default 56%). */
  split: number;
  tradeCols: { price: boolean };
  alerts: TokenAlert[];
  buySol: number | null;
  sellPct: number | null;
  sellSol: number | null;
  sellUnit: SellUnit;
  triggerMetric: TriggerMetric;
  ladderMode: LadderMode;
  ladder: LadderLeg[];
  oco: boolean;
  costOpen: boolean;

  // Session state (reset per token)
  tab: BottomTab;
  side: TradeSide;
  orderType: OrderType;
  /** Limit-order draft target in SOL per token; drawn as a dashed draggable line. */
  limitPriceSol: number | null;
  /** Clicked candle (Unix seconds, [from, to)); filters the trades table. */
  candle: { from: number; to: number } | null;
  /** Filters the trades table to one trader. */
  maker: string | null;
  maximized: boolean;

  setTf(tf: Timeframe): void;
  stepTf(delta: 1 | -1): void;
  setMode(mode: ChartMode): void;
  setChartType(type: ChartType): void;
  setVolume(on: boolean): void;
  setMovingAverage(on: boolean): void;
  toggleMarker(key: MarkerKey): void;
  setSplit(split: number): void;
  setTradeCols(patch: Partial<TokenUiState["tradeCols"]>): void;
  addAlert(mint: string, priceSol: number, currentPriceSol: number): string;
  moveAlert(id: string, priceSol: number, currentPriceSol: number): void;
  removeAlert(id: string): void;
  setBuySol(v: number | null): void;
  setSellPct(v: number | null): void;
  setSellSol(v: number | null): void;
  setSellUnit(unit: SellUnit): void;
  setTriggerMetric(metric: TriggerMetric): void;
  setLadderMode(mode: LadderMode): void;
  setLadder(ladder: LadderLeg[]): void;
  updateLeg(id: string, patch: Partial<LadderLeg>): void;
  setOco(on: boolean): void;
  setCostOpen(open: boolean): void;
  setTab(tab: BottomTab): void;
  setSide(side: TradeSide): void;
  setOrderType(type: OrderType): void;
  setLimitPriceSol(priceSol: number | null): void;
  setCandle(candle: TokenUiState["candle"]): void;
  setMaker(maker: string | null): void;
  setMaximized(on: boolean): void;
  resetForToken(): void;
}

export const DEFAULT_SPLIT = 0.56;

export const DEFAULT_MARKERS: Record<MarkerKey, boolean> = {
  you: true,
  dev: true,
  tracked: true,
  snipers: false,
  avgLines: true,
  orderLines: true,
  migration: true,
  candleClick: true,
};

export function defaultLadder(): LadderLeg[] {
  return [
    { id: uid("leg"), kind: "take_profit", triggerPct: 50, sellPct: 25 },
    { id: uid("leg"), kind: "take_profit", triggerPct: 100, sellPct: 50 },
    { id: uid("leg"), kind: "stop_loss", triggerPct: 30, sellPct: 100 },
  ];
}

const MAX_ALERTS = 60;

export const useTokenUi = create<TokenUiState>()(
  persist(
    (set) => ({
      tf: "15s",
      mode: "mc",
      chartType: "candles",
      volume: true,
      movingAverage: false,
      markers: DEFAULT_MARKERS,
      split: DEFAULT_SPLIT,
      tradeCols: { price: false },
      alerts: [],
      buySol: null,
      sellPct: 50,
      sellSol: null,
      sellUnit: "pct",
      triggerMetric: "mc",
      ladderMode: "pct",
      ladder: defaultLadder(),
      oco: true,
      costOpen: false,

      tab: "trades",
      side: "buy",
      orderType: "market",
      limitPriceSol: null,
      candle: null,
      maker: null,
      maximized: false,

      setTf: (tf) => set({ tf, candle: null }),
      stepTf: (delta) =>
        set((s) => {
          const i = TIMEFRAMES.indexOf(s.tf);
          const next = TIMEFRAMES[Math.min(TIMEFRAMES.length - 1, Math.max(0, i + delta))] ?? s.tf;
          return next === s.tf ? s : { tf: next, candle: null };
        }),
      setMode: (mode) => set({ mode }),
      setChartType: (chartType) => set({ chartType }),
      setVolume: (volume) => set({ volume }),
      setMovingAverage: (movingAverage) => set({ movingAverage }),
      toggleMarker: (key) => set((s) => ({ markers: { ...s.markers, [key]: !s.markers[key] } })),
      setSplit: (split) => set({ split: Math.min(0.9, Math.max(0.1, split)) }),
      setTradeCols: (patch) => set((s) => ({ tradeCols: { ...s.tradeCols, ...patch } })),
      addAlert: (mint, priceSol, currentPriceSol) => {
        const id = uid("alert");
        set((s) => ({
          alerts: [{ id, mint, priceSol, above: priceSol >= currentPriceSol, createdAt: Date.now() }, ...s.alerts].slice(0, MAX_ALERTS),
        }));
        return id;
      },
      moveAlert: (id, priceSol, currentPriceSol) =>
        set((s) => ({ alerts: s.alerts.map((a) => (a.id === id ? { ...a, priceSol, above: priceSol >= currentPriceSol } : a)) })),
      removeAlert: (id) => set((s) => ({ alerts: s.alerts.filter((a) => a.id !== id) })),
      setBuySol: (buySol) => set({ buySol }),
      setSellPct: (sellPct) => set({ sellPct }),
      setSellSol: (sellSol) => set({ sellSol }),
      setSellUnit: (sellUnit) => set({ sellUnit }),
      setTriggerMetric: (triggerMetric) => set({ triggerMetric }),
      setLadderMode: (ladderMode) => set({ ladderMode }),
      setLadder: (ladder) => set({ ladder }),
      updateLeg: (id, patch) => set((s) => ({ ladder: s.ladder.map((l) => (l.id === id ? { ...l, ...patch } : l)) })),
      setOco: (oco) => set({ oco }),
      setCostOpen: (costOpen) => set({ costOpen }),
      setTab: (tab) => set({ tab }),
      setSide: (side) => set({ side }),
      setOrderType: (orderType) => set({ orderType }),
      setLimitPriceSol: (limitPriceSol) => set({ limitPriceSol }),
      setCandle: (candle) => set({ candle }),
      setMaker: (maker) => set({ maker }),
      setMaximized: (maximized) => set({ maximized }),
      resetForToken: () =>
        set({
          side: "buy",
          orderType: "market",
          limitPriceSol: null,
          candle: null,
          maker: null,
          maximized: false,
          tab: "trades",
        }),
    }),
    {
      name: "zerofee.tokenUi",
      version: 2,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        tf: s.tf,
        mode: s.mode,
        chartType: s.chartType,
        volume: s.volume,
        movingAverage: s.movingAverage,
        markers: s.markers,
        split: s.split,
        tradeCols: s.tradeCols,
        alerts: s.alerts,
        buySol: s.buySol,
        sellPct: s.sellPct,
        sellSol: s.sellSol,
        sellUnit: s.sellUnit,
        triggerMetric: s.triggerMetric,
        ladderMode: s.ladderMode,
        ladder: s.ladder,
        oco: s.oco,
        costOpen: s.costOpen,
      }),
      // Older versions stored only tf/mode/currency; keep what still applies.
      migrate: (persisted) => {
        const p = (persisted ?? {}) as Partial<TokenUiState>;
        return { tf: p.tf, mode: p.mode } as Partial<TokenUiState>;
      },
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<TokenUiState>;
        return {
          ...current,
          ...p,
          markers: { ...current.markers, ...(p.markers ?? {}) },
          tradeCols: { ...current.tradeCols, ...(p.tradeCols ?? {}) },
          ladder: Array.isArray(p.ladder) && p.ladder.length > 0 ? p.ladder : current.ladder,
          alerts: Array.isArray(p.alerts) ? p.alerts : current.alerts,
        };
      },
    },
  ),
);
