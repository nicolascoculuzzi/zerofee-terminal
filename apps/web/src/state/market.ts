import { create } from "zustand";
import type { FeedHealth, MarketStatus, PulseColumnId, TokenSummary } from "../protocol";
import type { FeedConnectionState } from "../services/dataSource";

export interface PulseBatch {
  column: PulseColumnId;
  /** Present when a fresh snapshot replaces the column. */
  snapshot: TokenSummary[] | null;
  upsert: TokenSummary[];
  remove: string[];
}

export interface MarketState {
  tokens: Record<string, TokenSummary>;
  columns: Record<PulseColumnId, string[]>;
  solUsd: number;
  slot: number;
  feed: FeedHealth;
  connection: FeedConnectionState;
  /** Applies coalesced Pulse updates in one store write; returns mints that newly entered each column. */
  applyPulse(batches: PulseBatch[]): Record<PulseColumnId, string[]>;
  upsertToken(token: TokenSummary): void;
  setMarket(status: MarketStatus): void;
  setConnection(state: FeedConnectionState): void;
}

const sorters: Record<PulseColumnId, (a: TokenSummary, b: TokenSummary) => number> = {
  new: (a, b) => b.createdAt - a.createdAt,
  final: (a, b) => b.bondingProgress - a.bondingProgress || b.createdAt - a.createdAt,
  migrated: (a, b) => (b.migratedAt ?? 0) - (a.migratedAt ?? 0),
};

export const useMarket = create<MarketState>()((set, get) => ({
  tokens: {},
  columns: { new: [], final: [], migrated: [] },
  solUsd: 119.5,
  slot: 0,
  feed: { state: "reconnecting", lagMs: 0, eventsPerSec: 0 },
  connection: "connecting",

  applyPulse(batches) {
    const entered: Record<PulseColumnId, string[]> = { new: [], final: [], migrated: [] };
    if (batches.length === 0) return entered;
    const state = get();
    const tokens = { ...state.tokens };
    const columns = { ...state.columns };
    for (const b of batches) {
      const current = new Set(b.snapshot ? [] : columns[b.column]);
      if (b.snapshot) {
        for (const t of b.snapshot) {
          tokens[t.mint] = t;
          current.add(t.mint);
        }
      }
      for (const mint of b.remove) current.delete(mint);
      for (const t of b.upsert) {
        tokens[t.mint] = t;
        if (!current.has(t.mint)) {
          current.add(t.mint);
          if (!b.snapshot) entered[b.column].push(t.mint);
        }
      }
      const list = [...current].filter((m) => tokens[m]);
      const sorter = sorters[b.column];
      list.sort((x, y) => sorter(tokens[x] as TokenSummary, tokens[y] as TokenSummary));
      columns[b.column] = list;
    }
    // Drop summaries no longer referenced by any column (the token page keeps its own copy).
    const live = new Set([...columns.new, ...columns.final, ...columns.migrated]);
    for (const mint of Object.keys(tokens)) if (!live.has(mint)) delete tokens[mint];
    set({ tokens, columns });
    return entered;
  },

  upsertToken(token) {
    set((s) => (s.tokens[token.mint] ? { tokens: { ...s.tokens, [token.mint]: token } } : s));
  },

  setMarket(status) {
    set({ solUsd: status.solUsd, slot: status.slot, feed: status.feed });
  },

  setConnection(connection) {
    set({ connection });
  },
}));
