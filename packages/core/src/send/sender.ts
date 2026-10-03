/**
 * Helius Sender lane. https://www.helius.dev/docs/sending-transactions/sender
 *  - SWQoS-only (default): `?swqos_only=true`, tip >= 5,000 lamports, single SWQoS path, no API credits.
 *  - Max (opt-in "turbo"): no flag, tip >= 0.001 SOL, fans out across Helius SWQoS/Jito/Harmonic/...
 *  - Every tx must carry a Sender tip transfer AND a setComputeUnitPrice instruction.
 *  - Regional plain-HTTP endpoints for servers; the global HTTPS endpoint for browsers (CORS).
 *  - Request: sendTransaction [base64, {encoding:"base64", skipPreflight:true, maxRetries:0}].
 */
import {
  HELIUS_SENDER_ENDPOINTS,
  HELIUS_SENDER_PING_INTERVAL_MS,
  HELIUS_SENDER_PING_PATH,
  HELIUS_SENDER_SEND_PATH,
  type HeliusSenderRegion,
} from "../constants";
import { postJsonRpc } from "./jsonRpc";
import { type Lane, type LaneAck, now } from "./lane";

export interface HeliusSenderConfig {
  region: HeliusSenderRegion;
  mode: "swqos" | "max";
  /** Route away from validators linked to sandwiching (`mev-protect=true`). */
  mevProtect?: boolean;
  /** Only for users approved for higher limits. */
  apiKey?: string;
  fetchFn?: typeof fetch;
}

export function heliusSenderUrl(cfg: Pick<HeliusSenderConfig, "region" | "mode" | "mevProtect" | "apiKey">): string {
  const url = new URL(HELIUS_SENDER_SEND_PATH, HELIUS_SENDER_ENDPOINTS[cfg.region]);
  if (cfg.mode === "swqos") url.searchParams.set("swqos_only", "true");
  if (cfg.mevProtect) url.searchParams.set("mev-protect", "true");
  if (cfg.apiKey) url.searchParams.set("api-key", cfg.apiKey);
  return url.toString();
}

export class HeliusSenderLane implements Lane {
  readonly name: string;
  private readonly url: string;
  private readonly pingUrl: string;
  private lastActivity = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly cfg: HeliusSenderConfig) {
    this.name = `helius-${cfg.mode}-${cfg.region}`;
    this.url = heliusSenderUrl(cfg);
    this.pingUrl = new URL(HELIUS_SENDER_PING_PATH, HELIUS_SENDER_ENDPOINTS[cfg.region]).toString();
  }

  async sendTransaction(wireBase64: string, signal?: AbortSignal): Promise<LaneAck> {
    const sentAt = now();
    this.lastActivity = Date.now();
    try {
      const res = await postJsonRpc<string>(
        this.url,
        "sendTransaction",
        [wireBase64, { encoding: "base64", skipPreflight: true, maxRetries: 0 }],
        { signal, fetchFn: this.cfg.fetchFn },
      );
      return {
        lane: this.name,
        ok: !res.error && typeof res.result === "string",
        signature: res.result,
        error: res.error ? `${res.error.code}: ${res.error.message}` : undefined,
        httpStatus: res.status,
        sentAt,
        ackAt: now(),
      };
    } catch (e) {
      return { lane: this.name, ok: false, error: String(e), sentAt, ackAt: now() };
    }
  }

  async warm(): Promise<void> {
    await (this.cfg.fetchFn ?? fetch)(this.pingUrl).catch(() => {});
  }

  /** Keeps the connection warm: pings when idle longer than the interval. */
  startKeepAlive(intervalMs = HELIUS_SENDER_PING_INTERVAL_MS): void {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastActivity >= intervalMs) {
        this.lastActivity = Date.now();
        void this.warm();
      }
    }, intervalMs);
  }

  stopKeepAlive(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}
