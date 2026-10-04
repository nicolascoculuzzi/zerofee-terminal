/**
 * Alerts end to end through the running server: REST CRUD and validation, notification channels
 * (Telegram link via webhook, Discord encrypted at rest, Web Push subscriptions), test sends, and a
 * market-cap alert that fires from live market state (synthetic trades through a fake ingest source)
 * and is delivered to a linked Telegram chat. All outbound calls hit a mock; nothing leaves the process.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  Alert,
  AlertDelivery,
  ChannelsResponse,
  NotificationChannel,
  TelegramLinkResponse,
  VapidPublicKeyResponse,
} from "@zerofee/protocol";
import { generateVapidKeys } from "../src/alerts/push";
import { addr, FakeCurve, synthTx, waitFor } from "./helpers";
import { Browser, startUserApp, TestSource, transportMock, type UserTestEnv } from "./userHelpers";

const TG_TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
const WEBHOOK_SECRET = "test-webhook-secret-0123456789";
const HOOK = `https://discord.com/api/webhooks/987654321098765432/${"w".repeat(68)}`;
const vapid = generateVapidKeys();
const mock = transportMock();
const source = new TestSource();
let env: UserTestEnv;
let alice: Browser;
let bob: Browser;

beforeAll(async () => {
  env = await startUserApp({
    source,
    fetchFn: mock.fn,
    env: {
      TELEGRAM_BOT_TOKEN: TG_TOKEN,
      TELEGRAM_BOT_USERNAME: "zerofee_test_bot",
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      CHANNEL_ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      VAPID_SUBJECT: "mailto:ops@zerofee.test",
    },
  });
  alice = new Browser(env);
  bob = new Browser(env);
  await alice.signIn();
  await bob.signIn();
}, 60_000);
afterAll(async () => {
  await env.close();
});

/** Links a Telegram chat to `b`'s account the way the real flow does: REST link + /start via webhook. */
async function linkTelegram(b: Browser, chatId: number): Promise<TelegramLinkResponse> {
  const link = (await b.json<TelegramLinkResponse>("POST", "/api/notifications/telegram/link")).body;
  const r = await fetch(`${env.base}/api/telegram/webhook`, {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
    body: JSON.stringify({
      update_id: chatId,
      message: { chat: { id: chatId, type: "private", username: `user${chatId}` }, text: `/start ${link.code}` },
    }),
  });
  expect(r.status).toBe(200);
  return link;
}

describe("alerts REST", () => {
  test("create, list, patch (re-arms), delete; validation; per-user isolation", async () => {
    const mint = addr("rest-alert-mint");
    const r = await alice.json<Alert>("POST", "/api/alerts", {
      type: "price",
      params: { mint, currency: "usd", direction: "above", value: 0.5 },
      channels: ["push", "telegram"],
      note: "moon",
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      type: "price",
      channels: ["push", "telegram"],
      priority: "normal",
      repeat: "once",
      cooldownSec: 900,
      enabled: true,
      fireCount: 0,
    });
    expect(r.body).not.toHaveProperty("userId");
    expect(r.body).not.toHaveProperty("armed");
    const id = r.body.id;
    expect((await alice.json<Alert[]>("GET", "/api/alerts")).body.map((a) => a.id)).toEqual([id]);
    expect((await bob.json<Alert[]>("GET", "/api/alerts")).body).toEqual([]);

    const p = await alice.json<Alert>("PATCH", `/api/alerts/${id}`, {
      params: { mint, currency: "usd", direction: "below", value: 0.1 },
      repeat: "rearm",
    });
    expect(p.body).toMatchObject({ params: { direction: "below", value: 0.1 }, repeat: "rearm", note: "moon" });
    expect((await bob.req("PATCH", `/api/alerts/${id}`, { note: "mine" })).status).toBe(404);
    expect((await alice.req("PATCH", `/api/alerts/${id}`, { type: "market_cap" })).status).toBe(400); // type is fixed

    const bad = [
      { type: "price", params: { mint: "nope", currency: "usd", direction: "above", value: 1 } },
      { type: "price", params: { mint, currency: "eur", direction: "above", value: 1 } },
      { type: "price", params: { mint, currency: "usd", direction: "sideways", value: 1 } },
      { type: "price", params: { mint, currency: "usd", direction: "above", value: -1 } },
      { type: "volume", params: { mint, currency: "usd", direction: "above", value: 1 } },
      { type: "price", params: { mint, currency: "usd", direction: "above", value: 1 }, channels: [] },
      { type: "price", params: { mint, currency: "usd", direction: "above", value: 1 }, channels: ["sms"] },
      { type: "price", params: { mint, currency: "usd", direction: "above", value: 1 }, cooldownSec: 5 },
      { type: "price", params: { mint, currency: "usd", direction: "above", value: 1 }, webhook: "x" },
    ];
    for (const body of bad) expect((await alice.req("POST", "/api/alerts", body)).status).toBe(400);
    expect((await alice.req("DELETE", `/api/alerts/${id}`)).status).toBe(200);
    expect((await alice.req("DELETE", `/api/alerts/${id}`)).status).toBe(404);
    expect((await alice.req("DELETE", "/api/alerts/not-a-uuid")).status).toBe(400);
  });
});

describe("notification channels", () => {
  test("availability, and the Telegram link flow through the webhook", async () => {
    const ch = (await alice.json<ChannelsResponse>("GET", "/api/notifications/channels")).body;
    expect(ch.available).toEqual({ push: true, telegram: true, discord: true });
    const link = await linkTelegram(alice, 4242);
    expect(link.url).toBe(`https://t.me/zerofee_test_bot?start=${link.code}`);
    const after = (await alice.json<ChannelsResponse>("GET", "/api/notifications/channels")).body;
    expect(after.channels).toMatchObject([{ kind: "telegram", status: "active", target: "@user4242" }]);
    const bad = await fetch(`${env.base}/api/telegram/webhook`, {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "wrong" },
      body: "{}",
    });
    expect(bad.status).toBe(401);
    const tgReplies = mock.of("api.telegram.org").filter((c) => (c.json as { chat_id?: string }).chat_id === "4242");
    expect((tgReplies.at(-1)?.json as { text?: string } | undefined)?.text).toContain("Linked to zerofee account");
  });

  test("Discord: only webhook URLs, stored encrypted, shown masked; duplicates conflict; test send has no mentions", async () => {
    expect((await alice.req("POST", "/api/notifications/discord", { webhookUrl: "https://evil.example/api/webhooks/1/2" })).status).toBe(
      400,
    );
    const r = await alice.json<NotificationChannel>("POST", "/api/notifications/discord", { webhookUrl: HOOK, label: "alpha calls" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      kind: "discord",
      label: "alpha calls",
      status: "active",
      target: "discord.com/api/webhooks/987654…/…wwww",
    });
    expect(JSON.stringify(r.body)).not.toContain("w".repeat(20));
    const rows = await env.db.db.query("SELECT discord_webhook_enc, target_hint FROM notification_channels WHERE id = $1::uuid", [
      r.body.id,
    ]);
    expect(Buffer.from(rows[0]?.discord_webhook_enc as Uint8Array).toString("latin1")).not.toContain("discord.com");
    expect((await alice.req("POST", "/api/notifications/discord", { webhookUrl: HOOK })).status).toBe(409);

    const before = mock.of("discord.com").length;
    expect((await alice.req("POST", `/api/notifications/channels/${r.body.id}/test`)).status).toBe(200);
    const sent = mock.of("discord.com");
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)?.url).toBe(HOOK);
    expect(sent.at(-1)?.json).toMatchObject({ allowed_mentions: { parse: [] }, embeds: [{ title: "zerofee test alert" }] });
    expect((await alice.req("POST", `/api/notifications/channels/${r.body.id}/test`)).status).toBe(429); // one test every few seconds
    expect((await bob.req("POST", `/api/notifications/channels/${r.body.id}/test`)).status).toBe(404);
    expect((await bob.req("DELETE", `/api/notifications/channels/${r.body.id}`)).status).toBe(404);
    expect((await alice.req("DELETE", `/api/notifications/channels/${r.body.id}`)).status).toBe(200);
  });

  test("Web Push: public VAPID key, subscriptions only for known push services with valid keys", async () => {
    const k = (await (await fetch(`${env.base}/api/push/vapid-public-key`)).json()) as VapidPublicKeyResponse;
    expect(k.publicKey).toBe(vapid.publicKey);
    const recv = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const keys = {
      p256dh: Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", recv.publicKey))).toString("base64url"),
      auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url"),
    };
    const endpoint = "https://fcm.googleapis.com/fcm/send/alice-browser";
    expect((await bob.req("POST", "/api/push/subscriptions", { endpoint: "https://169.254.169.254/latest", keys })).status).toBe(400);
    expect((await bob.req("POST", "/api/push/subscriptions", { endpoint, keys: { p256dh: "AAAA", auth: "AAAA" } })).status).toBe(400);
    const r = await bob.json<{ id: string; endpointHost: string }>("POST", "/api/push/subscriptions", {
      endpoint,
      expirationTime: null,
      keys,
    });
    expect(r.status).toBe(200);
    expect(r.body.endpointHost).toBe("fcm.googleapis.com");
    expect((await bob.json<ChannelsResponse>("GET", "/api/notifications/channels")).body.push).toHaveLength(1);
    const before = mock.of("fcm.googleapis.com").length;
    expect((await bob.req("POST", `/api/notifications/channels/${r.body.id}/test`)).status).toBe(200);
    expect(mock.of("fcm.googleapis.com").length).toBe(before + 1);
    expect(mock.of("fcm.googleapis.com").at(-1)?.headers["content-encoding"]).toBe("aes128gcm");
    expect((await bob.req("DELETE", "/api/push/subscriptions", { endpoint })).status).toBe(200);
    expect((await bob.req("DELETE", "/api/push/subscriptions", { endpoint })).status).toBe(404);
  });

  test("a server without bot token / key / VAPID says so (503) instead of pretending", async () => {
    const bare = await startUserApp({ db: env.db });
    try {
      const b = new Browser(bare);
      await b.signIn();
      expect((await b.json<ChannelsResponse>("GET", "/api/notifications/channels")).body.available).toEqual({
        push: false,
        telegram: false,
        discord: false,
      });
      expect((await b.req("POST", "/api/notifications/telegram/link")).status).toBe(503);
      expect((await b.req("POST", "/api/notifications/discord", { webhookUrl: HOOK })).status).toBe(503);
      expect(((await (await fetch(`${bare.base}/api/push/vapid-public-key`)).json()) as VapidPublicKeyResponse).publicKey).toBeNull();
      expect((await fetch(`${bare.base}/api/telegram/webhook`, { method: "POST", body: "{}" })).status).toBe(404);
    } finally {
      await bare.close();
    }
  }, 60_000);
});

describe("end to end: a market-cap alert fires from live market state", () => {
  test("synthetic trades move the market cap past the threshold; Telegram receives the alert once", async () => {
    const carol = new Browser(env);
    await carol.signIn();
    await linkTelegram(carol, 777_001);
    const mint = addr("e2e-alert-mint");
    const dev = addr("e2e-dev");
    const curve = new FakeCurve(mint, dev);
    const nowSec = () => Math.floor(Date.now() / 1000);
    let slot = 50_000_000;
    source.emit(synthTx(++slot, [curve.create(nowSec()), curve.buy(dev, 1_000_000_000n, nowSec())]));
    const start = await waitFor(() => env.app.market.summary(mint));
    const threshold = (start.mcSol ?? 0) * 1.5;

    const created = await carol.json<Alert>("POST", "/api/alerts", {
      type: "market_cap",
      params: { mint, currency: "sol", direction: "above", value: threshold },
      channels: ["telegram"],
      priority: "high",
    });
    expect(created.status).toBe(200);
    expect(env.user.alerts.watches(mint)).toBe(true);
    await Bun.sleep(300);
    const toCarol = () =>
      mock
        .of("api.telegram.org")
        .filter((c) => (c.json as { chat_id?: string }).chat_id === "777001" && /market cap/.test((c.json as { text: string }).text));
    expect(toCarol()).toHaveLength(0); // not there yet

    source.emit(synthTx(++slot, [curve.buy(addr("e2e-whale"), 40_000_000_000n, nowSec())]));
    const sent = await waitFor(() => toCarol()[0], 5_000);
    const text = (sent.json as { text: string }).text;
    expect(text).toContain(`${mint.slice(0, 4).toUpperCase()} market cap above`);
    expect(text).toContain(`/token/${mint}`);
    expect(env.app.market.summary(mint)?.mcSol ?? 0).toBeGreaterThan(threshold);

    source.emit(synthTx(++slot, [curve.buy(addr("e2e-whale-2"), 5_000_000_000n, nowSec())]));
    await Bun.sleep(400);
    expect(toCarol()).toHaveLength(1); // once: it does not fire again
    const [after] = (await carol.json<Alert[]>("GET", "/api/alerts")).body;
    expect(after).toMatchObject({ enabled: false, fireCount: 1 });
    expect(env.user.alerts.watches(mint)).toBe(false);

    let deliveries: AlertDelivery[] = [];
    for (let i = 0; i < 50 && !deliveries.length; i++) {
      await Bun.sleep(100); // delivery records are flushed in batches every second
      deliveries = (await carol.json<AlertDelivery[]>("GET", "/api/alerts/deliveries")).body;
    }
    expect(deliveries[0]).toMatchObject({
      alertId: created.body.id,
      channel: "telegram",
      status: "sent",
      source: "market_cap",
      digestCount: 1,
    });
  }, 30_000);
});
