/**
 * REST endpoints (JSON). Errors are `{ error, code }` with a matching HTTP status.
 *
 * Market (public):
 *   GET  /api/health                         HealthResponse
 *   GET  /api/tokens/:mint                   TokenResponse            (404 if unknown)
 *   GET  /api/candles?mint&tf&from&to        CandlesResponse          (from/to: epoch ms, optional)
 *   GET  /api/program-accounts               ProgramAccountsResponse  (pump Global / FeeConfig, PumpSwap GlobalConfig / FeeConfig)
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
  solUsd: { price: number | null; ageMs: number | null; stale: boolean };
  chain: { slot: number | null; blockhashAgeMs: number | null };
  tokens: { inMemory: number; pulse: { new: number; final: number; migrated: number } };
  storage: { pendingRows: number; lastFlushMs: number | null; flushes: number; errors: number };
  gateway: { connections: number; subscriptions: number; topics: number };
}

export interface TokenResponse {
  token: TokenSummary;
  tradeContext: TradeContext | null;
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
