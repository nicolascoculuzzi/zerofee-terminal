/**
 * Outbound pacing per upstream host, shared by the metadata fetcher and the image proxy (both hit the same
 * IPFS gateways: pump.mypinata.cloud answers 429 within seconds of a burst).
 *
 *  - Per host: a concurrency limit and a token bucket (requests per second, burst). A request waits for both.
 *  - Waiters are served by priority (0 = on screen, 1 = new launches, 2 = background refetch), FIFO within one.
 *  - 429 / 503: the host pauses for Retry-After when the answer had one, else for an exponential back-off
 *    with jitter (2 s doubling to 60 s), and its rate halves (down to a floor); successes win the rate back
 *    slowly (AIMD). Timeouts, resets and other 5xx pause it briefly after two in a row.
 *  - A waiter whose signal aborts leaves the queue without using a slot or a token.
 *
 * Limits come from IMG_HOST_LIMITS (media/config.ts) on top of conservative defaults for the Pinata gateways.
 */
import { FetchFailure } from "./net";

export type Priority = 0 | 1 | 2;
export const PRIORITY = { visible: 0, launch: 1, background: 2 } as const satisfies Record<string, Priority>;

export interface HostLimit {
  /** Requests in flight at once. */
  concurrency: number;
  /** Sustained requests per second. */
  rps: number;
  /** Bucket size. */
  burst: number;
}

/** Conservative defaults: Pinata's gateways rate-limit per client IP; pump's image CDN (Cloudflare) is generous. */
export const DEFAULT_HOST_LIMITS: Record<string, HostLimit> = {
  "pump.mypinata.cloud": { concurrency: 4, rps: 3, burst: 6 },
  "gateway.pinata.cloud": { concurrency: 2, rps: 1, burst: 2 },
  "images.pump.fun": { concurrency: 6, rps: 8, burst: 16 },
  "imagedelivery.net": { concurrency: 6, rps: 8, burst: 16 },
};
export const DEFAULT_LIMIT: HostLimit = { concurrency: 3, rps: 3, burst: 6 };

/** "host=concurrency/rps/burst,host2=..." (e.g. "pump.mypinata.cloud=4/3/6"); "*" sets the default for other hosts. */
export function parseHostLimits(raw: string | null): { limits: Record<string, HostLimit>; fallback: HostLimit } {
  const limits = { ...DEFAULT_HOST_LIMITS };
  let fallback = DEFAULT_LIMIT;
  if (!raw) return { limits, fallback };
  for (const part of raw.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const m = /^([a-z0-9.*-]+)=(\d+)\/(\d+(?:\.\d+)?)\/(\d+)$/i.exec(p);
    if (!m) throw new Error(`IMG_HOST_LIMITS: bad entry "${p}" (host=concurrency/rps/burst)`);
    const lim = { concurrency: Number(m[2]), rps: Number(m[3]), burst: Number(m[4]) };
    if (lim.concurrency < 1 || lim.rps <= 0 || lim.burst < 1) throw new Error(`IMG_HOST_LIMITS: bad limits in "${p}"`);
    if (m[1] === "*") fallback = lim;
    else limits[(m[1] as string).toLowerCase()] = lim;
  }
  return { limits, fallback };
}

interface Waiter {
  prio: Priority;
  resolve(release: () => void): void;
  reject(e: unknown): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface HostState {
  name: string;
  limit: HostLimit;
  active: number;
  tokens: number;
  refilledAt: number;
  /** Current rate (AIMD), <= limit.rps. */
  rate: number;
  pausedUntil: number;
  /** Consecutive throttling answers (429 / 503). */
  throttles: number;
  /** Consecutive transport failures. */
  errors: number;
  lanes: [Waiter[], Waiter[], Waiter[]];
  timer: ReturnType<typeof setTimeout> | null;
  stats: { started: number; throttled: number; paused: number; waitedMs: number };
}

export interface PacerOptions {
  limits?: Record<string, HostLimit>;
  fallback?: HostLimit;
  now?: () => number;
  /** Jitter source in [0, 1) (tests). */
  random?: () => number;
  /** Longest pause honoured from a Retry-After header. */
  maxPauseMs?: number;
  /** Waiters per host beyond which new low-priority requests are refused at once. */
  maxQueue?: number;
  /** Longest a request waits for a slot before giving up as "host_paused" (default 30 s). */
  maxWaitMs?: number;
}

export class HostPacer {
  private readonly hosts = new Map<string, HostState>();
  private readonly limits: Record<string, HostLimit>;
  private readonly fallback: HostLimit;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly maxPauseMs: number;
  private readonly maxQueue: number;
  private readonly maxWaitMs: number;

  constructor(o: PacerOptions = {}) {
    this.limits = o.limits ?? DEFAULT_HOST_LIMITS;
    this.fallback = o.fallback ?? DEFAULT_LIMIT;
    this.now = o.now ?? Date.now;
    this.random = o.random ?? Math.random;
    this.maxPauseMs = o.maxPauseMs ?? 120_000;
    this.maxQueue = o.maxQueue ?? 2_000;
    this.maxWaitMs = o.maxWaitMs ?? 30_000;
  }

  limitFor(host: string): HostLimit {
    return this.limits[host] ?? this.fallback;
  }

  /**
   * Waits for a slot on `host` at `prio`; resolves with the release function (call it exactly once).
   * Rejects with a transient "host_paused" failure when the host is paused for longer than `maxWaitMs`, or
   * the wait runs past it (the caller retries later instead of holding a race open).
   */
  acquire(host: string, prio: Priority, signal?: AbortSignal, maxWaitMs = this.maxWaitMs): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new FetchFailure("aborted", false));
    const h = this.state(host);
    const t = this.now();
    if (!h.lanes[0].length && !h.lanes[1].length && !h.lanes[2].length && this.ready(h, t)) return Promise.resolve(this.take(h, t));
    if (h.pausedUntil - t > maxWaitMs) return Promise.reject(new FetchFailure("host_paused", false, 0, h.pausedUntil - t));
    if (this.queued(h) >= this.maxQueue && prio > 0) return Promise.reject(new FetchFailure("busy", false));
    return new Promise((resolve, reject) => {
      const w: Waiter = { prio, resolve, reject, signal };
      const queuedAt = t;
      const leave = () => {
        const lane = h.lanes[w.prio];
        const i = lane.indexOf(w);
        if (i >= 0) lane.splice(i, 1);
        return i >= 0;
      };
      const timer = setTimeout(() => {
        if (!leave()) return;
        if (signal && w.onAbort) signal.removeEventListener("abort", w.onAbort);
        reject(new FetchFailure("host_paused", false, 0, Math.max(0, h.pausedUntil - this.now())));
      }, maxWaitMs);
      (timer as { unref?: () => void }).unref?.();
      w.resolve = (release) => {
        clearTimeout(timer);
        h.stats.waitedMs += this.now() - queuedAt;
        resolve(release);
      };
      if (signal) {
        w.onAbort = () => {
          clearTimeout(timer);
          leave();
          reject(new FetchFailure("aborted", false));
        };
        signal.addEventListener("abort", w.onAbort, { once: true });
      }
      h.lanes[prio].push(w);
      this.schedule(h);
    });
  }

  /** Runs `fn` holding a slot on `host`. */
  async run<T>(host: string, prio: Priority, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(host, prio, signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** The host answered normally: clear the back-off, win back some rate. */
  success(host: string): void {
    const h = this.state(host);
    h.throttles = 0;
    h.errors = 0;
    h.rate = Math.min(h.limit.rps, h.rate + h.limit.rps * 0.05);
  }

  /** 429 / 503: pause the host (Retry-After when given, else 2 s doubling to 60 s, with jitter) and halve its rate. */
  throttled(host: string, retryAfterMs: number | null): void {
    const h = this.state(host);
    h.throttles++;
    h.stats.throttled++;
    h.rate = Math.max(h.limit.rps / 8, h.rate / 2);
    // 2 s doubling to 5 min: a host that answers nothing but 429 (a closed public gateway) costs ~1 request / 5 min
    const backoff = Math.min(300_000, 2_000 * 2 ** (h.throttles - 1));
    // "Retry-After: 0" (Cloudflare block pages) says nothing: use the back-off
    const pause =
      retryAfterMs !== null && retryAfterMs >= 1_000
        ? Math.min(this.maxPauseMs, Math.max(retryAfterMs, backoff / 4))
        : this.jitter(backoff);
    this.pause(h, pause);
  }

  /** Timeout, reset or another 5xx: two in a row pause the host briefly (1 s doubling to 30 s). */
  failed(host: string): void {
    const h = this.state(host);
    h.errors++;
    if (h.errors >= 2) this.pause(h, this.jitter(Math.min(30_000, 1_000 * 2 ** (h.errors - 2))));
  }

  /** ms until `host` may start a request again (0 when not paused). */
  pausedFor(host: string): number {
    const h = this.hosts.get(host);
    return h ? Math.max(0, h.pausedUntil - this.now()) : 0;
  }

  snapshot(): {
    host: string;
    active: number;
    queued: number;
    rate: number;
    pausedMs: number;
    started: number;
    throttled: number;
    paused: number;
  }[] {
    const t = this.now();
    return [...this.hosts].map(([host, h]) => ({
      host,
      active: h.active,
      queued: this.queued(h),
      rate: Math.round(h.rate * 100) / 100,
      pausedMs: Math.max(0, h.pausedUntil - t),
      started: h.stats.started,
      throttled: h.stats.throttled,
      paused: h.stats.paused,
    }));
  }

  /** Waiting requests across hosts by priority. */
  queuedByPriority(): [number, number, number] {
    const out: [number, number, number] = [0, 0, 0];
    for (const h of this.hosts.values()) for (const p of [0, 1, 2] as const) out[p] += h.lanes[p].length;
    return out;
  }

  private jitter(ms: number): number {
    return Math.round(ms * (0.75 + this.random() * 0.5));
  }

  private pause(h: HostState, ms: number): void {
    const until = this.now() + ms;
    if (until > h.pausedUntil) {
      h.pausedUntil = until;
      h.stats.paused++;
    }
    this.schedule(h);
  }

  private queued(h: HostState): number {
    return h.lanes[0].length + h.lanes[1].length + h.lanes[2].length;
  }

  private refill(h: HostState, t: number): void {
    const dt = (t - h.refilledAt) / 1000;
    if (dt > 0) {
      h.tokens = Math.min(h.limit.burst, h.tokens + dt * h.rate);
      h.refilledAt = t;
    }
  }

  private ready(h: HostState, t: number): boolean {
    if (h.pausedUntil > t || h.active >= h.limit.concurrency) return false;
    this.refill(h, t);
    return h.tokens >= 1;
  }

  private take(h: HostState, _t: number): () => void {
    h.tokens -= 1;
    h.active++;
    h.stats.started++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      h.active--;
      this.dispatch(h);
    };
  }

  private next(h: HostState): Waiter | undefined {
    for (const lane of h.lanes) if (lane.length) return lane.shift();
    return undefined;
  }

  private dispatch(h: HostState): void {
    const t = this.now();
    while (this.queued(h) && this.ready(h, t)) {
      const w = this.next(h) as Waiter;
      if (w.signal && w.onAbort) w.signal.removeEventListener("abort", w.onAbort);
      w.resolve(this.take(h, t));
    }
    if (this.queued(h)) this.schedule(h);
  }

  /** Wakes the queue when the next token arrives or the pause ends (slots wake it on release). */
  private schedule(h: HostState): void {
    if (h.timer || !this.queued(h)) return;
    const t = this.now();
    if (this.ready(h, t)) {
      queueMicrotask(() => this.dispatch(h));
      return;
    }
    if (h.active >= h.limit.concurrency && h.pausedUntil <= t) return; // a release will dispatch
    const untilPause = Math.max(0, h.pausedUntil - t);
    const untilToken = h.tokens >= 1 ? 0 : ((1 - h.tokens) / h.rate) * 1000;
    const wait = Math.max(untilPause, untilToken, 5);
    h.timer = setTimeout(() => {
      h.timer = null;
      this.dispatch(h);
    }, wait);
    (h.timer as { unref?: () => void }).unref?.();
  }

  private state(host: string): HostState {
    let h = this.hosts.get(host);
    if (!h) {
      if (this.hosts.size > 2_000) {
        for (const [k, v] of this.hosts) if (!v.active && !this.queued(v) && !v.timer) this.hosts.delete(k);
      }
      const limit = this.limitFor(host);
      h = {
        name: host,
        limit,
        active: 0,
        tokens: limit.burst,
        refilledAt: this.now(),
        rate: limit.rps,
        pausedUntil: 0,
        throttles: 0,
        errors: 0,
        lanes: [[], [], []],
        timer: null,
        stats: { started: 0, throttled: 0, paused: 0, waitedMs: 0 },
      };
      this.hosts.set(host, h);
    }
    return h;
  }
}
