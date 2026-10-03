/**
 * Alert building blocks, offline: secret encryption at rest, Discord / push URL guards, Web Push
 * encryption checked by decrypting with an independent RFC 8291 implementation (WebCrypto) and
 * verifying the VAPID JWT, and hostile-text formatting.
 */
import { describe, expect, test } from "bun:test";
import { DiscordTransport, maskWebhook, parseDiscordWebhook } from "../src/alerts/discord";
import { escapeDiscord, fmtCap, fmtPrice, sanitizeUntrusted } from "../src/alerts/format";
import { generateVapidKeys, isAllowedPushEndpoint, PushTransport, validPushKeys } from "../src/alerts/push";
import { discordAad, SecretBox } from "../src/alerts/secretBox";
import { formatTelegram, TelegramApi, TelegramTransport } from "../src/alerts/telegram";
import type { OutboundMessage } from "../src/alerts/types";
import { transportMock } from "./userHelpers";

const HOOK = `https://discord.com/api/webhooks/123456789012345678/${"a".repeat(68)}`;
const msg = (o: Partial<OutboundMessage> = {}): OutboundMessage => ({
  title: "BONK above $0.001",
  body: "Price $0.0011",
  url: "https://zerofee.test/token/x",
  priority: "high",
  tag: "alert:1",
  ts: 1_791_000_000_000,
  count: 1,
  ...o,
});

describe("SecretBox (Discord webhooks at rest)", () => {
  test("round-trips; wrong row, wrong key or tampering fail", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const box = await SecretBox.create(key);
    const aad = discordAad("chan-1", "user-1");
    const blob = await box.seal(HOOK, aad);
    expect(Buffer.from(blob).toString("latin1")).not.toContain("discord.com");
    expect(blob[0]).toBe(1);
    expect(await box.open(blob, aad)).toBe(HOOK);
    expect(await box.seal(HOOK, aad)).not.toEqual(blob); // fresh IV every time
    await expect(box.open(blob, discordAad("chan-2", "user-1"))).rejects.toThrow();
    await expect(box.open(blob, discordAad("chan-1", "user-2"))).rejects.toThrow();
    const other = await SecretBox.create(crypto.getRandomValues(new Uint8Array(32)));
    await expect(other.open(blob, aad)).rejects.toThrow();
    const bad = blob.slice();
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 1;
    await expect(box.open(bad, aad)).rejects.toThrow();
    await expect(SecretBox.create(new Uint8Array(16))).rejects.toThrow();
  });
});

describe("Discord webhook URLs", () => {
  test("only discord.com / discordapp.com webhook paths, normalized", () => {
    const token = "a".repeat(68);
    for (const ok of [
      HOOK,
      `https://discordapp.com/api/webhooks/123456789012345678/${token}`,
      `https://discord.com/api/v10/webhooks/123456789012345678/${token}`,
      ` ${HOOK} `,
    ]) {
      expect(parseDiscordWebhook(ok)).toEqual({ url: HOOK, id: "123456789012345678" });
    }
    for (const bad of [
      `http://discord.com/api/webhooks/123456789012345678/${token}`,
      `https://evil.example/api/webhooks/123456789012345678/${token}`,
      `https://discord.com.evil.example/api/webhooks/123456789012345678/${token}`,
      `https://canary.discord.com/api/webhooks/123456789012345678/${token}`,
      `https://discord.com:8443/api/webhooks/123456789012345678/${token}`,
      `https://user:pw@discord.com/api/webhooks/123456789012345678/${token}`,
      `https://discord.com/api/webhooks/123456789012345678/${token}?wait=true`,
      `https://discord.com/api/webhooks/123456789012345678/${token}/slack`,
      `https://discord.com/api/webhooks/12/${token}`,
      "https://discord.com/api/webhooks/123456789012345678/short",
      `https://discord.com/api/channels/123456789012345678/${token}`,
      "not a url",
    ]) {
      expect(parseDiscordWebhook(bad)).toBeNull();
    }
    expect(maskWebhook({ url: HOOK, id: "123456789012345678" })).toBe("discord.com/api/webhooks/123456…/…aaaa");
  });

  test("transport: escaped embed, no mentions, no redirects; 429 / 404 classified", async () => {
    let status = 204;
    const m = transportMock(() =>
      status === 204
        ? undefined
        : status === 429
          ? Response.json({ retry_after: 1.5, global: false }, { status: 429 })
          : new Response(null, { status }),
    );
    const t = new DiscordTransport(m.fn);
    expect(await t.send({ id: "c", url: HOOK }, msg({ title: "*@everyone* [click](https://evil)" }))).toEqual({ ok: true });
    const call = m.calls[0];
    expect(call?.url).toBe(HOOK);
    expect(call?.json).toMatchObject({
      allowed_mentions: { parse: [] },
      embeds: [{ title: "\\*@everyone\\* \\[click\\]\\(https\\://evil\\)", url: "https://zerofee.test/token/x" }],
    });
    status = 429;
    expect(await t.send({ id: "c", url: HOOK }, msg())).toMatchObject({ ok: false, retryAfterMs: 1500, global: false });
    status = 404;
    expect(await t.send({ id: "c", url: HOOK }, msg())).toMatchObject({ ok: false, permanent: true });
    status = 500;
    expect(await t.send({ id: "c", url: HOOK }, msg())).toMatchObject({ ok: false });
    expect(await t.send({ id: "c", url: "https://evil.example/x" }, msg())).toMatchObject({ ok: false, permanent: true });
  });
});

describe("Telegram transport", () => {
  test("plain-text sendMessage without previews; 429 / 403 classified", async () => {
    let reply: unknown = { ok: true, result: { message_id: 1 } };
    const m = transportMock(() => Response.json(reply));
    const t = new TelegramTransport(new TelegramApi("123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij", m.fn));
    expect(await t.send({ chatId: "42" }, msg({ priority: "low" }))).toEqual({ ok: true });
    expect(m.calls[0]?.url).toBe("https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij/sendMessage");
    expect(m.calls[0]?.json).toEqual({
      chat_id: "42",
      text: formatTelegram(msg()),
      link_preview_options: { is_disabled: true },
      disable_notification: true,
    });
    expect(m.calls[0]?.json).not.toHaveProperty("parse_mode");
    reply = { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } };
    expect(await t.send({ chatId: "42" }, msg())).toMatchObject({ ok: false, retryAfterMs: 7_000 });
    reply = { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" };
    expect(await t.send({ chatId: "42" }, msg())).toMatchObject({ ok: false, permanent: true });
    reply = { ok: false, error_code: 400, description: "Bad Request: chat not found" };
    expect(await t.send({ chatId: "42" }, msg())).toMatchObject({ ok: false, permanent: true });
  });
});

describe("Web Push", () => {
  test("endpoint allowlist (SSRF guard) and key validation", () => {
    for (const ok of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
      "https://web.push.apple.com/QGx1",
    ]) {
      expect(isAllowedPushEndpoint(ok)).toBe(true);
    }
    for (const bad of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com.evil.example/x",
      "https://evil.example/fcm.googleapis.com",
      "https://127.0.0.1/x",
      "https://169.254.169.254/latest/meta-data",
      "https://fcm.googleapis.com:8443/x",
      "https://a:b@fcm.googleapis.com/x",
      "nope",
    ]) {
      expect(isAllowedPushEndpoint(bad)).toBe(false);
    }
    expect(
      validPushKeys(Buffer.from(new Uint8Array(65).fill(4)).toString("base64url"), Buffer.from(new Uint8Array(16)).toString("base64url")),
    ).toBe(true);
    expect(validPushKeys("AAAA", "AAAA")).toBe(false);
  });

  test("payload decrypts with an independent RFC 8291 implementation; the VAPID JWT verifies", async () => {
    // The "browser": a P-256 key pair and a 16-byte auth secret.
    const recv = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const recvPub = new Uint8Array(await crypto.subtle.exportKey("raw", recv.publicKey));
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const endpoint = "https://fcm.googleapis.com/fcm/send/device-1";
    const target = {
      kind: "push" as const,
      id: "s1",
      endpoint,
      p256dh: Buffer.from(recvPub).toString("base64url"),
      auth: Buffer.from(auth).toString("base64url"),
    };
    const vapid = generateVapidKeys();
    const m = transportMock();
    const push = new PushTransport({ ...vapid, subject: "mailto:ops@zerofee.test", fetchFn: m.fn });
    expect(await push.send(target, msg({ priority: "normal" }))).toEqual({ ok: true });
    const call = m.calls[0];
    expect(call?.url).toBe(endpoint);
    expect(call?.headers).toMatchObject({ "content-encoding": "aes128gcm", ttl: "3600", urgency: "normal" });
    expect(call?.headers.topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);

    // RFC 8188 header: salt(16) | rs(4) | idlen(1) | keyid = sender public key
    const body = call?.bytes as Uint8Array;
    const salt = body.slice(0, 16);
    const idlen = body[20] as number;
    const senderPub = body.slice(21, 21 + idlen);
    const ciphertext = body.slice(21 + idlen);
    const sender = await crypto.subtle.importKey("raw", senderPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: sender }, recv.privateKey, 256));
    const hkdf = async (s: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, len: number) =>
      new Uint8Array(
        await crypto.subtle.deriveBits(
          { name: "HKDF", hash: "SHA-256", salt: s, info },
          await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]),
          len * 8,
        ),
      );
    const enc = new TextEncoder();
    const ikm = await hkdf(auth, shared, new Uint8Array([...enc.encode("WebPush: info\0"), ...recvPub, ...senderPub]), 32);
    const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce },
        await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]),
        ciphertext,
      ),
    );
    let end = plain.length - 1;
    while (end > 0 && plain[end] === 0) end--;
    expect(plain[end]).toBe(2); // last-record delimiter
    expect(JSON.parse(new TextDecoder().decode(plain.slice(0, end)))).toEqual({
      title: "BONK above $0.001",
      body: "Price $0.0011",
      url: "https://zerofee.test/token/x",
      tag: "alert:1",
      priority: "normal",
      ts: 1_791_000_000_000,
    });

    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(call?.headers.authorization ?? "") ?? [];
    expect(k).toBe(vapid.publicKey);
    const [h, p, sig] = (jwt as string).split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(p, "base64url").toString())).toMatchObject({
      aud: "https://fcm.googleapis.com",
      sub: "mailto:ops@zerofee.test",
    });
    const pub = await crypto.subtle.importKey(
      "raw",
      Buffer.from(vapid.publicKey, "base64url"),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, Buffer.from(sig, "base64url"), enc.encode(`${h}.${p}`)),
    ).toBe(true);
  });

  test("410 / 404 / 403 are permanent, 429 honours Retry-After, foreign endpoints are refused", async () => {
    let status = 410;
    const m = transportMock(() => new Response(null, { status, headers: status === 429 ? { "retry-after": "12" } : {} }));
    const vapid = generateVapidKeys();
    const push = new PushTransport({ ...vapid, subject: "mailto:ops@zerofee.test", fetchFn: m.fn });
    const recv = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const target = {
      kind: "push" as const,
      id: "s",
      endpoint: "https://updates.push.services.mozilla.com/wpush/v2/x",
      p256dh: Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", recv.publicKey))).toString("base64url"),
      auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url"),
    };
    expect(await push.send(target, msg())).toMatchObject({ ok: false, permanent: true });
    status = 403;
    expect(await push.send(target, msg())).toMatchObject({ ok: false, permanent: true });
    status = 429;
    expect(await push.send(target, msg())).toMatchObject({ ok: false, retryAfterMs: 12_000 });
    const before = m.calls.length;
    expect(await push.send({ ...target, endpoint: "https://evil.example/x" }, msg())).toMatchObject({ ok: false, permanent: true });
    expect(m.calls.length).toBe(before);
  });
});

describe("formatting hostile token text", () => {
  test("controls and bidi stripped, links defanged, capped", () => {
    expect(sanitizeUntrusted("PEPE‮KCUF", 16)).toBe("PEPE KCUF");
    expect(sanitizeUntrusted("claim-airdrop.xyz", 32)).toBe("claim-airdrop․xyz");
    expect(sanitizeUntrusted("https://evil.example/x", 64)).not.toContain("://");
    expect(sanitizeUntrusted("A".repeat(40), 16)).toHaveLength(16);
    expect(sanitizeUntrusted("line1\nline2\tx", 32)).toBe("line1 line2 x");
    expect(escapeDiscord("**hi** @everyone")).toBe("\\*\\*hi\\*\\* @everyone");
  });

  test("prices and caps read naturally", () => {
    expect(fmtPrice(0.00123, "usd")).toBe("$0.00123");
    expect(fmtPrice(1234.5, "usd")).toBe("$1,235");
    expect(fmtPrice(0.000000041, "sol")).toBe("0.000000041 SOL");
    expect(fmtCap(1_234_000, "usd")).toBe("$1.23M");
    expect(fmtCap(45_600, "sol")).toBe("45.6K SOL");
    expect(fmtCap(1_200, "usd")).toBe("$1.2K");
    expect(fmtCap(950, "usd")).toBe("$950");
  });
});
