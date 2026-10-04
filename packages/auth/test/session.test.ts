import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SESSION_COOKIE_NAME,
  generateNonce,
  generateSessionToken,
  hashSessionToken,
  InMemoryNonceStore,
  isSessionTokenFormat,
  isValidNonce,
  readCookie,
  serializeExpiredSessionCookie,
  serializeSessionCookie,
} from "../src";
import { base64UrlToBytes } from "../src/encoding";

describe("session tokens", () => {
  test("32 random bytes, base64url, unique", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const token = generateSessionToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(base64UrlToBytes(token)?.length).toBe(32);
      expect(isSessionTokenFormat(token)).toBe(true);
      seen.add(token);
    }
    expect(seen.size).toBe(200);
    expect(isSessionTokenFormat("short")).toBe(false);
    expect(isSessionTokenFormat(`${generateSessionToken()}=`)).toBe(false);
  });

  test("SHA-256 hashing for storage", async () => {
    // FIPS 180-2 test vector for "abc".
    expect(await hashSessionToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const token = generateSessionToken();
    expect(await hashSessionToken(token)).toBe(await hashSessionToken(token));
    expect(await hashSessionToken(token)).not.toBe(await hashSessionToken(generateSessionToken()));
  });
});

describe("Set-Cookie serializer", () => {
  test("emits HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age", () => {
    expect(serializeSessionCookie(DEFAULT_SESSION_COOKIE_NAME, "tok_123", { maxAgeSeconds: 3600 })).toBe(
      "__Host-zf_session=tok_123; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Strict",
    );
    expect(serializeExpiredSessionCookie("sid")).toBe("sid=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict");
  });

  test("rejects header injection and bad lifetimes", () => {
    expect(() => serializeSessionCookie("sid", "a; Domain=evil.example", { maxAgeSeconds: 1 })).toThrow();
    expect(() => serializeSessionCookie("sid", "a\r\nSet-Cookie: x=y", { maxAgeSeconds: 1 })).toThrow();
    expect(() => serializeSessionCookie("s id", "a", { maxAgeSeconds: 1 })).toThrow();
    expect(() => serializeSessionCookie("sid", "a", { maxAgeSeconds: -1 })).toThrow();
    expect(() => serializeSessionCookie("sid", "a", { maxAgeSeconds: 1.5 })).toThrow();
    expect(() => serializeSessionCookie("sid", "a", { maxAgeSeconds: 401 * 24 * 3600 })).toThrow();
  });

  test("readCookie finds one value and refuses duplicates", () => {
    expect(readCookie("a=1; __Host-zf_session=abc; b=2", "__Host-zf_session")).toBe("abc");
    expect(readCookie("a=1", "sid")).toBeUndefined();
    expect(readCookie(undefined, "sid")).toBeUndefined();
    expect(readCookie("sid=1; sid=2", "sid")).toBeUndefined();
  });
});

describe("nonce store", () => {
  test("nonces are 32 hex chars and valid SIWS nonces", () => {
    const n = generateNonce();
    expect(n).toMatch(/^[0-9a-f]{32}$/);
    expect(isValidNonce(n)).toBe(true);
    expect(generateNonce()).not.toBe(n);
  });

  test("consume succeeds once, then fails", () => {
    const store = new InMemoryNonceStore();
    const n = generateNonce();
    store.issue(n, 60_000);
    expect(store.consume(n)).toBe(true);
    expect(store.consume(n)).toBe(false);
    expect(store.consume(generateNonce())).toBe(false);
  });

  test("expired nonces fail and are swept", () => {
    let now = 1_000;
    const store = new InMemoryNonceStore({ now: () => now });
    const a = generateNonce();
    const b = generateNonce();
    store.issue(a, 10);
    store.issue(b, 10);
    now = 1_010;
    expect(store.consume(a)).toBe(false);
    store.sweep();
    expect(store.size).toBe(0);
  });

  test("bounded size evicts the oldest", () => {
    const store = new InMemoryNonceStore({ maxEntries: 2 });
    const [a, b, c] = [generateNonce(), generateNonce(), generateNonce()];
    store.issue(a, 60_000);
    store.issue(b, 60_000);
    store.issue(c, 60_000);
    expect(store.size).toBe(2);
    expect(store.consume(a)).toBe(false);
    expect(store.consume(c)).toBe(true);
  });

  test("refuses malformed nonces and re-issue", () => {
    const store = new InMemoryNonceStore();
    expect(() => store.issue("short", 1000)).toThrow();
    const n = generateNonce();
    store.issue(n, 1000);
    expect(() => store.issue(n, 1000)).toThrow();
  });

  test("eviction skips consumed nonces: a re-issued nonce is not evicted through its old queue slot", () => {
    const store = new InMemoryNonceStore({ maxEntries: 2 });
    const [a, b, c] = ["aaaaaaaa1", "bbbbbbbb2", "cccccccc3"];
    store.issue(a, 60_000);
    expect(store.consume(a)).toBe(true);
    store.issue(b, 60_000);
    store.issue(a, 60_000); // same string again after use: its first queue slot is stale
    store.issue(c, 60_000); // over capacity: evicts the oldest outstanding nonce, b
    expect([store.consume(b), store.consume(a), store.consume(c)]).toEqual([false, true, true]);
  });

  test("issue stays cheap with many outstanding and consumed nonces (no full sweep per issue)", () => {
    const store = new InMemoryNonceStore({ maxEntries: 50_000 });
    const t0 = performance.now();
    for (let i = 0; i < 150_000; i++) {
      const n = `nonce${String(i).padStart(8, "0")}`;
      store.issue(n, 600_000);
      if (i % 2 === 0) store.consume(n); // half of the sign-ins complete
    }
    // a sweep of the whole map on every issue took minutes here; front pruning takes well under a second
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(store.size).toBe(50_000);
    expect(store.consume("nonce00149999")).toBe(true);
    expect(store.consume("nonce00000001")).toBe(false); // evicted long ago
  });
});
