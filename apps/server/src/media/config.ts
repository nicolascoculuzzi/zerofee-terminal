/**
 * Image proxy settings (GET /api/img, packages/protocol media.ts). Defaults suit one server behind Caddy.
 *
 *   IMG_PROXY_ENABLED       on (default) / off: off answers 404 and the app shows monograms
 *   IMG_MAX_BYTES           largest upstream image accepted (default 8 MB; every output is re-encoded small)
 *   IMG_TIMEOUT_MS          per upstream attempt, headers and body, from when the request is sent (default 8 s)
 *   IMG_STAGGER_MS          delay before racing the next source of the same image (default 800 ms)
 *   IMG_QUEUE_PATIENCE_MS   race the next source anyway when one is still waiting for a host slot (default 2 s)
 *   IMG_MAX_PIXELS          decode limit, checked from the header before any pixel is allocated (default 4096 x 4096)
 *   IMG_PUMP_CDN            first (default) / fallback / off: pump.fun's own image CDN (images.pump.fun, already
 *                           resized, on Cloudflare) for pump coins, before or after the metadata image's sources
 *   IMG_PREFETCH            on (default): fetch and resize a new token's image as soon as its metadata
 *                           arrives, so the first viewer gets a cache hit; restored tokens are refetched in
 *                           the background at startup
 *   IMG_BACKGROUND_RPS      background (startup refetch) image jobs started per second (default 2)
 *   IMG_RETRY_MAX           attempts per image on transient failures before failing it for 30 min (default 8)
 *   IMG_RETRY_BASE_MS       first retry delay of an image, doubling per attempt up to 5 min (default 3 s)
 *   IMG_WAIT_MS             how long a request waits for an image being fetched before answering "pending" (default 6 s;
 *                           below Bun.serve's 10 s idle timeout)
 *   IMG_HOST_LIMITS         per-host pacing, "host=concurrency/rps/burst,..." ("*" = other hosts), on top of
 *                           the defaults in pacer.ts (pump.mypinata.cloud 5/5/10, gateway.pinata.cloud, ipfs.filebase.io and 4everland.io 2/1/2,
 *                           images.pump.fun and imagedelivery.net 12/25/40, others 3/3/6)
 *   IMG_WORKERS             worker processes for decoding / encoding / metadata parsing (default 2; 0 = inline)
 *   IMG_WORKER_NICE         nice(1) increment for the workers (default 10)
 *   IMG_WORK_QUEUE          waiting jobs past which prefetch / background work is dropped (default 64)
 *   IMG_CACHE_DIR           disk cache directory (default: img-cache next to DB_PATH; "off" disables it)
 *   IMG_CACHE_DISK_MB       disk cache budget, oldest files evicted first (default 1024)
 *   IMG_CACHE_MEMORY_MB     in-memory cache of resized images (default 64)
 *   IMG_RATE_RPS / _BURST   requests per IP (default 50/s, burst 300: a Pulse page loads many avatars at once)
 *   IMG_MISS_RPS / _BURST   upstream fetches (cache misses) started per IP (default 10/s, burst 100)
 *   IMG_MAX_UPSTREAM        image fetch jobs running at once, server-wide (default 32; more wait in the priority queue;
 *                           per-host limits are the pacer's)
 */
import { dirname, join } from "node:path";
import { type HostLimit, parseHostLimits } from "./pacer";

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
  patienceMs: number;
  backgroundRps: number;
  retryMax: number;
  retryBaseMs: number;
  waitMs: number;
  hostLimits: Record<string, HostLimit>;
  hostFallback: HostLimit;
  workers: number;
  workerNice: number;
  workQueue: number;
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

function num(env: Env, name: string, def: number, min: number, max: number): number {
  const raw = get(env, name);
  const v = raw === null ? def : Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${name} must be a number in [${min}, ${max}]`);
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
  const pumpCdn = get(env, "IMG_PUMP_CDN") ?? "first";
  if (pumpCdn !== "fallback" && pumpCdn !== "first" && pumpCdn !== "off") throw new Error("IMG_PUMP_CDN must be fallback, first or off");
  const dir = get(env, "IMG_CACHE_DIR");
  const hosts = parseHostLimits(get(env, "IMG_HOST_LIMITS"));
  return {
    enabled: flag(env, "IMG_PROXY_ENABLED", true),
    maxBytes: int(env, "IMG_MAX_BYTES", 8 * 1024 * 1024, 16 * 1024, 32 * 1024 * 1024),
    timeoutMs: int(env, "IMG_TIMEOUT_MS", 8_000, 500, 60_000),
    staggerMs: int(env, "IMG_STAGGER_MS", 800, 0, 10_000),
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
    maxUpstream: int(env, "IMG_MAX_UPSTREAM", 32, 1, 1_000),
    patienceMs: int(env, "IMG_QUEUE_PATIENCE_MS", 2_000, 0, 60_000),
    backgroundRps: num(env, "IMG_BACKGROUND_RPS", 2, 0.01, 1_000),
    retryMax: int(env, "IMG_RETRY_MAX", 8, 1, 100),
    retryBaseMs: int(env, "IMG_RETRY_BASE_MS", 3_000, 10, 600_000),
    waitMs: int(env, "IMG_WAIT_MS", 6_000, 0, 9_000),
    hostLimits: hosts.limits,
    hostFallback: hosts.fallback,
    workers: int(env, "IMG_WORKERS", 2, 0, 16),
    workerNice: int(env, "IMG_WORKER_NICE", 10, 0, 19),
    workQueue: int(env, "IMG_WORK_QUEUE", 64, 1, 100_000),
  };
}
