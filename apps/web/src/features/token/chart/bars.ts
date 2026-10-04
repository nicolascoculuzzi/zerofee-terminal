import { type Candle, TIMEFRAME_SECONDS, type Timeframe } from "../../../protocol";

/*
 * Pure candle bookkeeping for the token chart: bucketing, validation, the gapless open, merging live
 * deltas and older history pages, and the autoscale floor. No Lightweight Charts and no DOM here, so
 * all of it is unit-tested (bars.test.ts).
 *
 * Candles are gapless (src/protocol.ts: "a new bucket opens at the previous close"): the server's open is
 * the bucket's first trade, which leaves floating bodies on sparse 1s/15s charts; Axiom and GMGN open
 * each candle at the previous close. The first candle of a coin opens at its own first trade.
 */

/** Bucket start (Unix seconds) of a trade at `tsMs`, aligned like the server (UTC epoch multiples). */
export function bucketStart(tsMs: number, tf: Timeframe): number {
  const secs = TIMEFRAME_SECONDS[tf];
  return Math.floor(tsMs / 1000 / secs) * secs;
}

const positive = (n: number) => Number.isFinite(n) && n > 0;

/** A candle with finite positive prices and a whole-second time; null when it can't be drawn. */
export function sanitize(c: Candle): Candle | null {
  if (!Number.isFinite(c.time) || !positive(c.close)) return null;
  const open = positive(c.open) ? c.open : c.close;
  const values = [open, c.close, c.high, c.low].filter(positive);
  return {
    ...c,
    time: Math.floor(c.time),
    open,
    high: Math.max(...values),
    low: Math.min(...values),
    volumeSol: Number.isFinite(c.volumeSol) && c.volumeSol > 0 ? c.volumeSol : 0,
  };
}

/** Opens `list[i]` at the previous close (expanding its wick to cover it). In place. */
function chain(list: Candle[], i: number): void {
  const c = list[i];
  const prev = list[i - 1];
  if (!c || !prev) return;
  if (c.open === prev.close) return;
  const open = prev.close;
  list[i] = { ...c, open, high: Math.max(c.high, open), low: Math.min(c.low, open) };
}

/** Index of the first candle with time >= `time` (list ascending). */
export function lowerBound(list: readonly { time: number }[], time: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid] as { time: number }).time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Deduplicated (the last candle for a time wins), ascending, sanitized and gapless. */
export function normalize(candles: readonly Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const raw of candles) {
    const c = sanitize(raw);
    if (c) byTime.set(c.time, c);
  }
  const out = [...byTime.values()].sort((a, b) => a.time - b.time);
  for (let i = 1; i < out.length; i++) chain(out, i);
  return out;
}

export interface LiveMerge {
  bars: Candle[];
  /** Indices to push with series.update(), ascending (the changed bar and the one after it). */
  touched: number[];
  /** A bucket was inserted before the newest one: indices shifted, so the series needs setData. */
  rewrite: boolean;
}

/**
 * Applies live candles (the current bucket's update and any new buckets, possibly out of order or
 * duplicated) to `list`. Returns a new array; `list` is not modified.
 */
export function mergeLive(list: readonly Candle[], incoming: readonly Candle[]): LiveMerge {
  const bars = list.slice();
  const touched = new Set<number>();
  let rewrite = false;
  const sorted = incoming
    .map(sanitize)
    .filter((c): c is Candle => c !== null)
    .sort((a, b) => a.time - b.time);
  for (const c of sorted) {
    const i = lowerBound(bars, c.time);
    const existing = bars[i];
    if (existing && existing.time === c.time) {
      bars[i] = c;
    } else if (i === bars.length) {
      bars.push(c);
    } else {
      bars.splice(i, 0, c);
      rewrite = true;
    }
    chain(bars, i);
    touched.add(i);
    if (i + 1 < bars.length) {
      const before = bars[i + 1];
      chain(bars, i + 1);
      if (bars[i + 1] !== before) touched.add(i + 1);
    }
  }
  return { bars, touched: [...touched].sort((a, b) => a - b), rewrite };
}

export interface OlderMerge {
  bars: Candle[];
  /** Candles that were not on the chart before. */
  added: number;
}

/** Prepends an older history page. Candles already on the chart win (they are newer data). */
export function mergeOlder(list: readonly Candle[], older: readonly Candle[]): OlderMerge {
  const have = new Set(list.map((c) => c.time));
  const fresh = older.filter((c) => !have.has(Math.floor(c.time)));
  if (fresh.length === 0) return { bars: list.slice(), added: 0 };
  const bars = normalize([...fresh, ...list]);
  return { bars, added: bars.length - list.length };
}

/**
 * Replaces the window a (re)snapshot covers while keeping older pages loaded before it: everything
 * older than the snapshot's first bucket stays, the snapshot is authoritative from there on.
 */
export function mergeSnapshot(list: readonly Candle[], snapshot: readonly Candle[]): Candle[] {
  const fresh = normalize(snapshot);
  const first = fresh[0];
  if (!first) return list.slice();
  const keep = list.filter((c) => c.time < first.time);
  return keep.length ? normalize([...keep, ...fresh]) : fresh;
}

/**
 * Autoscale floor: a range thinner than `minRel` of its midpoint is widened around the midpoint, so one
 * candle (or a flat run) never stretches across the whole pane. A zero midpoint gets +-1.
 */
export function padRange(min: number, max: number, minRel = 0.01): { min: number; max: number } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min, max };
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const mid = (lo + hi) / 2;
  const need = Math.abs(mid) * minRel || 1;
  if (hi - lo >= need) return { min: lo, max: hi };
  return { min: mid - need / 2, max: mid + need / 2 };
}

/** Ratio above which the first candle's open/wick count as a launch outlier for autoscale. */
export const GENESIS_OUTLIER = 2.5;

/**
 * Price range of the bars in logical range [from, to]. With `trimGenesis`, the coin's first candle (index
 * 0) counts only with its close when its open/wick would stretch the range more than GENESIS_OUTLIER
 * times (pump launches: a dev buy at the virtual-reserve price, then snipers 10x higher in the same
 * second). Null when no bar is in range or nothing needs trimming.
 */
export function visibleRange(
  bars: readonly { high: number; low: number; close: number }[],
  from: number,
  to: number,
  trimGenesis: boolean,
): { min: number; max: number } | null {
  const a = Math.max(0, Math.floor(from));
  const b = Math.min(bars.length - 1, Math.ceil(to));
  const first = bars[0];
  if (!trimGenesis || !first || a > 0 || b < 2) return null;
  let min = first.close;
  let max = first.close;
  for (let i = 1; i <= b; i++) {
    const bar = bars[i] as { high: number; low: number };
    if (bar.low < min) min = bar.low;
    if (bar.high > max) max = bar.high;
  }
  const fullMin = Math.min(min, first.low);
  const fullMax = Math.max(max, first.high);
  const span = max - min || Math.abs(max) * 0.01;
  if (fullMax - fullMin <= span * GENESIS_OUTLIER) return null;
  return { min, max };
}

/**
 * Default interval by coin age, like Axiom: seconds charts for fresh launches, minutes once there is
 * history to see. Unknown age keeps `fallback` (the user's last pick).
 */
export function defaultTimeframe(createdAtMs: number | null | undefined, nowMs: number, fallback: Timeframe): Timeframe {
  if (!createdAtMs || !Number.isFinite(createdAtMs) || createdAtMs > nowMs + 60_000) return fallback;
  const age = Math.max(0, nowMs - createdAtMs);
  const min = 60_000;
  if (age < 30 * min) return "1s";
  if (age < 6 * 60 * min) return "15s";
  if (age < 3 * 24 * 60 * min) return "1m";
  if (age < 21 * 24 * 60 * min) return "5m";
  return "15m";
}
