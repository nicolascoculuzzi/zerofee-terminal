/**
 * Token metadata JSON (image, description, socials) from the CreateEvent / on-chain `uri`.
 *
 *  - IPFS URIs (ipfs://, /ipfs/<cid>, <cid>.ipfs.<host>, and Cloudflare's dead gateways) are fetched from
 *    public gateways (ipfs.io, dweb.link by default; never Cloudflare), racing them with a timeout, and
 *    cached by CID forever (content-addressed).
 *  - Other http(s) URIs are fetched directly (cached by URI) behind an SSRF guard: public hosts only,
 *    redirects followed manually and re-checked, 64 KB body cap.
 *  - Bounded concurrency and queue; failures retried with backoff. Never on the hot path: results are
 *    delivered through a callback and merged into the token record later.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { TokenSocials } from "@zerofee/protocol";
import { logger } from "../log";
import { LruMap } from "../util/lru";

const log = logger("metadata");

export interface ParsedMetadata {
  name: string | null;
  symbol: string | null;
  description: string | null;
  image: string | null;
  socials: TokenSocials;
}

export interface MetadataStore {
  get(key: string): { json: string | null; ok: boolean; fetchedAt: number } | null;
  put(key: string, json: string | null, ok: boolean): void;
}

const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/;
const CLOUDFLARE_IPFS = new Set(["cloudflare-ipfs.com", "cf-ipfs.com"]);
const MAX_BYTES = 64 * 1024;

/** Extracts an IPFS CID (+ sub-path) from any common URI form, or null. */
export function extractCid(uri: string): { cid: string; path: string } | null {
  const s = uri.trim();
  const m1 = /^ipfs:\/\/(?:ipfs\/)?([^/?#]+)([^?#]*)/i.exec(s);
  if (m1 && CID_RE.test(m1[1] as string)) return { cid: m1[1] as string, path: m1[2] ?? "" };
  try {
    const u = new URL(s);
    const m2 = /\/ipfs\/([^/?#]+)([^?#]*)/.exec(u.pathname);
    if (m2 && CID_RE.test(m2[1] as string)) return { cid: m2[1] as string, path: m2[2] ?? "" };
    const sub = /^([a-z0-9]+)\.ipfs\./i.exec(u.hostname);
    if (sub && CID_RE.test(sub[1] as string)) return { cid: sub[1] as string, path: u.pathname === "/" ? "" : u.pathname };
  } catch {
    /* not a URL */
  }
  return null;
}

export function gatewayUrls(cid: string, path: string, gateways: readonly string[]): string[] {
  return gateways.map((g) => `${g.replace(/\/+$/, "")}/ipfs/${cid}${path}`);
}

/** Rewrites IPFS image URLs to the first configured gateway (keeps other URLs). */
export function rewriteIpfsUrl(url: string, gateways: readonly string[]): string {
  const c = extractCid(url);
  return c && gateways.length ? (gatewayUrls(c.cid, c.path, gateways)[0] as string) : url;
}

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v = ip.toLowerCase();
  return v === "::1" || v === "::" || v.startsWith("fe80:") || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("::ffff:");
}

/** Syntactic check: http(s), no credentials, not an obviously internal host. */
export function isSafeUrlSyntax(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.username || u.password) return false;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (isIP(host)) return !isPrivateIp(host);
  return host.includes(".");
}

/** Syntax check plus DNS resolution (rejects names that resolve to private addresses). */
export async function isSafeUrl(url: string, resolve: (host: string) => Promise<string[]> = defaultResolve): Promise<boolean> {
  if (!isSafeUrlSyntax(url)) return false;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return true;
  try {
    const ips = await resolve(host);
    return ips.length > 0 && ips.every((ip) => !isPrivateIp(ip));
  } catch {
    return false;
  }
}

async function defaultResolve(host: string): Promise<string[]> {
  return (await lookup(host, { all: true })).map((r) => r.address);
}

function str(v: unknown, max = 2_000): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

function normalizeX(v: string | null): string | null {
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return /^(https?:\/\/)(www\.)?(twitter|x)\.com\//i.test(v) ? v : null;
  const handle = v.replace(/^@/, "");
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? `https://x.com/${handle}` : null;
}

function normalizeTelegram(v: string | null): string | null {
  if (!v) return null;
  if (/^https?:\/\/(t\.me|telegram\.me)\//i.test(v)) return v;
  const handle = v.replace(/^@/, "");
  return /^[A-Za-z0-9_]{4,64}$/.test(handle) ? `https://t.me/${handle}` : null;
}

function normalizeWebsite(v: string | null): string | null {
  return v && /^https?:\/\/[^\s]+\.[^\s]+/i.test(v) ? v : null;
}

/** Extracts the fields we show from pump-style metadata JSON (top-level or `extensions`). */
export function parseMetadataJson(json: unknown, gateways: readonly string[]): ParsedMetadata {
  const o = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const ext = (o.extensions && typeof o.extensions === "object" ? o.extensions : {}) as Record<string, unknown>;
  const image = str(o.image) ?? str(o.image_uri);
  return {
    name: str(o.name, 64),
    symbol: str(o.symbol, 32),
    description: str(o.description, 1_000),
    image: image ? rewriteIpfsUrl(image, gateways) : null,
    socials: {
      x: normalizeX(str(o.twitter) ?? str(ext.twitter) ?? str(o.x)),
      telegram: normalizeTelegram(str(o.telegram) ?? str(ext.telegram)),
      website: normalizeWebsite(str(o.website) ?? str(ext.website)),
    },
  };
}

export interface MetadataFetcherOptions {
  gateways: string[];
  timeoutMs: number;
  maxConcurrent?: number;
  maxQueue?: number;
  fetchFn?: typeof fetch;
  store?: MetadataStore;
  resolve?: (host: string) => Promise<string[]>;
  onResult(mint: string, meta: ParsedMetadata | null): void;
}

interface Job {
  mint: string;
  uri: string;
  attempt: number;
}

export class MetadataFetcher {
  private readonly fetchFn: typeof fetch;
  private readonly memory = new LruMap<string, string | null>(50_000);
  private readonly queue: Job[] = [];
  private inFlight = 0;
  private stopped = false;
  readonly stats = { requested: 0, cacheHits: 0, fetched: 0, failed: 0, unsafe: 0, dropped: 0 };

  constructor(private readonly opts: MetadataFetcherOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  get queued(): number {
    return this.queue.length;
  }

  stop(): void {
    this.stopped = true;
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
    const c = extractCid(uri);
    return c ? `ipfs:${c.cid}${c.path}` : uri;
  }

  private deliver(mint: string, json: string | null): void {
    if (json === null) {
      this.opts.onResult(mint, null);
      return;
    }
    try {
      this.opts.onResult(mint, parseMetadataJson(JSON.parse(json), this.opts.gateways));
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
      if (job.attempt < 2) {
        const delay = [5_000, 30_000][job.attempt] as number;
        setTimeout(() => {
          this.queue.push({ ...job, attempt: job.attempt + 1 });
          this.pump();
        }, delay);
        return;
      }
      this.stats.failed++;
      this.opts.store?.put(key, null, false);
      log.debug(`giving up on ${job.uri}: ${msg}`);
      this.opts.onResult(job.mint, null);
    }
  }

  /** Fetches the JSON text: races gateways for IPFS, direct (guarded) otherwise. */
  async fetchJson(uri: string): Promise<string> {
    const cid = extractCid(uri);
    if (cid) return this.race(gatewayUrls(cid.cid, cid.path, this.opts.gateways));
    let host = "";
    try {
      host = new URL(uri).hostname;
    } catch {
      throw new Error("unsafe url");
    }
    if (CLOUDFLARE_IPFS.has(host)) throw new Error("unsafe url");
    return this.fetchGuarded(uri, 0);
  }

  private async race(urls: string[]): Promise<string> {
    const controllers = urls.map(() => new AbortController());
    try {
      return await Promise.any(urls.map((u, i) => this.fetchText(u, (controllers[i] as AbortController).signal, "follow")));
    } catch {
      throw new Error("all gateways failed");
    } finally {
      for (const c of controllers) c.abort();
    }
  }

  private async fetchGuarded(url: string, hops: number): Promise<string> {
    if (hops > 3 || !(await isSafeUrl(url, this.opts.resolve))) throw new Error("unsafe url");
    const res = await this.fetchFn(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(this.opts.timeoutMs),
      headers: { accept: "application/json" },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`redirect without location (${res.status})`);
      return this.fetchGuarded(new URL(loc, url).toString(), hops + 1);
    }
    return this.readBody(res);
  }

  private async fetchText(url: string, signal: AbortSignal, redirect: RequestRedirect): Promise<string> {
    const res = await this.fetchFn(url, {
      redirect,
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.opts.timeoutMs)]),
      headers: { accept: "application/json" },
    });
    return this.readBody(res);
  }

  private async readBody(res: Response): Promise<string> {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_BYTES) throw new Error("metadata too large");
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error("metadata too large");
    JSON.parse(text); // validate
    return text;
  }
}
