/** Shared alert-delivery types. */
import type { AlertPriority, ChannelKind, DeliverySource } from "@zerofee/protocol";
import type { DeliveryTarget } from "../db/pg/notify";

/** One alert for one user, before fan-out to that user's channels. */
export interface Notification {
  userId: string;
  alertId: string | null;
  source: DeliverySource;
  priority: AlertPriority;
  title: string;
  body: string;
  /** Link to open (token page, orders view); null for none. */
  url: string | null;
  channels: ChannelKind[];
  /** Same tag = same subject (a re-fire of one alert); used as the Web Push topic. */
  tag: string;
  createdAt: number;
}

/** What a transport sends: one notification, or a digest of several. */
export interface OutboundMessage {
  title: string;
  body: string;
  url: string | null;
  priority: AlertPriority;
  tag: string;
  ts: number;
  /** Notifications carried (1 = single). */
  count: number;
}

export type SendResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      /** The service asked us to wait (HTTP 429 / Telegram retry_after). */
      retryAfterMs?: number;
      /** The target is gone (webhook deleted, bot blocked, subscription expired): stop using it. */
      permanent?: boolean;
      /** The limit applies to the whole channel kind (bot-wide), not just this target. */
      global?: boolean;
    };

/** A delivery target with whatever the transport needs (Discord: the decrypted URL). */
export type ResolvedTarget =
  | Extract<DeliveryTarget, { kind: "push" }>
  | Extract<DeliveryTarget, { kind: "telegram" }>
  | { kind: "discord"; id: string; url: string };

export interface Transport<K extends ChannelKind = ChannelKind> {
  readonly kind: K;
  send(target: Extract<ResolvedTarget, { kind: K }>, msg: OutboundMessage): Promise<SendResult>;
}

/** Bounded network wait for every outbound call. */
export const SEND_TIMEOUT_MS = 10_000;

/** Parses Retry-After (seconds or an HTTP date) into ms. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const s = Number(header);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(header);
  return Number.isFinite(t) ? Math.max(0, t - now) : undefined;
}
