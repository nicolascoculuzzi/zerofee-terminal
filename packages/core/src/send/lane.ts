/** Common lane (relay adapter) contract used by the router. */

export interface LaneAck {
  lane: string;
  ok: boolean;
  /** Signature echoed by the relay (if any). */
  signature?: string;
  /** Jito bundle id (bundleOnly / sendBundle). */
  bundleId?: string;
  error?: string;
  httpStatus?: number;
  /** performance.now() timestamps. */
  sentAt: number;
  ackAt: number;
}

export interface Lane {
  readonly name: string;
  /** Sends one fully-signed base64 transaction. Must never throw; failures are reported in the ack. */
  sendTransaction(wireBase64: string, signal?: AbortSignal): Promise<LaneAck>;
  /** Optional connection warming (e.g. Sender /ping every 5 s while idle). */
  warm?(): Promise<void>;
}

export const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());
