import { useEffect } from "react";
import { create } from "zustand";
import { isBase58Address } from "../lib/address";
import type { TokenDetail, TokenDetailDelta, Trade } from "../protocol";
import { IS_LIVE } from "../runtime";
import { getServices } from "../services";
import { subscribeSequenced } from "./subscribe";
import { type MissingReason, resolveLoop } from "./tokenResolve";

const TAPE_FLUSH_MS = 80;
const TAPE_MAX = 800;
/** Live: no snapshot this soon means the server doesn't hold the coin; ask it to read it from chain. */
const RESOLVE_AFTER_MS = 500;
/** After the server resolved it, the socket's summary should follow at once; ask for a fresh snapshot otherwise. */
const RESYNC_AFTER_MS = 2_500;

export interface TokenState {
  mint: string | null;
  detail: TokenDetail | null;
  /** Newest first. */
  trades: Trade[];
  /** "resolving": the server is reading a coin it didn't hold from chain ("Loading from chain…"). */
  status: "idle" | "loading" | "resolving" | "ready" | "missing";
  /** Why the token is missing (a definitive server answer, or a malformed address). */
  missingReason: MissingReason | null;
  /** The address was a pool of this coin: open the coin instead. */
  redirect: string | null;
  reset(mint: string | null): void;
  setDetail(detail: TokenDetail): void;
  applyDelta(delta: TokenDetailDelta): void;
  setTrades(trades: Trade[]): void;
  pushTrades(trades: Trade[]): void;
  setMissing(reason?: MissingReason, redirect?: string | null): void;
  setResolving(): void;
}

export const useToken = create<TokenState>()((set, get) => ({
  mint: null,
  detail: null,
  trades: [],
  status: "idle",
  missingReason: null,
  redirect: null,
  reset(mint) {
    set({ mint, detail: null, trades: [], status: mint ? "loading" : "idle", missingReason: null, redirect: null });
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
  setMissing(reason = "not_found", redirect = null) {
    const s = get().status;
    if (s === "loading" || s === "resolving") set({ status: "missing", missingReason: reason, redirect });
  },
  setResolving() {
    if (get().status === "loading") set({ status: "resolving" });
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
    const stop = new AbortController();
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (!isBase58Address(mint)) useToken.getState().setMissing("invalid");
    else if (!IS_LIVE) timers.push(setTimeout(() => useToken.getState().setMissing(), 2500));
    else
      timers.push(
        setTimeout(() => {
          if (useToken.getState().detail) return;
          useToken.getState().setResolving();
          void resolveLoop(mint, {
            signal: stop.signal,
            onDone: (a) => {
              if (a.kind === "missing") {
                useToken.getState().setMissing(a.reason, a.redirect);
                return;
              }
              // resolved: the socket sends the summary; if it got lost, ask for fresh snapshots
              timers.push(
                setTimeout(() => {
                  if (useToken.getState().detail) return;
                  const socket = (getServices().data as { socket?: { resync(topic: string): void } }).socket;
                  for (const t of [`token:${mint}`, `tradectx:${mint}`, `trades:${mint}`]) socket?.resync(t);
                }, RESYNC_AFTER_MS),
              );
            },
          });
        }, RESOLVE_AFTER_MS),
      );
    const offDetail = subscribeSequenced(
      `token:${mint}`,
      (detail) => {
        for (const t of timers) clearTimeout(t);
        stop.abort();
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
      for (const t of timers) clearTimeout(t);
      stop.abort();
      if (timer) clearTimeout(timer);
      offDetail();
      offTrades();
      if (useToken.getState().mint === mint) useToken.getState().reset(null);
    };
  }, [mint]);
}
