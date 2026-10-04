/**
 * REST endpoints (JSON). Errors are `{ error, code }` with a matching HTTP status.
 *
 * Market (public):
 *   GET  /api/health                         HealthResponse
 *   GET  /api/perf                           PerfResponse             (latency breakdown, event-loop lag)
 *   GET  /api/pulse                          PulseBootstrapResponse   (all three Pulse lists, for the first paint)
 *   GET  /api/tokens/:mint                   TokenResponse            (404 if unknown)
 *   GET  /api/search?q&limit                 SearchResponse           (name, ticker or contract address; limit 1-50, default 20)
 *   GET  /api/candles?mint&tf&from&to        CandlesResponse          (from/to: epoch ms, optional)
 *   GET  /api/program-accounts               ProgramAccountsResponse  (pump Global / FeeConfig, PumpSwap GlobalConfig / FeeConfig)
 *   GET  /api/lookup-tables?addresses        LookupTablesResponse     (1-8 comma-separated lookup table addresses, read from chain)
 *   GET  /api/img?mint&v&s                   token image (webp / png / jpeg / gif bytes, not JSON): media.ts
 *   POST /api/tx                             TxSubmitRequest -> TxSubmitResponse (503 "halted" while the kill switch is on)
 *
 * Accounts, settings and the wallet tracker: user.ts. Alerts and notification channels: alerts.ts.
 * Operator endpoints: admin.ts.
 *
 * Authentication: the `__Host-zf_session` cookie (HttpOnly, Secure, SameSite=Strict) set by
 * POST /api/auth/signin. Requests that carry it and change state (POST/PUT/PATCH/DELETE, including
 * POST /api/tx) must send an `Origin` header from the server's allowed origins, otherwise 403
 * "forbidden". Rate limits: per IP on every endpoint, stricter per IP on sign-in, per user on
 * authenticated calls (429 "rate_limited").
 */

import type { Candle, TokenSummary, TradeContext } from "./market";
import type { ErrorCode } from "./messages";
import type { Timeframe } from "./topics";

export interface ApiErrorBody {
  error: string;
  code: ErrorCode;
}

export interface SourceHealth {
  name: string;
  connected: boolean;
  reconnects: number;
  /** Raw notifications / updates received. */
  messages: number;
  lastMessageAt: number | null;
  /** Latest slot this source has delivered. */
  slot: number | null;
  /** Messages dropped by the source's bounded queue (backpressure). */
  dropped: number;
  notes: string[];
}

export interface LatencyStats {
  /** Detection latency = receive time - block time (ms; block time has 1 s resolution). */
  p50: number | null;
  p90: number | null;
  p99: number | null;
  samples: number;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  startedAt: number;
  uptimeSec: number;
  /** POST /api/tx simulates instead of sending while true. */
  dryRun: boolean;
  sources: SourceHealth[];
  ingest: {
    /** Transactions with at least one decoded event. */
    txs: number;
    events: number;
    trades: number;
    launches: number;
    migrations: number;
    decodeFailures: number;
    /** Events whose pool/mint could not be resolved yet (PumpSwap pools seen before their mint is known). */
    pendingPoolEvents: number;
    tradesPerSec1m: number;
    lastEventAt: number | null;
    /** Detection latency of trades. */
    latency: LatencyStats;
    /** Detection latency of launches (CreateEvent). */
    launchLatency: LatencyStats;
  };
  /**
   * How late the server's event loop runs a 50 ms timer (ms, last ~5 min): time spent blocked by work on the
   * ingest / gateway thread. Image decoding runs in worker processes and should not show up here.
   */
  eventLoopLag?: { p50: number | null; p99: number | null; max: number | null; samples: number };
  solUsd: { price: number | null; ageMs: number | null; stale: boolean };
  chain: { slot: number | null; blockhashAgeMs: number | null };
  tokens: { inMemory: number; pulse: { new: number; final: number; migrated: number } };
  storage: { pendingRows: number; lastFlushMs: number | null; flushes: number; errors: number };
  gateway: { connections: number; subscriptions: number; topics: number };
}

/** Percentiles of one latency stage or work span (ms). */
export interface PerfStat {
  count: number;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  max: number | null;
}

/**
 * GET /api/perf: the server's latency breakdown (apps/server/src/perf.ts). `loop` is the event-loop lag
 * (how late a 20 ms timer fires); `stages` are per-event pipeline hops; `spans` are named pieces of
 * synchronous work, busiest first (`perSecMs`: average ms of each second spent in it).
 */
export interface PerfResponse {
  at: number;
  uptimeSec: number;
  loop: {
    intervalMs: number;
    samples: number;
    p50: number | null;
    p90: number | null;
    p99: number | null;
    max: number | null;
    stallsOver50ms: number;
    stallsOver100ms: number;
    stallsOver500ms: number;
    worstAt: number | null;
  };
  stages: Record<string, PerfStat>;
  spans: Record<string, PerfStat & { totalMs: number; perSecMs: number }>;
}

/**
 * GET /api/pulse: the three Pulse lists as the WebSocket snapshots would send them right now (display order).
 * A bootstrap for the first paint; the `pulse:<column>` topics are the source of truth after that.
 */
export interface PulseBootstrapResponse {
  at: number;
  columns: { new: TokenSummary[]; final: TokenSummary[]; migrated: TokenSummary[] };
}

export interface TokenResponse {
  token: TokenSummary;
  tradeContext: TradeContext | null;
}

/**
 * GET /api/search. A contract address matches that token exactly (in memory or in the database); any other
 * query matches tickers and names of the tokens the server holds in memory (live and recently active ones),
 * best first: exact ticker, ticker prefix, then name; ties go to the most recently traded.
 */
export interface SearchResponse {
  tokens: TokenSummary[];
}

export interface CandlesResponse {
  mint: string;
  tf: Timeframe;
  /** Supply in UI units (market-cap candles = price * supply). */
  supply: number;
  /** Oldest first. */
  candles: Candle[];
}

export interface ProgramAccount {
  owner: string;
  lamports: string;
  /** Raw account data, base64 (decode with @zerofee/core decodePumpGlobal / decodeFeeConfig / decodeAmmGlobalConfig). */
  data: string;
}

export interface ProgramAccountsResponse {
  /** Context slot of the fetch. */
  slot: number;
  fetchedAt: number;
  accounts: Record<string, ProgramAccount>;
}

/**
 * GET /api/lookup-tables. Address lookup table contents read from chain (only accounts the Address Lookup
 * Table program owns), so the browser compiles v0 transactions against real contents and hands the signer
 * firewall the same map. Jupiter routes name their tables and list contents too; the browser checks that
 * claim against this read. Tables only grow (entries never change), so a briefly cached list is a correct
 * prefix of the live one. A missing, closed or non-table account is null.
 */
export interface LookupTableContents {
  addresses: string[];
  /** False once deactivation started (a deactivating table still resolves lookups until it closes). */
  active: boolean;
  /** Slot of the last extension (entries added in that slot become usable in the next one). */
  lastExtendedSlot: number;
}

export interface LookupTablesResponse {
  /** Context slot of the read (the newest among cached and fresh entries). */
  slot: number;
  tables: Record<string, LookupTableContents | null>;
}

/**
 * Landing presets (SPEC.md "Landing presets"):
 *   reduced (default) - Helius Sender SWQoS-only + mev-protect
 *   secure            - Jito bundleOnly with the jitodontfront marker
 *   fast              - Helius Sender Max (all lanes)
 * The transaction must already carry the matching tip(s); the server only picks the lanes.
 */
export type LandingPreset = "reduced" | "secure" | "fast";

export interface TxSubmitRequest {
  /** Fully signed transaction, base64 wire format. */
  tx: string;
  preset: LandingPreset;
  /** Client clock (ms) when the request was sent, for the latency log. */
  clientSentAt?: number;
}

export interface TxSimulation {
  err: unknown;
  logs: string[];
  unitsConsumed: number | null;
  slot: number;
}

export interface TxLaneResult {
  lane: string;
  ok: boolean;
  error: string | null;
  /** Time from send to the relay's ack. */
  ackMs: number;
}

export interface TxSubmitResponse {
  /** Fee-payer signature (the transaction id). */
  signature: string;
  /** True: the server simulated and did NOT send (DRY_RUN=true). */
  dryRun: boolean;
  preset: LandingPreset;
  /** Lanes the transaction went to (empty in dry-run). */
  lanes: TxLaneResult[];
  /** Present in dry-run. */
  simulation: TxSimulation | null;
  receivedAt: number;
}
