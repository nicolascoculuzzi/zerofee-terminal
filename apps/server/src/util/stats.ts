/** Counters, rolling rates and latency percentiles for health / debug output. */

/** Fixed-size ring of numeric samples with nearest-rank percentiles. */
export class SampleRing {
  private readonly buf: Float64Array;
  private n = 0;
  private i = 0;
  total = 0;

  constructor(capacity = 20_000) {
    this.buf = new Float64Array(capacity);
  }

  add(v: number): void {
    if (!Number.isFinite(v)) return;
    this.buf[this.i] = v;
    this.i = (this.i + 1) % this.buf.length;
    if (this.n < this.buf.length) this.n++;
    this.total++;
  }

  get count(): number {
    return this.n;
  }

  /** Nearest-rank percentiles over the retained window (null when empty). */
  percentiles<const P extends readonly number[]>(ps: P): { [K in keyof P]: number | null } {
    if (this.n === 0) return ps.map(() => null) as { [K in keyof P]: number | null };
    const sorted = Array.from(this.buf.subarray(0, this.n)).sort((a, b) => a - b);
    return ps.map((p) => {
      const rank = Math.ceil((p / 100) * sorted.length);
      return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] as number;
    }) as { [K in keyof P]: number | null };
  }

  reset(): void {
    this.n = 0;
    this.i = 0;
  }
}

/** Events per second over a sliding window of 1-second buckets. */
export class RateCounter {
  private readonly buckets: Float64Array;
  private readonly secs: Float64Array;
  total = 0;

  constructor(private readonly windowSec = 60) {
    this.buckets = new Float64Array(windowSec);
    this.secs = new Float64Array(windowSec).fill(-1);
  }

  add(n = 1, nowMs = Date.now()): void {
    const s = Math.floor(nowMs / 1000);
    const idx = s % this.windowSec;
    if (this.secs[idx] !== s) {
      this.secs[idx] = s;
      this.buckets[idx] = 0;
    }
    this.buckets[idx] = (this.buckets[idx] as number) + n;
    this.total += n;
  }

  /** Average rate over the last `windowSec` seconds (excluding the current partial second). */
  perSec(nowMs = Date.now()): number {
    const now = Math.floor(nowMs / 1000);
    let sum = 0;
    for (let k = 0; k < this.windowSec; k++) {
      const s = this.secs[k] as number;
      if (s >= now - this.windowSec && s < now) sum += this.buckets[k] as number;
    }
    return sum / this.windowSec;
  }
}
