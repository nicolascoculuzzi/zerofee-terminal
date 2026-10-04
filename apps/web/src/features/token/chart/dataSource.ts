import type { Candle as WireCandle } from "@zerofee/protocol";
import type { Candle, Timeframe } from "../../../protocol";
import { apiUrl, IS_LIVE } from "../../../runtime";
import { useMarket } from "../../../state/market";
import { subscribeSequenced } from "../../../state/subscribe";
import { type LiveMerge, mergeLive, mergeOlder, mergeSnapshot, normalize } from "./bars";

/*
 * The token chart's one data adapter. Everything the chart knows about where candles come from lives
 * here, so wiring the trade-history endpoints is a change to this file only:
 *
 *   1. `candles:<mint>:<tf>` snapshot (the newest ~300 buckets), then live deltas, batched per frame;
 *   2. older pages on demand (the user scrolls near the left edge, or the snapshot is empty):
 *      today `GET /api/candles?mint&tf&from=0&to=<oldest>` (the newest 2,000 buckets before `to`);
 *   3. the coin's history state (complete / partial / backfilling) drives a "Loading history" hint and,
 *      while backfilling, a slow re-poll for pages that were not on the server yet.
 *
 * Re-snapshots (corrections, a resubscribe after a sequence gap) replace the window they cover and keep
 * the older pages, and the chart keeps the user's scroll position for both.
 */

export type HistoryState = "complete" | "partial" | "backfilling" | "unknown";

export interface OlderPage {
  /** Ascending. */
  candles: Candle[];
  /** More history may exist before the oldest candle of this page. */
  hasMore: boolean;
  history: HistoryState;
}

/** How the bar list changed, so the controller picks the cheapest correct series call. */
export type BarChange =
  /** A new series (first snapshot, interval switch): reset the view to the latest bars. */
  | { kind: "reset" }
  /** Bars were replaced or prepended: setData, keeping the visible range anchored. */
  | { kind: "keep" }
  /** Live ticks: series.update() for these indices. */
  | { kind: "live"; touched: number[] };

export type FeedStatus = "loading" | "ready" | "empty" | "error";

export interface HistoryInfo {
  /** An older page is in flight. */
  loading: boolean;
  /** Older pages may exist. */
  hasMore: boolean;
  state: HistoryState;
}

export interface FeedCallbacks {
  onBars(bars: readonly Candle[], change: BarChange): void;
  onStatus(status: FeedStatus): void;
  onHistory(info: HistoryInfo): void;
}

/** Transport and timers, swappable in tests. */
export interface FeedDeps {
  subscribe(mint: string, tf: Timeframe, onSnapshot: (c: Candle[]) => void, onDelta: (c: Candle[]) => void): () => void;
  fetchOlder(mint: string, tf: Timeframe, beforeSec: number, signal: AbortSignal): Promise<OlderPage>;
  /** Next animation frame (batches live deltas). */
  frame(fn: () => void): () => void;
  later(fn: () => void, ms: number): () => void;
}

/** No snapshot within this long: "Couldn't load candles · Retry". */
export const SNAPSHOT_TIMEOUT_MS = 8000;
/** While the server backfills, re-ask for an empty older page this often, this many times. */
export const BACKFILL_POLL_MS = 5000;
export const BACKFILL_POLLS = 24;
/** The REST endpoint's page cap (apps/server gateway MAX_CANDLES_REST). */
const REST_PAGE = 2000;

/**
 * One chart's candle stream for one mint and interval. `start()` subscribes; `requestOlder()` loads the
 * page before the oldest bar (no-op while one is in flight or history is exhausted); `stop()` drops
 * everything (safe to call twice, e.g. StrictMode).
 */
export class ChartFeed {
  private bars: Candle[] = [];
  private gotSnapshot = false;
  private pending: Candle[] = [];
  private cancelFrame: (() => void) | null = null;
  private cancelTimeout: (() => void) | null = null;
  private cancelPoll: (() => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  private abort: AbortController | null = null;
  private stopped = false;
  private polls = 0;
  private history: HistoryInfo;

  constructor(
    readonly mint: string,
    readonly tf: Timeframe,
    private readonly cb: FeedCallbacks,
    private readonly deps: FeedDeps = defaultDeps,
    hasOlderPages = IS_LIVE,
  ) {
    this.history = { loading: false, hasMore: hasOlderPages, state: "unknown" };
  }

  get list(): readonly Candle[] {
    return this.bars;
  }

  start(): void {
    this.cb.onStatus("loading");
    this.cancelTimeout = this.deps.later(() => {
      if (!this.gotSnapshot && !this.stopped) this.cb.onStatus("error");
    }, SNAPSHOT_TIMEOUT_MS);
    this.unsubscribe = this.deps.subscribe(
      this.mint,
      this.tf,
      (c) => this.onSnapshot(c),
      (c) => this.onDelta(c),
    );
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.cancelFrame?.();
    this.cancelTimeout?.();
    this.cancelPoll?.();
    this.abort?.abort();
    this.cancelFrame = this.cancelTimeout = this.cancelPoll = null;
    this.abort = null;
    this.pending = [];
  }

  /** Server-side history state from the token (when the server publishes one). */
  setHistoryState(state: HistoryState): void {
    if (state === this.history.state) return;
    const wasBackfilling = this.history.state === "backfilling";
    this.history = { ...this.history, state, hasMore: this.history.hasMore || state === "backfilling" || state === "partial" };
    this.cb.onHistory(this.history);
    // Backfill finished: there may be a page now that wasn't before.
    if (wasBackfilling && state === "complete" && this.gotSnapshot) this.requestOlder();
  }

  private onSnapshot(candles: Candle[]): void {
    if (this.stopped) return;
    this.cancelTimeout?.();
    this.cancelTimeout = null;
    const first = !this.gotSnapshot;
    this.gotSnapshot = true;
    this.bars = first ? normalize(candles) : mergeSnapshot(this.bars, candles);
    // Deltas queued before this snapshot are already in it.
    this.pending = [];
    this.cb.onBars(this.bars, first ? { kind: "reset" } : { kind: "keep" });
    if (this.bars.length > 0) this.cb.onStatus("ready");
    else if (!this.history.hasMore) this.cb.onStatus("empty");
    // Nothing in the snapshot window (a quiet coin on a seconds interval): look further back at once.
    if (first && this.bars.length === 0) this.requestOlder();
  }

  private onDelta(candles: Candle[]): void {
    if (this.stopped || !this.gotSnapshot) return;
    this.pending.push(...candles);
    if (!this.cancelFrame) this.cancelFrame = this.deps.frame(() => this.flush());
  }

  /** Applies queued deltas (also called by tests directly). */
  flush(): void {
    this.cancelFrame = null;
    if (this.pending.length === 0) return;
    const had = this.bars.length;
    const m: LiveMerge = mergeLive(this.bars, this.pending);
    this.pending = [];
    this.bars = m.bars;
    this.cb.onBars(this.bars, m.rewrite ? { kind: "keep" } : { kind: "live", touched: m.touched });
    if (had === 0 && this.bars.length > 0) this.cb.onStatus("ready");
  }

  requestOlder(): void {
    if (this.stopped || this.history.loading || !this.history.hasMore || !this.gotSnapshot) return;
    const oldest = this.bars[0]?.time ?? Math.floor(Date.now() / 1000) + 1;
    const abort = new AbortController();
    this.abort = abort;
    this.history = { ...this.history, loading: true };
    this.cb.onHistory(this.history);
    this.deps
      .fetchOlder(this.mint, this.tf, oldest, abort.signal)
      .then((page) => {
        if (this.stopped || abort.signal.aborted) return;
        const m = mergeOlder(this.bars, page.candles);
        const backfilling = page.history === "backfilling";
        this.history = { loading: false, hasMore: page.hasMore || backfilling, state: page.history };
        if (m.added > 0) {
          this.bars = m.bars;
          this.cb.onBars(this.bars, { kind: "keep" });
          this.cb.onStatus("ready");
        } else if (this.bars.length === 0 && !this.history.hasMore) {
          this.cb.onStatus("empty");
        }
        this.cb.onHistory(this.history);
        if (backfilling && m.added === 0) this.schedulePoll();
        else this.polls = 0;
      })
      .catch(() => {
        if (this.stopped || abort.signal.aborted) return;
        // A failed page is not fatal: the chart has its bars; scrolling left again retries.
        this.history = { ...this.history, loading: false };
        this.cb.onHistory(this.history);
        if (this.bars.length === 0) this.cb.onStatus("empty");
      });
  }

  private schedulePoll(): void {
    if (this.polls >= BACKFILL_POLLS || this.cancelPoll) return;
    this.polls++;
    this.cancelPoll = this.deps.later(() => {
      this.cancelPoll = null;
      this.requestOlder();
    }, BACKFILL_POLL_MS);
  }
}

// ---------------------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------------------

/** Wire candle (ms, SOL) to the UI candle (seconds, SOL). Kept here so the chart chunk never imports the live adapters. */
export function fromWire(c: WireCandle, solUsdNow: number): Candle {
  return {
    time: Math.floor(c.t / 1000),
    open: c.o,
    high: c.h,
    low: c.l,
    close: c.c,
    volumeSol: c.v,
    buys: Number.NaN,
    sells: Number.NaN,
    solUsd: c.solUsd ?? solUsdNow,
  };
}

const HISTORY_STATES: readonly HistoryState[] = ["complete", "partial", "backfilling"];

/** Reads a history state from any server payload that carries one (`history` or `historyState`). */
export function historyStateOf(payload: unknown): HistoryState {
  if (!payload || typeof payload !== "object") return "unknown";
  const p = payload as { history?: unknown; historyState?: unknown };
  const raw = typeof p.history === "string" ? p.history : typeof p.historyState === "string" ? p.historyState : null;
  return raw && (HISTORY_STATES as readonly string[]).includes(raw) ? (raw as HistoryState) : "unknown";
}

/**
 * Today's REST page: `from=0` makes the gateway return the newest REST_PAGE buckets before `to`, so a
 * short page means the start of the coin's history. Tolerates the paginated shape the history work is
 * adding (`hasMore`, `history`) without depending on it.
 */
async function fetchOlderLive(mint: string, tf: Timeframe, beforeSec: number, signal: AbortSignal): Promise<OlderPage> {
  const qs = new URLSearchParams({ mint, tf, from: "0", to: String(beforeSec * 1000 - 1) });
  const res = await fetch(apiUrl(`/api/candles?${qs}`), { signal, credentials: "same-origin" });
  if (!res.ok) throw new Error(`candles ${res.status}`);
  const body = (await res.json()) as { candles?: WireCandle[]; hasMore?: unknown };
  const solUsd = useMarket.getState().solUsd;
  const wire = Array.isArray(body.candles) ? body.candles : [];
  const candles = wire.filter((c) => c.t < beforeSec * 1000).map((c) => fromWire(c, solUsd));
  const history = historyStateOf(body);
  const hasMore = typeof body.hasMore === "boolean" ? body.hasMore : wire.length >= REST_PAGE;
  return { candles, hasMore, history };
}

export const defaultDeps: FeedDeps = {
  subscribe: (mint, tf, onSnapshot, onDelta) =>
    subscribeSequenced(
      `candles:${mint}:${tf}`,
      (snap) => onSnapshot(snap.candles),
      (delta) => onDelta(delta.candles),
    ),
  // The simulation's snapshot already holds the coin's whole history.
  fetchOlder: (mint, tf, beforeSec, signal) =>
    IS_LIVE ? fetchOlderLive(mint, tf, beforeSec, signal) : Promise.resolve({ candles: [], hasMore: false, history: "complete" }),
  frame: (fn) => {
    const id = requestAnimationFrame(fn);
    return () => cancelAnimationFrame(id);
  },
  later: (fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
};
