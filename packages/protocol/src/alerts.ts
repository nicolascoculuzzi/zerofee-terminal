/**
 * Alerts and off-app delivery (REST, JSON; session cookie required, mutations need an allowed Origin).
 *
 * Price and market-cap alerts are evaluated on the server from live market state, so they fire with
 * the tab closed. Tracked-wallet alerts use each tracked wallet's flags (user.ts) and order-fill alerts
 * use `UserSettings.notifications`. Delivery goes to Web Push, Telegram and/or Discord, with per-channel
 * rate limits: high-priority alerts are sent on their own as soon as the channel allows, normal ones go
 * out immediately or batched while a channel is rate limited, and low-priority ones are batched into a
 * digest every `notifications.digestSeconds`.
 *
 *   GET    /api/alerts                              -> Alert[]
 *   POST   /api/alerts                              AlertInput -> Alert
 *   PATCH  /api/alerts/:id                          AlertPatch -> Alert
 *   DELETE /api/alerts/:id                          -> { ok: true }
 *   GET    /api/alerts/deliveries?limit=50          -> AlertDelivery[] (newest first)
 *
 *   GET    /api/notifications/channels              -> ChannelsResponse
 *   POST   /api/notifications/telegram/link         -> TelegramLinkResponse (open `url`, press Start)
 *   POST   /api/notifications/discord               DiscordChannelInput -> NotificationChannel
 *   POST   /api/notifications/channels/:id/test     -> { ok: true } (sends a test message)
 *   DELETE /api/notifications/channels/:id          -> { ok: true }
 *
 *   GET    /api/push/vapid-public-key               -> VapidPublicKeyResponse (public; for pushManager.subscribe)
 *   POST   /api/push/subscriptions                  PushSubscriptionInput (PushSubscription.toJSON()) -> PushSubscriptionInfo
 *   DELETE /api/push/subscriptions                  { endpoint } -> { ok: true }
 */

export type ChannelKind = "push" | "telegram" | "discord";
export const CHANNEL_KINDS: readonly ChannelKind[] = ["push", "telegram", "discord"];

export type AlertType = "price" | "market_cap";
export type AlertCurrency = "usd" | "sol";
export type AlertDirection = "above" | "below";
/** high: sent alone, first; normal: sent now or batched while rate limited; low: always digested. */
export type AlertPriority = "high" | "normal" | "low";
/** once: disabled after it fires; rearm: fires again after the value moves back past the threshold (and the cooldown). */
export type AlertRepeat = "once" | "rearm";

export interface TokenAlertParams {
  mint: string;
  currency: AlertCurrency;
  direction: AlertDirection;
  /** Threshold in `currency`: price per whole token (type price) or market cap (type market_cap). */
  value: number;
}

export interface Alert {
  id: string;
  type: AlertType;
  params: TokenAlertParams;
  channels: ChannelKind[];
  priority: AlertPriority;
  repeat: AlertRepeat;
  /** rearm: minimum seconds between two firings (60-86400). */
  cooldownSec: number;
  enabled: boolean;
  note: string;
  lastFiredAt: number | null;
  fireCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface AlertInput {
  type: AlertType;
  params: TokenAlertParams;
  /** Default ["push"]. */
  channels?: ChannelKind[];
  /** Default "normal". */
  priority?: AlertPriority;
  /** Default "once". */
  repeat?: AlertRepeat;
  /** Default 900. */
  cooldownSec?: number;
  enabled?: boolean;
  note?: string;
}

export type AlertPatch = Partial<Omit<AlertInput, "type">>;

export type ChannelStatus = "pending" | "active" | "disabled";

export interface NotificationChannel {
  id: string;
  kind: "telegram" | "discord";
  label: string;
  /** Telegram: "@username" or the chat title; Discord: a masked webhook. Never the full webhook URL. */
  target: string;
  status: ChannelStatus;
  lastError: string | null;
  createdAt: number;
}

export interface PushSubscriptionInfo {
  id: string;
  /** Host of the push service endpoint (fcm.googleapis.com, updates.push.services.mozilla.com, ...). */
  endpointHost: string;
  createdAt: number;
  lastSuccessAt: number | null;
}

export interface ChannelsResponse {
  channels: NotificationChannel[];
  push: PushSubscriptionInfo[];
  /** Which channel kinds this server is configured for (bot token, VAPID keys, webhook encryption key). */
  available: Record<ChannelKind, boolean>;
}

export interface TelegramLinkResponse {
  channelId: string;
  /** One-time code; the bot links the chat that sends `/start <code>`. */
  code: string;
  /** https://t.me/<bot>?start=<code> */
  url: string;
  expiresAt: number;
}

export interface DiscordChannelInput {
  /** https://discord.com/api/webhooks/<id>/<token> (discordapp.com also accepted). Stored encrypted. */
  webhookUrl: string;
  label?: string;
}

/** `PushSubscription.toJSON()` from the browser. */
export interface PushSubscriptionInput {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

export interface VapidPublicKeyResponse {
  /** Base64url application server key, or null when Web Push is not configured. */
  publicKey: string | null;
}

export type DeliverySource = "price" | "market_cap" | "wallet" | "order" | "test" | "system";
export type DeliveryStatus = "sent" | "failed" | "dropped";

export interface AlertDelivery {
  id: string;
  alertId: string | null;
  source: DeliverySource;
  channel: ChannelKind;
  status: DeliveryStatus;
  title: string;
  /** Alerts carried by the message this one went out in (1 = sent alone, more = digest). */
  digestCount: number;
  error: string | null;
  createdAt: number;
}

/** Payload of a Web Push message (JSON, decrypted by the service worker). */
export interface PushPayload {
  title: string;
  body: string;
  /** Link to open on click (the app's token page, an order view...). */
  url: string | null;
  /** Notifications with the same tag replace each other. */
  tag: string;
  priority: AlertPriority;
  ts: number;
}
