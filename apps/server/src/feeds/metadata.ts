/**
 * Token metadata JSON (image, description, socials) from the CreateEvent / on-chain `uri`.
 *
 *  - IPFS URIs (ipfs://, /ipfs/<cid>, <cid>.ipfs.<host>, any gateway URL) are fetched from the URI's own
 *    host when that is a live gateway, then from the configured gateways, in a staggered race (media/urls.ts:
 *    ipfs.io, dweb.link and Cloudflare's gateways are retired and never contacted). Cached by CID forever
 *    (content-addressed).
 *  - Other http(s) URIs are fetched directly (cached by URI) behind the SSRF guard (media/net.ts): public
 *    hosts only, redirects followed manually and re-checked, 64 KB body cap.
 *  - A URI that serves an image instead of JSON is taken as the token's image.
 *  - Field extraction (image from image / image_uri / properties.files ..., socials normalized to https
 *    URLs) lives in media/extract.ts.
 *  - Bounded concurrency and queue; failures retried with backoff. Never on the hot path: results are
 *    delivered through a callback and merged into the token record later.
 */

import { logger } from "../log";
import { type ParsedMetadata, parseMetadataJson } from "../media/extract";
import { boundedFetch, FetchFailure, type Resolve } from "../media/net";
import { checkContentType } from "../media/sniff";
import { contentKey, extractCid, type FetchCandidate, fetchCandidates, HostHealth, normalizeImageUrl, staggeredRace } from "../media/urls";
import { LruMap } from "../util/lru";

export { type ParsedMetadata, parseMetadataJson } from "../media/extract";
export { isPrivateIp, isSafeUrl, isSafeUrlSyntax } from "../media/net";
export { extractCid } from "../media/urls";

const log = logger("metadata");

export interface MetadataStore {
  get(key: string): { json: string | null; ok: boolean; fetchedAt: number } | null;
  put(key: string, json: string | null, ok: boolean): void;
}

const MAX_BYTES = 64 * 1024;
/** Retries after a failed fetch (new IPFS content can take a moment to show up on gateways). */
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000];

export function gatewayUrls(cid: string, path: string, gateways: readonly string[]): string[] {
  return gateways.map((g) => `${g.replace(/\/+$/, "")}/ipfs/${cid}${path}`);
}

/** Rewrites IPFS image URLs to a live gateway (normalizeImageUrl); other URLs are returned unchanged. */
export function rewriteIpfsUrl(url: string, gateways: readonly string[]): string {
  return extractCid(url) ? (normalizeImageUrl(url, gateways) ?? url) : url;
}

export interface MetadataFetcherOptions {
  gateways: string[];
  timeoutMs: number;
  maxConcurrent?: number;
  maxQueue?: number;
  /** Delay before racing the next source of the same URI (ms). */
  staggerMs?: number;
  fetchFn?: typeof fetch;
  store?: MetadataStore;
  resolve?: Resolve;
  onResult(mint: string, meta: ParsedMetadata | null): void;
}

interface Job {
  mint: string;
  uri: string;
  attempt: number;
}

export class MetadataFetcher {
  private readonly memory = new LruMap<string, string | null>(50_000);
  private readonly queue: Job[] = [];
  private readonly health = new HostHealth();
  private inFlight = 0;
  private stopped = false;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  readonly stats = { requested: 0, cacheHits: 0, fetched: 0, failed: 0, unsafe: 0, dropped: 0, imageUris: 0, withImage: 0 };

  constructor(private readonly opts: MetadataFetcherOptions) {}

  get queued(): number {
    return this.queue.length;
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  request(mint: string, uri: string): void {
    this.stats.requested++;
    const key = this.cacheKey(uri);
    const mem = this.memory.get(key);
    if (mem !== undefined) {
      this.stats.cacheHits++;
      this.deliver(mint, mem);
      return;
    }
    const stored = this.opts.store?.get(key);
    if (stored?.ok) {
      this.stats.cacheHits++;
      this.memory.set(key, stored.json);
      this.deliver(mint, stored.json);
      return;
    }
    if (this.queue.length >= (this.opts.maxQueue ?? 5_000)) {
      this.stats.dropped++;
      this.queue.shift();
    }
    this.queue.push({ mint, uri, attempt: 0 });
    this.pump();
  }

  private cacheKey(uri: string): string {
    return extractCid(uri) ? contentKey(uri) : uri.trim();
  }

  private deliver(mint: string, json: string | null): void {
    if (json === null) {
      this.opts.onResult(mint, null);
      return;
    }
    try {
      const meta = parseMetadataJson(JSON.parse(json), this.opts.gateways);
      if (meta.image) this.stats.withImage++;
      this.opts.onResult(mint, meta);
    } catch {
      this.opts.onResult(mint, null);
    }
  }

  private pump(): void {
    while (!this.stopped && this.inFlight < (this.opts.maxConcurrent ?? 8) && this.queue.length) {
      const job = this.queue.shift() as Job;
      this.inFlight++;
      void this.run(job).finally(() => {
        this.inFlight--;
        this.pump();
      });
    }
  }

  private async run(job: Job): Promise<void> {
    const key = this.cacheKey(job.uri);
    try {
      const json = await this.fetchJson(job.uri);
      this.stats.fetched++;
      this.memory.set(key, json);
      this.opts.store?.put(key, json, true);
      this.deliver(job.mint, json);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "unsafe url") {
        this.stats.unsafe++;
        this.opts.onResult(job.mint, null);
        return;
      }
      const delay = RETRY_DELAYS_MS[job.attempt];
      if (delay !== undefined && !this.stopped) {
        const t = setTimeout(() => {
          this.timers.delete(t);
          this.queue.push({ ...job, attempt: job.attempt + 1 });
          this.pump();
        }, delay);
        this.timers.add(t);
        return;
      }
      this.stats.failed++;
      this.opts.store?.put(key, null, false);
      log.debug(`giving up on ${job.uri}: ${msg}`);
      this.opts.onResult(job.mint, null);
    }
  }

  /**
   * Fetches the JSON text: a staggered race over the IPFS sources for CIDs, arweave.net for Arweave ids,
   * direct (guarded) for other http(s) URIs; anything else is refused.
   */
  async fetchJson(uri: string): Promise<string> {
    const candidates = fetchCandidates(uri.trim(), this.opts.gateways);
    if (!candidates.length) throw new Error("unsafe url");
    const ordered = this.health.order(candidates);
    try {
      return await staggeredRace(ordered, (c, signal) => this.fetchOne(c, signal), this.opts.staggerMs ?? 300);
    } catch (e) {
      const errors = e instanceof AggregateError ? e.errors : [e];
      if (errors.length && errors.every((x) => x instanceof FetchFailure && x.reason === "unsafe_url")) throw new Error("unsafe url");
      const first = errors.find((x) => x instanceof FetchFailure) as FetchFailure | undefined;
      throw new Error(first ? first.reason : "all sources failed");
    }
  }

  private async fetchOne(c: FetchCandidate, signal: AbortSignal): Promise<string> {
    let isImage = false;
    try {
      const res = await boundedFetch(c.url, {
        fetchFn: this.opts.fetchFn,
        resolve: this.opts.resolve,
        timeoutMs: this.opts.timeoutMs,
        maxBytes: MAX_BYTES,
        accept: "application/json",
        signal,
        trusted: c.trusted,
        check: (r) => {
          const type = (r.headers.get("content-type") ?? "").toLowerCase();
          // The URI points at the image itself: don't download it here, the image proxy will.
          if (type.startsWith("image/") && checkContentType(type) === "accept") {
            isImage = true;
            throw new FetchFailure("image", true);
          }
        },
      });
      const text = new TextDecoder().decode(res.bytes);
      JSON.parse(text); // validate
      this.health.success(c.host);
      return text;
    } catch (e) {
      if (isImage) {
        this.health.success(c.host);
        this.stats.imageUris++;
        return JSON.stringify({ image: c.url });
      }
      if (e instanceof FetchFailure) {
        if (e.reason === "timeout" || e.reason === "network" || e.status === 429 || e.status >= 500) this.health.failure(c.host);
        throw e;
      }
      throw new FetchFailure("invalid_json", true);
    }
  }
}
