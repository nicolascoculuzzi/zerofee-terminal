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
 *    else is refused; at most IMG_MAX_BYTES (2 MB), streamed and cut off; the magic bytes must say PNG,
 *    JPEG, WebP or GIF; the header's pixel count must be under IMG_MAX_PIXELS before decoding.
 *  - Output is re-encoded by Bun.Image (libspng / libjpeg-turbo / libwebp) to WebP at the requested size,
 *    which also drops any trailing payload. Only when decoding fails is the validated original passed
 *    through, with the type its magic bytes name. Responses carry nosniff and a sandboxing CSP.
 *  - Per-IP token buckets on requests and, separately, on cache misses that start upstream fetches; a
 *    server-wide cap on concurrent upstream fetches with a bounded wait queue.
 *  - Failures are negative-cached per image: transient ones (timeouts, 404 on fresh IPFS content, 5xx) for
 *    15 s doubling to 10 min, permanent ones (wrong type, too large, too many pixels) for 6 h.
 *
 * Caching: resized outputs in memory (byte-budgeted LRU) and on disk (budgeted, LRU by mtime), keyed by
 * the image's content identity (CID or Arweave id when it has one) and size; originals briefly in memory
 * so several sizes of one image cost one upstream fetch; concurrent requests share one fetch.
 */
import { IMAGE_PROXY_SIZES, type ImageProxySize, imageProxySize, imageVersion } from "@zerofee/protocol";
import { apiError } from "../api/http";
import { RateLimiter } from "../gateway/rateLimit";
import { logger } from "../log";
import { LruMap } from "../util/lru";
import { SampleRing } from "../util/stats";
import { ByteLru, DiskCache } from "./cache";
import type { MediaConfig } from "./config";
import { boundedFetch, FetchFailure, type Resolve } from "./net";
import { checkContentType, looksLikeMarkup, RASTER_MIME, type RasterFormat, sniffImage } from "./sniff";
import { contentKey, type FetchCandidate, fetchCandidates, HostHealth, staggeredRace } from "./urls";

const log = logger("media");

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const VERSION_RE = /^[0-9a-z]{1,13}$/;
const PUMP_CDN = "https://images.pump.fun/coin-image";
/** A valid address no token uses: pump's CDN answers it with its placeholder image. */
const PUMP_SENTINEL = "11111111111111111111111111111111";
const ACCEPT = "image/webp,image/png,image/jpeg,image/gif;q=0.9";
const LARGEST = IMAGE_PROXY_SIZES[IMAGE_PROXY_SIZES.length - 1] as ImageProxySize;
const WARM_SIZE: ImageProxySize = 96;
const PERMANENT_TTL = 6 * 3_600_000;

/** What the proxy needs to know about a mint. */
export interface ImageRef {
  image: string | null;
  /** Launched on pump.fun: pump's own image CDN knows it. */
  pump: boolean;
}

export interface ImageProxyOptions {
  cfg: MediaConfig;
  /** IPFS gateways to fetch CIDs from (the metadata fetcher's list). */
  gateways: readonly string[];
  lookup(mint: string): ImageRef | null;
  fetchFn?: typeof fetch;
  resolve?: Resolve;
  now?: () => number;
}

interface Output {
  bytes: Uint8Array;
  mime: string;
  etag: string;
}

interface Original {
  bytes: Uint8Array;
  format: RasterFormat;
  source: string;
}

interface Negative {
  until: number;
  reason: string;
  failures: number;
}

export interface ImageProxyStats {
  requests: number;
  memoryHits: number;
  diskHits: number;
  misses: number;
  notModified: number;
  rateLimited: number;
  notFound: number;
  /** Failure reasons of upstream fetches and image checks. */
  failures: Record<string, number>;
  upstreamOk: number;
  upstreamFailed: number;
  /** Successful upstream fetches by source host. */
  sources: Record<string, number>;
  resized: number;
  passthrough: number;
  prefetched: number;
  bytesOut: number;
}

class ProxyError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(reason);
  }
}

/** Counting semaphore with a bounded queue. */
class Gate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly max: number,
    private readonly maxQueue: number,
  ) {}

  get load(): number {
    return this.active + this.waiting.length;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      if (this.waiting.length >= this.maxQueue) throw new FetchFailure("busy", false);
      await new Promise<void>((r) => this.waiting.push(r));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

const etagOf = (b: Uint8Array): string => `"${Bun.hash(b).toString(16)}-${b.byteLength.toString(16)}"`;

export class ImageProxy {
  readonly stats: ImageProxyStats = {
    requests: 0,
    memoryHits: 0,
    diskHits: 0,
    misses: 0,
    notModified: 0,
    rateLimited: 0,
    notFound: 0,
    failures: {},
    upstreamOk: 0,
    upstreamFailed: 0,
    sources: {},
    resized: 0,
    passthrough: 0,
    prefetched: 0,
    bytesOut: 0,
  };
  /** Request latency (ms) when served from cache, and when an upstream fetch was needed. */
  readonly latency = { hit: new SampleRing(5_000), miss: new SampleRing(5_000) };
  readonly health: HostHealth;
  private readonly memory: ByteLru<Output>;
  private readonly originals: ByteLru<Original>;
  private readonly disk: DiskCache | null;
  private readonly negative = new LruMap<string, Negative>(50_000);
  private readonly inflightOut = new Map<string, Promise<{ out: Output; fetched: boolean }>>();
  private readonly inflightSrc = new Map<string, Promise<Original>>();
  private readonly requests: RateLimiter;
  private readonly misses: RateLimiter;
  private readonly upstream: Gate;
  private readonly decode = new Gate(2, 1_000);
  private readonly now: () => number;
  private placeholder: { hash: string | null; at: number; pending: Promise<string | null> | null } = { hash: null, at: 0, pending: null };

  constructor(private readonly o: ImageProxyOptions) {
    this.now = o.now ?? Date.now;
    this.health = new HostHealth(this.now);
    this.memory = new ByteLru<Output>(o.cfg.memoryBytes, (v) => v.bytes.byteLength + 200);
    this.originals = new ByteLru<Original>(Math.max(8 * 1024 * 1024, Math.floor(o.cfg.memoryBytes / 2)), (v) => v.bytes.byteLength + 200);
    this.disk = o.cfg.cacheDir ? new DiskCache(o.cfg.cacheDir, o.cfg.diskBytes, this.now) : null;
    this.requests = new RateLimiter(o.cfg.ratePerSec, o.cfg.rateBurst);
    this.misses = new RateLimiter(o.cfg.missPerSec, o.cfg.missBurst);
    this.upstream = new Gate(o.cfg.maxUpstream, 512);
  }

  get diskBytes(): number {
    return this.disk?.usedBytes ?? 0;
  }

  get memoryBytes(): number {
    return this.memory.bytes;
  }

  /** Handles GET/HEAD /api/img. */
  async handle(req: Request, url: URL, ip: string): Promise<Response> {
    const t0 = performance.now();
    this.stats.requests++;
    if (req.method !== "GET" && req.method !== "HEAD") return apiError(405, "bad_request", "GET only");
    if (!this.o.cfg.enabled) return this.notFound("disabled");
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
    if (!ref?.image) return this.notFound("no_image");
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
      return this.notFound(e instanceof Error ? e.message : "failed");
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

  /** Fetches and resizes a token's image ahead of the first request (new launches). Never throws. */
  warm(mint: string): void {
    if (!this.o.cfg.enabled || !this.o.cfg.prefetch) return;
    if (this.upstream.load >= this.o.cfg.maxUpstream) return; // busy: real requests first
    const ref = this.o.lookup(mint);
    if (!ref?.image) return;
    this.stats.prefetched++;
    void this.output(mint, ref, WARM_SIZE, () => true).catch(() => {});
  }

  private notFound(reason: string): Response {
    this.stats.notFound++;
    return apiError(404, "not_found", `no image (${reason})`, { "cache-control": "no-store" });
  }

  private fail(reason: string): void {
    this.stats.failures[reason] = (this.stats.failures[reason] ?? 0) + 1;
  }

  /** Resized output for (image, size); `fetched` when an upstream fetch had to happen for it. */
  private async output(
    mint: string,
    ref: ImageRef,
    size: ImageProxySize,
    allowMiss: () => boolean,
  ): Promise<{ out: Output; fetched: boolean }> {
    const image = ref.image as string;
    const src = contentKey(image);
    const key = `${src}|${size}`;
    const mem = this.memory.get(key);
    if (mem) {
      this.stats.memoryHits++;
      return { out: mem, fetched: false };
    }
    const pending = this.inflightOut.get(key);
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
      const neg = this.negative.get(src);
      if (neg && neg.until > this.now()) throw new ProxyError(404, neg.reason);
      let original = this.originals.get(src);
      let fetched = false;
      if (!original) {
        if (!this.inflightSrc.has(src) && !allowMiss()) throw new ProxyError(429, "rate_limited");
        original = await this.original(mint, ref, src);
        fetched = true;
      }
      this.stats.misses++;
      let out: Output;
      try {
        out = await this.render(original, size);
      } catch (e) {
        if (e instanceof ProxyError && e.status === 404) {
          // a decompression bomb or similar: don't try this image again soon
          this.originals.delete(src);
          this.negative.set(src, { until: this.now() + PERMANENT_TTL, reason: e.reason, failures: 1 });
        }
        throw e;
      }
      this.memory.set(key, out);
      void this.disk?.put(key, out.bytes);
      return { out, fetched };
    })();
    this.inflightOut.set(key, p);
    try {
      return await p;
    } finally {
      this.inflightOut.delete(key);
    }
  }

  private original(mint: string, ref: ImageRef, src: string): Promise<Original> {
    const pending = this.inflightSrc.get(src);
    if (pending) return pending;
    const p = this.fetchOriginal(mint, ref, src).finally(() => this.inflightSrc.delete(src));
    this.inflightSrc.set(src, p);
    return p;
  }

  private candidates(mint: string, ref: ImageRef): (FetchCandidate & { pumpCdn?: boolean })[] {
    const own = this.health.order(fetchCandidates(ref.image as string, this.o.gateways));
    const mode = this.o.cfg.pumpCdn;
    if (!ref.pump || mode === "off") return own;
    const cdn = { url: `${PUMP_CDN}/${mint}`, trusted: true, host: "images.pump.fun", pumpCdn: true };
    return mode === "first" ? [cdn, ...own] : [...own, cdn];
  }

  private async fetchOriginal(mint: string, ref: ImageRef, src: string): Promise<Original> {
    const candidates = this.candidates(mint, ref);
    let got: Original;
    try {
      got = await this.upstream.run(() => staggeredRace(candidates, (c, signal) => this.attempt(c, signal), this.o.cfg.staggerMs));
    } catch (e) {
      // Overload is ours, not the image's: no negative entry.
      if (e instanceof FetchFailure && e.reason === "busy") throw new ProxyError(503, "busy");
      const errors = e instanceof AggregateError ? e.errors : [e];
      const failures = errors.filter((x): x is FetchFailure => x instanceof FetchFailure && x.reason !== "aborted");
      const permanent = failures.length > 0 && failures.every((f) => f.permanent);
      const reason = failures[0]?.reason ?? "failed";
      const n = (this.negative.peek(src)?.failures ?? 0) + 1;
      const ttl = permanent ? PERMANENT_TTL : Math.min(600_000, 15_000 * 2 ** (n - 1));
      this.negative.set(src, { until: this.now() + ttl, reason, failures: n });
      throw new ProxyError(404, reason);
    }
    this.negative.delete(src);
    this.originals.set(src, got);
    return got;
  }

  private async attempt(c: FetchCandidate & { pumpCdn?: boolean }, signal: AbortSignal): Promise<Original> {
    try {
      const res = await boundedFetch(c.url, {
        fetchFn: this.o.fetchFn,
        resolve: this.o.resolve,
        timeoutMs: this.o.cfg.timeoutMs,
        maxBytes: this.o.cfg.maxBytes,
        accept: ACCEPT,
        signal,
        trusted: c.trusted,
        check: (r) => {
          const verdict = checkContentType(r.headers.get("content-type"));
          if (verdict !== "accept") throw new FetchFailure(verdict, true);
        },
      });
      const format = sniffImage(res.bytes);
      if (!format) throw new FetchFailure(looksLikeMarkup(res.bytes) ? "markup" : "bad_magic", true);
      if (c.pumpCdn && (await this.isPumpPlaceholder(res.bytes, signal))) throw new FetchFailure("placeholder", false);
      this.health.success(c.host);
      this.stats.upstreamOk++;
      this.stats.sources[c.host] = (this.stats.sources[c.host] ?? 0) + 1;
      return { bytes: res.bytes, format, source: c.host };
    } catch (e) {
      const f = e instanceof FetchFailure ? e : new FetchFailure("failed", false);
      if (f.reason !== "aborted") {
        this.stats.upstreamFailed++;
        this.fail(f.reason);
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
      ph.pending ??= boundedFetch(`${PUMP_CDN}/${PUMP_SENTINEL}`, {
        fetchFn: this.o.fetchFn,
        resolve: this.o.resolve,
        timeoutMs: this.o.cfg.timeoutMs,
        maxBytes: this.o.cfg.maxBytes,
        accept: ACCEPT,
        trusted: true,
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

  /** Re-encodes to WebP with the shorter side at `size` (never upscaled); passes the original through if decoding fails. */
  private async render(original: Original, size: ImageProxySize): Promise<Output> {
    const passthrough = (): Output => {
      this.stats.passthrough++;
      return { bytes: original.bytes, mime: RASTER_MIME[original.format], etag: etagOf(original.bytes) };
    };
    if (typeof Bun.Image !== "function") return passthrough();
    try {
      const bytes = await this.decode.run(async () => {
        const opts = { maxPixels: this.o.cfg.maxPixels };
        const meta = await new Bun.Image(original.bytes, opts).metadata();
        const shorter = Math.min(meta.width, meta.height);
        const img = new Bun.Image(original.bytes, opts);
        if (shorter > size) {
          const k = size / shorter;
          img.resize(Math.max(1, Math.round(meta.width * k)), Math.max(1, Math.round(meta.height * k)), {
            fit: "fill",
            filter: "lanczos3",
          });
        }
        return img.webp({ quality: 82 }).bytes();
      });
      if (sniffImage(bytes) !== "webp") return passthrough();
      this.stats.resized++;
      return { bytes, mime: RASTER_MIME.webp, etag: etagOf(bytes) };
    } catch (e) {
      if (e instanceof FetchFailure) throw new ProxyError(503, "busy"); // decode queue full
      const code = (e as { code?: string }).code;
      if (code === "ERR_IMAGE_TOO_MANY_PIXELS") {
        this.fail("too_many_pixels");
        throw new ProxyError(404, "too_many_pixels");
      }
      log.debug(`image re-encode failed (${code ?? (e instanceof Error ? e.message : e)}), passing the original through`);
      return passthrough();
    }
  }
}
