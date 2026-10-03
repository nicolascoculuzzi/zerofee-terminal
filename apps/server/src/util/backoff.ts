/** Exponential reconnect backoff with jitter, reset after a healthy period. */
export class Backoff {
  private attempt = 0;

  constructor(
    private readonly baseMs = 500,
    private readonly maxMs = 30_000,
  ) {}

  next(): number {
    const exp = Math.min(this.maxMs, this.baseMs * 2 ** this.attempt);
    this.attempt++;
    return Math.round(exp / 2 + Math.random() * (exp / 2));
  }

  reset(): void {
    this.attempt = 0;
  }

  get attempts(): number {
    return this.attempt;
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
