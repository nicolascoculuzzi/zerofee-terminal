/**
 * Operator endpoints. Authenticated with `Authorization: Bearer <ADMIN_TOKEN>` (never the session
 * cookie). Every call, including failed authentication, is written to the append-only admin audit log
 * (who, what, when, from where): SPEC "Insider risk".
 *
 *   POST /api/admin/halt              AdminHaltRequest -> HaltState   stop all submissions (POST /api/tx -> 503 "halted")
 *   POST /api/admin/resume            -> HaltState
 *   GET  /api/admin/status            -> AdminStatusResponse
 *   GET  /api/admin/users/:wallet     -> AdminUserLookup (counts only; no trading-wallet or tracked-wallet addresses)
 *   GET  /api/admin/audit?limit=100   -> AdminAuditEntry[] (newest first)
 */
import type { HaltState } from "./chain";

export interface AdminHaltRequest {
  /** Shown to users on the `chain` topic. */
  reason?: string;
}

export interface AdminStatusResponse {
  halt: HaltState;
  users: number;
  activeSessions: number;
}

export interface AdminUserLookup {
  wallet: string;
  createdAt: number;
  lastLoginAt: number;
  activeSessions: number;
  tradingWallets: number;
  trackedWallets: number;
  alerts: number;
  notificationChannels: number;
}

export interface AdminAuditEntry {
  id: number;
  at: number;
  /** Admin identity: the token's name, or "admin:<fingerprint>" for an unnamed token. */
  actor: string;
  action: string;
  target: string | null;
  ip: string | null;
  ok: boolean;
  detail: Record<string, unknown>;
}
