/**
 * Server configuration from the environment (Bun auto-loads `.env` from the working directory).
 * Every value has a safe default: binds to 127.0.0.1, DRY_RUN=true, public RPC, no secrets required.
 * Never log secret values; use redactUrl() for URLs that may embed keys.
 */
import { DEFAULT_RPC_URL, HELIUS_SENDER_ENDPOINTS, type HeliusSenderRegion, JITO_BLOCK_ENGINES, type JitoRegion } from "@zerofee/core";
import { type EnrichConfig, loadEnrichConfig } from "./enrich/config";
import { proTraderSet } from "./market/feeWallets";
import { loadOrdersConfig, type OrdersConfig } from "./orders/config";

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
    /** Tight size band of the N-buyers-in-one-slot bundle rule (bps). */
    bundleSizeBandBps: number;
    /** insidersPct needs Helius funded-by: on when HELIUS_API_KEY is set. */
    insiders: boolean;
    proTraderWallets: string[];
    proTraderTokenAccounts: string[];
  };
  enrich: EnrichConfig;
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
  rateLimit: {
    restPerSec: number;
    restBurst: number;
    txPerSec: number;
    wsMsgPerSec: number;
    wsConnPerIp: number;
    /** Nonce + sign-in requests per IP per minute. */
    authPerMin: number;
    /** Authenticated API requests per user. */
    userPerSec: number;
    userBurst: number;
    wsConnPerUser: number;
    /** Admin calls per IP per minute (failed attempts count too: bounds audit-log flooding). */
    adminPerMin: number;
  };
  wsMaxSubscriptions: number;
  wsCompression: boolean;
  logLevel: "debug" | "info" | "warn" | "error";

  /** User state: Postgres via Bun.sql when databaseUrl is set, else PGlite (development). */
  userDb: { databaseUrl: string | null; pgliteDir: string };
  auth: {
    /** Origin users load the web app from (scheme://host[:port]); the SIWS message binds its host. */
    publicOrigin: string;
    /** Origins accepted on cookie-authenticated mutations and WebSocket upgrades (includes publicOrigin). */
    allowedOrigins: string[];
    /** SIWS `domain` (host[:port]); defaults to publicOrigin's host. */
    siwsDomain: string;
    cookieName: string;
    sessionTtlMs: number;
    maxSessionsPerUser: number;
  };
  /** ADMIN_TOKEN: one token, or `name:token,name:token` for named operators. Null disables /api/admin. */
  adminToken: string | null;
  notifications: {
    /** 32-byte key (base64 or hex) encrypting Discord webhook URLs at rest. Null disables Discord channels. */
    channelKey: string | null;
    vapidPublicKey: string | null;
    vapidPrivateKey: string | null;
    vapidSubject: string;
    telegramBotToken: string | null;
    telegramBotUsername: string | null;
    /** Set: Telegram updates arrive by webhook (POST /api/telegram/webhook); unset: long polling. */
    telegramWebhookSecret: string | null;
    alertSweepMs: number;
    deliveryRetentionDays: number;
  };
  /** GET /metrics access and alarm thresholds (src/metrics.ts). */
  monitoring: {
    /** Bearer token every /metrics caller must send; null = loopback, unproxied requests only. */
    metricsToken: string | null;
    /** zerofee_feed_stalled turns 1 after this long without an ingested transaction. */
    feedStallMs: number;
    /** Directory holding the edge kill-switch flag files (HALT_TX, MAINTENANCE); null = not reported. */
    killSwitchDir: string | null;
  };
  /** Wallet tracker matching and copy trading (src/trackers). */
  trackers: {
    /** Watcher entries (user x address) the in-memory index may hold in total. */
    maxEntries: number;
    /** Live feed flush cadence (ms). */
    flushMs: number;
    /** Matches kept for `tracked` snapshots; per mint for `tracked:<mint>`; mints with marker history. */
    feedRing: number;
    mintRing: number;
    mintRings: number;
    maxRowsPerFrame: number;
    /** Per-(wallet, mint) positions of watched wallets (first-buy detection). */
    positions: number;
    skipRetentionDays: number;
    copy: {
      /** SPEC "Limits": copy volume per leader per slot across all followers (SOL). */
      leaderSlotCapSol: number;
      buyTtlMs: number;
      sellTtlMs: number;
      minSol: number;
      skipLogPerHour: number;
      exitCooldownMs: number;
    };
  };
  /** Armed-orders engine (orders/config.ts). */
  orders: OrdersConfig;
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

function float(env: Env, name: string, def: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  const v = raw ? Number(raw) : def;
  if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${name} must be a number in [${min}, ${max}]`);
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

/** Session cookie. `__Host-` makes browsers require Secure, Path=/ and no Domain attribute. */
export const SESSION_COOKIE_NAME = "__Host-zf_session";

/** Validates and normalizes an http(s) origin (scheme://host[:port], nothing else). */
export function normalizeOrigin(name: string, value: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`${name} must be an origin like https://zerofee.example (got ${JSON.stringify(value)})`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`${name} must use https (or http on loopback)`);
  if (u.pathname !== "/" || u.search || u.hash || u.username || u.password) {
    throw new Error(`${name} must be a bare origin: no path, query, fragment or credentials`);
  }
  return u.origin;
}

/** Loopback hosts count as secure contexts in browsers, so Secure cookies work over plain http there. */
export function isLoopbackOrigin(origin: string): boolean {
  const host = new URL(origin).hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host.endsWith(".localhost");
}

export interface AdminTokenEntry {
  /** Operator name recorded in the audit log ("admin" for a single unnamed token). */
  name: string;
  token: string;
  /** Unnamed tokens are logged as admin:<first 12 hex of SHA-256(token)>. */
  named: boolean;
}

/** ADMIN_TOKEN = `<token>` or `name:<token>,name:<token>`. Tokens need at least 32 characters. */
export function parseAdminTokens(spec: string): AdminTokenEntry[] {
  const parts = spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const entries = parts.map((p): AdminTokenEntry => {
    const i = p.indexOf(":");
    if (i < 0) return { name: "admin", token: p, named: false };
    const name = p.slice(0, i);
    if (!/^[A-Za-z0-9_.-]{1,32}$/.test(name)) throw new Error("ADMIN_TOKEN names must be 1-32 of A-Z a-z 0-9 _ . -");
    return { name, token: p.slice(i + 1), named: true };
  });
  if (!entries.length) throw new Error("ADMIN_TOKEN is empty");
  if (entries.length > 1 && entries.some((e) => !e.named)) throw new Error("ADMIN_TOKEN with several tokens needs name:token pairs");
  if (new Set(entries.map((e) => e.name)).size !== entries.length) throw new Error("ADMIN_TOKEN names must be unique");
  for (const e of entries) {
    if (e.token.length < 32 || /\s/.test(e.token)) throw new Error("ADMIN_TOKEN tokens must be at least 32 characters without spaces");
  }
  return entries;
}

/** 32 raw bytes from base64, base64url or hex text (CHANNEL_ENCRYPTION_KEY). */
export function decodeKey32(name: string, text: string): Uint8Array {
  const t = text.trim();
  let bytes: Uint8Array | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(t)) bytes = new Uint8Array(Buffer.from(t, "hex"));
  else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(t)) bytes = new Uint8Array(Buffer.from(t.replaceAll("-", "+").replaceAll("_", "/"), "base64"));
  if (bytes?.length !== 32) throw new Error(`${name} must be 32 bytes as 64 hex characters or base64 (openssl rand -base64 32)`);
  return bytes;
}

function base64UrlBytes(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  return new Uint8Array(Buffer.from(text, "base64url"));
}

export function loadConfig(env: Env = process.env): ServerConfig {
  const rpcUrl = str(env, "RPC_URL", DEFAULT_RPC_URL);
  const programs = list(env, "RPC_LOGS_PROGRAMS", ["pump", "pumpswap"]);
  // Curated, source-cited fee-wallet registry (market/feeWallets.ts) plus operator additions.
  const pros = proTraderSet(oneOf(env, "PRO_TRADER_PROVENANCE", "all", ["all", "vendor-docs"]), list(env, "PRO_TRADER_WALLETS", []));
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
      bundleSizeBandBps: int(env, "BUNDLE_SIZE_BAND_BPS", 1_000, 0, 100_000),
      insiders: optional(env, "HELIUS_API_KEY") !== null,
      proTraderWallets: pros.wallets,
      proTraderTokenAccounts: pros.tokenAccounts,
    },
    enrich: loadEnrichConfig(env, rpcUrl),
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
      authPerMin: int(env, "RATE_LIMIT_AUTH_PER_MIN", 30, 1, 100_000),
      userPerSec: int(env, "RATE_LIMIT_USER_RPS", 10, 1, 100_000),
      userBurst: int(env, "RATE_LIMIT_USER_BURST", 40, 1, 100_000),
      wsConnPerUser: int(env, "WS_MAX_CONN_PER_USER", 10, 1, 10_000),
      adminPerMin: int(env, "RATE_LIMIT_ADMIN_PER_MIN", 60, 1, 100_000),
    },
    wsMaxSubscriptions: int(env, "WS_MAX_SUBSCRIPTIONS", 64, 1, 10_000),
    wsCompression: bool(env, "WS_COMPRESSION", false),
    logLevel: oneOf(env, "LOG_LEVEL", "info", ["debug", "info", "warn", "error"]),
    userDb: { databaseUrl: optional(env, "DATABASE_URL"), pgliteDir: str(env, "PGLITE_DIR", "data/pglite") },
    auth: loadAuth(env),
    adminToken: optional(env, "ADMIN_TOKEN"),
    notifications: {
      channelKey: optional(env, "CHANNEL_ENCRYPTION_KEY"),
      vapidPublicKey: optional(env, "VAPID_PUBLIC_KEY"),
      vapidPrivateKey: optional(env, "VAPID_PRIVATE_KEY"),
      vapidSubject: "",
      telegramBotToken: optional(env, "TELEGRAM_BOT_TOKEN"),
      telegramBotUsername: optional(env, "TELEGRAM_BOT_USERNAME")?.replace(/^@/, "") ?? null,
      telegramWebhookSecret: optional(env, "TELEGRAM_WEBHOOK_SECRET"),
      alertSweepMs: int(env, "ALERT_SWEEP_MS", 10_000, 1_000, 3_600_000),
      deliveryRetentionDays: int(env, "ALERT_DELIVERY_RETENTION_DAYS", 30, 1, 3_650),
    },
    monitoring: {
      metricsToken: optional(env, "METRICS_TOKEN"),
      feedStallMs: int(env, "METRICS_FEED_STALL_SEC", 30, 5, 3_600) * 1_000,
      killSwitchDir: optional(env, "KILL_SWITCH_DIR"),
    },
    trackers: {
      maxEntries: int(env, "TRACKER_MAX_ENTRIES", 2_000_000, 1, 100_000_000),
      flushMs: int(env, "TRACKER_FLUSH_MS", 100, 10, 5_000),
      feedRing: int(env, "TRACKER_FEED_RING", 20_000, 100, 10_000_000),
      mintRing: int(env, "TRACKER_MINT_RING", 300, 10, 100_000),
      mintRings: int(env, "TRACKER_MINT_RINGS", 10_000, 10, 10_000_000),
      maxRowsPerFrame: int(env, "TRACKER_MAX_ROWS_PER_FRAME", 500, 1, 100_000),
      positions: int(env, "TRACKER_POSITIONS", 200_000, 1_000, 100_000_000),
      skipRetentionDays: int(env, "COPY_SKIP_RETENTION_DAYS", 7, 1, 3_650),
      copy: {
        leaderSlotCapSol: float(env, "COPY_LEADER_SLOT_CAP_SOL", 25, 0.001, 1_000_000),
        buyTtlMs: int(env, "COPY_BUY_TTL_MS", 15_000, 1_000, 600_000),
        sellTtlMs: int(env, "COPY_SELL_TTL_MS", 60_000, 1_000, 3_600_000),
        minSol: float(env, "COPY_MIN_SOL", 0.001, 0.000001, 1_000),
        skipLogPerHour: int(env, "COPY_SKIP_LOG_PER_HOUR", 120, 0, 1_000_000),
        exitCooldownMs: int(env, "COPY_EXIT_COOLDOWN_MS", 30_000, 0, 3_600_000),
      },
    },
    orders: loadOrdersConfig(env),
  };
  if (cfg.source === "yellowstone" && !cfg.yellowstoneEndpoint) throw new Error("INGEST_SOURCE=yellowstone requires YELLOWSTONE_ENDPOINT");
  if (cfg.userDb.databaseUrl && !/^postgres(ql)?:\/\//.test(cfg.userDb.databaseUrl))
    throw new Error("DATABASE_URL must be a postgres:// URL");
  if (cfg.adminToken) parseAdminTokens(cfg.adminToken);
  validateNotifications(env, cfg);
  if (cfg.monitoring.metricsToken !== null && cfg.monitoring.metricsToken.length < 16)
    throw new Error("METRICS_TOKEN must be at least 16 characters (openssl rand -hex 32)");
  return cfg;
}

function loadAuth(env: Env): ServerConfig["auth"] {
  const port = env.SERVER_PORT?.trim() || "8787";
  const publicOrigin = normalizeOrigin("PUBLIC_ORIGIN", str(env, "PUBLIC_ORIGIN", `http://127.0.0.1:${port}`));
  if (publicOrigin.startsWith("http:") && !isLoopbackOrigin(publicOrigin)) {
    throw new Error("PUBLIC_ORIGIN must be https: the session cookie is Secure (plain http only works on 127.0.0.1 / localhost)");
  }
  const extra = list(env, "ALLOWED_ORIGINS", []).map((o) => normalizeOrigin("ALLOWED_ORIGINS", o));
  for (const o of extra) {
    if (o.startsWith("http:") && !isLoopbackOrigin(o)) throw new Error(`ALLOWED_ORIGINS: ${o} must be https (http only on loopback)`);
  }
  const siwsDomain = str(env, "SIWS_DOMAIN", new URL(publicOrigin).host);
  if (!/^[^\s/?#@]+$/.test(siwsDomain)) throw new Error("SIWS_DOMAIN must be a bare host[:port]");
  return {
    publicOrigin,
    allowedOrigins: [...new Set([publicOrigin, ...extra])],
    siwsDomain,
    cookieName: SESSION_COOKIE_NAME,
    sessionTtlMs: int(env, "SESSION_TTL_HOURS", 24, 1, 24 * 7) * 3_600_000,
    maxSessionsPerUser: int(env, "SESSION_MAX_PER_USER", 10, 1, 100),
  };
}

function validateNotifications(env: Env, cfg: ServerConfig): void {
  const n = cfg.notifications;
  if (n.channelKey) decodeKey32("CHANNEL_ENCRYPTION_KEY", n.channelKey);
  if (!!n.vapidPublicKey !== !!n.vapidPrivateKey)
    throw new Error("set both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (bun run --cwd apps/server vapid-keys)");
  if (n.vapidPublicKey && n.vapidPrivateKey) {
    const pub = base64UrlBytes(n.vapidPublicKey);
    const priv = base64UrlBytes(n.vapidPrivateKey);
    if (pub?.length !== 65 || pub[0] !== 4)
      throw new Error("VAPID_PUBLIC_KEY must be an uncompressed P-256 point, base64url (87 characters)");
    if (priv?.length !== 32) throw new Error("VAPID_PRIVATE_KEY must be 32 bytes, base64url (43 characters)");
    const subject = optional(env, "VAPID_SUBJECT") ?? (cfg.auth.publicOrigin.startsWith("https:") ? cfg.auth.publicOrigin : null);
    if (!subject || !/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(subject)) {
      throw new Error("VAPID_SUBJECT must be a mailto: address or an https: URL (push services reject anything else)");
    }
    n.vapidSubject = subject;
  }
  if (n.telegramBotToken && !/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(n.telegramBotToken)) throw new Error("TELEGRAM_BOT_TOKEN looks malformed");
  if (n.telegramBotUsername && !/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(n.telegramBotUsername))
    throw new Error("TELEGRAM_BOT_USERNAME is invalid");
  if (n.telegramWebhookSecret && !/^[A-Za-z0-9_-]{16,256}$/.test(n.telegramWebhookSecret)) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET must be 16-256 of A-Z a-z 0-9 _ -");
  }
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
    // Keys embedded in the path (e.g. Chainstack's /<key>) are long random segments.
    u.pathname = u.pathname
      .split("/")
      .map((seg) => (seg.length >= 24 ? "***" : seg))
      .join("/");
    return u.toString();
  } catch {
    return "<invalid url>";
  }
}
