/**
 * Token image URLs for <img src>: always our own image proxy (GET /api/img, contract in
 * packages/protocol/src/media.ts), so the CSP stays `img-src 'self'` and the browser never contacts the
 * hosts named in token metadata.
 *
 * Mirrors `imageProxyUrl` / `imageVersion` / `IMAGE_PROXY_SIZES` from @zerofee/protocol (this app does not
 * depend on that package yet); tokenImage.test.ts pins the same vectors as the server's tests.
 */

const PROXY_PATH = "/api/img";
const SIZES = [32, 48, 64, 96, 128, 256] as const;

/** Size bucket for a box of `cssPx`, at most 2x the display size (DESIGN.md 8: images). */
export function proxySize(cssPx: number, dpr = 1): number {
  const px = cssPx * Math.min(2, Math.max(1, dpr || 1));
  for (const s of SIZES) if (s >= px) return s;
  return SIZES[SIZES.length - 1] as number;
}

/** FNV-1a (32-bit) over the URL's UTF-16 code units, base 36: the proxy's `v` cache buster. */
export function imageVersion(image: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < image.length; i++) {
    h ^= image.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * The <img src> for a token's image at a display size, or null (draw the monogram).
 *  - an already proxied URL (TokenSummary.imageProxied, "/api/img?...") gets its size set;
 *  - a metadata URL (TokenSummary.image, http(s)) becomes the proxy URL for that mint;
 *  - anything else (data:, blob:, javascript:, other origins' paths) is never loaded.
 */
export function tokenImageSrc(mint: string, image: string | null | undefined, cssPx: number, dpr = 1): string | null {
  if (!image || !mint) return null;
  const s = proxySize(cssPx, dpr);
  if (image.startsWith(`${PROXY_PATH}?`)) {
    const u = new URL(image, "http://self.invalid");
    if (u.pathname !== PROXY_PATH || u.searchParams.get("mint") !== mint) return null;
    u.searchParams.set("s", String(s));
    return `${PROXY_PATH}?${u.searchParams.toString()}`;
  }
  if (!/^https?:\/\//i.test(image)) return null;
  return `${PROXY_PATH}?mint=${encodeURIComponent(mint)}&v=${imageVersion(image)}&s=${s}`;
}

/**
 * What the proxy says about an image that did not load (an <img> error carries no status, so the avatar
 * asks with a HEAD of the same URL): `x-zf-image: pending` (being fetched, look again after Retry-After),
 * `failed` / `none` (keep the monogram, don't ask again), `ok` (it is there now).
 */
export type ImageProbe = { state: "ok" | "pending" | "failed"; retryAfterMs: number };

export async function probeImage(src: string, fetchFn: typeof fetch = fetch): Promise<ImageProbe> {
  try {
    const r = await fetchFn(src, { method: "HEAD", cache: "no-store" });
    if (r.ok) return { state: "ok", retryAfterMs: 0 };
    const retry = Number(r.headers.get("retry-after"));
    const retryAfterMs = Number.isFinite(retry) && retry > 0 ? retry * 1000 : 0;
    const state = r.headers.get("x-zf-image");
    // 429 (our own rate limit) and 503 (busy) are about us, not the image: try again later
    if (state === "pending" || r.status === 429 || r.status === 503) return { state: "pending", retryAfterMs };
    return { state: "failed", retryAfterMs: 0 };
  } catch {
    return { state: "pending", retryAfterMs: 0 }; // offline for a moment
  }
}

/** Back-off between looks at a pending image: 3 s doubling to 2 min, never sooner than the server asked. */
export const IMAGE_RETRY_LIMIT = 12;
export function imageRetryDelay(attempt: number, retryAfterMs: number): number | null {
  if (attempt >= IMAGE_RETRY_LIMIT) return null;
  return Math.max(retryAfterMs, Math.min(120_000, 3_000 * 2 ** attempt));
}
