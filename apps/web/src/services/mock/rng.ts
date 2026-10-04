/** Small seeded PRNG (mulberry32) so a `?seed=` URL param reproduces a simulated world. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Inclusive integer range. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Rng.pick on empty array");
    return items[Math.floor(this.next() * items.length)] as T;
  }

  weighted<T>(items: readonly (readonly [T, number])[]): T {
    let total = 0;
    for (const [, w] of items) total += w;
    let r = this.next() * total;
    for (const [item, w] of items) {
      r -= w;
      if (r <= 0) return item;
    }
    const last = items[items.length - 1];
    if (!last) throw new Error("Rng.weighted on empty array");
    return last[0];
  }

  normal(): number {
    const u = Math.max(this.next(), 1e-12);
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  logNormal(mu: number, sigma: number): number {
    return Math.exp(mu + sigma * this.normal());
  }

  /** Number of events in an interval with expected count `lambda` (Knuth; fine for small lambda). */
  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * this.normal()));
    const limit = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > limit);
    return k - 1;
  }
}

/** Fixed by default so persisted references (watchlist, tracked wallets) survive reloads. */
export const DEFAULT_SEED = 20261003;

/** `?seed=123` reproduces a world, `?seed=random` gives a fresh one on every load. */
export function seedFromUrl(): number {
  if (typeof window === "undefined") return DEFAULT_SEED;
  const raw = new URLSearchParams(window.location.search).get("seed");
  if (raw === "random") return Date.now() >>> 0;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed >>> 0 : DEFAULT_SEED;
}
