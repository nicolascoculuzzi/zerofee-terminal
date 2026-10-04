/**
 * Token bucket for outbound API budgets. `capacity` tokens at most, refilled continuously at `perMinute`.
 * With capacity B and rate r per minute, any 60 s window admits at most B + r requests, so a hard
 * "N per minute" limit is met with B + r <= N (see `perWindow`). A 429 can pause the bucket (`pause`).
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private pausedUntil = 0;
  readonly stats = { taken: 0, denied: 0, pauses: 0 };

  constructor(
    readonly capacity: number,
    readonly perMinute: number,
    now = Date.now(),
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  /**
   * A bucket that admits at most `n` requests in any 60 s window: capacity `burst` + refill n - burst per
   * minute, or (when n <= burst) capacity 1 + refill n, which spaces requests at least 60/n s apart.
   */
  static perWindow(n: number, burst: number, now = Date.now()): TokenBucket {
    return n > burst ? new TokenBucket(burst, n - burst, now) : new TokenBucket(1, n, now);
  }

  private refill(now: number): void {
    if (now > this.last) {
      this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 60_000) * this.perMinute);
      this.last = now;
    }
  }

  /** Takes `cost` tokens if available (and not paused). */
  take(cost = 1, now = Date.now()): boolean {
    this.refill(now);
    if (now < this.pausedUntil || this.tokens < cost) {
      this.stats.denied++;
      return false;
    }
    this.tokens -= cost;
    this.stats.taken++;
    return true;
  }

  /** Tokens available now (fractional). */
  available(now = Date.now()): number {
    this.refill(now);
    return now < this.pausedUntil ? 0 : this.tokens;
  }

  /** Stops admitting requests for `ms` (after a 429) and drains the bucket. */
  pause(ms: number, now = Date.now()): void {
    this.pausedUntil = Math.max(this.pausedUntil, now + ms);
    this.tokens = 0;
    this.last = now;
    this.stats.pauses++;
  }

  pausedFor(now = Date.now()): number {
    return Math.max(0, this.pausedUntil - now);
  }
}
