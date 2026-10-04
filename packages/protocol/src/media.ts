/**
 * Token images go through the server's image proxy, so the browser only ever loads images from our own
 * origin (CSP `img-src 'self'`) and never contacts the hosts named in token metadata.
 *
 *   GET /api/img?mint=<mint>&v=<version>&s=<px>
 *
 *  - `mint`: the token. The server looks the image up itself (the token's `TokenSummary.image`), so the
 *    proxy only fetches images that some token's metadata names. It is not an open proxy, needs no
 *    signing secret, and a client can build the URL from `(mint, image)` alone: `imageProxyUrl` below.
 *  - `v`: `imageVersion(image)`, a cache buster that changes when the token's image URL changes. With the
 *    current version the response is cacheable for a year (immutable); with a stale or missing one it is
 *    the current image, cacheable for 5 minutes.
 *  - `s`: the box size in CSS px times the device pixel ratio (cap the ratio at 2: images are at most 2x
 *    their display size), rounded up to one of `IMAGE_PROXY_SIZES`. Missing: the largest size.
 *
 * Responses:
 *  - 200 `image/webp`, resized so the shorter side equals the size (never upscaled), so `object-fit: cover`
 *    fills a square box. When an image can't be re-encoded the validated original is sent instead
 *    (`image/png`, `image/jpeg`, `image/webp` or `image/gif`, at most 2 MB). Never SVG or anything else.
 *    Strong `ETag`, `If-None-Match` answers 304.
 *  - 404 `not_found`: the token is unknown, has no image, or the image could not be fetched or is not an
 *    allowed raster image. Show the monogram. Failures are retried server-side after a short back-off, so
 *    a later request (a remount, a retry with the same URL) can succeed for a brand-new token.
 *  - 400 `bad_request` (malformed mint or size), 429 `rate_limited` (per-IP limit).
 *
 * `TokenSummary.imageProxied` carries `imageProxyUrl(mint, image)` (no size): append `&s=<px>`, or call
 * `imageProxyUrl(mint, image, px)` directly.
 */

export const IMAGE_PROXY_PATH = "/api/img";

/** Output sizes (px, the shorter side). Requested sizes round up to the next one; larger ones clamp to the last. */
export const IMAGE_PROXY_SIZES = [32, 48, 64, 96, 128, 256] as const;

export type ImageProxySize = (typeof IMAGE_PROXY_SIZES)[number];

/** The proxy size bucket for a box of `px` device pixels (CSS px x min(devicePixelRatio, 2)). */
export function imageProxySize(px: number): ImageProxySize {
  const last = IMAGE_PROXY_SIZES[IMAGE_PROXY_SIZES.length - 1] as ImageProxySize;
  if (!Number.isFinite(px) || px <= 0) return last;
  for (const s of IMAGE_PROXY_SIZES) if (s >= px) return s;
  return last;
}

/** FNV-1a (32-bit) over the URL's UTF-16 code units, in base 36: the `v` cache buster. */
export function imageVersion(image: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < image.length; i++) {
    h ^= image.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Same-origin proxy URL for a token's image, or null when the token has no image. */
export function imageProxyUrl(mint: string, image: string | null, px?: number): string | null {
  if (!image) return null;
  const base = `${IMAGE_PROXY_PATH}?mint=${encodeURIComponent(mint)}&v=${imageVersion(image)}`;
  return px === undefined ? base : `${base}&s=${imageProxySize(px)}`;
}
