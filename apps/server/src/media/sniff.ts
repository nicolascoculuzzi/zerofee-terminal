/**
 * Image type checks for the proxy. Only four raster formats are ever served: PNG, JPEG, WebP and GIF.
 * SVG (scriptable), HTML and anything else is refused, whatever the upstream Content-Type says; the type
 * we send is derived from the magic bytes, never copied from upstream.
 */

export type RasterFormat = "png" | "jpeg" | "webp" | "gif";

export const RASTER_MIME: Record<RasterFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** Upstream Content-Types we read the body of. Generic binary types are allowed: the magic bytes decide. */
const ACCEPTED_TYPES = new Set([
  "image/png",
  "image/apng",
  "image/jpeg",
  "image/jpg",
  "image/pjpeg",
  "image/webp",
  "image/gif",
  "application/octet-stream",
  "binary/octet-stream",
  "",
]);

/** "accept" | a refusal reason, from the upstream Content-Type header alone. */
export function checkContentType(header: string | null): "accept" | "svg" | "content_type" {
  const t = (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (t.includes("svg")) return "svg";
  return ACCEPTED_TYPES.has(t) ? "accept" : "content_type";
}

/** The raster format named by the leading bytes, or null. */
export function sniffImage(b: Uint8Array): RasterFormat | null {
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  )
    return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (
    b.length >= 6 &&
    b[0] === 0x47 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x38 &&
    (b[4] === 0x37 || b[4] === 0x39) &&
    b[5] === 0x61
  )
    return "gif";
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return "webp";
  return null;
}

/** Markup (SVG, HTML, XML) after an optional BOM and whitespace: refused with its own reason in metrics. */
export function looksLikeMarkup(b: Uint8Array): boolean {
  let i = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  while (i < b.length && i < 512 && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d)) i++;
  return b[i] === 0x3c; // "<"
}
