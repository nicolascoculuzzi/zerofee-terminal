/**
 * Rolling 5 m / 1 h / 24 h volume and trade counts from sparse one-minute buckets (only minutes with
 * trades are stored, at most 1,440). Late trades land in their own minute; removals (dead slots)
 * subtract. Reads are cached until the token changes or the minute rolls over.
 */

interface Bucket {
  minute: number;
  volume: number;
  buys: number;
  sells: number;
}

export interface WindowTotals {
  volume5m: number;
  volume1h: number;
  volume24h: number;
  txns: number;
  buys: number;
  sells: number;
}

const DAY_MINUTES = 1_440;

export class RollingWindows {
  private buckets: Bucket[] = [];
  private cache: { minute: number; version: number; totals: WindowTotals } | null = null;
  private version = 0;

  add(tsMs: number, volume: number, isBuy: boolean, sign: 1 | -1 = 1): void {
    const minute = Math.floor(tsMs / 60_000);
    let i = this.buckets.length - 1;
    while (i >= 0 && (this.buckets[i] as Bucket).minute > minute) i--;
    let b = this.buckets[i];
    if (!b || b.minute !== minute) {
      if (sign < 0) return; // removing from a bucket we no longer hold
      b = { minute, volume: 0, buys: 0, sells: 0 };
      this.buckets.splice(i + 1, 0, b);
    }
    b.volume += sign * volume;
    if (isBuy) b.buys += sign;
    else b.sells += sign;
    this.version++;
  }

  remove(tsMs: number, volume: number, isBuy: boolean): void {
    this.add(tsMs, volume, isBuy, -1);
  }

  totals(nowMs: number): WindowTotals {
    const nowMin = Math.floor(nowMs / 60_000);
    if (this.cache && this.cache.minute === nowMin && this.cache.version === this.version) return this.cache.totals;
    // Drop buckets older than 24 h.
    let drop = 0;
    while (drop < this.buckets.length && (this.buckets[drop] as Bucket).minute <= nowMin - DAY_MINUTES) drop++;
    if (drop) this.buckets.splice(0, drop);
    const t: WindowTotals = { volume5m: 0, volume1h: 0, volume24h: 0, txns: 0, buys: 0, sells: 0 };
    for (const b of this.buckets) {
      const age = nowMin - b.minute; // 0 = current minute
      t.volume24h += b.volume;
      t.buys += b.buys;
      t.sells += b.sells;
      if (age < 60) t.volume1h += b.volume;
      if (age < 5) t.volume5m += b.volume;
    }
    t.txns = t.buys + t.sells;
    this.cache = { minute: nowMin, version: this.version, totals: t };
    return t;
  }

  get size(): number {
    return this.buckets.length;
  }
}
