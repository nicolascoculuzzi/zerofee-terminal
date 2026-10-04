/**
 * Alert evaluation and delivery against a PGlite store with a fake clock and mocked transports:
 * price / market-cap conditions, once vs rearm (hysteresis, cooldown, persisted armed state), the
 * wallet-tracker and order-fill hooks, and the dispatcher's per-channel rate limits, priority classes,
 * digest batching, retries and dead-target handling.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { DiscordTransport } from "../src/alerts/discord";
import { Dispatcher, type DispatcherLimits } from "../src/alerts/dispatcher";
import { AlertEngine, type TokenQuote } from "../src/alerts/engine";
import { generateVapidKeys, PushTransport } from "../src/alerts/push";
import { discordAad, SecretBox } from "../src/alerts/secretBox";
import { TelegramApi, TelegramBot, TelegramTransport } from "../src/alerts/telegram";
import type { Notification } from "../src/alerts/types";
import { UserStore } from "../src/db/pg";
import type { AlertWrite } from "../src/db/pg/notify";
import { setLogLevel } from "../src/log";
import { sha256Hex } from "../src/util/hash";
import { addr } from "./helpers";
import { pgliteDb, type TestDb } from "./pgHelpers";
import { Clock, transportMock } from "./userHelpers";

setLogLevel("error");
const TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
const HOOK = (n: number) => `https://discord.com/api/webhooks/1234567890123456${String(n).padStart(2, "0")}/${"t".repeat(68)}`;
let t: TestDb;
let store: UserStore;
let clock: Clock;

beforeAll(async () => {
  t = await pgliteDb();
  store = new UserStore(t.db);
}, 60_000);
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  clock = new Clock(Date.UTC(2026, 9, 3, 12, 0, 0));
});

const newUser = async (tag: string) => (await store.users.upsertOnLogin(addr(tag), clock.now())).id;
const MINT = addr("alert-token");
const quote = (o: Partial<TokenQuote> = {}): TokenQuote => ({
  symbol: "BONK",
  priceSol: 0.00001,
  priceUsd: 0.0012,
  mcSol: 10_000,
  mcUsd: 1_200_000,
  ...o,
});

function alert(o: Partial<AlertWrite> = {}): AlertWrite {
  return {
    type: "price",
    params: { mint: MINT, currency: "usd", direction: "above", value: 0.002 },
    channels: ["telegram"],
    priority: "normal",
    repeat: "once",
    cooldownSec: 900,
    enabled: true,
    note: "",
    ...o,
  };
}

function engineWith(q: { current: TokenQuote | null }) {
  const out: Notification[] = [];
  const engine = new AlertEngine({ store, notify: (n) => out.push(n), appUrl: "https://zerofee.test", now: clock.now });
  engine.attachQuotes((mint) => (mint === MINT ? q.current : null));
  return { engine, out };
}

describe("price and market-cap alerts", () => {
  test("once: fires when the condition holds, then disables itself (persisted)", async () => {
    const uid = await newUser("eng-1");
    const rule = await store.notify.createAlert(uid, alert({ note: "take profit?" }), clock.now(), 10);
    const q = { current: quote() as TokenQuote | null };
    const { engine, out } = engineWith(q);
    engine.upsert(rule);
    expect(out).toHaveLength(0);
    q.current = quote({ priceUsd: 0.0021, mcUsd: 2_100_000 });
    clock.advance(1_000);
    engine.onTokensChanged([MINT]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      userId: uid,
      alertId: rule.id,
      source: "price",
      title: "BONK above $0.002",
      url: `https://zerofee.test/token/${MINT}`,
      channels: ["telegram"],
      tag: `alert:${rule.id}`,
    });
    expect(out[0]?.body).toBe("Price $0.0021 · MC $2.1M · take profit?");
    engine.onTokensChanged([MINT]);
    engine.sweep();
    expect(out).toHaveLength(1);
    expect(engine.watches(MINT)).toBe(false);
    await Bun.sleep(20);
    expect(await store.notify.getAlert(uid, rule.id)).toMatchObject({
      enabled: false,
      armed: false,
      fireCount: 1,
      lastFiredAt: clock.now(),
    });
  });

  test("rearm: needs the value to fall 1% back below the threshold, and respects the cooldown", async () => {
    const uid = await newUser("eng-2");
    const rule = await store.notify.createAlert(uid, alert({ repeat: "rearm", cooldownSec: 60 }), clock.now(), 10);
    const q = { current: quote({ priceUsd: 0.0025 }) as TokenQuote | null };
    const { engine, out } = engineWith(q);
    engine.upsert(rule); // already above: fires on creation
    expect(out).toHaveLength(1);
    q.current = quote({ priceUsd: 0.00199 }); // within the 1% band: stays disarmed
    engine.sweep();
    q.current = quote({ priceUsd: 0.0021 });
    engine.sweep();
    expect(out).toHaveLength(1);
    q.current = quote({ priceUsd: 0.00197 }); // cleared: re-armed
    engine.sweep();
    q.current = quote({ priceUsd: 0.0021 });
    clock.advance(30_000); // inside the cooldown
    engine.sweep();
    expect(out).toHaveLength(1);
    clock.advance(31_000);
    engine.sweep();
    expect(out).toHaveLength(2);
    await Bun.sleep(20);
    // Restart: the disarmed state survives, so nothing re-fires while the price stays up.
    const again = engineWith(q);
    await again.engine.load();
    again.engine.sweep();
    expect(again.out).toHaveLength(0);
    expect((await store.notify.getAlert(uid, rule.id))?.fireCount).toBe(2);
  });

  test("market cap below in SOL; USD alerts wait for a SOL/USD price", async () => {
    const uid = await newUser("eng-3");
    const cap = await store.notify.createAlert(
      uid,
      alert({ type: "market_cap", params: { mint: MINT, currency: "sol", direction: "below", value: 5_000 }, priority: "high" }),
      clock.now(),
      10,
    );
    const usd = await store.notify.createAlert(
      uid,
      alert({ params: { mint: MINT, currency: "usd", direction: "below", value: 1 } }),
      clock.now(),
      10,
    );
    const q = { current: quote({ priceUsd: null, mcUsd: null }) as TokenQuote | null };
    const { engine, out } = engineWith(q);
    engine.upsert(cap);
    engine.upsert(usd);
    expect(out).toHaveLength(0); // mc 10,000 SOL > 5,000; USD unknown
    q.current = quote({ mcSol: 4_000, priceSol: 0.000004, priceUsd: null, mcUsd: null });
    engine.onTokensChanged([MINT]);
    expect(out.map((n) => n.title)).toEqual(["BONK market cap below 5K SOL"]);
    expect(out[0]?.priority).toBe("high");
    q.current = null; // token evicted: nothing to evaluate
    engine.sweep();
    expect(out).toHaveLength(1);
  });

  test("hostile symbols are sanitized in alert titles", async () => {
    const uid = await newUser("eng-4");
    const rule = await store.notify.createAlert(uid, alert(), clock.now(), 10);
    const q = { current: quote({ symbol: "free-sol.xyz‮", priceUsd: 0.01 }) as TokenQuote | null };
    const { engine, out } = engineWith(q);
    engine.upsert(rule);
    expect(out[0]?.title).toBe("free-sol․xyz above $0.002");
  });
});

describe("hooks: wallet tracker and order fills", () => {
  test("tracked-wallet activity routes to walletChannels, honours flags, minimum size and dedupes", async () => {
    const uid = await newUser("eng-5");
    const whale = addr("whale");
    await store.tracked.upsertMany(
      uid,
      [{ address: whale, label: "Whale", emoji: "🐳", tags: [], alerts: { buy: true, sell: false, create: true, minSol: 1 } }],
      { now: clock.now(), max: 100, overwriteAlerts: true },
    );
    await store.prefs.putSettings(
      uid,
      { notifications: { walletChannels: ["discord", "push"], orderChannels: ["telegram"], digestSeconds: 60 } },
      clock.now(),
    );
    const { engine, out } = engineWith({ current: null });
    await engine.load();
    expect(engine.trackedAddresses().has(whale)).toBe(true);
    const ev = { address: whale, kind: "buy" as const, mint: MINT, symbol: "BONK", amountSol: 2.5, signature: "sig-1", ts: clock.now() };
    engine.onWalletActivity(ev);
    engine.onWalletActivity(ev); // duplicate delivery
    engine.onWalletActivity({ ...ev, signature: "sig-2", amountSol: 0.5 }); // under minSol
    engine.onWalletActivity({ ...ev, signature: "sig-3", kind: "sell" }); // sells not enabled
    engine.onWalletActivity({ ...ev, signature: "sig-4", kind: "create", amountSol: 0 });
    engine.onWalletActivity({ ...ev, address: addr("stranger"), signature: "sig-5" });
    await Bun.sleep(30);
    expect(out.map((n) => n.title)).toEqual(["🐳 Whale bought 2.50 SOL of BONK", "🐳 Whale launched BONK"]);
    expect(out[0]).toMatchObject({ source: "wallet", channels: ["discord", "push"], priority: "normal", alertId: null });

    await store.tracked.remove(uid, whale);
    await engine.reloadTracked(uid);
    expect(engine.trackedAddresses().has(whale)).toBe(false);
  });

  test("order events: fills and failures are high priority on orderChannels", async () => {
    const uid = await newUser("eng-6");
    const { engine, out } = engineWith({ current: null });
    engine.setPrefs(uid, { walletChannels: [], orderChannels: ["telegram", "push"], digestSeconds: 60 });
    engine.onOrderEvent({
      userId: uid,
      orderId: "o1",
      kind: "take-profit",
      status: "filled",
      mint: MINT,
      symbol: "BONK",
      side: "sell",
      signature: "5xSig",
    });
    engine.onOrderEvent({
      userId: uid,
      orderId: "o2",
      kind: "stop-loss",
      status: "failed-consumed",
      event: "consumed",
      mint: MINT,
      side: "sell",
      signature: null,
      detail: "slippage",
    });
    engine.onOrderEvent({ userId: uid, orderId: "o3", kind: "limit-buy", status: "cancelled", mint: MINT, side: "buy", signature: null });
    engine.onOrderEvent({
      userId: uid,
      orderId: "o4",
      kind: "trailing-stop",
      status: "armed",
      event: "flagged",
      mint: MINT,
      symbol: "BONK",
      side: "sell",
      signature: null,
      detail: "interface-upgrade",
    });
    await Bun.sleep(20);
    const short = `${MINT.slice(0, 4)}…${MINT.slice(-4)}`;
    expect(out.map((n) => [n.title, n.priority])).toEqual([
      ["Take profit filled: BONK", "high"],
      [`Stop loss failed, re-arm it: ${short}`, "high"],
      [`Limit buy cancelled: ${short}`, "low"],
      ["Trailing stop needs a check, re-arm it: BONK", "normal"],
    ]);
    expect(out[0]).toMatchObject({ source: "order", channels: ["telegram", "push"], url: "https://zerofee.test/orders" });
  });
});

// ---------------------------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------------------------

async function linkTelegram(uid: string, chatId: string): Promise<void> {
  const code = `code${chatId}xyz`;
  await store.notify.createTelegramLink(uid, sha256Hex(code), clock.now() + 600_000, clock.now(), 10);
  await store.notify.consumeTelegramLink(sha256Hex(code), chatId, `@chat${chatId}`, clock.now());
}

function dispatcherWith(
  m: ReturnType<typeof transportMock>,
  box: SecretBox | null,
  limits: Partial<DispatcherLimits> = {},
  push?: PushTransport,
) {
  return new Dispatcher({
    store,
    transports: { telegram: new TelegramTransport(new TelegramApi(TOKEN, m.fn)), discord: new DiscordTransport(m.fn), push: push ?? null },
    box,
    appUrl: "https://zerofee.test",
    now: clock.now,
    limits,
  });
}

const note = (uid: string, o: Partial<Notification> = {}): Notification => ({
  userId: uid,
  alertId: null,
  source: "price",
  priority: "normal",
  title: "alert",
  body: "body",
  url: "https://zerofee.test/token/x",
  channels: ["telegram"],
  tag: "t",
  createdAt: clock.now(),
  ...o,
});

/** Lets pending fan-outs enqueue (at the current time), advances the clock, ticks, waits for sends. */
async function step(d: Dispatcher, ms = 0): Promise<void> {
  await d.idle();
  clock.advance(ms);
  d.tick(clock.now());
  await d.idle();
}

describe("dispatcher", () => {
  test("Telegram: 1 msg/s per chat; what piles up while rate limited goes out as one digest", async () => {
    const uid = await newUser("dsp-1");
    await linkTelegram(uid, "1001");
    const m = transportMock();
    const d = dispatcherWith(m, null);
    const texts = () => m.calls.map((c) => (c.json as { text: string }).text);
    d.notify(note(uid, { title: "A" }));
    await step(d);
    expect(texts()).toEqual(["A\nbody\nhttps://zerofee.test/token/x"]); // sent at once, alone
    d.notify(note(uid, { title: "B" }));
    d.notify(note(uid, { title: "C" }));
    await step(d, 500); // the chat's bucket is still empty
    expect(m.calls).toHaveLength(1);
    await step(d, 600);
    expect(texts()[1]).toBe("2 alerts\n- B\n- C\nhttps://zerofee.test/token/x");
    expect(d.stats).toMatchObject({ sent: 2, digests: 1 });
    // Alerts that fire in the same instant share one message too.
    for (const title of ["D", "E", "F"]) d.notify(note(uid, { title }));
    await step(d, 1_000);
    expect(texts()[2]?.split("\n")[0]).toBe("3 alerts");
    await d.flushDeliveries();
    const rows = await store.notify.listDeliveries(uid, 10);
    expect(rows.map((r) => [r.title, r.status, r.digestCount]).sort()).toEqual([
      ["A", "sent", 1],
      ["B", "sent", 2],
      ["C", "sent", 2],
      ["D", "sent", 3],
      ["E", "sent", 3],
      ["F", "sent", 3],
    ]);
  });

  test("priorities: high goes alone and first; low waits for the digest window", async () => {
    const uid = await newUser("dsp-2");
    await linkTelegram(uid, "1002");
    await store.prefs.putSettings(uid, { notifications: { walletChannels: [], orderChannels: [], digestSeconds: 30 } }, clock.now());
    const m = transportMock();
    const d = dispatcherWith(m, null);
    d.notify(note(uid, { title: "low-1", priority: "low" }));
    d.notify(note(uid, { title: "low-2", priority: "low" }));
    d.notify(note(uid, { title: "normal", priority: "normal" }));
    d.notify(note(uid, { title: "FILL", priority: "high" }));
    await step(d);
    const first = () => m.calls.map((c) => (c.json as { text: string }).text.split("\n")[0]);
    expect(first()).toEqual(["FILL"]);
    await step(d, 1_000);
    expect(first()).toEqual(["FILL", "3 alerts"]); // the normal one carries the lows with it
    d.notify(note(uid, { title: "low-3", priority: "low" }));
    await step(d, 5_000);
    expect(m.calls).toHaveLength(2); // held for the 30 s digest window
    await step(d, 26_000);
    expect(first()).toEqual(["FILL", "3 alerts", "low-3"]);
    expect((m.calls[2]?.json as { disable_notification?: boolean } | undefined)?.disable_notification).toBe(true);
  });

  test("Telegram global limit: 30 msg/s across all chats", async () => {
    const m = transportMock();
    const d = dispatcherWith(m, null);
    for (let i = 0; i < 40; i++) {
      const uid = await newUser(`dsp-g-${i}`);
      await linkTelegram(uid, String(5000 + i));
      d.notify(note(uid, { title: `chat ${i}` }));
    }
    await step(d);
    expect(m.calls).toHaveLength(30);
    await step(d, 400);
    expect(m.calls).toHaveLength(40);
  });

  test("Discord: 30/min per webhook (burst 5); 429 pauses; a deleted webhook disables the channel", async () => {
    const uid = await newUser("dsp-3");
    const box = await SecretBox.create(crypto.getRandomValues(new Uint8Array(32)));
    const id = crypto.randomUUID();
    await store.notify.createDiscordChannel(
      uid,
      { id, label: "d", webhookEnc: await box.seal(HOOK(1), discordAad(id, uid)), webhookHash: "h1", hint: "x" },
      clock.now(),
      10,
    );
    let mode: "ok" | "429" | "404" = "ok";
    const m = transportMock((c) =>
      c.host !== "discord.com"
        ? undefined
        : mode === "429"
          ? Response.json({ retry_after: 3 }, { status: 429 })
          : mode === "404"
            ? new Response(null, { status: 404 })
            : undefined,
    );
    const d = dispatcherWith(m, box);
    for (let i = 0; i < 7; i++) {
      d.notify(note(uid, { channels: ["discord"], title: `n${i}`, priority: "high" }));
    }
    await step(d);
    for (let i = 0; i < 6; i++) await step(d, 0);
    expect(m.of("discord.com")).toHaveLength(5); // burst of 5, then 2 s per message
    expect(m.of("discord.com")[0]?.url).toBe(HOOK(1)); // decrypted right before sending
    await step(d, 2_000);
    expect(m.of("discord.com")).toHaveLength(6);
    mode = "429";
    await step(d, 2_000);
    expect(m.of("discord.com")).toHaveLength(7);
    mode = "ok";
    await step(d, 2_000); // still paused (retry_after 3 s)
    expect(m.of("discord.com")).toHaveLength(7);
    await step(d, 1_100);
    expect(m.of("discord.com")).toHaveLength(8);
    expect(d.queued).toBe(0);

    mode = "404";
    d.notify(note(uid, { channels: ["discord"], title: "after delete" }));
    await step(d, 2_000);
    const [ch] = await store.notify.listChannels(uid);
    expect(ch).toMatchObject({ status: "disabled" });
    expect(ch?.lastError).toContain("404");
    d.notify(note(uid, { channels: ["discord"], title: "nobody home" }));
    await step(d, 5_000);
    expect(m.of("discord.com")).toHaveLength(9); // the disabled channel is no longer a target
  });

  test("Telegram 403 disables the chat; network errors retry with backoff then give up", async () => {
    const uid = await newUser("dsp-4");
    await linkTelegram(uid, "1004");
    let mode: "403" | "down" = "down";
    const m = transportMock((c) => {
      if (c.host !== "api.telegram.org") return undefined;
      if (mode === "down") throw new Error("ECONNRESET");
      return Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" });
    });
    const d = dispatcherWith(m, null);
    d.notify(note(uid, { title: "retry me", priority: "high" }));
    await step(d);
    await step(d, 900); // backoff 1 s
    expect(m.calls).toHaveLength(1);
    await step(d, 200);
    expect(m.calls).toHaveLength(2);
    await step(d, 5_100);
    expect(m.calls).toHaveLength(3); // third and last attempt
    await step(d, 30_000);
    expect(m.calls).toHaveLength(3);
    await d.flushDeliveries();
    expect((await store.notify.listDeliveries(uid, 5))[0]).toMatchObject({ title: "retry me", status: "failed" });

    mode = "403";
    d.notify(note(uid, { title: "blocked" }));
    await step(d, 1_000);
    expect(await store.notify.targets(uid, ["telegram"])).toEqual([]);
    expect((await store.notify.listChannels(uid))[0]?.status).toBe("disabled");
  });

  test("push: an expired subscription (410) is deleted", async () => {
    const uid = await newUser("dsp-5");
    const recv = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    await store.notify.upsertPush(
      uid,
      {
        endpoint: "https://fcm.googleapis.com/fcm/send/dead",
        p256dh: Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", recv.publicKey))).toString("base64url"),
        auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url"),
        userAgentHash: null,
      },
      clock.now(),
      10,
    );
    const m = transportMock((c) => (c.host === "fcm.googleapis.com" ? new Response(null, { status: 410 }) : undefined));
    const push = new PushTransport({ ...generateVapidKeys(), subject: "mailto:ops@zerofee.test", fetchFn: m.fn });
    const d = dispatcherWith(m, null, {}, push);
    d.notify(note(uid, { channels: ["push"] }));
    await step(d);
    expect(m.of("fcm.googleapis.com")).toHaveLength(1);
    expect(await store.notify.listPush(uid)).toEqual([]);
  });

  test("no linked channel: recorded as dropped, nothing sent", async () => {
    const uid = await newUser("dsp-6");
    const m = transportMock();
    const d = dispatcherWith(m, null);
    d.notify(note(uid, { channels: ["telegram", "discord"] }));
    await step(d);
    await d.flushDeliveries();
    expect(m.calls).toEqual([]);
    expect((await store.notify.listDeliveries(uid, 5))[0]).toMatchObject({ status: "dropped" });
  });
});

describe("Telegram linking flow", () => {
  test("/start <code> links the chat once; /stop unlinks; strangers get one help reply", async () => {
    const uid = await newUser("tg-1");
    const m = transportMock();
    const changed: string[][] = [];
    const bot = new TelegramBot({ api: new TelegramApi(TOKEN, m.fn), store, now: clock.now, onChange: (u) => changed.push(u) });
    const link = await bot.createLink(uid, 10);
    expect(link.url).toBe(`https://t.me/zerofee_test_bot?start=${link.code}`);
    expect(link.code).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect((await store.notify.listChannels(uid))[0]).toMatchObject({ status: "pending" });

    const upd = (text: string, chatId = 777, extra: Record<string, unknown> = {}) => ({
      update_id: 1,
      message: { chat: { id: chatId, type: "private", username: "alice", ...extra }, text },
    });
    await bot.handleUpdate(upd(`/start ${link.code}`));
    expect((await store.notify.listChannels(uid))[0]).toMatchObject({ status: "active", target: "@alice" });
    expect(changed).toEqual([[uid]]);
    const replies = () => m.calls.filter((c) => c.url.endsWith("/sendMessage")).map((c) => (c.json as { text: string }).text);
    expect(replies().at(-1)).toContain("Linked to zerofee account");

    await bot.handleUpdate(upd(`/start ${link.code}`, 888)); // replayed code from another chat
    expect(replies().at(-1)).toContain("invalid or expired");
    expect((await store.notify.targets(uid, ["telegram"])).map((x) => x.kind === "telegram" && x.chatId)).toEqual(["777"]);

    await bot.handleUpdate(upd("hello?", 999));
    await bot.handleUpdate(upd("hello again", 999));
    expect(replies().filter((r) => r.includes("delivers zerofee alerts"))).toHaveLength(1);

    await bot.handleUpdate(upd("/stop"));
    expect(replies().at(-1)).toContain("Unlinked");
    expect(await store.notify.targets(uid, ["telegram"])).toEqual([]);

    const expired = await bot.createLink(uid, 10);
    clock.advance(11 * 60_000);
    await bot.handleUpdate(upd(`/start ${expired.code}`, 1234));
    expect(replies().at(-1)).toContain("invalid or expired");
  });

  test("webhook secret check is exact", () => {
    const req = (v: string | null) =>
      new Request("http://x/api/telegram/webhook", { method: "POST", headers: v ? { "x-telegram-bot-api-secret-token": v } : {} });
    expect(TelegramBot.checkWebhookSecret(req("s3cret-s3cret-s3cret"), "s3cret-s3cret-s3cret")).toBe(true);
    expect(TelegramBot.checkWebhookSecret(req("s3cret-s3cret-s3cre"), "s3cret-s3cret-s3cret")).toBe(false);
    expect(TelegramBot.checkWebhookSecret(req(null), "s3cret-s3cret-s3cret")).toBe(false);
  });
});
