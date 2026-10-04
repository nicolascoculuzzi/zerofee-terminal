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
 *    URLs) lives in media/extract.ts; with a work pool, parsing runs in a worker process.
 *
 * Scheduling (shared with the image proxy through one HostPacer, so both respect each host's limits):
 *  - Jobs wait in a priority queue: 0 = the token is on screen (Pulse columns, an open token page),
 *    1 = a new launch, 2 = startup refetch of restored tokens. Priority 2 starts at most
 *    METADATA_BACKGROUND_RPS jobs per second and only while half the slots are free: a restart never
 *    stampedes the gateways.
 *  - A transient failure (429, 5xx, timeout, reset, a gateway without the content yet) is retried with
 *    exponential back-off and jitter (5 s doubling to 10 min, at least the host's Retry-After) until it
 *    succeeds or METADATA_RETRY_MAX attempts are spent. Permanent failures stop at once: invalid JSON, an
 *    unsafe URL, 403-style refusals from every source, or 404/410 that persists over three attempts.
 *  - `onRetry` reports the first transient failure, so the caller can show a fallback image meanwhile.
 *  - Never on the hot path: results are delivered through a callback and merged into the token record later.
 */

import { logger } from "../log";
import { type ParsedMetadata, parseMetadataJson } from "../media/extract";
import { boundedFetch, FetchFailure, type Resolve } from "../media/net";
import { type HostPacer, PRIORITY, type Priority } from "../media/pacer";
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
const RETRY_BASE_MS = 5_000;
const RETRY_CAP_MS = 600_000;
/** 404 / 410 from every source on this many attempts: the content does not exist. */
const NOT_FOUND_ATTEMPTS = 3;

export function gatewayUrls(cid: string, path: string, gateways: readonly string[]): string[] {
  return gateways.map((g) => `${g.replace(/\/+$/, "")}/ipfs/${cid}${path}`);
}

/** Rewrites IPFS image URLs to a live gateway (normalizeImageUrl); other URLs are returned unchanged. */
export function rewriteIpfsUrl(url: string, gateways: readonly string[]): string {
  return extractCid(url) ? (normalizeImageUrl(url, gateways) ?? url) : url;
}

/** Where a request comes from: `restore` (startup refetch) runs at background priority. */
export type MetadataOrigin = "launch" | "restore";

export interface MetadataFetcherOptions {
  gateways: string[];
  timeoutMs: number;
  maxConcurrent?: number;
  maxQueue?: number;
  /** Delay before racing the next source of the same URI (ms). */
  staggerMs?: number;
  /** Launch the next source anyway when a paced attempt is still queued after this long (ms). */
  patienceMs?: number;
  fetchFn?: typeof fetch;
  store?: MetadataStore;
  resolve?: Resolve;
  pacer?: HostPacer;
  /** Attempts per URI before giving up on transient failures (default 12: about 1.5 h of back-off). */
  retryMax?: number;
  /** First retry delay (ms, default 5 s; doubles per attempt). */
  retryBaseMs?: number;
  /** Background (restore) jobs started per second (default 2). */
  backgroundRps?: number;
  /** 0 when the token is on screen (raises its priority); undefined otherwise. */
  priorityOf?(mint: string): Priority | undefined;
  /** False once the token is gone (evicted): pending retries are dropped. */
  wanted?(mint: string): boolean;
  /** Parses metadata JSON text (a worker pool); inline when absent. */
  parse?(text: string, gateways: readonly string[], prio: Priority): Promise<ParsedMetadata | null>;
  now?: () => number;
  random?: () => number;
  onResult(mint: string, meta: ParsedMetadata | null): void;
  /** The first attempt failed transiently and a retry is scheduled. */
  onRetry?(mint: string, attempt: number, reason: string): void;
}

interface Job {
  mint: string;
  uri: string;
  key: string;
  attempt: number;
  prio: Priority;
  notFound: number;
  /** Reason of the first transient failure (set once a retry is scheduled). */
  lastReason?: string;
}

/** Outcome of one fetch round (all sources raced). */
class RoundFailure extends Error {
  constructor(
    readonly reason: string,
    readonly permanent: boolean,
    readonly notFound: boolean,
    readonly retryAfterMs: number | null,
  ) {
    super(reason);
  }
}

export class MetadataFetcher {
  private readonly memory = new LruMap<string, string | null>(50_000);
  private readonly lanes: [Job[], Job[], Job[]] = [[], [], []];
  /** Keys queued, running or waiting for a retry: one job per URI (other mints with the same URI wait on it). */
  private readonly pending = new Map<string, Job>();
  private readonly followers = new Map<string, Set<string>>();
  private readonly health = new HostHealth();
  private inFlight = 0;
  private stopped = false;
  private bgTokens = 0;
  private bgAt = 0;
  private bgTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly now: () => number;
  private readonly random: () => number;
  readonly stats = {
    requested: 0,
    cacheHits: 0,
    fetched: 0,
    failed: 0,
    unsafe: 0,
    dropped: 0,
    imageUris: 0,
    withImage: 0,
    retries: 0,
    permanent: 0,
    gaveUp: 0,
    /** Failure reasons of fetch rounds. */
    reasons: {} as Record<string, number>,
  };

  constructor(private readonly opts: MetadataFetcherOptions) {
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.bgAt = this.now();
  }

  get queued(): number {
    return this.lanes[0].length + this.lanes[1].length + this.lanes[2].length;
  }

  /** URIs queued, in flight or waiting for a retry. */
  get pendingCount(): number {
    return this.pending.size;
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.bgTimer) clearTimeout(this.bgTimer);
  }

  request(mint: string, uri: string, origin: MetadataOrigin = "launch"): void {
    this.stats.requested++;
    const key = this.cacheKey(uri);
    const mem = this.memory.get(key);
    if (mem !== undefined) {
      this.stats.cacheHits++;
      this.deliver(mint, mem, PRIORITY.launch);
      return;
    }
    const stored = this.opts.store?.get(key);
    if (stored?.ok) {
      this.stats.cacheHits++;
      this.memory.set(key, stored.json);
      this.deliver(mint, stored.json, origin === "restore" ? PRIORITY.background : PRIORITY.launch);
      return;
    }
    const prio = this.priority(mint, origin === "restore" ? PRIORITY.background : PRIORITY.launch);
    const existing = this.pending.get(key);
    if (existing) {
      if (existing.mint !== mint) {
        const f = this.followers.get(key) ?? new Set<string>();
        this.followers.set(key, f);
        f.add(mint);
        // the URI already failed once: this token gets its fallback now, like the first one did
        if (existing.lastReason) this.opts.onRetry?.(mint, existing.attempt, existing.lastReason);
      }
      if (prio < existing.prio) this.promote(existing, prio);
      return;
    }
    if (this.queued >= (this.opts.maxQueue ?? 5_000)) {
      // full: shed the lowest-priority, oldest job
      const lane = this.lanes[2].length ? this.lanes[2] : this.lanes[1].length ? this.lanes[1] : this.lanes[0];
      const victim = lane.shift();
      if (victim) {
        this.pending.delete(victim.key);
        this.followers.delete(victim.key);
      }
      this.stats.dropped++;
    }
    const job: Job = { mint, uri, key, attempt: 0, prio, notFound: 0 };
    this.pending.set(key, job);
    this.lanes[prio].push(job);
    this.pump();
  }

  private promote(job: Job, prio: Priority): void {
    const lane = this.lanes[job.prio];
    const i = lane.indexOf(job);
    job.prio = prio;
    if (i >= 0) {
      lane.splice(i, 1);
      this.lanes[prio].push(job);
      this.pump();
    }
  }

  private priority(mint: string, base: Priority): Priority {
    const p = this.opts.priorityOf?.(mint);
    return p !== undefined && p < base ? p : base;
  }

  private cacheKey(uri: string): string {
    return extractCid(uri) ? contentKey(uri) : uri.trim();
  }

  private deliver(mint: string, json: string | null, prio: Priority): void {
    if (json === null) {
      this.opts.onResult(mint, null);
      return;
    }
    const done = (meta: ParsedMetadata | null) => {
      if (meta?.image) this.stats.withImage++;
      this.opts.onResult(mint, meta);
    };
    if (this.opts.parse) {
      void this.opts
        .parse(json, this.opts.gateways, prio)
        .catch(() => {
          try {
            return parseMetadataJson(JSON.parse(json), this.opts.gateways);
          } catch {
            return null;
          }
        })
        .then(done);
      return;
    }
    try {
      done(parseMetadataJson(JSON.parse(json), this.opts.gateways));
    } catch {
      this.opts.onResult(mint, null);
    }
  }

  private deliverAll(job: Job, json: string | null): void {
    this.deliver(job.mint, json, job.prio);
    for (const m of this.followers.get(job.key) ?? []) this.deliver(m, json, job.prio);
    this.followers.delete(job.key);
    this.pending.delete(job.key);
  }

  /** Background jobs: a token bucket of `backgroundRps` (burst 2) and at most half the slots. */
  private backgroundAllowed(max: number): boolean {
    if (this.inFlight >= Math.max(1, Math.floor(max / 2))) return false;
    const rps = this.opts.backgroundRps ?? 2;
    const t = this.now();
    this.bgTokens = Math.min(2, this.bgTokens + ((t - this.bgAt) / 1000) * rps);
    this.bgAt = t;
    if (this.bgTokens >= 1) return true;
    if (!this.bgTimer && !this.stopped) {
      this.bgTimer = setTimeout(
        () => {
          this.bgTimer = null;
          this.pump();
        },
        Math.ceil(((1 - this.bgTokens) / rps) * 1000),
      );
      (this.bgTimer as { unref?: () => void }).unref?.();
    }
    return false;
  }

  private pump(): void {
    const max = this.opts.maxConcurrent ?? 8;
    while (!this.stopped && this.inFlight < max) {
      let job = this.lanes[0].shift() ?? this.lanes[1].shift();
      if (!job && this.lanes[2].length && this.backgroundAllowed(max)) {
        this.bgTokens -= 1;
        job = this.lanes[2].shift();
      }
      if (!job) return;
      if (this.opts.wanted && !this.opts.wanted(job.mint) && !this.followers.get(job.key)?.size) {
        this.pending.delete(job.key);
        continue;
      }
      this.inFlight++;
      const j = job;
      void this.run(j).finally(() => {
        this.inFlight--;
        this.pump();
      });
    }
  }

  private async run(job: Job): Promise<void> {
    job.attempt++;
    try {
      const json = await this.fetchJson(job.uri, job.prio);
      this.stats.fetched++;
      this.memory.set(job.key, json);
      this.opts.store?.put(job.key, json, true);
      this.deliverAll(job, json);
    } catch (e) {
      const f = e instanceof RoundFailure ? e : new RoundFailure(e instanceof Error ? e.message : String(e), false, false, null);
      this.stats.reasons[f.reason] = (this.stats.reasons[f.reason] ?? 0) + 1;
      if (f.reason === "unsafe url") {
        this.stats.unsafe++;
        this.pending.delete(job.key);
        this.followers.delete(job.key);
        this.opts.onResult(job.mint, null);
        return;
      }
      job.notFound = f.notFound ? job.notFound + 1 : 0;
      const permanent = f.permanent || job.notFound >= NOT_FOUND_ATTEMPTS;
      if (!permanent && job.attempt < (this.opts.retryMax ?? 12) && !this.stopped) {
        this.stats.retries++;
        const backoff =
          Math.min(RETRY_CAP_MS, (this.opts.retryBaseMs ?? RETRY_BASE_MS) * 2 ** (job.attempt - 1)) * (0.75 + this.random() * 0.5);
        const delay = Math.round(Math.max(backoff, f.retryAfterMs ?? 0));
        if (job.attempt === 1) {
          job.lastReason = f.reason;
          this.opts.onRetry?.(job.mint, job.attempt, f.reason);
          for (const m of this.followers.get(job.key) ?? []) this.opts.onRetry?.(m, job.attempt, f.reason);
        }
        const t = setTimeout(() => {
          this.timers.delete(t);
          if (this.stopped) return;
          job.prio = this.priority(job.mint, job.prio);
          this.lanes[job.prio].push(job);
          this.pump();
        }, delay);
        (t as { unref?: () => void }).unref?.();
        this.timers.add(t);
        return;
      }
      this.stats.failed++;
      if (permanent) this.stats.permanent++;
      else this.stats.gaveUp++;
      this.opts.store?.put(job.key, null, false);
      log.debug(`giving up on ${job.uri} after ${job.attempt} attempts: ${f.reason}${permanent ? " (permanent)" : ""}`);
      this.deliverAll(job, null);
    }
  }

  /**
   * Fetches the JSON text: a staggered race over the IPFS sources for CIDs, arweave.net for Arweave ids,
   * direct (guarded) for other http(s) URIs; anything else is refused.
   */
  async fetchJson(uri: string, prio: Priority = PRIORITY.launch): Promise<string> {
    const candidates = fetchCandidates(uri.trim(), this.opts.gateways);
    if (!candidates.length) throw new RoundFailure("unsafe url", true, false, null);
    const pacer = this.opts.pacer;
    const { use: ordered, skipped } = this.health.usable(
      candidates,
      pacer ? (h) => pacer.pausedFor(h) > (this.opts.patienceMs ?? 2_000) : undefined,
    );
    try {
      return await staggeredRace(
        ordered,
        (c, signal, started) => this.fetchOne(c, signal, started, prio),
        this.opts.staggerMs ?? 300,
        this.opts.pacer ? (this.opts.patienceMs ?? 2_000) : undefined,
      );
    } catch (e) {
      const errors = e instanceof AggregateError ? e.errors : [e];
      const failures = errors.filter((x): x is FetchFailure => x instanceof FetchFailure && x.reason !== "aborted");
      if (failures.length && failures.every((x) => x.reason === "unsafe_url")) throw new RoundFailure("unsafe url", true, false, null);
      const first = failures.find((x) => x.status === 429) ?? failures[0];
      const notFound = failures.length > 0 && failures.every((x) => x.status === 404 || x.status === 410 || x.permanent);
      // sources we skipped (down, or paused after a 429) may still have it: not a permanent failure
      const permanent = skipped === 0 && failures.length > 0 && failures.every((x) => x.permanent);
      const retryAfter = failures.reduce<number | null>((a, x) => (x.retryAfterMs !== null ? Math.max(a ?? 0, x.retryAfterMs) : a), null);
      throw new RoundFailure(first ? first.reason : "all sources failed", permanent, skipped === 0 && notFound && !permanent, retryAfter);
    }
  }

  private async fetchOne(c: FetchCandidate, signal: AbortSignal, started: () => void, prio: Priority): Promise<string> {
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
        pacer: this.opts.pacer,
        // a launch's metadata gates everything else about it: same host priority as on-screen images
        priority: prio === PRIORITY.background ? PRIORITY.background : PRIORITY.visible,
        onStart: started,
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
      if (!/^\s*[{[]/.test(text)) throw new FetchFailure("invalid_json", true);
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
