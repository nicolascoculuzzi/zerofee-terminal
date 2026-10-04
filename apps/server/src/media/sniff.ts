/**
 * Image type checks for the proxy. Only four raster formats are ever served: PNG, JPEG, WebP and GIF.
 * AVIF and HEIC are read too (ISO-BMFF `ftyp` brands), but only ever leave as a re-encoded WebP, and only
 * when Bun.Image can decode them on this host. SVG (scriptable), HTML and anything else is refused,
 * whatever the upstream Content-Type says; the type we send is derived from the magic bytes, never copied
 * from upstream.
 */

export type RasterFormat = "png" | "jpeg" | "webp" | "gif";

/** What we accept from upstream: the four web formats plus AVIF / HEIC (decoded, never passed through). */
export type SourceFormat = RasterFormat | "avif" | "heic";

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
  "image/avif",
  "image/heic",
  "image/heif",
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

const AVIF_BRANDS = new Set(["avif", "avis"]);
const HEIC_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"]);

/** AVIF or HEIC from the ISO-BMFF `ftyp` box (major brand, then compatible brands), or null. */
function sniffBmff(b: Uint8Array): "avif" | "heic" | null {
  if (b.length < 16 || b[4] !== 0x66 || b[5] !== 0x74 || b[6] !== 0x79 || b[7] !== 0x70) return null;
  const size = Math.min(b.length, ((b[0] as number) << 24) | ((b[1] as number) << 16) | ((b[2] as number) << 8) | (b[3] as number));
  const brands: string[] = [];
  for (let i = 8; i + 4 <= size && i < 64; i += 4) {
    if (i === 12) continue; // minor version
    brands.push(String.fromCharCode(b[i] as number, b[i + 1] as number, b[i + 2] as number, b[i + 3] as number));
  }
  if (brands.some((x) => AVIF_BRANDS.has(x))) return "avif";
  if (brands.some((x) => HEIC_BRANDS.has(x))) return "heic";
  return null;
}

/** Any format we read from upstream (web formats, AVIF, HEIC), or null. */
export function sniffSource(b: Uint8Array): SourceFormat | null {
  return sniffImage(b) ?? sniffBmff(b);
}

/**
 * A short label for bytes we refused as `bad_magic`, for logs and metrics: what upstreams actually send
 * instead of an image (an HTML error page, JSON, a BMP or ICO, an empty body ...).
 */
export function describeUnknown(b: Uint8Array): string {
  if (b.length === 0) return "empty";
  if (looksLikeMarkup(b)) return "markup";
  const head = new TextDecoder("latin1").decode(b.subarray(0, 16));
  if (/^\s*[{[]/.test(head)) return "json";
  if (head.startsWith("BM")) return "bmp";
  if (head.startsWith("II*\0") || head.startsWith("MM\0*")) return "tiff";
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return "ico";
  if (b.length >= 12 && head.slice(4, 8) === "ftyp") return `bmff:${head.slice(8, 12).replace(/[^\x20-\x7e]/g, "?")}`;
  if (head.startsWith("RIFF")) return `riff:${new TextDecoder("latin1").decode(b.subarray(8, 12)).replace(/[^\x20-\x7e]/g, "?")}`;
  if (head.startsWith("%PDF")) return "pdf";
  if (b[0] === 0x1f && b[1] === 0x8b) return "gzip";
  const printable = (c: number) => c === 0x09 || c === 0x0a || c === 0x0d || (c >= 0x20 && c <= 0x7e);
  if (b.length >= 8 && Array.from(b.subarray(0, 16)).every(printable)) return "text";
  return "unknown";
}

/** First bytes in hex (log samples of refused bodies). */
export function hexHead(b: Uint8Array, n = 16): string {
  return Array.from(b.subarray(0, n), (x) => x.toString(16).padStart(2, "0")).join("");
}
