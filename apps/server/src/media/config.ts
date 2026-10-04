/**
 * Image proxy settings (GET /api/img, packages/protocol media.ts). Defaults suit one server behind Caddy.
 *
 *   IMG_PROXY_ENABLED       on (default) / off: off answers 404 and the app shows monograms
 *   IMG_MAX_BYTES           largest upstream image accepted (default 2 MB)
 *   IMG_TIMEOUT_MS          per upstream attempt, headers and body (default 8 s)
 *   IMG_STAGGER_MS          delay before racing the next source of the same image (default 400 ms)
 *   IMG_MAX_PIXELS          decode limit, checked from the header before any pixel is allocated (default 4096 x 4096)
 *   IMG_PUMP_CDN            fallback (default) / first / off: pump.fun's own image CDN (images.pump.fun) for
 *                           pump coins, after or before the metadata image's own sources
 *   IMG_PREFETCH            on (default): fetch and resize a new token's image as soon as its metadata
 *                           arrives, so the first viewer gets a cache hit
 *   IMG_CACHE_DIR           disk cache directory (default: img-cache next to DB_PATH; "off" disables it)
 *   IMG_CACHE_DISK_MB       disk cache budget, oldest files evicted first (default 1024)
 *   IMG_CACHE_MEMORY_MB     in-memory cache of resized images (default 64)
 *   IMG_RATE_RPS / _BURST   requests per IP (default 50/s, burst 300: a Pulse page loads many avatars at once)
 *   IMG_MISS_RPS / _BURST   upstream fetches (cache misses) started per IP (default 10/s, burst 100)
 *   IMG_MAX_UPSTREAM        concurrent upstream fetches, server-wide (default 16; more wait in a bounded queue)
 */
import { dirname, join } from "node:path";

export interface MediaConfig {
  enabled: boolean;
  maxBytes: number;
  timeoutMs: number;
  staggerMs: number;
  maxPixels: number;
  pumpCdn: "fallback" | "first" | "off";
  prefetch: boolean;
  cacheDir: string | null;
  diskBytes: number;
  memoryBytes: number;
  ratePerSec: number;
  rateBurst: number;
  missPerSec: number;
  missBurst: number;
  maxUpstream: number;
}

type Env = Record<string, string | undefined>;

const get = (env: Env, name: string): string | null => {
  const v = env[name]?.trim();
  return v ? v : null;
};

function int(env: Env, name: string, def: number, min: number, max: number): number {
  const raw = get(env, name);
  const v = raw === null ? def : Number(raw);
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  return v;
}

function flag(env: Env, name: string, def: boolean): boolean {
  const raw = get(env, name)?.toLowerCase();
  if (raw === undefined) return def;
  if (["1", "true", "on", "yes"].includes(raw)) return true;
  if (["0", "false", "off", "no"].includes(raw)) return false;
  throw new Error(`${name} must be on or off`);
}

export function loadMediaConfig(env: Env, dbPath: string): MediaConfig {
  const pumpCdn = get(env, "IMG_PUMP_CDN") ?? "fallback";
  if (pumpCdn !== "fallback" && pumpCdn !== "first" && pumpCdn !== "off") throw new Error("IMG_PUMP_CDN must be fallback, first or off");
  const dir = get(env, "IMG_CACHE_DIR");
  return {
    enabled: flag(env, "IMG_PROXY_ENABLED", true),
    maxBytes: int(env, "IMG_MAX_BYTES", 2 * 1024 * 1024, 16 * 1024, 16 * 1024 * 1024),
    timeoutMs: int(env, "IMG_TIMEOUT_MS", 8_000, 500, 60_000),
    staggerMs: int(env, "IMG_STAGGER_MS", 400, 0, 10_000),
    maxPixels: int(env, "IMG_MAX_PIXELS", 4096 * 4096, 64 * 64, 16_384 * 16_384),
    pumpCdn,
    prefetch: flag(env, "IMG_PREFETCH", true),
    cacheDir: dir === "off" ? null : (dir ?? (dbPath === ":memory:" ? null : join(dirname(dbPath), "img-cache"))),
    diskBytes: int(env, "IMG_CACHE_DISK_MB", 1_024, 1, 1_000_000) * 1024 * 1024,
    memoryBytes: int(env, "IMG_CACHE_MEMORY_MB", 64, 1, 100_000) * 1024 * 1024,
    ratePerSec: int(env, "IMG_RATE_RPS", 50, 1, 100_000),
    rateBurst: int(env, "IMG_RATE_BURST", 300, 1, 1_000_000),
    missPerSec: int(env, "IMG_MISS_RPS", 10, 1, 100_000),
    missBurst: int(env, "IMG_MISS_BURST", 100, 1, 1_000_000),
    maxUpstream: int(env, "IMG_MAX_UPSTREAM", 16, 1, 1_000),
  };
}
