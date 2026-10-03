/** Alerts, notification channels and Web Push subscriptions (protocol alerts.ts). */
import {
  type Alert,
  type AlertPriority,
  type AlertRepeat,
  CHANNEL_KINDS,
  type ChannelKind,
  type ChannelsResponse,
  type TokenAlertParams,
  USER_LIMITS,
  type VapidPublicKeyResponse,
} from "@zerofee/protocol";
import { maskWebhook, parseDiscordWebhook } from "../alerts/discord";
import type { Dispatcher } from "../alerts/dispatcher";
import type { AlertEngine } from "../alerts/engine";
import { isAllowedPushEndpoint, validPushKeys } from "../alerts/push";
import { discordAad, type SecretBox } from "../alerts/secretBox";
import { TelegramBot } from "../alerts/telegram";
import type { UserStore } from "../db/pg";
import { type AlertWrite, publicAlert } from "../db/pg/notify";
import type { RateLimiter } from "../gateway/rateLimit";
import { sha256Hex, userAgentHash } from "../util/hash";
import { apiError, badRequest, HttpError, json, notFound, ok } from "./http";
import type { Route } from "./router";
import { address, arr, bool, num, obj, oneOf, str, strict, uuid } from "./validate";

export interface AlertRoutesDeps {
  store: UserStore;
  now: () => number;
  engine: AlertEngine;
  dispatcher: Dispatcher;
  telegram: TelegramBot | null;
  telegramWebhookSecret: string | null;
  box: SecretBox | null;
  vapidPublicKey: string | null;
  /** Test sends per user. */
  testLimiter: RateLimiter;
}

const PRIORITIES: readonly AlertPriority[] = ["high", "normal", "low"];
const REPEATS: readonly AlertRepeat[] = ["once", "rearm"];

function params(v: unknown): TokenAlertParams {
  const o = obj(v, "params");
  strict(o, ["mint", "currency", "direction", "value"], "params");
  return {
    mint: address(o.mint, "params.mint"),
    currency: oneOf(o.currency, "params.currency", ["usd", "sol"] as const),
    direction: oneOf(o.direction, "params.direction", ["above", "below"] as const),
    value: num(o.value, "params.value", { min: 1e-15, max: 1e15 }),
  };
}

function channels(v: unknown): ChannelKind[] {
  const list = arr(v, "channels", CHANNEL_KINDS.length).map((c, i) => oneOf(c, `channels[${i}]`, CHANNEL_KINDS));
  if (!list.length) throw badRequest("channels needs at least one of push, telegram, discord");
  return [...new Set(list)];
}

const ALERT_FIELDS = ["type", "params", "channels", "priority", "repeat", "cooldownSec", "enabled", "note"];

/** Validates a create body (defaults filled) or a patch over `base`. */
function alertWrite(body: unknown, base: AlertWrite | null): AlertWrite {
  const b = obj(body);
  strict(b, base ? ALERT_FIELDS.filter((f) => f !== "type") : ALERT_FIELDS);
  return {
    type: base ? base.type : oneOf(b.type, "type", ["price", "market_cap"] as const),
    params: b.params !== undefined ? params(b.params) : base ? base.params : params(undefined),
    channels: b.channels !== undefined ? channels(b.channels) : (base?.channels ?? ["push"]),
    priority: b.priority !== undefined ? oneOf(b.priority, "priority", PRIORITIES) : (base?.priority ?? "normal"),
    repeat: b.repeat !== undefined ? oneOf(b.repeat, "repeat", REPEATS) : (base?.repeat ?? "once"),
    cooldownSec:
      b.cooldownSec !== undefined ? num(b.cooldownSec, "cooldownSec", { min: 60, max: 86_400, int: true }) : (base?.cooldownSec ?? 900),
    enabled: b.enabled !== undefined ? bool(b.enabled, "enabled") : (base?.enabled ?? true),
    note: b.note !== undefined ? str(b.note, "note", { max: 200 }) : (base?.note ?? ""),
  };
}

export function alertRoutes(d: AlertRoutesDeps): Route[] {
  const { store, now } = d;
  const routes: Route[] = [
    // alerts ---------------------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/alerts",
      auth: "session",
      handler: async (c) => json((await store.notify.listAlerts(c.session.userId)).map(publicAlert)),
    },
    {
      method: "POST",
      path: "/api/alerts",
      auth: "session",
      handler: async (c) => {
        const w = alertWrite(await c.json(), null);
        const rule = await store.notify.createAlert(c.session.userId, w, now(), USER_LIMITS.alerts);
        d.engine.upsert(rule);
        return json(publicAlert(rule) satisfies Alert);
      },
    },
    {
      method: "GET",
      path: "/api/alerts/deliveries",
      auth: "session",
      handler: async (c) => {
        const limit = Math.min(200, Math.max(1, Number(c.url.searchParams.get("limit") ?? 50) || 50));
        return json(await store.notify.listDeliveries(c.session.userId, limit));
      },
    },
    {
      method: "PATCH",
      path: "/api/alerts/:id",
      auth: "session",
      handler: async (c) => {
        const id = uuid(c.params.id, "id");
        const existing = await store.notify.getAlert(c.session.userId, id);
        if (!existing) throw notFound("no such alert");
        const w = alertWrite(await c.json(), existing);
        // A new condition, or re-enabling, starts armed again.
        const rearm = JSON.stringify(w.params) !== JSON.stringify(existing.params) || (w.enabled && !existing.enabled);
        const rule = await store.notify.updateAlert(c.session.userId, id, w, rearm, now());
        if (!rule) throw notFound("no such alert");
        d.engine.upsert(rule);
        return json(publicAlert(rule));
      },
    },
    {
      method: "DELETE",
      path: "/api/alerts/:id",
      auth: "session",
      handler: async (c) => {
        const id = uuid(c.params.id, "id");
        if (!(await store.notify.deleteAlert(c.session.userId, id))) throw notFound("no such alert");
        d.engine.remove(id);
        return ok();
      },
    },

    // channels -------------------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/notifications/channels",
      auth: "session",
      handler: async (c) => {
        const body: ChannelsResponse = {
          channels: await store.notify.listChannels(c.session.userId),
          push: await store.notify.listPush(c.session.userId),
          available: { push: d.dispatcher.available("push"), telegram: !!d.telegram, discord: d.dispatcher.available("discord") },
        };
        return json(body);
      },
    },
    {
      method: "POST",
      path: "/api/notifications/telegram/link",
      auth: "session",
      handler: async (c) => {
        if (!d.telegram) return apiError(503, "unavailable", "Telegram is not configured on this server (TELEGRAM_BOT_TOKEN)");
        return json(await d.telegram.createLink(c.session.userId, USER_LIMITS.notificationChannels));
      },
    },
    {
      method: "POST",
      path: "/api/notifications/discord",
      auth: "session",
      handler: async (c) => {
        if (!d.box || !d.dispatcher.available("discord")) {
          return apiError(503, "unavailable", "Discord webhooks are not configured on this server (CHANNEL_ENCRYPTION_KEY)");
        }
        const b = obj(await c.json(4 * 1024));
        strict(b, ["webhookUrl", "label"]);
        const hook = parseDiscordWebhook(str(b.webhookUrl, "webhookUrl", { max: 300 }));
        if (!hook) throw badRequest("webhookUrl must be https://discord.com/api/webhooks/<id>/<token> (or discordapp.com)");
        const id = crypto.randomUUID();
        const channel = await store.notify.createDiscordChannel(
          c.session.userId,
          {
            id,
            label: b.label === undefined ? "Discord" : str(b.label, "label", { max: 64 }),
            webhookEnc: await d.box.seal(hook.url, discordAad(id, c.session.userId)),
            webhookHash: sha256Hex(hook.url),
            hint: maskWebhook(hook),
          },
          now(),
          USER_LIMITS.notificationChannels,
        );
        d.dispatcher.invalidate(c.session.userId);
        return json(channel);
      },
    },
    {
      method: "POST",
      path: "/api/notifications/channels/:id/test",
      auth: "session",
      handler: async (c) => {
        const id = uuid(c.params.id, "id");
        const target =
          (await store.notify.getChannelTarget(c.session.userId, id)) ?? (await store.notify.getPushTarget(c.session.userId, id));
        if (!target) throw notFound("no such active channel or push subscription");
        if (!d.testLimiter.allow(c.session.userId)) return apiError(429, "rate_limited", "one test message every few seconds");
        const r = await d.dispatcher.sendTest(c.session.userId, target);
        if (r.ok) return ok();
        throw new HttpError(
          r.retryAfterMs !== undefined ? 429 : 502,
          r.retryAfterMs !== undefined ? "rate_limited" : "unavailable",
          r.error,
        );
      },
    },
    {
      method: "DELETE",
      path: "/api/notifications/channels/:id",
      auth: "session",
      handler: async (c) => {
        if (!(await store.notify.deleteChannel(c.session.userId, uuid(c.params.id, "id")))) throw notFound("no such channel");
        d.dispatcher.invalidate(c.session.userId);
        return ok();
      },
    },

    // web push -------------------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/push/vapid-public-key",
      auth: "public",
      handler: async () => json({ publicKey: d.vapidPublicKey } satisfies VapidPublicKeyResponse),
    },
    {
      method: "POST",
      path: "/api/push/subscriptions",
      auth: "session",
      handler: async (c) => {
        if (!d.vapidPublicKey) return apiError(503, "unavailable", "Web Push is not configured on this server (VAPID keys)");
        const b = obj(await c.json(8 * 1024));
        strict(b, ["endpoint", "expirationTime", "keys"]);
        const endpoint = str(b.endpoint, "endpoint", { max: 1_024 });
        if (!isAllowedPushEndpoint(endpoint)) throw badRequest("endpoint must be an https URL of a known push service");
        const keys = obj(b.keys, "keys");
        strict(keys, ["p256dh", "auth"], "keys");
        const p256dh = str(keys.p256dh, "keys.p256dh", { max: 128 });
        const auth = str(keys.auth, "keys.auth", { max: 64 });
        if (!validPushKeys(p256dh, auth)) throw badRequest("keys must be a P-256 public key (p256dh) and a 16-byte auth secret, base64url");
        const info = await store.notify.upsertPush(
          c.session.userId,
          { endpoint, p256dh, auth, userAgentHash: userAgentHash(c.req) },
          now(),
          USER_LIMITS.pushSubscriptions,
        );
        d.dispatcher.invalidate(c.session.userId);
        return json(info);
      },
    },
    {
      method: "DELETE",
      path: "/api/push/subscriptions",
      auth: "session",
      handler: async (c) => {
        const b = obj(await c.json(4 * 1024));
        strict(b, ["endpoint"]);
        if (!(await store.notify.deletePushByEndpoint(c.session.userId, str(b.endpoint, "endpoint", { max: 1_024 })))) {
          throw notFound("no such subscription");
        }
        d.dispatcher.invalidate(c.session.userId);
        return ok();
      },
    },
  ];

  const bot = d.telegram;
  const secret = d.telegramWebhookSecret;
  if (bot && secret) {
    routes.push({
      method: "POST",
      path: "/api/telegram/webhook",
      auth: "public",
      handler: async (c) => {
        if (!TelegramBot.checkWebhookSecret(c.req, secret)) return apiError(401, "unauthorized", "bad secret");
        await bot.handleUpdate(await c.json(256 * 1024));
        return ok();
      },
    });
  }
  return routes;
}
