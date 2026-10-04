/**
 * Outbound fetches of URLs named in token metadata (metadata JSON, images): an SSRF guard and a bounded
 * fetch.
 *
 *  - Only http(s), no credentials, no local names, no private / reserved addresses: literal IPs are
 *    checked directly, names are resolved and every address must be public.
 *  - Redirects are followed by hand (at most 3 hops) and every hop is checked again.
 *  - A wall-clock timeout covers headers and body; bodies are streamed and cut off past `maxBytes`.
 *
 * Known gap: the name is resolved here and again by fetch() (DNS rebinding between the two lookups).
 * What an attacker gains is bounded: a response that must still pass the caller's type checks (JSON for
 * metadata, a raster image for the image proxy) and the size cap.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type Resolve = (host: string) => Promise<string[]>;

/** Private, loopback, link-local, CGNAT, multicast, documentation and other non-routable ranges. */
export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split(".").map(Number) as [number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v = ip.toLowerCase();
  return (
    // ::, ::1, IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): global unicast never starts with ::
    v.startsWith("::") ||
    v.startsWith("fe8") ||
    v.startsWith("fe9") ||
    v.startsWith("fea") ||
    v.startsWith("feb") ||
    v.startsWith("fec") ||
    v.startsWith("fed") ||
    v.startsWith("fee") ||
    v.startsWith("fef") ||
    v.startsWith("fc") ||
    v.startsWith("fd") ||
    v.startsWith("ff") ||
    v.startsWith("64:ff9b:") ||
    v.startsWith("100::") ||
    v.startsWith("2001:db8:") ||
    v.startsWith("2001:0db8:")
  );
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
  return host.includes(".") && !host.endsWith(".");
}

async function defaultResolve(host: string): Promise<string[]> {
  return (await lookup(host, { all: true })).map((r) => r.address);
}

/** Syntax check plus DNS resolution (rejects names that resolve to private addresses). */
export async function isSafeUrl(url: string, resolve: Resolve = defaultResolve): Promise<boolean> {
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

/** Why a fetch failed; `permanent` failures are not worth retrying soon (negative-cached longer). */
export class FetchFailure extends Error {
  constructor(
    readonly reason: string,
    readonly permanent: boolean,
    readonly status = 0,
  ) {
    super(reason);
    this.name = "FetchFailure";
  }
}

export interface BoundedFetchOptions {
  fetchFn?: typeof fetch;
  resolve?: Resolve;
  timeoutMs: number;
  maxBytes: number;
  accept: string;
  /** Aborts the request (a race was won elsewhere). */
  signal?: AbortSignal;
  /** Skip the DNS check of the first URL (an operator-configured gateway); redirects are still checked. */
  trusted?: boolean;
  /** Called with the response headers before the body is read; throw a FetchFailure to refuse it. */
  check?(res: Response): void;
  maxRedirects?: number;
}

export interface BoundedResponse {
  bytes: Uint8Array;
  contentType: string;
  /** The URL that answered (after redirects). */
  url: string;
}

/** GET with the SSRF guard on every hop, a timeout and a streamed size cap. */
export async function boundedFetch(url: string, o: BoundedFetchOptions): Promise<BoundedResponse> {
  const fetchFn = o.fetchFn ?? fetch;
  const timeout = AbortSignal.timeout(o.timeoutMs);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  let current = url;
  for (let hop = 0; ; hop++) {
    const checkDns = hop > 0 || !o.trusted;
    if (checkDns ? !(await isSafeUrl(current, o.resolve)) : !isSafeUrlSyntax(current)) throw new FetchFailure("unsafe_url", true);
    let res: Response;
    try {
      res = await fetchFn(current, { redirect: "manual", signal, headers: { accept: o.accept } });
    } catch {
      if (o.signal?.aborted) throw new FetchFailure("aborted", false);
      throw new FetchFailure(timeout.aborted ? "timeout" : "network", false);
    }
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      void res.body?.cancel().catch(() => {});
      const loc = res.headers.get("location");
      if (!loc) throw new FetchFailure("redirect_without_location", true, res.status);
      if (hop >= (o.maxRedirects ?? 3)) throw new FetchFailure("too_many_redirects", true, res.status);
      current = new URL(loc, current).toString();
      continue;
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      // 404 / 410 / 403 on a content URL rarely heal in seconds, but brand-new IPFS content can 404 at
      // first: everything but 4xx-that-is-not-404/408/429 counts as transient.
      const transient = res.status === 404 || res.status === 408 || res.status === 429 || res.status >= 500;
      throw new FetchFailure(`http_${res.status}`, !transient, res.status);
    }
    try {
      o.check?.(res);
    } catch (e) {
      void res.body?.cancel().catch(() => {});
      throw e;
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > o.maxBytes) {
      void res.body?.cancel().catch(() => {});
      throw new FetchFailure("too_large", true, res.status);
    }
    const bytes = await readCapped(res, o.maxBytes, timeout);
    return { bytes, contentType: (res.headers.get("content-type") ?? "").toLowerCase(), url: current };
  }
}

async function readCapped(res: Response, maxBytes: number, timeout: AbortSignal): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new FetchFailure("too_large", true, res.status);
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof FetchFailure) throw e;
    throw new FetchFailure(timeout.aborted ? "timeout" : "network", false);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
