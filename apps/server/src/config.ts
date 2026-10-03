/**
 * Server configuration from the environment (Bun auto-loads `.env` from the working directory).
 * Every value has a safe default: binds to 127.0.0.1, DRY_RUN=true, public RPC, no secrets required.
 * Never log secret values; use redactUrl() for URLs that may embed keys.
 */
import { DEFAULT_RPC_URL, HELIUS_SENDER_ENDPOINTS, type HeliusSenderRegion, JITO_BLOCK_ENGINES, type JitoRegion } from "@zerofee/core";

export type IngestSourceKind = "rpc" | "yellowstone";
export type RpcCommitment = "processed" | "confirmed";

export interface ServerConfig {
  host: string;
  port: number;
  /** Trust X-Forwarded-For for client IPs (only behind a proxy you control). */
  trustProxy: boolean;

  source: IngestSourceKind;
  rpcUrl: string;
  rpcWsUrl: string;
  rpcLogsCommitment: RpcCommitment;
  rpcLogsPrograms: ("pump" | "pumpswap")[];
  /** Bounded queue between the WebSocket and the decoder; overflow drops the oldest. */
  rpcLogsQueueMax: number;
  blockhashPollMs: number;

  yellowstoneEndpoint: string | null;
  yellowstoneXToken: string | null;
  yellowstoneCommitment: RpcCommitment;

  pumpPortalEnabled: boolean;
  pumpPortalApiKey: string | null;
  pumpPortalUrl: string;

  binanceWsUrls: string[];
  solUsdStaleMs: number;

  dbPath: string;
  tradesRetentionHours: number;
  flushIntervalMs: number;
  tokenPersistIntervalMs: number;
  replayHours: number;

  pulse: {
    finalStretchBps: number;
    migratedWindowMs: number;
    newMaxAgeMs: number;
    finalMaxIdleMs: number;
    listLimit: number;
  };
  metrics: {
    sniperSlots: number;
    bundleMinBuyers: number;
    proTraderWallets: string[];
  };
  flush: {
    pulseMs: number;
    tapeMs: number;
    candleMs: number;
    chainMs: number;
  };
  tokenIdleEvictMs: number;
  metadataGateways: string[];
  metadataTimeoutMs: number;

  dryRun: boolean;
  allowAnonymousTx: boolean;
  landing: {
    heliusRegion: HeliusSenderRegion;
    jitoRegion: JitoRegion;
    heliusApiKey?: string;
    jitoUuid?: string;
  };
  rateLimit: { restPerSec: number; restBurst: number; txPerSec: number; wsMsgPerSec: number; wsConnPerIp: number };
  wsMaxSubscriptions: number;
  wsCompression: boolean;
  logLevel: "debug" | "info" | "warn" | "error";
  /** GET /metrics access and alarm thresholds (src/metrics.ts). */
  monitoring: {
    /** Bearer token every /metrics caller must send; null = loopback, unproxied requests only. */
    metricsToken: string | null;
    /** zerofee_feed_stalled turns 1 after this long without an ingested transaction. */
    feedStallMs: number;
    /** Directory holding the edge kill-switch flag files (HALT_TX, MAINTENANCE); null = not reported. */
    killSwitchDir: string | null;
  };
}

type Env = Record<string, string | undefined>;

function str(env: Env, name: string, def: string): string {
  const v = env[name]?.trim();
  return v ? v : def;
}

function optional(env: Env, name: string): string | null {
  const v = env[name]?.trim();
  return v ? v : null;
}

function bool(env: Env, name: string, def: boolean): boolean {
  const v = env[name]?.trim();
  if (!v) return def;
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  if (/^(0|false|no|off)$/i.test(v)) return false;
  throw new Error(`${name} must be true/false`);
}

function int(env: Env, name: string, def: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  const v = raw ? Number(raw) : def;
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  return v;
}

function oneOf<T extends string>(env: Env, name: string, def: T, allowed: readonly T[]): T {
  const v = (env[name]?.trim() || def) as T;
  if (!allowed.includes(v)) throw new Error(`${name} must be one of ${allowed.join(", ")}`);
  return v;
}

function list(env: Env, name: string, def: string[]): string[] {
  const v = env[name]?.trim();
  if (!v) return def;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Maestro's documented fee wallet (token_analytics notes); extend via PRO_TRADER_WALLETS. */
const DEFAULT_PRO_TRADER_WALLETS = ["MaestroUL88UBnZr3wfoN7hqmNWFi3ZYCGqZoJJHE36"];

export function loadConfig(env: Env = process.env): ServerConfig {
  const rpcUrl = str(env, "RPC_URL", DEFAULT_RPC_URL);
  const programs = list(env, "RPC_LOGS_PROGRAMS", ["pump", "pumpswap"]);
  for (const p of programs) if (p !== "pump" && p !== "pumpswap") throw new Error("RPC_LOGS_PROGRAMS entries must be pump or pumpswap");
  const cfg: ServerConfig = {
    host: str(env, "SERVER_HOST", "127.0.0.1"),
    port: int(env, "SERVER_PORT", 8787, 0, 65535),
    trustProxy: bool(env, "TRUST_PROXY", false),
    source: oneOf<IngestSourceKind>(env, "INGEST_SOURCE", "rpc", ["rpc", "yellowstone"]),
    rpcUrl,
    rpcWsUrl: str(env, "RPC_WS_URL", rpcUrl.replace(/^http/, "ws")),
    rpcLogsCommitment: oneOf<RpcCommitment>(env, "RPC_LOGS_COMMITMENT", "processed", ["processed", "confirmed"]),
    rpcLogsPrograms: programs as ("pump" | "pumpswap")[],
    rpcLogsQueueMax: int(env, "RPC_LOGS_QUEUE_MAX", 50_000, 100, 10_000_000),
    blockhashPollMs: int(env, "BLOCKHASH_POLL_MS", 2_000, 250, 60_000),
    yellowstoneEndpoint: optional(env, "YELLOWSTONE_ENDPOINT"),
    yellowstoneXToken: optional(env, "YELLOWSTONE_X_TOKEN"),
    yellowstoneCommitment: oneOf<RpcCommitment>(env, "YELLOWSTONE_COMMITMENT", "processed", ["processed", "confirmed"]),
    pumpPortalEnabled: bool(env, "PUMPPORTAL_ENABLED", false),
    pumpPortalApiKey: optional(env, "PUMPPORTAL_API_KEY"),
    pumpPortalUrl: str(env, "PUMPPORTAL_WS_URL", "wss://pumpportal.fun/api/data"),
    binanceWsUrls: list(env, "BINANCE_WS_URLS", [
      "wss://stream.binance.com:9443/ws/solusdt@aggTrade",
      "wss://data-stream.binance.vision/ws/solusdt@aggTrade",
    ]),
    solUsdStaleMs: int(env, "SOL_USD_STALE_MS", 30_000, 1_000, 3_600_000),
    dbPath: str(env, "DB_PATH", "data/market.db"),
    tradesRetentionHours: int(env, "TRADES_RETENTION_HOURS", 72, 1, 24 * 365),
    flushIntervalMs: int(env, "DB_FLUSH_MS", 250, 10, 60_000),
    tokenPersistIntervalMs: int(env, "TOKEN_PERSIST_MS", 10_000, 0, 3_600_000),
    replayHours: int(env, "REPLAY_HOURS", 6, 0, 72),
    pulse: {
      finalStretchBps: int(env, "PULSE_FINAL_STRETCH_BPS", 6_000, 1, 10_000),
      migratedWindowMs: int(env, "PULSE_MIGRATED_WINDOW_HOURS", 24, 1, 24 * 30) * 3_600_000,
      newMaxAgeMs: int(env, "PULSE_NEW_MAX_AGE_MIN", 24 * 60, 1, 24 * 60 * 30) * 60_000,
      finalMaxIdleMs: int(env, "PULSE_FINAL_MAX_IDLE_MIN", 60, 1, 24 * 60 * 30) * 60_000,
      listLimit: int(env, "PULSE_LIST_LIMIT", 100, 1, 1_000),
    },
    metrics: {
      sniperSlots: int(env, "SNIPER_SLOTS", 3, 0, 100),
      bundleMinBuyers: int(env, "BUNDLE_MIN_BUYERS", 4, 2, 100),
      proTraderWallets: list(env, "PRO_TRADER_WALLETS", DEFAULT_PRO_TRADER_WALLETS),
    },
    flush: {
      pulseMs: int(env, "PULSE_FLUSH_MS", 200, 50, 5_000),
      tapeMs: int(env, "TAPE_FLUSH_MS", 75, 10, 5_000),
      candleMs: int(env, "CANDLE_FLUSH_MS", 100, 10, 5_000),
      chainMs: int(env, "CHAIN_FLUSH_MS", 250, 10, 5_000),
    },
    tokenIdleEvictMs: int(env, "TOKEN_IDLE_EVICT_MIN", 120, 1, 24 * 60 * 30) * 60_000,
    metadataGateways: list(env, "METADATA_GATEWAYS", ["https://ipfs.io", "https://dweb.link"]),
    metadataTimeoutMs: int(env, "METADATA_TIMEOUT_MS", 3_000, 100, 60_000),
    // DRY_RUN is true unless explicitly set to false: POST /api/tx simulates instead of sending.
    dryRun: bool(env, "DRY_RUN", true),
    allowAnonymousTx: bool(env, "ALLOW_ANONYMOUS_TX", false),
    landing: {
      heliusRegion: oneOf(env, "SENDER_REGION", "fra", Object.keys(HELIUS_SENDER_ENDPOINTS) as HeliusSenderRegion[]),
      jitoRegion: oneOf(env, "JITO_REGION", "frankfurt", Object.keys(JITO_BLOCK_ENGINES) as JitoRegion[]),
      heliusApiKey: optional(env, "HELIUS_SENDER_API_KEY") ?? undefined,
      jitoUuid: optional(env, "JITO_UUID") ?? undefined,
    },
    rateLimit: {
      restPerSec: int(env, "RATE_LIMIT_REST_RPS", 20, 1, 100_000),
      restBurst: int(env, "RATE_LIMIT_REST_BURST", 60, 1, 100_000),
      txPerSec: int(env, "RATE_LIMIT_TX_RPS", 5, 1, 10_000),
      wsMsgPerSec: int(env, "RATE_LIMIT_WS_MSG_RPS", 30, 1, 100_000),
      wsConnPerIp: int(env, "WS_MAX_CONN_PER_IP", 20, 1, 100_000),
    },
    wsMaxSubscriptions: int(env, "WS_MAX_SUBSCRIPTIONS", 64, 1, 10_000),
    wsCompression: bool(env, "WS_COMPRESSION", false),
    logLevel: oneOf(env, "LOG_LEVEL", "info", ["debug", "info", "warn", "error"]),
    monitoring: {
      metricsToken: optional(env, "METRICS_TOKEN"),
      feedStallMs: int(env, "METRICS_FEED_STALL_SEC", 30, 5, 3_600) * 1_000,
      killSwitchDir: optional(env, "KILL_SWITCH_DIR"),
    },
  };
  if (cfg.source === "yellowstone" && !cfg.yellowstoneEndpoint) throw new Error("INGEST_SOURCE=yellowstone requires YELLOWSTONE_ENDPOINT");
  if (cfg.monitoring.metricsToken !== null && cfg.monitoring.metricsToken.length < 16)
    throw new Error("METRICS_TOKEN must be at least 16 characters (openssl rand -hex 32)");
  return cfg;
}

/** Redacts key-like query params and userinfo before printing a URL. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = "***";
      u.password = "";
    }
    for (const k of [...u.searchParams.keys()]) if (/key|token|auth|uuid|secret/i.test(k)) u.searchParams.set(k, "***");
    return u.toString();
  } catch {
    return "<invalid url>";
  }
}
