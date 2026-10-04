/**
 * Image and content URLs from token metadata: normalization, and where to fetch content-addressed data.
 *
 * IPFS in October 2026: the big public HTTP gateways are gone. Cloudflare's (cloudflare-ipfs.com,
 * cf-ipfs.com) closed in 2024; ipfs.io and dweb.link answer 429 "switching to a service worker gateway
 * only" since their retirement on 2026-09-21 (gatewaychanges.ipfs.io), and nftstorage.link redirects to
 * ipfs.io. Content is still served by the pinning services' own gateways: pump.fun pins launches through
 * Pinata and serves them from pump.mypinata.cloud; gateway.pinata.cloud serves any CID (slowly); other
 * launchers use Filebase dedicated gateways (<name>.myfilebase.com) or their own CDNs.
 *
 * So a CID is fetched from the URL's own host when that is a live gateway (usually the pinning service
 * that holds it), then from the configured gateways, in a staggered race. Retired gateways are never
 * contacted; their URLs only contribute the CID.
 */

/** CIDv0 (base58 multihash) or CIDv1 in base32. */
export const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/;
const ARWEAVE_ID_RE = /^[A-Za-z0-9_-]{43}$/;
/** Characters allowed in an IPFS / Arweave sub-path we pass on (no query, no fragment, no dot segments). */
const SUBPATH_RE = /^(\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+)*\/?$/;

/** Retired public gateways: their URLs name a CID, but they no longer serve it. */
export const DEAD_IPFS_GATEWAYS: ReadonlySet<string> = new Set([
  "ipfs.io",
  "gateway.ipfs.io",
  "dweb.link",
  "nftstorage.link",
  "cloudflare-ipfs.com",
  "cf-ipfs.com",
  "ipfs.infura.io",
  "infura-ipfs.io",
]);

/**
 * Default METADATA_GATEWAYS, in race order. pump.mypinata.cloud holds every pump.fun launch (metadata and
 * image) and answers in well under a second, 403 at once for anything else; gateway.pinata.cloud serves
 * any CID but takes seconds; Filebase's and 4EVERLAND's public gateways back them up. A gateway that keeps
 * failing is skipped for a while (HostHealth).
 */
export const DEFAULT_IPFS_GATEWAYS = [
  "https://pump.mypinata.cloud",
  "https://gateway.pinata.cloud",
  "https://ipfs.filebase.io",
  "https://4everland.io",
];

export const ARWEAVE_GATEWAY = "https://arweave.net";

const MAX_URL = 2_048;

/** C0 control characters or DEL anywhere in the string. */
export function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

function hostIsDead(host: string): boolean {
  const h = host.toLowerCase();
  for (const d of DEAD_IPFS_GATEWAYS) if (h === d || h.endsWith(`.${d}`)) return true;
  return false;
}

function cleanSubpath(p: string): string | null {
  if (!p || p === "/") return "";
  if (!SUBPATH_RE.test(p)) return null;
  if (p.split("/").some((seg) => seg === "." || seg === "..")) return null;
  return p.replace(/\/+$/, "");
}

/**
 * The IPFS CID (+ sub-path, without query) of any common form: ipfs://<cid>, ipfs://ipfs/<cid>, a bare CID,
 * /ipfs/<cid>, https://<any host>/ipfs/<cid>, https://<cid>.ipfs.<host>/. Null otherwise.
 */
export function extractCid(uri: string): { cid: string; path: string } | null {
  const s = uri.trim();
  const proto = /^ipfs:\/\/(?:ipfs\/)?([^/?#]+)([^?#]*)/i.exec(s);
  if (proto) return withCid(proto[1] as string, proto[2] as string);
  const bare = /^\/?(?:ipfs\/)?((?:Qm|b)[A-Za-z0-9]+)([^?#]*)/.exec(s);
  if (bare && !s.includes("://")) return withCid(bare[1] as string, bare[2] as string);
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const path = /^\/ipfs\/([^/?#]+)(.*)$/.exec(u.pathname);
    if (path) return withCid(path[1] as string, path[2] as string);
    const sub = /^([a-z0-9]+)\.ipfs\./i.exec(u.hostname);
    if (sub) return withCid((sub[1] as string).toLowerCase(), u.pathname);
  } catch {
    /* not a URL */
  }
  return null;
}

function withCid(cid: string, rawPath: string): { cid: string; path: string } | null {
  if (!CID_RE.test(cid)) return null;
  const path = cleanSubpath(rawPath);
  return path === null ? null : { cid, path };
}

/** The Arweave transaction id (+ sub-path) of ar://<id> or an arweave.net URL (any subdomain). */
export function extractArweave(uri: string): { id: string; path: string } | null {
  const s = uri.trim();
  const proto = /^ar:\/\/([^/?#]+)([^?#]*)/i.exec(s);
  if (proto) return withArweave(proto[1] as string, proto[2] as string);
  try {
    const u = new URL(s);
    const h = u.hostname.toLowerCase();
    if ((u.protocol === "https:" || u.protocol === "http:") && (h === "arweave.net" || h.endsWith(".arweave.net"))) {
      const m = /^\/([^/]+)(.*)$/.exec(u.pathname);
      if (m) return withArweave(m[1] as string, m[2] as string);
    }
  } catch {
    /* not a URL */
  }
  return null;
}

function withArweave(id: string, rawPath: string): { id: string; path: string } | null {
  if (!ARWEAVE_ID_RE.test(id)) return null;
  const path = cleanSubpath(rawPath);
  return path === null ? null : { id, path };
}

/** "https://host" without a trailing slash, lower-case host. */
function origin(gateway: string): string {
  return gateway.trim().replace(/\/+$/, "");
}

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

const BLOCKED_SCHEMES = /^(javascript|data|vbscript|file|blob|about|chrome|filesystem|ws|wss|ftp):/i;

/**
 * Normalizes an image URL from metadata to an http(s) URL, or null when unusable.
 *  - IPFS: kept on its own host when that host is a live gateway (path form, no query), otherwise
 *    rewritten to the first configured gateway.
 *  - Arweave (ar://, *.arweave.net): https://arweave.net/<id>.
 *  - Other http(s) URLs: kept (fragment dropped); protocol-relative and scheme-less host/path forms get https.
 *  - Anything else (data:, javascript:, file:, credentials in the URL, local hosts): null.
 */
export function normalizeImageUrl(raw: unknown, gateways: readonly string[]): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > MAX_URL || BLOCKED_SCHEMES.test(s) || hasControlChars(s)) return null;
  const cid = extractCid(s);
  if (cid) {
    const host = hostOf(s);
    if (host && !hostIsDead(host) && !/\.ipfs\./i.test(host)) return `https://${host}/ipfs/${cid.cid}${cid.path}`;
    if (host && !hostIsDead(host)) {
      // subdomain gateway (<cid>.ipfs.<host>): same host family, path form
      const base = host.slice(host.indexOf(".ipfs.") + ".ipfs.".length);
      if (!hostIsDead(base)) return `https://${base}/ipfs/${cid.cid}${cid.path}`;
    }
    const gw = gateways[0];
    return gw ? `${origin(gw)}/ipfs/${cid.cid}${cid.path}` : `ipfs://${cid.cid}${cid.path}`;
  }
  const ar = extractArweave(s);
  if (ar) return `${ARWEAVE_GATEWAY}/${ar.id}${ar.path}`;
  let candidate = s;
  if (candidate.startsWith("//")) candidate = `https:${candidate}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(candidate)) return null;
    candidate = `https://${candidate}`;
  }
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal"))
    return null;
  u.hash = "";
  return u.href;
}

/** Content identity of a normalized URL: the CID or Arweave id when there is one (same bytes, any host). */
export function contentKey(url: string): string {
  const c = extractCid(url);
  if (c) return `ipfs:${c.cid}${c.path}`;
  const a = extractArweave(url);
  if (a) return `ar:${a.id}${a.path}`;
  return url;
}

export interface FetchCandidate {
  url: string;
  /** Operator-configured gateway (skip the DNS check of the first hop). */
  trusted: boolean;
  /** Host, for health tracking. */
  host: string;
}

/**
 * Where to fetch a (normalized) URL: for IPFS, its own host when that is a live gateway, then the
 * configured gateways; for Arweave, arweave.net; otherwise the URL itself (untrusted).
 */
export function fetchCandidates(url: string, gateways: readonly string[]): FetchCandidate[] {
  const cid = extractCid(url);
  if (cid) {
    const out: FetchCandidate[] = [];
    const seen = new Set<string>();
    const own = hostOf(url);
    const configured = gateways.map(origin);
    const configuredHosts = new Set(configured.map((g) => hostOf(g) ?? g));
    if (own && !hostIsDead(own) && !configuredHosts.has(own)) {
      out.push({ url: `https://${own}/ipfs/${cid.cid}${cid.path}`, trusted: false, host: own });
      seen.add(own);
    }
    for (const g of configured) {
      const h = hostOf(g);
      if (!h || seen.has(h)) continue;
      seen.add(h);
      out.push({ url: `${g}/ipfs/${cid.cid}${cid.path}`, trusted: true, host: h });
    }
    return out;
  }
  const ar = extractArweave(url);
  if (ar) return [{ url: `${ARWEAVE_GATEWAY}/${ar.id}${ar.path}`, trusted: true, host: "arweave.net" }];
  const h = hostOf(url);
  return h ? [{ url, trusted: false, host: h }] : [];
}

/**
 * Per-host circuit breaker: a host failing at the transport level (timeouts, resets, 429, 5xx) three times
 * in a row is skipped for 30 s, doubling up to 10 min; one success resets it. Content-level answers (403,
 * 404, a non-image) say nothing about the host and don't count.
 */
export class HostHealth {
  private readonly hosts = new Map<string, { fails: number; until: number; ok: number; failed: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  available(host: string): boolean {
    const h = this.hosts.get(host);
    return !h || h.until <= this.now();
  }

  success(host: string): void {
    const h = this.entry(host);
    h.fails = 0;
    h.until = 0;
    h.ok++;
  }

  failure(host: string): void {
    const h = this.entry(host);
    h.fails++;
    h.failed++;
    if (h.fails >= 3) h.until = this.now() + Math.min(600_000, 30_000 * 2 ** (h.fails - 3));
  }

  /** Candidates in order, with tripped hosts moved to the back (still tried when nothing else is left). */
  order<T extends { host: string }>(candidates: T[]): T[] {
    const up = candidates.filter((c) => this.available(c.host));
    return up.length === candidates.length ? candidates : [...up, ...candidates.filter((c) => !this.available(c.host))];
  }

  snapshot(): { host: string; ok: number; failed: number; down: boolean }[] {
    return [...this.hosts].map(([host, h]) => ({ host, ok: h.ok, failed: h.failed, down: h.until > this.now() }));
  }

  private entry(host: string): { fails: number; until: number; ok: number; failed: number } {
    let h = this.hosts.get(host);
    if (!h) {
      if (this.hosts.size > 1_000) this.hosts.clear();
      h = { fails: 0, until: 0, ok: 0, failed: 0 };
      this.hosts.set(host, h);
    }
    return h;
  }
}

/**
 * Staggered race ("happy eyeballs"): starts the first candidate, then the next one after `staggerMs` or as
 * soon as every started attempt has failed. The first success wins and the others are aborted. Rejects
 * with every attempt's error when all fail.
 */
export function staggeredRace<C, T>(
  candidates: readonly C[],
  attempt: (c: C, signal: AbortSignal) => Promise<T>,
  staggerMs: number,
): Promise<T> {
  if (!candidates.length) return Promise.reject(new AggregateError([], "no candidates"));
  return new Promise<T>((resolve, reject) => {
    const controllers: AbortController[] = [];
    const errors: unknown[] = [];
    let next = 0;
    let running = 0;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      done = true;
      if (timer) clearTimeout(timer);
      for (const c of controllers) c.abort();
    };
    const launch = () => {
      if (done || next >= candidates.length) return;
      const c = candidates[next++] as C;
      const ctl = new AbortController();
      controllers.push(ctl);
      running++;
      if (timer) clearTimeout(timer);
      timer = next < candidates.length ? setTimeout(launch, staggerMs) : null;
      attempt(c, ctl.signal).then(
        (v) => {
          if (done) return;
          finish();
          resolve(v);
        },
        (e) => {
          running--;
          if (done) return;
          errors.push(e);
          if (next < candidates.length) {
            if (running === 0) launch();
          } else if (running === 0) {
            finish();
            reject(new AggregateError(errors, "all candidates failed"));
          }
        },
      );
    };
    launch();
  });
}
