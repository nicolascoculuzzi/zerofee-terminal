/** Token-bucket rate limiting keyed by client (per IP for REST, per connection for WS messages). */

interface Bucket {
  tokens: number;
  last: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private sweeps = 0;

  constructor(
    private readonly perSec: number,
    private readonly burst: number,
  ) {}

  /** Consumes `cost` tokens; false when the caller is over its rate. */
  allow(key: string, cost = 1, now = Date.now()): boolean {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.burst, last: now };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.last) / 1000) * this.perSec);
    b.last = now;
    if (++this.sweeps % 10_000 === 0) this.sweep(now);
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  /** Drops full buckets idle for a minute (bounded memory). */
  sweep(now = Date.now()): void {
    for (const [k, b] of this.buckets) if (now - b.last > 60_000) this.buckets.delete(k);
  }
}
