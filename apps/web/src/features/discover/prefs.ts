import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { SortDir, SortKey, TrendWindow } from "./ranking";

/** Persisted Discover preferences (the search box is session-only and lives in the page). */
export interface DiscoverFilters {
  dexPaid: boolean;
  minLiq: number | null;
  minVol: number | null;
  maxTop10: number | null;
}

export const NO_DISCOVER_FILTERS: DiscoverFilters = { dexPaid: false, minLiq: null, minVol: null, maxTop10: null };

interface DiscoverPrefsState {
  window: TrendWindow;
  sort: { key: SortKey; dir: SortDir };
  filters: DiscoverFilters;
  setWindow(window: TrendWindow): void;
  setSort(sort: { key: SortKey; dir: SortDir }): void;
  setFilters(patch: Partial<DiscoverFilters>): void;
  resetFilters(): void;
}

export const useDiscoverPrefs = create<DiscoverPrefsState>()(
  persist(
    (set) => ({
      window: "1h",
      sort: { key: "rank", dir: "asc" },
      filters: NO_DISCOVER_FILTERS,
      setWindow: (window) => set({ window }),
      setSort: (sort) => set({ sort }),
      setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
      resetFilters: () => set({ filters: NO_DISCOVER_FILTERS }),
    }),
    {
      name: "zerofee.discover.ui",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ window: s.window, sort: s.sort, filters: s.filters }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<DiscoverPrefsState>;
        return { ...current, ...p, filters: { ...current.filters, ...(p.filters ?? {}) } };
      },
    },
  ),
);

export function discoverFiltersActive(f: DiscoverFilters): boolean {
  return f.dexPaid || f.minLiq !== null || f.minVol !== null || f.maxTop10 !== null;
}
