/**
 * OHLCV candles per mint per timeframe, built from trades (price in SOL per whole token, volume in SOL).
 *
 * Buckets are keyed by event block time. Open/close follow the ORDERING KEY (slot, tx index, event
 * index), not arrival order, so out-of-order arrivals inside a bucket still yield the right OHLC. A
 * trade landing in a bucket older than the newest one is "late": the update is reported as a
 * correction. Dead-slot rollbacks rebuild affected buckets from the surviving trades.
 * Memory keeps a bounded tail per series; history lives in SQLite.
 */
import { type Candle, TIMEFRAME_MS, TIMEFRAMES, type Timeframe } from "@zerofee/protocol";

/** (slot, tx index or arrival sequence, event index). */
export type OrderKey = readonly [number, number, number];

export function cmpKey(a: OrderKey, b: OrderKey): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

interface Agg extends Candle {
  openKey: OrderKey;
  closeKey: OrderKey;
}

export interface CandleUpdate {
  mint: string;
  tf: Timeframe;
  candle: Candle;
  /** True when the bucket is older than the series' newest bucket (send as a correction). */
  late: boolean;
}

export interface CandleTrade {
  tsMs: number;
  price: number;
  volume: number;
  key: OrderKey;
  solUsd: number | null;
}

/** Buckets kept in memory per series (older ones are served from SQLite). */
export const MEMORY_CAP: Readonly<Record<Timeframe, number>> = { "1s": 900, "15s": 480, "1m": 720, "5m": 576, "15m": 288, "1h": 168 };

const strip = (a: Agg): Candle => ({ t: a.t, o: a.o, h: a.h, l: a.l, c: a.c, v: a.v, n: a.n, solUsd: a.solUsd });

class Series {
  readonly byT = new Map<number, Agg>();
  maxT = Number.NEGATIVE_INFINITY;

  constructor(readonly tf: Timeframe) {}

  bucketOf(tsMs: number): number {
    const ms = TIMEFRAME_MS[this.tf];
    return Math.floor(tsMs / ms) * ms;
  }

  add(tr: CandleTrade): { candle: Candle; late: boolean } {
    const t = this.bucketOf(tr.tsMs);
    const late = t < this.maxT;
    let a = this.byT.get(t);
    if (!a) {
      a = { t, o: tr.price, h: tr.price, l: tr.price, c: tr.price, v: 0, n: 0, solUsd: tr.solUsd, openKey: tr.key, closeKey: tr.key };
      this.byT.set(t, a);
      if (t > this.maxT) {
        this.maxT = t;
        this.trim();
      }
    } else {
      if (cmpKey(tr.key, a.openKey) < 0) {
        a.o = tr.price;
        a.openKey = tr.key;
      }
      if (cmpKey(tr.key, a.closeKey) >= 0) {
        a.c = tr.price;
        a.closeKey = tr.key;
        if (tr.solUsd !== null) a.solUsd = tr.solUsd;
      }
      if (tr.price > a.h) a.h = tr.price;
      if (tr.price < a.l) a.l = tr.price;
    }
    a.v += tr.volume;
    a.n++;
    return { candle: strip(a), late };
  }

  private trim(): void {
    const cap = MEMORY_CAP[this.tf];
    if (this.byT.size <= cap) return;
    const cutoff = this.maxT - cap * TIMEFRAME_MS[this.tf];
    for (const t of this.byT.keys()) if (t <= cutoff) this.byT.delete(t);
  }

  /** Rebuilds one bucket from every trade that falls in it; removes it when empty. */
  rebuild(t: number, trades: readonly CandleTrade[]): Candle | null {
    this.byT.delete(t);
    const inBucket = trades.filter((tr) => this.bucketOf(tr.tsMs) === t).sort((x, y) => cmpKey(x.key, y.key));
    if (!inBucket.length) {
      if (t === this.maxT) this.maxT = this.byT.size ? Math.max(...this.byT.keys()) : Number.NEGATIVE_INFINITY;
      return null;
    }
    let last: Candle | null = null;
    for (const tr of inBucket) last = this.add(tr).candle;
    return last;
  }

  /**
   * Removes trades from a bucket whose full trade list is not in memory: volume and count are exact,
   * open/close move to the nearest surviving in-memory trade, high/low stay (approximation).
   */
  subtract(t: number, removed: readonly CandleTrade[], survivors: readonly CandleTrade[]): Candle | null {
    const a = this.byT.get(t);
    if (!a) return null;
    const removedKeys = new Set(removed.map((r) => r.key.join(":")));
    for (const r of removed) {
      a.v -= r.volume;
      a.n--;
    }
    const inBucket = survivors.filter((tr) => this.bucketOf(tr.tsMs) === t).sort((x, y) => cmpKey(x.key, y.key));
    const lastSurvivor = inBucket[inBucket.length - 1];
    if (removedKeys.has(a.closeKey.join(":")) && lastSurvivor) {
      a.c = lastSurvivor.price;
      a.closeKey = lastSurvivor.key;
    }
    if (a.n <= 0) {
      this.byT.delete(t);
      return null;
    }
    return strip(a);
  }
}

export class CandleBook {
  private readonly series = new Map<string, Map<Timeframe, Series>>();

  private seriesOf(mint: string, tf: Timeframe, create: boolean): Series | undefined {
    let m = this.series.get(mint);
    if (!m) {
      if (!create) return undefined;
      m = new Map();
      this.series.set(mint, m);
    }
    let s = m.get(tf);
    if (!s && create) {
      s = new Series(tf);
      m.set(tf, s);
    }
    return s;
  }

  addTrade(mint: string, tr: CandleTrade): CandleUpdate[] {
    if (!(tr.price > 0) || !Number.isFinite(tr.price)) return [];
    const out: CandleUpdate[] = [];
    for (const tf of TIMEFRAMES) {
      const r = (this.seriesOf(mint, tf, true) as Series).add(tr);
      out.push({ mint, tf, candle: r.candle, late: r.late });
    }
    return out;
  }

  /**
   * Dead-slot rollback: fixes every bucket touched by `removed`. `surviving` are the token's remaining
   * in-memory trades, complete from `coverFromMs` on: buckets starting at or after it are rebuilt
   * exactly, older ones are adjusted in place. Returns corrections; an emptied bucket comes back with
   * n = 0 so clients drop it.
   */
  rebuildAfterRemoval(
    mint: string,
    removed: readonly CandleTrade[],
    surviving: readonly CandleTrade[],
    coverFromMs: number,
  ): CandleUpdate[] {
    const out: CandleUpdate[] = [];
    for (const tf of TIMEFRAMES) {
      const s = this.seriesOf(mint, tf, false);
      if (!s) continue;
      const byBucket = new Map<number, CandleTrade[]>();
      for (const tr of removed) {
        const t = s.bucketOf(tr.tsMs);
        const list = byBucket.get(t) ?? [];
        list.push(tr);
        byBucket.set(t, list);
      }
      for (const [t, gone] of byBucket) {
        const c = t >= coverFromMs ? s.rebuild(t, surviving) : s.subtract(t, gone, surviving);
        out.push({ mint, tf, candle: c ?? { t, o: 0, h: 0, l: 0, c: 0, v: 0, n: 0, solUsd: null }, late: true });
      }
    }
    return out;
  }

  /** In-memory candles in [from, to] (ms, inclusive), oldest first. */
  range(mint: string, tf: Timeframe, from = 0, to = Number.MAX_SAFE_INTEGER): Candle[] {
    const s = this.seriesOf(mint, tf, false);
    if (!s) return [];
    return [...s.byT.values()]
      .filter((a) => a.t >= from && a.t <= to)
      .sort((a, b) => a.t - b.t)
      .map(strip);
  }

  /** Oldest in-memory bucket start for a series (null if none). */
  oldest(mint: string, tf: Timeframe): number | null {
    const s = this.seriesOf(mint, tf, false);
    if (!s?.byT.size) return null;
    return Math.min(...s.byT.keys());
  }

  evict(mint: string): void {
    this.series.delete(mint);
  }

  get size(): number {
    return this.series.size;
  }
}
