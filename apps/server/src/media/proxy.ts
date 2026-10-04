/**
 * GET /api/img?mint=<mint>&v=<version>&s=<px>: token images from our own origin (contract in
 * packages/protocol media.ts).
 *
 * Security limits:
 *  - Closed proxy: the request names a mint, never a URL. The server fetches only the image that token's
 *    metadata names (plus pump.fun's own CDN for pump coins), so nobody can point it at a URL of their choice.
 *  - Every upstream hop passes the SSRF guard (net.ts); IPFS content comes from the URL's own live gateway
 *    or the operator's gateways, never from a retired one.
 *  - Upstream responses: Content-Type must be a raster image type (or generic binary); SVG and anything
 *    else is refused; at most IMG_MAX_BYTES (8 MB), streamed and cut off; the magic bytes must say PNG,
 *    JPEG, WebP, GIF, AVIF or HEIC; the header's pixel count must be under IMG_MAX_PIXELS before decoding.
 *  - Output is always re-encoded by Bun.Image to WebP at the requested size, which also drops any trailing
 *    payload. Only a small (<= 512 KB) PNG / JPEG / WebP / GIF that fails to decode is passed through, with
 *    the type its magic bytes name; AVIF / HEIC only leave as WebP, and only when this host can decode them.
 *    Responses carry nosniff and a sandboxing CSP.
 *  - Decoding and encoding run in a small pool of niced worker processes (pool.ts), never on the event loop.
 *  - Per-IP token buckets on requests and, separately, on cache misses that start upstream fetches.
 *
 * Fetch scheduling (one job per image, shared by every size and every request for it):
 *  - Jobs run by priority: 0 = someone is looking at it (a request, a Pulse column, an open token page),
 *    1 = a new launch (prefetch), 2 = background (startup refetch of restored tokens: at most
 *    IMG_BACKGROUND_RPS per second, only while the pool and the upstream slots have room).
 *  - Each upstream request waits for a slot on its host (pacer.ts: concurrency + token bucket per host,
 *    Retry-After honoured, back-off on 429).
 *  - Transient failures (429, 5xx, timeouts, a fresh IPFS 404, pump's placeholder for a coin it hasn't
 *    indexed yet) are retried by the job itself: 3 s doubling to 5 min with jitter, at least the
 *    Retry-After, up to IMG_RETRY_MAX attempts, then failed for 30 min. Permanent failures (wrong type, too
 *    many pixels, undecodable) fail for 6 h.
 *  - Per-image state is exposed: a 404 says `x-zf-image: pending` (with Retry-After: when to look again)
 *    or `failed` / `none`, on GET and HEAD, so a client keeps its monogram without hammering.
 *
 * Caching: a "master" per image (shorter side <= 256 px, WebP) in memory and on disk, and the rendered
 * sizes in memory (byte-budgeted LRU) and on disk (budgeted, LRU by mtime), keyed by the image's content
 * identity (CID or Arweave id when it has one). A restart serves from disk without touching the upstream.
 */
import { IMAGE_PROXY_SIZES, type ImageProxySize, imageProxySize, imageVersion } from "@zerofee/protocol";
import { apiError } from "../api/http";
import { RateLimiter } from "../gateway/rateLimit";
import { logger } from "../log";
import { LruMap } from "../util/lru";
import { SampleRing } from "../util/stats";
import { ByteLru, DiskCache } from "./cache";
import type { MediaConfig } from "./config";
import type { MasterResult } from "./imageops";
import { boundedFetch, FetchFailure, type Resolve } from "./net";
import { HostPacer, PRIORITY, type Priority } from "./pacer";
import { PoolBusy, WorkPool } from "./pool";
import { checkContentType, describeUnknown, hexHead, RASTER_MIME, type SourceFormat, sniffImage, sniffSource } from "./sniff";
import { contentKey, type FetchCandidate, fetchCandidates, HostHealth, staggeredRace } from "./urls";

const log = logger("media");

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const VERSION_RE = /^[0-9a-z]{1,13}$/;
export const PUMP_CDN = "https://images.pump.fun/coin-image";
/** A valid address no token uses: pump's CDN answers it with its placeholder image. */
const PUMP_SENTINEL = "11111111111111111111111111111111";
const ACCEPT = "image/webp,image/png,image/jpeg,image/gif;q=0.9,image/avif;q=0.8,*/*;q=0.1";
const LARGEST = IMAGE_PROXY_SIZES[IMAGE_PROXY_SIZES.length - 1] as ImageProxySize;
const WARM_SIZE: ImageProxySize = 96;
const PERMANENT_TTL = 6 * 3_600_000;
const GAVE_UP_TTL = 30 * 60_000;
const RETRY_CAP_MS = 300_000;

/** pump.fun's CDN URL for a mint: the fallback image when a pump coin's metadata can't be had. */
export const pumpCdnUrl = (mint: string): string => `${PUMP_CDN}/${mint}`;

/** What the proxy needs to know about a mint. */
export interface ImageRef {
  image: string | null;
  /** Launched on pump.fun: pump's own image CDN knows it. */
  pump: boolean;
}

/** An image's fetch state, as exposed to clients (`x-zf-image`). */
export type ImageState = "ok" | "pending" | "failed" | "none";

export interface ImageProxyOptions {
  cfg: MediaConfig;
  /** IPFS gateways to fetch CIDs from (the metadata fetcher's list). */
  gateways: readonly string[];
  lookup(mint: string): ImageRef | null;
  /** 0 when the token is on screen somewhere (Pulse column, open token page); undefined otherwise. */
  priorityOf?(mint: string): Priority | undefined;
  /** Shared with the metadata fetcher (same gateways); one is made when absent. */
  pacer?: HostPacer;
  /** Shared work pool; one is made from cfg when absent. */
  pool?: WorkPool;
  fetchFn?: typeof fetch;
  resolve?: Resolve;
  now?: () => number;
  random?: () => number;
}

interface Output {
  bytes: Uint8Array;
  mime: string;
  etag: string;
}

/** The normalized image every size is rendered from (or a small undecodable original, passed through). */
interface Master {
  bytes: Uint8Array;
  passthrough: boolean;
  /** Format of `bytes` (webp unless passed through). */
  format: SourceFormat;
}

interface Failed {
  until: number;
  reason: string;
  permanent: boolean;
}

interface Waiter {
  resolve(m: Master): void;
  reject(e: unknown): void;
}

interface Job {
  src: string;
  mint: string;
  ref: ImageRef;
  prio: Priority;
  attempts: number;
  nextAt: number;
  running: boolean;
  queued: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  reason: string;
  createdAt: number;
  waiters: Waiter[];
  /** A fetched original waiting for room in the work pool (not downloaded again). */
  original: Fetched | null;
}

interface Fetched {
  bytes: Uint8Array;
  format: SourceFormat;
  source: string;
}

export interface ImageProxyStats {
  requests: number;
  memoryHits: number;
  diskHits: number;
  misses: number;
  notModified: number;
  rateLimited: number;
  notFound: number;
  /** 404s by the state reported to the client. */
  notFoundByState: Record<string, number>;
  /** Failure reasons of upstream fetches and image checks. */
  failures: Record<string, number>;
  upstreamOk: number;
  upstreamFailed: number;
  /** Successful upstream fetches by source host. */
  sources: Record<string, number>;
  /** Failed upstream attempts by host and reason ("host reason"). */
  hostFailures: Record<string, number>;
  /** What bodies refused as bad_magic actually were (describeUnknown). */
  badMagic: Record<string, number>;
  /** Accepted source formats. */
  formats: Record<string, number>;
  resized: number;
  passthrough: number;
  prefetched: number;
  /** Prefetch / background work dropped because the work pool was saturated. */
  shed: number;
  /** Job outcomes. */
  jobs: { started: number; ok: number; retried: number; failedPermanent: number; gaveUp: number };
  bytesOut: number;
}

class ProxyError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    readonly state: ImageState = "failed",
    readonly retryAfterSec = 0,
  ) {
    super(reason);
  }
}

const etagOf = (b: Uint8Array): string => `"${Bun.hash(b).toString(16)}-${b.byteLength.toString(16)}"`;
const bump = (o: Record<string, number>, k: string) => {
  o[k] = (o[k] ?? 0) + 1;
};

export class ImageProxy {
  readonly stats: ImageProxyStats = {
    requests: 0,
    memoryHits: 0,
    diskHits: 0,
    misses: 0,
    notModified: 0,
    rateLimited: 0,
    notFound: 0,
    notFoundByState: {},
    failures: {},
    upstreamOk: 0,
    upstreamFailed: 0,
    sources: {},
    hostFailures: {},
    badMagic: {},
    formats: {},
    resized: 0,
    passthrough: 0,
    prefetched: 0,
    shed: 0,
    jobs: { started: 0, ok: 0, retried: 0, failedPermanent: 0, gaveUp: 0 },
    bytesOut: 0,
  };
  /** Request latency (ms) when served from cache, and when an upstream fetch was needed. */
  readonly latency = { hit: new SampleRing(5_000), miss: new SampleRing(5_000) };
  /** Job creation -> master ready (ms), by priority. */
  readonly timeToImage: [SampleRing, SampleRing, SampleRing] = [new SampleRing(2_000), new SampleRing(2_000), new SampleRing(2_000)];
  readonly health: HostHealth;
  readonly pacer: HostPacer;
  readonly pool: WorkPool;
  private readonly ownPool: boolean;
  private readonly memory: ByteLru<Output>;
  private readonly masters: ByteLru<Master>;
  private readonly disk: DiskCache | null;
  private readonly failed = new LruMap<string, Failed>(50_000);
  private readonly jobs = new Map<string, Job>();
  private readonly lanes: [Job[], Job[], Job[]] = [[], [], []];
  private running = 0;
  private bgTokens = 1;
  private bgAt: number;
  private bgTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly inflightOut = new Map<string, Promise<{ out: Output; fetched: boolean }>>();
  private readonly requests: RateLimiter;
  private readonly misses: RateLimiter;
  private readonly now: () => number;
  private readonly random: () => number;
  private stopped = false;
  private badMagicLogged = 0;
  private placeholder: { hash: string | null; at: number; pending: Promise<string | null> | null } = { hash: null, at: 0, pending: null };

  constructor(private readonly o: ImageProxyOptions) {
    this.now = o.now ?? Date.now;
    this.random = o.random ?? Math.random;
    this.bgAt = this.now();
    this.health = new HostHealth(this.now);
    this.pacer = o.pacer ?? new HostPacer({ limits: o.cfg.hostLimits, fallback: o.cfg.hostFallback, now: this.now, random: this.random });
    this.ownPool = !o.pool;
    this.pool = o.pool ?? new WorkPool({ workers: o.cfg.workers, nice: o.cfg.workerNice, maxQueue: o.cfg.workQueue });
    this.memory = new ByteLru<Output>(o.cfg.memoryBytes, (v) => v.bytes.byteLength + 200);
    this.masters = new ByteLru<Master>(Math.max(8 * 1024 * 1024, Math.floor(o.cfg.memoryBytes / 2)), (v) => v.bytes.byteLength + 200);
    this.disk = o.cfg.cacheDir ? new DiskCache(o.cfg.cacheDir, o.cfg.diskBytes, this.now) : null;
    this.requests = new RateLimiter(o.cfg.ratePerSec, o.cfg.rateBurst);
    this.misses = new RateLimiter(o.cfg.missPerSec, o.cfg.missBurst);
  }

  get diskBytes(): number {
    return this.disk?.usedBytes ?? 0;
  }

  get memoryBytes(): number {
    return this.memory.bytes + this.masters.bytes;
  }

  /** Jobs waiting or running, by priority, and how many are waiting out a back-off. */
  jobCounts(): { queued: [number, number, number]; running: number; backoff: number; failed: number } {
    let backoff = 0;
    for (const j of this.jobs.values()) if (!j.running && !j.queued) backoff++;
    return {
      queued: [this.lanes[0].length, this.lanes[1].length, this.lanes[2].length],
      running: this.running,
      backoff,
      failed: this.failed.size,
    };
  }

  stop(): void {
    this.stopped = true;
    for (const j of this.jobs.values()) if (j.timer) clearTimeout(j.timer);
    if (this.bgTimer) clearTimeout(this.bgTimer);
    if (this.ownPool) this.pool.stop();
  }

  /** The image state of a mint, as a client would be told (no fetch is started). */
  imageState(mint: string): ImageState {
    const ref = this.o.lookup(mint);
    if (!ref?.image) return "none";
    const src = contentKey(ref.image);
    if (this.masters.get(src)) return "ok";
    const f = this.failed.get(src);
    if (f && f.until > this.now()) return "failed";
    return this.jobs.has(src) ? "pending" : "ok";
  }

  /** Handles GET/HEAD /api/img. */
  async handle(req: Request, url: URL, ip: string): Promise<Response> {
    const t0 = performance.now();
    this.stats.requests++;
    if (req.method !== "GET" && req.method !== "HEAD") return apiError(405, "bad_request", "GET only");
    if (!this.o.cfg.enabled) return this.notFound("disabled", "none");
    if (!this.requests.allow(ip)) {
      this.stats.rateLimited++;
      return apiError(429, "rate_limited", "slow down", { "retry-after": "1" });
    }
    const mint = url.searchParams.get("mint") ?? "";
    if (!MINT_RE.test(mint)) return apiError(400, "bad_request", "invalid mint");
    const rawSize = url.searchParams.get("s");
    let size: ImageProxySize = LARGEST;
    if (rawSize !== null) {
      const n = Number(rawSize);
      if (!Number.isInteger(n) || n < 1 || n > 4096) return apiError(400, "bad_request", "s must be an integer pixel size");
      size = imageProxySize(n);
    }
    const v = url.searchParams.get("v");
    if (v !== null && !VERSION_RE.test(v)) return apiError(400, "bad_request", "invalid v");
    const ref = this.o.lookup(mint);
    if (!ref?.image) return this.notFound("no_image", "none");
    let out: Output;
    let missed: boolean;
    try {
      ({ out, fetched: missed } = await this.output(mint, ref, size, () => this.misses.allow(ip)));
    } catch (e) {
      if (e instanceof ProxyError && e.status === 429) {
        this.stats.rateLimited++;
        return apiError(429, "rate_limited", "slow down", { "retry-after": "1" });
      }
      if (e instanceof ProxyError && e.status === 503) return apiError(503, "unavailable", "busy", { "retry-after": "2" });
      if (e instanceof ProxyError) return this.notFound(e.reason, e.state, e.retryAfterSec);
      return this.notFound(e instanceof Error ? e.message : "failed", "failed");
    }
    (missed ? this.latency.miss : this.latency.hit).add(performance.now() - t0);
    const headers: Record<string, string> = {
      "content-type": out.mime,
      "cache-control": v === imageVersion(ref.image) ? "public, max-age=31536000, immutable" : "public, max-age=300",
      etag: out.etag,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
      "x-zf-cache": missed ? "miss" : "hit",
      "x-zf-image": "ok",
    };
    if (
      req.headers
        .get("if-none-match")
        ?.split(",")
        .some((t) => t.trim() === out.etag)
    ) {
      this.stats.notModified++;
      return new Response(null, { status: 304, headers });
    }
    headers["content-length"] = String(out.bytes.byteLength);
    this.stats.bytesOut += out.bytes.byteLength;
    return new Response(req.method === "HEAD" ? null : (out.bytes as Uint8Array<ArrayBuffer>), { status: 200, headers });
  }

  /**
   * Fetches and normalizes a token's image ahead of the first request: new launches (priority 1) and
   * restored tokens at startup (priority 2, paced). Never throws.
   */
  warm(mint: string, prio: Priority = PRIORITY.launch): void {
    if (!this.o.cfg.enabled || !this.o.cfg.prefetch || this.stopped) return;
    const ref = this.o.lookup(mint);
    if (!ref?.image) return;
    const p = this.priorityFor(mint, prio);
    if (p > 0 && this.pool.saturated) {
      this.stats.shed++;
      return;
    }
    this.stats.prefetched++;
    void this.output(mint, ref, WARM_SIZE, () => true, p).catch(() => {});
  }

  private priorityFor(mint: string, base: Priority): Priority {
    const p = this.o.priorityOf?.(mint);
    return p !== undefined && p < base ? p : base;
  }

  private notFound(reason: string, state: ImageState, retryAfterSec = 0): Response {
    this.stats.notFound++;
    bump(this.stats.notFoundByState, state);
    const headers: Record<string, string> = { "cache-control": "no-store", "x-zf-image": state };
    if (state === "pending") headers["retry-after"] = String(Math.max(1, Math.ceil(retryAfterSec)));
    return apiError(404, "not_found", `no image (${reason})`, headers);
  }

  private fail(reason: string): void {
    bump(this.stats.failures, reason);
  }

  /** Resized output for (image, size); `fetched` when an upstream fetch had to happen for it. */
  private async output(
    mint: string,
    ref: ImageRef,
    size: ImageProxySize,
    allowMiss: () => boolean,
    prio: Priority = PRIORITY.visible,
  ): Promise<{ out: Output; fetched: boolean }> {
    const image = ref.image as string;
    const src = contentKey(image);
    const key = `${src}|${size}`;
    const mem = this.memory.get(key);
    if (mem) {
      this.stats.memoryHits++;
      return { out: mem, fetched: false };
    }
    // viewers share work with viewers only: they wait with a deadline, prefetch waits without one
    const flightKey = `${key}|${prio === PRIORITY.visible ? "v" : "b"}`;
    const pending = this.inflightOut.get(flightKey);
    if (pending) return pending;
    const p = (async () => {
      const onDisk = await this.disk?.get(key);
      const format = onDisk ? sniffImage(onDisk) : null;
      if (onDisk && format) {
        const out = { bytes: onDisk, mime: RASTER_MIME[format], etag: etagOf(onDisk) };
        this.memory.set(key, out);
        this.stats.diskHits++;
        return { out, fetched: false };
      }
      let master = this.masters.get(src) ?? (await this.diskMaster(src));
      let fetched = false;
      if (!master) {
        const f = this.failed.get(src);
        if (f && f.until > this.now()) {
          if (prio === PRIORITY.visible) bump(this.stats.notFoundByState, "negative_hit");
          throw new ProxyError(404, f.reason, "failed");
        }
        if (!this.jobs.has(src) && prio === PRIORITY.visible && !allowMiss()) throw new ProxyError(429, "rate_limited");
        master = await this.waitMaster(mint, ref, src, prio);
        fetched = true;
      }
      this.stats.misses++;
      const out = await this.render(master, size, prio);
      this.memory.set(key, out);
      void this.disk?.put(key, out.bytes);
      return { out, fetched };
    })();
    this.inflightOut.set(flightKey, p);
    try {
      return await p;
    } finally {
      this.inflightOut.delete(flightKey);
    }
  }

  /** A master from the disk cache: our own, or (caches written before masters existed) the largest rendered size. */
  private async diskMaster(src: string): Promise<Master | null> {
    if (!this.disk) return null;
    for (const k of [`${src}|m`, `${src}|${LARGEST}`]) {
      const b = await this.disk.get(k);
      const format = b ? sniffImage(b) : null;
      if (b && format) {
        const m: Master = { bytes: b, passthrough: format !== "webp", format };
        this.masters.set(src, m);
        this.stats.diskHits++;
        return m;
      }
    }
    return null;
  }

  // ---- jobs ------------------------------------------------------------------------------------------

  /**
   * The master for `src`, through its job (created or joined). A viewer (priority 0) waits at most
   * IMG_WAIT_MS; past that, or when the job is waiting out a back-off longer than that, the answer is
   * "pending" with when to look again.
   */
  private waitMaster(mint: string, ref: ImageRef, src: string, prio: Priority): Promise<Master> {
    let job = this.jobs.get(src);
    if (!job) {
      job = {
        src,
        mint,
        ref,
        prio,
        attempts: 0,
        nextAt: this.now(),
        running: false,
        queued: false,
        timer: null,
        reason: "",
        createdAt: this.now(),
        waiters: [],
        original: null,
      };
      this.jobs.set(src, job);
      this.enqueue(job);
    } else if (prio < job.prio) {
      this.promote(src, prio);
    }
    const j = job;
    const wait = this.o.cfg.waitMs;
    if (prio === PRIORITY.visible && !j.running && j.nextAt - this.now() > wait)
      return Promise.reject(new ProxyError(404, j.reason || "pending", "pending", (j.nextAt - this.now()) / 1000));
    return new Promise<Master>((resolve, reject) => {
      const w: Waiter = { resolve, reject };
      j.waiters.push(w);
      if (prio !== PRIORITY.visible) return;
      const t = setTimeout(() => {
        const i = j.waiters.indexOf(w);
        if (i < 0) return;
        j.waiters.splice(i, 1);
        const left = j.running ? 2 : Math.max(1, (j.nextAt - this.now()) / 1000);
        reject(new ProxyError(404, j.reason || "pending", "pending", left));
      }, wait);
      const settle =
        <T>(f: (v: T) => void) =>
        (v: T) => {
          clearTimeout(t);
          f(v);
        };
      w.resolve = settle(resolve);
      w.reject = settle(reject);
    });
  }

  private promote(src: string, prio: Priority = PRIORITY.visible): void {
    const job = this.jobs.get(src);
    if (!job || job.prio <= prio) return;
    if (job.queued) {
      const lane = this.lanes[job.prio];
      const i = lane.indexOf(job);
      if (i >= 0) lane.splice(i, 1);
      job.prio = prio;
      this.lanes[prio].push(job);
      this.pump();
    } else {
      job.prio = prio;
    }
  }

  private enqueue(job: Job): void {
    const delay = job.nextAt - this.now();
    if (delay > 0) {
      job.timer = setTimeout(() => {
        job.timer = null;
        this.enqueue(job);
      }, delay);
      (job.timer as { unref?: () => void }).unref?.();
      return;
    }
    job.prio = this.priorityFor(job.mint, job.prio);
    job.queued = true;
    this.lanes[job.prio].push(job);
    this.pump();
  }

  /** Background jobs: IMG_BACKGROUND_RPS per second, at most half the upstream slots, never while the pool is saturated. */
  private backgroundAllowed(): boolean {
    if (this.running >= Math.max(1, Math.floor(this.o.cfg.maxUpstream / 2)) || this.pool.saturated) {
      this.wakeLater(500);
      return false;
    }
    const t = this.now();
    this.bgTokens = Math.min(2, this.bgTokens + ((t - this.bgAt) / 1000) * this.o.cfg.backgroundRps);
    this.bgAt = t;
    if (this.bgTokens >= 1) return true;
    this.wakeLater(Math.ceil(((1 - this.bgTokens) / this.o.cfg.backgroundRps) * 1000));
    return false;
  }

  private wakeLater(ms: number): void {
    if (this.bgTimer || this.stopped) return;
    this.bgTimer = setTimeout(() => {
      this.bgTimer = null;
      this.pump();
    }, ms);
    (this.bgTimer as { unref?: () => void }).unref?.();
  }

  private pump(): void {
    while (!this.stopped && this.running < this.o.cfg.maxUpstream) {
      let job = this.lanes[0].shift() ?? this.lanes[1].shift();
      if (!job && this.lanes[2].length && this.backgroundAllowed()) {
        this.bgTokens -= 1;
        job = this.lanes[2].shift();
      }
      if (!job) return;
      job.queued = false;
      void this.run(job);
    }
  }

  private async run(job: Job): Promise<void> {
    // the token may be gone, or its image changed, while this job waited
    const ref = this.o.lookup(job.mint);
    if (!ref?.image || contentKey(ref.image) !== job.src) {
      if (!job.waiters.length) {
        this.jobs.delete(job.src);
        return;
      }
    } else {
      job.ref = ref;
    }
    this.running++;
    job.running = true;
    job.attempts++;
    this.stats.jobs.started++;
    try {
      const master = this.masters.get(job.src) ?? (await this.fetchMaster(job));
      this.stats.jobs.ok++;
      this.timeToImage[job.prio].add(this.now() - job.createdAt);
      this.jobs.delete(job.src);
      this.failed.delete(job.src);
      for (const w of job.waiters.splice(0)) w.resolve(master);
    } catch (e) {
      this.onJobFailure(job, e);
    } finally {
      job.running = false;
      this.running--;
      this.pump();
    }
  }

  private onJobFailure(job: Job, e: unknown): void {
    if (e instanceof PoolBusy) {
      // our own overload, not the image's: try again shortly, without spending an attempt
      job.attempts--;
      this.stats.shed++;
      if (job.waiters.length && job.prio === PRIORITY.visible) {
        for (const w of job.waiters.splice(0)) w.reject(new ProxyError(503, "busy"));
      }
      job.nextAt = this.now() + 2_000;
      this.enqueue(job);
      return;
    }
    const errors = e instanceof AggregateError ? e.errors : [e];
    const failures = errors.filter((x): x is FetchFailure => x instanceof FetchFailure && x.reason !== "aborted");
    const permanent = failures.length > 0 && failures.every((f) => f.permanent);
    const reason = (failures.find((f) => f.status === 429) ?? failures[0])?.reason ?? (e instanceof Error ? e.message : "failed");
    job.reason = reason;
    if (permanent || job.attempts >= this.o.cfg.retryMax || this.stopped) {
      if (permanent) this.stats.jobs.failedPermanent++;
      else this.stats.jobs.gaveUp++;
      this.failed.set(job.src, { until: this.now() + (permanent ? PERMANENT_TTL : GAVE_UP_TTL), reason, permanent });
      this.jobs.delete(job.src);
      for (const w of job.waiters.splice(0)) w.reject(new ProxyError(404, reason, "failed"));
      return;
    }
    this.stats.jobs.retried++;
    const retryAfter = failures.reduce((a, f) => Math.max(a, f.retryAfterMs ?? 0, 0), 0);
    const backoff = Math.min(RETRY_CAP_MS, this.o.cfg.retryBaseMs * 2 ** (job.attempts - 1)) * (0.75 + this.random() * 0.5);
    job.nextAt = this.now() + Math.round(Math.max(backoff, retryAfter));
    for (const w of job.waiters.splice(0)) w.reject(new ProxyError(404, reason, "pending", (job.nextAt - this.now()) / 1000));
    this.enqueue(job);
  }

  /**
   * Sources for an image, best first. Hosts that keep failing or are paused after a 429 are skipped while
   * another source remains (`skipped`: a failure of the rest is then transient, not a verdict).
   */
  private candidates(mint: string, ref: ImageRef): { list: (FetchCandidate & { pumpCdn?: boolean })[]; skipped: number } {
    const image = ref.image as string;
    const cdn = { url: pumpCdnUrl(mint), trusted: true, host: "images.pump.fun", pumpCdn: true };
    // the fallback image of a pump coin whose metadata is unavailable: pump's CDN is the only source
    if (image.startsWith(`${PUMP_CDN}/`)) return { list: [cdn], skipped: 0 };
    const all = fetchCandidates(image, this.o.gateways);
    const { use: own, skipped } = this.health.usable(all, (h) => this.pacer.pausedFor(h) > this.o.cfg.patienceMs);
    const mode = this.o.cfg.pumpCdn;
    if (!ref.pump || mode === "off") return { list: own, skipped };
    return { list: mode === "first" ? [cdn, ...own] : [...own, cdn], skipped };
  }

  /** Fetches the original (staggered race over its sources, each paced per host) and normalizes it in the pool. */
  private async fetchMaster(job: Job): Promise<Master> {
    const { list, skipped } = this.candidates(job.mint, job.ref);
    let got: Fetched;
    try {
      got =
        job.original ??
        (await staggeredRace(
          list,
          (c, signal, started) => this.attempt(c, signal, started, job.prio),
          this.o.cfg.staggerMs,
          this.o.cfg.patienceMs,
        ));
    } catch (e) {
      // sources we skipped (down, or paused after a 429) may still have it: not a permanent failure
      if (skipped > 0)
        throw new AggregateError([...(e instanceof AggregateError ? e.errors : [e]), new FetchFailure("sources_down", false)]);
      throw e;
    }
    job.original = null;
    let res: MasterResult;
    try {
      res = await this.pool.master(got.bytes, got.format, this.o.cfg.maxPixels, LARGEST, job.prio);
    } catch (e) {
      if (e instanceof PoolBusy) {
        job.original = got; // kept for the retry: the upstream is not asked twice
        throw e;
      }
      const code = (e as { code?: string }).code ?? (e instanceof Error ? e.message : String(e));
      this.fail(code === "worker_crashed" ? "worker_crashed" : "decode_error");
      throw new FetchFailure(code === "worker_crashed" ? "worker_crashed" : "decode_error", true);
    }
    if (!res.ok) {
      this.fail(res.reason);
      if (res.reason !== "too_many_pixels")
        log.info(
          `image refused (${res.reason}${res.detail ? `: ${res.detail}` : ""}) from ${got.source}, ${got.bytes.byteLength} bytes ${got.format}`,
        );
      throw new FetchFailure(res.reason, true);
    }
    const master: Master = res.passthrough
      ? { bytes: got.bytes, passthrough: true, format: got.format }
      : { bytes: res.bytes, passthrough: false, format: "webp" };
    this.masters.set(job.src, master);
    if (!master.passthrough) void this.disk?.put(`${job.src}|m`, master.bytes);
    return master;
  }

  private async attempt(
    c: FetchCandidate & { pumpCdn?: boolean },
    signal: AbortSignal,
    started: () => void,
    prio: Priority,
  ): Promise<Fetched> {
    let contentType = "";
    try {
      const res = await boundedFetch(c.url, {
        fetchFn: this.o.fetchFn,
        resolve: this.o.resolve,
        timeoutMs: this.o.cfg.timeoutMs,
        maxBytes: this.o.cfg.maxBytes,
        accept: ACCEPT,
        signal,
        trusted: c.trusted,
        pacer: this.pacer,
        priority: prio,
        onStart: started,
        checkRedirect: c.pumpCdn
          ? (location, r) => {
              // pump's CDN redirects coins it has no image for to its placeholder: no need to download it
              if (r.headers.get("x-image-source") === "placeholder" || /placeholder/i.test(location))
                throw new FetchFailure("placeholder", false);
            }
          : undefined,
        check: (r) => {
          contentType = r.headers.get("content-type") ?? "";
          const verdict = checkContentType(contentType);
          if (verdict !== "accept") throw new FetchFailure(verdict, true);
        },
      });
      const format = sniffSource(res.bytes);
      if (!format) {
        const kind = describeUnknown(res.bytes);
        if (kind === "markup") throw new FetchFailure("markup", true);
        bump(this.stats.badMagic, kind);
        if (this.badMagicLogged < 50) {
          this.badMagicLogged++;
          log.info(
            `bad_magic from ${c.host}: ${kind}, content-type "${contentType}", ${res.bytes.byteLength} bytes, head ${hexHead(res.bytes)} (${res.url})`,
          );
        }
        throw new FetchFailure("bad_magic", true);
      }
      if (c.pumpCdn && (await this.isPumpPlaceholder(res.bytes, signal))) throw new FetchFailure("placeholder", false);
      this.health.success(c.host);
      this.stats.upstreamOk++;
      bump(this.stats.sources, c.host);
      bump(this.stats.formats, format);
      return { bytes: res.bytes, format, source: c.host };
    } catch (e) {
      const f = e instanceof FetchFailure ? e : new FetchFailure("failed", false);
      if (f.reason !== "aborted") {
        // waiting out a paused host never reached the upstream
        if (f.reason !== "host_paused" && f.reason !== "busy") this.stats.upstreamFailed++;
        this.fail(f.reason);
        bump(this.stats.hostFailures, `${c.host} ${f.reason}`);
        if (f.reason === "content_type" && this.badMagicLogged < 50) {
          this.badMagicLogged++;
          log.info(`content_type refused from ${c.host}: "${contentType}" (${c.url})`);
        }
        if (f.reason === "timeout" || f.reason === "network" || f.status === 429 || f.status >= 500) this.health.failure(c.host);
      }
      throw f;
    }
  }

  /** pump's CDN answers unknown coins with a stock placeholder: compare with what it serves a sentinel address. */
  private async isPumpPlaceholder(bytes: Uint8Array, signal: AbortSignal): Promise<boolean> {
    const ph = this.placeholder;
    const age = this.now() - ph.at;
    // refreshed every 6 h; when the sentinel fetch failed, retried after 5 min (unknown = accept the image)
    if (ph.at === 0 || age > (ph.hash === null ? 300_000 : 6 * 3_600_000)) {
      ph.pending ??= boundedFetch(pumpCdnUrl(PUMP_SENTINEL), {
        fetchFn: this.o.fetchFn,
        resolve: this.o.resolve,
        timeoutMs: this.o.cfg.timeoutMs,
        maxBytes: this.o.cfg.maxBytes,
        accept: ACCEPT,
        trusted: true,
        pacer: this.pacer,
        priority: PRIORITY.visible,
      })
        .then((r) => Bun.hash(r.bytes).toString(16))
        .catch(() => null)
        .then((h) => {
          ph.hash = h;
          ph.at = this.now();
          ph.pending = null;
          return h;
        });
      await Promise.race([ph.pending, new Promise((r) => signal.addEventListener("abort", r, { once: true }))]);
    }
    return ph.hash !== null && Bun.hash(bytes).toString(16) === ph.hash;
  }

  /** WebP with the shorter side at `size` (never upscaled), rendered from the master in the work pool. */
  private async render(master: Master, size: ImageProxySize, prio: Priority): Promise<Output> {
    if (master.passthrough) {
      this.stats.passthrough++;
      const format = sniffImage(master.bytes) ?? "png";
      return { bytes: master.bytes, mime: RASTER_MIME[format], etag: etagOf(master.bytes) };
    }
    try {
      const bytes = await this.pool.render(master.bytes, size, prio);
      if (sniffImage(bytes) !== "webp") throw new Error("encoder output");
      this.stats.resized++;
      return { bytes, mime: RASTER_MIME.webp, etag: etagOf(bytes) };
    } catch (e) {
      if (e instanceof PoolBusy) throw new ProxyError(prio === PRIORITY.visible ? 503 : 404, "busy", "pending", 2);
      // a master is our own WebP: if it can't be rendered, serve it as it is (at most 256 px)
      log.debug(`render failed (${e instanceof Error ? e.message : e}); serving the master`);
      return { bytes: master.bytes, mime: RASTER_MIME.webp, etag: etagOf(master.bytes) };
    }
  }
}
