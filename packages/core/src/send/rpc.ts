/**
 * Generic RPC lane: `sendTransaction` to any Solana JSON-RPC endpoint.
 *  - Tests: the local mainnet-fork validator (packages/core/e2e), so the router lands real transactions
 *    against real program code without real money.
 *  - Production: a fallback lane next to Sender/Jito (e.g. a user's own RPC). A plain RPC forwards to the
 *    leader over TPU and needs no tip, so adding this lane never changes what a transaction pays.
 * Same wire contract as the relay lanes: base64, skipPreflight true, maxRetries 0. We simulate once before
 * signing and rebroadcast ourselves until lastValidBlockHeight (tx_landing_and_mev.md §7).
 * The lane name and error strings carry only the host: RPC URLs often embed API keys in the path or query.
 */
import type { Commitment } from "@solana/kit";
import { postJsonRpc } from "./jsonRpc";
import { type Lane, type LaneAck, now } from "./lane";

export interface RpcLaneConfig {
  /** http(s) JSON-RPC endpoint. */
  url: string;
  /** Overrides the default `rpc-<host>` lane name. */
  name?: string;
  /** Default true: the endpoint must not re-simulate (and a preflight failure would hide a landed tx). */
  skipPreflight?: boolean;
  /** Preflight commitment, only sent when `skipPreflight` is false. Default "confirmed". */
  preflightCommitment?: Commitment;
  /** Default 0: the endpoint's send service must not retry; SubmitRouter.rebroadcast does. */
  maxRetries?: number;
  headers?: Record<string, string>;
  fetchFn?: typeof fetch;
}

/** `rpc-<host[:port]>`; never includes the path or query (API keys). */
export function rpcLaneName(url: string): string {
  return `rpc-${new URL(url).host}`;
}

export class RpcLane implements Lane {
  readonly name: string;
  private readonly url: string;
  private readonly sendConfig: Record<string, unknown>;

  constructor(private readonly cfg: RpcLaneConfig) {
    const parsed = new URL(cfg.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`RpcLane needs an http(s) URL, got ${parsed.protocol}`);
    }
    this.url = cfg.url;
    this.name = cfg.name ?? rpcLaneName(cfg.url);
    const skipPreflight = cfg.skipPreflight ?? true;
    this.sendConfig = {
      encoding: "base64",
      skipPreflight,
      maxRetries: cfg.maxRetries ?? 0,
      ...(skipPreflight ? {} : { preflightCommitment: cfg.preflightCommitment ?? "confirmed" }),
    };
  }

  async sendTransaction(wireBase64: string, signal?: AbortSignal): Promise<LaneAck> {
    const sentAt = now();
    try {
      const res = await postJsonRpc<string>(this.url, "sendTransaction", [wireBase64, this.sendConfig], {
        headers: this.cfg.headers,
        signal,
        fetchFn: this.cfg.fetchFn,
      });
      return {
        lane: this.name,
        ok: !res.error && typeof res.result === "string",
        signature: res.result,
        error: res.error ? this.redact(`${res.error.code}: ${res.error.message}`) : undefined,
        httpStatus: res.status,
        sentAt,
        ackAt: now(),
      };
    } catch (e) {
      return { lane: this.name, ok: false, error: this.redact(String(e)), sentAt, ackAt: now() };
    }
  }

  /** Strips the full URL (which may carry a key) from error text. */
  private redact(message: string): string {
    return message.split(this.url).join(this.name);
  }
}
