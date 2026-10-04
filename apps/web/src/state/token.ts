import { useEffect } from "react";
import { create } from "zustand";
import type { TokenDetail, TokenDetailDelta, Trade } from "../protocol";
import { subscribeSequenced } from "./subscribe";

const TAPE_FLUSH_MS = 80;
const TAPE_MAX = 800;

export interface TokenState {
  mint: string | null;
  detail: TokenDetail | null;
  /** Newest first. */
  trades: Trade[];
  status: "idle" | "loading" | "ready" | "missing";
  reset(mint: string | null): void;
  setDetail(detail: TokenDetail): void;
  applyDelta(delta: TokenDetailDelta): void;
  setTrades(trades: Trade[]): void;
  pushTrades(trades: Trade[]): void;
  setMissing(): void;
}

export const useToken = create<TokenState>()((set, get) => ({
  mint: null,
  detail: null,
  trades: [],
  status: "idle",
  reset(mint) {
    set({ mint, detail: null, trades: [], status: mint ? "loading" : "idle" });
  },
  setDetail(detail) {
    set({ detail, status: "ready" });
  },
  applyDelta(delta) {
    const prev = get().detail;
    if (!prev) return;
    set({
      detail: {
        ...prev,
        summary: delta.summary ?? prev.summary,
        curve: delta.curve !== undefined ? delta.curve : prev.curve,
        pool: delta.pool !== undefined ? delta.pool : prev.pool,
        route: delta.route !== undefined ? delta.route : prev.route,
        holders: delta.holders ?? prev.holders,
        topTraders: delta.topTraders ?? prev.topTraders,
      },
    });
  },
  setTrades(trades) {
    set({ trades: trades.slice(0, TAPE_MAX) });
  },
  pushTrades(trades) {
    set((s) => ({ trades: [...trades, ...s.trades].slice(0, TAPE_MAX) }));
  },
  setMissing() {
    if (get().status === "loading") set({ status: "missing" });
  },
}));

/**
 * Subscribes the focused token's detail and trade tape. The tape is flushed to React every
 * 80 ms (SPEC: focused token's tape every 50–100 ms).
 */
export function useTokenFeed(mint: string | undefined): void {
  useEffect(() => {
    if (!mint) return;
    const store = useToken.getState();
    store.reset(mint);
    let buffer: Trade[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      if (buffer.length === 0) return;
      const batch = buffer;
      buffer = [];
      useToken.getState().pushTrades(batch);
    };
    const missingTimer = setTimeout(() => useToken.getState().setMissing(), 2500);
    const offDetail = subscribeSequenced(
      `token:${mint}`,
      (detail) => {
        clearTimeout(missingTimer);
        useToken.getState().setDetail(detail);
      },
      (delta) => useToken.getState().applyDelta(delta),
    );
    const offTrades = subscribeSequenced(
      `trades:${mint}`,
      (snap) => useToken.getState().setTrades(snap.trades),
      (delta) => {
        buffer = delta.trades.concat(buffer);
        if (timer === null) timer = setTimeout(flush, TAPE_FLUSH_MS);
      },
    );
    return () => {
      clearTimeout(missingTimer);
      if (timer) clearTimeout(timer);
      offDetail();
      offTrades();
      if (useToken.getState().mint === mint) useToken.getState().reset(null);
    };
  }, [mint]);
}
