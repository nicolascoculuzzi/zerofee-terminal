/**
 * Jito block-engine lane. https://docs.jito.wtf/lowlatencytxnsend/
 *  - sendTransaction at /api/v1/transactions (direct validator proxy). `?bundleOnly=true` makes it a
 *    revert-protected single-tx bundle (Protected mode); bundle id comes back in `x-bundle-id`.
 *  - sendBundle at /api/v1/bundles (<= 5 txs, atomic, in order; only the tip matters).
 *  - getTipAccounts (live list - always prefer it over the documented fallback).
 *  - Default rate limit: 1 req/s per IP per region. Auth via `x-jito-auth: <uuid>`.
 */
import type { Address } from "@solana/kit";
import { address } from "@solana/kit";
import {
  JITO_BLOCK_ENGINES,
  JITO_BUNDLES_PATH,
  JITO_MAX_BUNDLE_TXS,
  JITO_TIP_ACCOUNTS_FALLBACK,
  JITO_TRANSACTIONS_PATH,
  type JitoRegion,
} from "../constants";
import { postJsonRpc } from "./jsonRpc";
import { type Lane, type LaneAck, now } from "./lane";

export interface JitoConfig {
  region: JitoRegion;
  bundleOnly?: boolean;
  uuid?: string;
  fetchFn?: typeof fetch;
}

function headers(uuid?: string): Record<string, string> {
  return uuid ? { "x-jito-auth": uuid } : {};
}

export class JitoLane implements Lane {
  readonly name: string;
  private readonly base: string;

  constructor(private readonly cfg: JitoConfig) {
    this.base = JITO_BLOCK_ENGINES[cfg.region];
    this.name = `jito-${cfg.bundleOnly ? "bundleOnly-" : ""}${cfg.region}`;
  }

  async sendTransaction(wireBase64: string, signal?: AbortSignal): Promise<LaneAck> {
    const sentAt = now();
    const url = new URL(JITO_TRANSACTIONS_PATH, this.base);
    if (this.cfg.bundleOnly) url.searchParams.set("bundleOnly", "true");
    try {
      const res = await postJsonRpc<string>(url.toString(), "sendTransaction", [wireBase64, { encoding: "base64" }], {
        headers: headers(this.cfg.uuid),
        signal,
        fetchFn: this.cfg.fetchFn,
      });
      return {
        lane: this.name,
        ok: !res.error && typeof res.result === "string",
        signature: res.result,
        bundleId: res.headers.get("x-bundle-id") ?? undefined,
        error: res.error ? `${res.error.code}: ${res.error.message}` : undefined,
        httpStatus: res.status,
        sentAt,
        ackAt: now(),
      };
    } catch (e) {
      return { lane: this.name, ok: false, error: String(e), sentAt, ackAt: now() };
    }
  }

  async sendBundle(wireBase64Txs: string[], signal?: AbortSignal): Promise<LaneAck> {
    if (wireBase64Txs.length === 0 || wireBase64Txs.length > JITO_MAX_BUNDLE_TXS) {
      throw new RangeError(`bundle must contain 1..${JITO_MAX_BUNDLE_TXS} transactions`);
    }
    const sentAt = now();
    try {
      const res = await postJsonRpc<string>(
        new URL(JITO_BUNDLES_PATH, this.base).toString(),
        "sendBundle",
        [wireBase64Txs, { encoding: "base64" }],
        { headers: headers(this.cfg.uuid), signal, fetchFn: this.cfg.fetchFn },
      );
      return {
        lane: `${this.name}-bundle`,
        ok: !res.error && typeof res.result === "string",
        bundleId: res.result,
        error: res.error ? `${res.error.code}: ${res.error.message}` : undefined,
        httpStatus: res.status,
        sentAt,
        ackAt: now(),
      };
    } catch (e) {
      return { lane: `${this.name}-bundle`, ok: false, error: String(e), sentAt, ackAt: now() };
    }
  }
}

/** Live Jito tip accounts; falls back to the documented list on any failure. */
export async function fetchJitoTipAccounts(
  region: JitoRegion = "global",
  opts: { uuid?: string; fetchFn?: typeof fetch } = {},
): Promise<{ accounts: Address[]; live: boolean; error?: string }> {
  try {
    const res = await postJsonRpc<string[]>(new URL(JITO_BUNDLES_PATH, JITO_BLOCK_ENGINES[region]).toString(), "getTipAccounts", [], {
      headers: headers(opts.uuid),
      fetchFn: opts.fetchFn,
    });
    if (res.error || !Array.isArray(res.result) || res.result.length === 0) {
      return { accounts: [...JITO_TIP_ACCOUNTS_FALLBACK], live: false, error: res.error?.message ?? "empty result" };
    }
    return { accounts: res.result.map((a) => address(a)), live: true };
  } catch (e) {
    return { accounts: [...JITO_TIP_ACCOUNTS_FALLBACK], live: false, error: String(e) };
  }
}

export interface JitoBundleStatus {
  bundle_id: string;
  transactions: string[];
  slot: number;
  confirmation_status: "processed" | "confirmed" | "finalized";
  err: unknown;
}

export async function getJitoBundleStatuses(
  bundleIds: string[],
  region: JitoRegion = "global",
  opts: { uuid?: string; fetchFn?: typeof fetch } = {},
): Promise<(JitoBundleStatus | null)[]> {
  const res = await postJsonRpc<{ value: (JitoBundleStatus | null)[] }>(
    new URL(JITO_BUNDLES_PATH, JITO_BLOCK_ENGINES[region]).toString(),
    "getBundleStatuses",
    [bundleIds],
    { headers: headers(opts.uuid), fetchFn: opts.fetchFn },
  );
  if (res.error) throw new Error(`getBundleStatuses: ${res.error.message}`);
  return res.result?.value ?? [];
}
