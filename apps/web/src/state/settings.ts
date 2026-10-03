import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { type BlacklistEntry, type Blacklists, emptyFilter, normalizeFilter, type PulseFilter } from "../lib/filters";
import { DEFAULT_HOTKEYS, type HotkeyAction } from "../lib/hotkeys";
import type { LandingPreset, PulseColumnId } from "../protocol";
import type { ExecutionSettings, TradeMode } from "../services/tradeService";

export type PresetId = "P1" | "P2" | "P3";
export const PRESET_IDS: PresetId[] = ["P1", "P2", "P3"];

export interface TradePreset {
  id: PresetId;
  label: string;
  buy: ExecutionSettings;
  sell: ExecutionSettings;
  /** Trade panel amount buttons, SOL. */
  buyAmounts: number[];
  /** Trade panel sell buttons, %. */
  sellPcts: number[];
  /** Instant Trade buy buttons, SOL. */
  instantBuy: number[];
  /** Instant Trade sell buttons in % mode. */
  instantSellPct: number[];
  /** Instant Trade sell buttons in SOL mode (SOL value to sell). */
  instantSellSol: number[];
}

export interface ColumnSettings {
  /** Null = use the global quick-buy amount. */
  quickBuySol: number | null;
  /** Null = use the globally active preset. */
  preset: PresetId | null;
  sound: boolean;
  activeFilter: 0 | 1 | 2;
  filters: [PulseFilter, PulseFilter, PulseFilter];
  search: string;
}

export type ToastPosition = "top-right" | "bottom-right" | "bottom-left" | "top-center";
export type Theme = "dark" | "light";

export interface DisplaySettings {
  theme: Theme;
  metricColors: boolean;
  compactCards: boolean;
  showProgressRing: boolean;
  largeQuickBuy: boolean;
  toastPosition: ToastPosition;
  /** Pulse list coalescing rate, 4–10 Hz (SPEC "Streaming"). */
  pulseHz: number;
  soundVolume: number;
}

export interface WithdrawalDestination {
  id: string;
  address: string;
  label: string;
  addedAt: number;
  /** Non-default destinations need a connected-wallet signature plus a 24 h delay. */
  activeAt: number;
}

export interface InstantTradeState {
  open: boolean;
  x: number;
  y: number;
  sellMode: "pct" | "sol";
  /** Trading-wallet addresses selected in the window's wallet picker (empty = active wallet). */
  wallets: string[];
}

export type BlacklistKind = keyof Blacklists;

export interface SettingsState {
  presets: Record<PresetId, TradePreset>;
  activePreset: PresetId;
  quickBuySol: number;
  columns: Record<PulseColumnId, ColumnSettings>;
  hotkeys: Record<HotkeyAction, string[]>;
  tradeHotkeys: boolean;
  display: DisplaySettings;
  defaultMode: TradeMode;
  autoLockMinutes: number;
  caps: { perTradeSol: number; dailySol: number };
  withdrawalDestinations: WithdrawalDestination[];
  blacklists: Blacklists;
  recentSearches: string[];
  recentTokens: string[];
  watchlist: string[];
  instant: InstantTradeState;
  docks: { tracker: boolean; social: boolean };
  autoBuyOnPaste: boolean;
  onboarded: boolean;

  setPreset(id: PresetId, patch: Partial<TradePreset>): void;
  setPresetSide(id: PresetId, side: "buy" | "sell", patch: Partial<ExecutionSettings>): void;
  setActivePreset(id: PresetId): void;
  setQuickBuy(sol: number): void;
  setColumn(column: PulseColumnId, patch: Partial<ColumnSettings>): void;
  setColumnFilter(column: PulseColumnId, index: 0 | 1 | 2, filter: PulseFilter): void;
  applyFilterToAll(filter: PulseFilter): void;
  setHotkey(action: HotkeyAction, bindings: string[]): void;
  resetHotkeys(): void;
  setTradeHotkeys(on: boolean): void;
  setDisplay(patch: Partial<DisplaySettings>): void;
  setDefaultMode(mode: TradeMode): void;
  setAutoLock(minutes: number): void;
  setCaps(patch: Partial<SettingsState["caps"]>): void;
  addWithdrawalDestination(address: string, label: string): void;
  removeWithdrawalDestination(id: string): void;
  addBlacklist(kind: BlacklistKind, value: string, note?: string): void;
  removeBlacklist(kind: BlacklistKind, value: string): void;
  addRecentSearch(query: string): void;
  clearRecentSearches(): void;
  addRecentToken(mint: string): void;
  toggleWatch(mint: string): void;
  setInstant(patch: Partial<InstantTradeState>): void;
  setDocks(patch: Partial<SettingsState["docks"]>): void;
  setAutoBuyOnPaste(on: boolean): void;
  setOnboarded(done: boolean): void;
}

const side = (slippagePct: number, priorityFeeSol: number, tipSol: number, landing: LandingPreset): ExecutionSettings => ({
  slippagePct,
  priorityFeeSol,
  tipSol,
  landing,
});

/** Lean defaults: terminal-default gas is 100–1,000× what calm markets need (SPEC). */
export const DEFAULT_PRESETS: Record<PresetId, TradePreset> = {
  P1: {
    id: "P1",
    label: "Lean",
    buy: side(20, 0.0001, 0.00001, "reduced"),
    sell: side(25, 0.0001, 0.00001, "reduced"),
    buyAmounts: [0.1, 0.25, 0.5, 1],
    sellPcts: [10, 25, 50, 100],
    instantBuy: [0.05, 0.1, 0.5, 1],
    instantSellPct: [10, 25, 50, 100],
    instantSellSol: [0.05, 0.1, 0.25, 0.5],
  },
  P2: {
    id: "P2",
    label: "Protected",
    buy: side(15, 0.0003, 0.0001, "secure"),
    sell: side(20, 0.0003, 0.0001, "secure"),
    buyAmounts: [0.25, 0.5, 1, 2],
    sellPcts: [25, 50, 75, 100],
    instantBuy: [0.1, 0.25, 0.5, 2],
    instantSellPct: [25, 50, 75, 100],
    instantSellSol: [0.1, 0.25, 0.5, 1],
  },
  P3: {
    id: "P3",
    label: "Fast",
    buy: side(30, 0.001, 0.001, "fast"),
    sell: side(35, 0.001, 0.001, "fast"),
    buyAmounts: [0.5, 1, 2, 5],
    sellPcts: [25, 50, 75, 100],
    instantBuy: [0.25, 0.5, 1, 2],
    instantSellPct: [25, 50, 75, 100],
    instantSellSol: [0.25, 0.5, 1, 2],
  },
};

const defaultColumn = (): ColumnSettings => ({
  quickBuySol: null,
  preset: null,
  sound: false,
  activeFilter: 0,
  filters: [emptyFilter(), emptyFilter(), emptyFilter()],
  search: "",
});

const emptyBlacklists = (): Blacklists => ({ tokens: [], devs: [], fundingWallets: [], xHandles: [] });

export const useSettings = create<SettingsState>()(
  persist(
    (set, get) => ({
      presets: DEFAULT_PRESETS,
      activePreset: "P1",
      quickBuySol: 0.25,
      columns: { new: defaultColumn(), final: defaultColumn(), migrated: defaultColumn() },
      hotkeys: DEFAULT_HOTKEYS,
      tradeHotkeys: true,
      display: {
        theme: "dark",
        metricColors: true,
        compactCards: false,
        showProgressRing: true,
        largeQuickBuy: false,
        toastPosition: "bottom-right",
        pulseHz: 6,
        soundVolume: 0.5,
      },
      defaultMode: "instant",
      autoLockMinutes: 15,
      caps: { perTradeSol: 5, dailySol: 50 },
      withdrawalDestinations: [],
      blacklists: emptyBlacklists(),
      recentSearches: [],
      recentTokens: [],
      watchlist: [],
      instant: { open: false, x: -1, y: -1, sellMode: "pct", wallets: [] },
      docks: { tracker: false, social: false },
      autoBuyOnPaste: false,
      onboarded: false,

      setPreset: (id, patch) => set((s) => ({ presets: { ...s.presets, [id]: { ...s.presets[id], ...patch } } })),
      setPresetSide: (id, which, patch) =>
        set((s) => ({
          presets: { ...s.presets, [id]: { ...s.presets[id], [which]: { ...s.presets[id][which], ...patch } } },
        })),
      setActivePreset: (id) => set({ activePreset: id }),
      setQuickBuy: (sol) => set({ quickBuySol: Math.max(0, sol) }),
      setColumn: (column, patch) => set((s) => ({ columns: { ...s.columns, [column]: { ...s.columns[column], ...patch } } })),
      setColumnFilter: (column, index, filter) =>
        set((s) => {
          const filters = [...s.columns[column].filters] as ColumnSettings["filters"];
          filters[index] = filter;
          return { columns: { ...s.columns, [column]: { ...s.columns[column], filters } } };
        }),
      applyFilterToAll: (filter) =>
        set((s) => {
          const next = { ...s.columns };
          for (const col of ["new", "final", "migrated"] as const) {
            const filters = [...next[col].filters] as ColumnSettings["filters"];
            filters[next[col].activeFilter] = normalizeFilter(filter);
            next[col] = { ...next[col], filters };
          }
          return { columns: next };
        }),
      setHotkey: (action, bindings) => set((s) => ({ hotkeys: { ...s.hotkeys, [action]: bindings } })),
      resetHotkeys: () => set({ hotkeys: DEFAULT_HOTKEYS }),
      setTradeHotkeys: (on) => set({ tradeHotkeys: on }),
      setDisplay: (patch) => set((s) => ({ display: { ...s.display, ...patch } })),
      setDefaultMode: (mode) => set({ defaultMode: mode }),
      setAutoLock: (minutes) => set({ autoLockMinutes: minutes }),
      setCaps: (patch) => set((s) => ({ caps: { ...s.caps, ...patch } })),
      addWithdrawalDestination: (address, label) =>
        set((s) => ({
          withdrawalDestinations: [
            ...s.withdrawalDestinations,
            {
              id: `wd-${Date.now().toString(36)}`,
              address,
              label,
              addedAt: Date.now(),
              activeAt: Date.now() + 24 * 3_600_000,
            },
          ],
        })),
      removeWithdrawalDestination: (id) => set((s) => ({ withdrawalDestinations: s.withdrawalDestinations.filter((d) => d.id !== id) })),
      addBlacklist: (kind, value, note = "") => {
        const v = value.trim();
        if (!v) return;
        const list = get().blacklists[kind];
        if (list.some((e) => e.value === v)) return;
        const entry: BlacklistEntry = { value: v, note, addedAt: Date.now() };
        set((s) => ({ blacklists: { ...s.blacklists, [kind]: [entry, ...s.blacklists[kind]] } }));
      },
      removeBlacklist: (kind, value) =>
        set((s) => ({ blacklists: { ...s.blacklists, [kind]: s.blacklists[kind].filter((e) => e.value !== value) } })),
      addRecentSearch: (query) => {
        const q = query.trim();
        if (!q) return;
        set((s) => ({ recentSearches: [q, ...s.recentSearches.filter((r) => r !== q)].slice(0, 8) }));
      },
      clearRecentSearches: () => set({ recentSearches: [] }),
      addRecentToken: (mint) => set((s) => ({ recentTokens: [mint, ...s.recentTokens.filter((m) => m !== mint)].slice(0, 12) })),
      toggleWatch: (mint) =>
        set((s) => ({
          watchlist: s.watchlist.includes(mint) ? s.watchlist.filter((m) => m !== mint) : [mint, ...s.watchlist],
        })),
      setInstant: (patch) => set((s) => ({ instant: { ...s.instant, ...patch } })),
      setDocks: (patch) => set((s) => ({ docks: { ...s.docks, ...patch } })),
      setAutoBuyOnPaste: (on) => set({ autoBuyOnPaste: on }),
      setOnboarded: (done) => set({ onboarded: done }),
    }),
    {
      name: "zerofee.settings",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        presets: s.presets,
        activePreset: s.activePreset,
        quickBuySol: s.quickBuySol,
        columns: s.columns,
        hotkeys: s.hotkeys,
        tradeHotkeys: s.tradeHotkeys,
        display: s.display,
        defaultMode: s.defaultMode,
        autoLockMinutes: s.autoLockMinutes,
        caps: s.caps,
        withdrawalDestinations: s.withdrawalDestinations,
        blacklists: s.blacklists,
        recentSearches: s.recentSearches,
        recentTokens: s.recentTokens,
        watchlist: s.watchlist,
        instant: s.instant,
        docks: s.docks,
        autoBuyOnPaste: s.autoBuyOnPaste,
        onboarded: s.onboarded,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SettingsState>;
        return {
          ...current,
          ...p,
          presets: { ...current.presets, ...(p.presets ?? {}) },
          hotkeys: { ...current.hotkeys, ...(p.hotkeys ?? {}) },
          display: { ...current.display, ...(p.display ?? {}) },
          caps: { ...current.caps, ...(p.caps ?? {}) },
          blacklists: { ...current.blacklists, ...(p.blacklists ?? {}) },
          instant: { ...current.instant, ...(p.instant ?? {}) },
          docks: { ...current.docks, ...(p.docks ?? {}) },
          columns: {
            new: { ...current.columns.new, ...(p.columns?.new ?? {}) },
            final: { ...current.columns.final, ...(p.columns?.final ?? {}) },
            migrated: { ...current.columns.migrated, ...(p.columns?.migrated ?? {}) },
          },
        };
      },
    },
  ),
);

/** Execution settings for a side of the given (or active) preset. */
export function presetSettings(side: "buy" | "sell", id?: PresetId | null): ExecutionSettings {
  const s = useSettings.getState();
  return s.presets[id ?? s.activePreset][side];
}

/** Quick-buy amount and preset for a Pulse column, falling back to the global ones. */
export function columnQuickBuy(column: PulseColumnId): { sol: number; preset: PresetId } {
  const s = useSettings.getState();
  const c = s.columns[column];
  return { sol: c.quickBuySol ?? s.quickBuySol, preset: c.preset ?? s.activePreset };
}
