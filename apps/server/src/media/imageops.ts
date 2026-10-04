/**
 * The CPU-heavy steps of the image pipeline, run in the worker processes (media/pool.ts, media/worker.ts) or
 * inline when IMG_WORKERS=0: decoding and re-encoding with Bun.Image, and parsing metadata JSON.
 *
 * Every upstream image becomes a "master" once: decoded (refused past the pixel limit, checked from the
 * header before any pixel is allocated), scaled so its shorter side is at most the largest avatar size and
 * encoded to WebP. Requested sizes are rendered from the master, so an 8 MB original costs one decode and
 * the caches hold a few KB per image.
 */
import { type ParsedMetadata, parseMetadataJson } from "./extract";
import { type SourceFormat, sniffImage } from "./sniff";

/** Originals that can't be decoded are served as they are only when small and in one of the four web formats. */
export const PASSTHROUGH_MAX_BYTES = 512 * 1024;
const WEB_FORMATS: ReadonlySet<SourceFormat> = new Set(["png", "jpeg", "webp", "gif"]);

export type MasterResult =
  | { ok: true; bytes: Uint8Array; width: number; height: number; passthrough: boolean }
  | { ok: false; reason: string; detail?: string };

function errCode(e: unknown): string {
  return (e as { code?: string })?.code ?? (e instanceof Error ? e.message : String(e));
}

/** Decodes `bytes`, scales the shorter side down to `size` (never up) and encodes WebP at quality 90. */
export async function makeMaster(bytes: Uint8Array, format: SourceFormat, maxPixels: number, size: number): Promise<MasterResult> {
  const passthrough = (detail: string): MasterResult =>
    WEB_FORMATS.has(format) && bytes.byteLength <= PASSTHROUGH_MAX_BYTES
      ? { ok: true, bytes, width: 0, height: 0, passthrough: true }
      : { ok: false, reason: WEB_FORMATS.has(format) ? "undecodable" : `undecodable_${format}`, detail };
  if (typeof Bun.Image !== "function") return passthrough("no Bun.Image");
  try {
    const opts = { maxPixels };
    const meta = await new Bun.Image(bytes, opts).metadata();
    if (!meta.width || !meta.height) return passthrough("no dimensions");
    const img = new Bun.Image(bytes, opts);
    const shorter = Math.min(meta.width, meta.height);
    let w = meta.width;
    let h = meta.height;
    if (shorter > size) {
      const k = size / shorter;
      w = Math.max(1, Math.round(meta.width * k));
      h = Math.max(1, Math.round(meta.height * k));
      img.resize(w, h, { fit: "fill", filter: "lanczos3" });
    }
    const out = await img.webp({ quality: 90 }).bytes();
    if (sniffImage(out) !== "webp") return passthrough("encoder output");
    return { ok: true, bytes: out, width: w, height: h, passthrough: false };
  } catch (e) {
    const code = errCode(e);
    if (code === "ERR_IMAGE_TOO_MANY_PIXELS") return { ok: false, reason: "too_many_pixels" };
    return passthrough(code);
  }
}

/** WebP with the shorter side at `size` (never upscaled), from a master. */
export async function renderSize(master: Uint8Array, size: number): Promise<Uint8Array> {
  const meta = await new Bun.Image(master).metadata();
  const img = new Bun.Image(master);
  const shorter = Math.min(meta.width, meta.height);
  if (shorter > size) {
    const k = size / shorter;
    img.resize(Math.max(1, Math.round(meta.width * k)), Math.max(1, Math.round(meta.height * k)), { fit: "fill", filter: "lanczos3" });
  }
  return img.webp({ quality: 82 }).bytes();
}

/** Metadata JSON text to the fields we show; null when it isn't JSON. */
export function parseMetadataText(text: string, gateways: readonly string[]): ParsedMetadata | null {
  try {
    return parseMetadataJson(JSON.parse(text), gateways);
  } catch {
    return null;
  }
}
