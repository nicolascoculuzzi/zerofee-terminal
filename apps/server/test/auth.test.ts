/**
 * SIWS sign-in end to end against the running gateway (PGlite user database, throwaway wallets):
 * nonce -> wallet signature -> session cookie -> /api/me -> sign-out; replay, wrong domain and
 * tampering; session expiry, rotation and revocation; CSRF origin checks; rate limits.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createSignInMessage, hashSessionToken } from "@zerofee/auth";
import type { MeResponse, NonceResponse } from "@zerofee/protocol";
import { decodeSignInRequest } from "../src/auth/sessions";
import { loadConfig } from "../src/config";
import { Browser, b64, ORIGIN, startUserApp, throwawaySigner, type UserTestEnv } from "./userHelpers";

let env: UserTestEnv;

beforeAll(async () => {
  env = await startUserApp({ env: { SESSION_TTL_HOURS: "2", SESSION_MAX_PER_USER: "3" } });
}, 60_000);
afterAll(async () => {
  await env.close();
});

const nonce = async (): Promise<NonceResponse> => (await (await fetch(`${env.base}/api/auth/nonce`)).json()) as NonceResponse;

async function signedBody(input: NonceResponse["input"], overrides: Partial<NonceResponse["input"]> = {}) {
  const s = await throwawaySigner();
  const msg = createSignInMessage({ ...input, ...overrides, address: s.address });
  return {
    signer: s,
    body: { account: { address: s.address, publicKey: b64(s.publicKey) }, signedMessage: b64(msg), signature: b64(await s.sign(msg)) },
  };
}

describe("sign-in", () => {
  test("nonce input binds our domain, origin, statement, a fresh nonce and a 10-minute expiry", async () => {
    const n = await nonce();
    expect(n.input).toMatchObject({ domain: "zerofee.test", uri: ORIGIN, version: "1", chainId: "mainnet" });
    expect(n.input.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(Date.parse(n.input.expirationTime) - Date.parse(n.input.issuedAt)).toBe(600_000);
    expect((await nonce()).input.nonce).not.toBe(n.input.nonce);
  });

  test("full flow: the cookie is __Host-, HttpOnly, Secure, SameSite=Strict; /api/me answers; only the token hash is stored", async () => {
    const n = await nonce();
    const { signer, body } = await signedBody(n.input);
    const r = await fetch(`${env.base}/api/auth/signin`, { method: "POST", headers: { origin: ORIGIN }, body: JSON.stringify(body) });
    expect(r.status).toBe(200);
    const me = (await r.json()) as MeResponse;
    expect(me.wallet).toBe(signer.address);
    expect(me.session.expiresAt - me.session.createdAt).toBe(2 * 3_600_000);

    const setCookie = r.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^__Host-zf_session=[A-Za-z0-9_-]{43}; /);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=7200"]) expect(setCookie).toContain(attr);
    expect(setCookie).not.toContain("Domain=");
    const cookie = setCookie.split(";")[0] as string;
    const token = cookie.split("=")[1] as string;
    expect(JSON.stringify(me)).not.toContain(token);

    const meAgain = await fetch(`${env.base}/api/me`, { headers: { cookie } });
    expect(meAgain.status).toBe(200);
    expect(((await meAgain.json()) as MeResponse).wallet).toBe(signer.address);

    const rows = await env.db.db.query(
      "SELECT token_hash, user_agent_hash FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.wallet = $1",
      [signer.address],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(await hashSessionToken(token));
    const dump = JSON.stringify(await env.db.db.query("SELECT * FROM sessions"));
    expect(dump).not.toContain(token);
  });

  test("a signed message works once (nonce burned), and only for our domain and URI", async () => {
    const n = await nonce();
    const { body } = await signedBody(n.input);
    const post = (b: unknown) =>
      fetch(`${env.base}/api/auth/signin`, { method: "POST", headers: { origin: ORIGIN }, body: JSON.stringify(b) });
    expect((await post(body)).status).toBe(200);
    const replay = await post(body);
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { error: string }).error).toContain("nonce_invalid");

    const wrongDomain = await signedBody((await nonce()).input, { domain: "zerofee.test.evil.example" });
    const r1 = await post(wrongDomain.body);
    expect(r1.status).toBe(401);
    expect(((await r1.json()) as { error: string }).error).toContain("domain_mismatch");

    const wrongUri = await signedBody((await nonce()).input, { uri: "https://evil.example" });
    expect(((await (await post(wrongUri.body)).json()) as { error: string }).error).toContain("uri_mismatch");

    const tampered = await signedBody((await nonce()).input);
    const sig = Buffer.from(tampered.body.signature, "base64");
    sig[0] = (sig[0] ?? 0) ^ 1;
    expect(((await (await post({ ...tampered.body, signature: sig.toString("base64") })).json()) as { error: string }).error).toContain(
      "invalid_signature",
    );

    const unknownNonce = await signedBody({ ...(await nonce()).input, nonce: "0123456789abcdef0123456789abcdef" });
    expect(((await (await post(unknownNonce.body)).json()) as { error: string }).error).toContain("nonce_invalid");
  });

  test("malformed bodies are 400, not 500", async () => {
    const post = (b: string) => fetch(`${env.base}/api/auth/signin`, { method: "POST", headers: { origin: ORIGIN }, body: b });
    expect((await post("not json")).status).toBe(400);
    expect((await post(JSON.stringify({ account: { address: 5 } }))).status).toBe(400);
    expect((await post(JSON.stringify({ account: { address: "x", publicKey: "!!" }, signedMessage: "AA", signature: "AA" }))).status).toBe(
      400,
    );
    expect(decodeSignInRequest({ account: { address: "a", publicKey: "AAAA" }, signedMessage: "AAAA", signature: "AAAA" })).not.toBeNull();
    expect(
      decodeSignInRequest({ account: { address: "a", publicKey: "AAAA" }, signedMessage: "AAAA", signature: "AAAA", signatureType: "rsa" }),
    ).toBeNull();
  });

  test("sign-in and sign-out refuse requests without our Origin (login CSRF)", async () => {
    const { body } = await signedBody((await nonce()).input);
    for (const origin of [null, "https://evil.example", "null", `${ORIGIN}/`, "http://zerofee.test"]) {
      const r = await fetch(`${env.base}/api/auth/signin`, {
        method: "POST",
        headers: origin ? { origin } : {},
        body: JSON.stringify(body),
      });
      expect(r.status).toBe(403);
    }
    expect((await fetch(`${env.base}/api/auth/signout`, { method: "POST", body: "{}" })).status).toBe(403);
  });
});

describe("sessions", () => {
  test("no cookie, a malformed cookie or a duplicated cookie name: 401", async () => {
    expect((await fetch(`${env.base}/api/me`)).status).toBe(401);
    expect((await fetch(`${env.base}/api/me`, { headers: { cookie: "__Host-zf_session=nope" } })).status).toBe(401);
    const b = new Browser(env);
    await b.signIn();
    expect((await fetch(`${env.base}/api/me`, { headers: { cookie: b.cookie as string } })).status).toBe(200);
    const dup = `${b.cookie}; ${b.cookie}`;
    expect((await fetch(`${env.base}/api/me`, { headers: { cookie: dup } })).status).toBe(401);
  });

  test("sessions expire at their absolute expiry, activity does not extend them", async () => {
    const b = new Browser(env);
    await b.signIn();
    env.clock.advance(3_600_000);
    expect((await b.req("GET", "/api/me")).status).toBe(200);
    env.clock.advance(3_600_000);
    expect((await b.req("GET", "/api/me")).status).toBe(401);
  });

  test("sign-out revokes the session and clears the cookie; the old cookie is dead", async () => {
    const b = new Browser(env);
    await b.signIn();
    const stolen = b.cookie as string;
    const r = await b.req("POST", "/api/auth/signout", {});
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(b.cookie).toBeNull();
    expect((await fetch(`${env.base}/api/me`, { headers: { cookie: stolen } })).status).toBe(401);
  });

  test("sign-out with all=true ends every session of the user; other users are untouched", async () => {
    const signer = await throwawaySigner();
    const laptop = new Browser(env);
    const phone = new Browser(env);
    const other = new Browser(env);
    await laptop.signIn(signer);
    await phone.signIn(signer);
    await other.signIn();
    expect((await phone.req("POST", "/api/auth/signout", { all: true })).status).toBe(200);
    expect((await laptop.req("GET", "/api/me")).status).toBe(401);
    expect((await other.req("GET", "/api/me")).status).toBe(200);
    expect((await phone.req("POST", "/api/auth/signout", { everything: true })).status).toBe(400);
  });

  test("signing in again rotates the browser's session; beyond SESSION_MAX_PER_USER the oldest is revoked", async () => {
    const signer = await throwawaySigner();
    const b = new Browser(env);
    await b.signIn(signer);
    const first = b.cookie as string;
    await b.signIn(signer);
    expect(b.cookie).not.toBe(first);
    expect((await fetch(`${env.base}/api/me`, { headers: { cookie: first } })).status).toBe(401);

    const devices = [new Browser(env), new Browser(env), new Browser(env)];
    for (const d of devices) {
      env.clock.advance(1_000); // distinct creation times: "oldest" is well defined
      await d.signIn(signer);
    }
    // cap 3: b's session (the oldest of four) is gone
    expect((await b.req("GET", "/api/me")).status).toBe(401);
    for (const d of devices) expect((await d.req("GET", "/api/me")).status).toBe(200);
  });
});

describe("CSRF on cookie-authenticated mutations", () => {
  test("POST /api/tx with the session cookie needs our Origin; anonymous dry-run calls do not", async () => {
    const b = new Browser(env);
    await b.signIn();
    const tx = Buffer.from(new Uint8Array([1, ...new Array(64).fill(0), 0x80, 1, 0, 1, 1, ...new Array(32).fill(3)])).toString("base64");
    const body = JSON.stringify({ tx, preset: "reduced" });
    const noOrigin = await fetch(`${env.base}/api/tx`, { method: "POST", headers: { cookie: b.cookie as string }, body });
    expect(noOrigin.status).toBe(403);
    const evil = await fetch(`${env.base}/api/tx`, {
      method: "POST",
      headers: { cookie: b.cookie as string, origin: "https://evil.example" },
      body,
    });
    expect(evil.status).toBe(403);
    const good = await fetch(`${env.base}/api/tx`, { method: "POST", headers: { cookie: b.cookie as string, origin: ORIGIN }, body });
    expect(good.status).toBe(200);
    expect((await fetch(`${env.base}/api/tx`, { method: "POST", body })).status).toBe(200); // no cookie: no ambient authority
  });
});

describe("rate limits", () => {
  test("nonce and sign-in are limited per IP; authenticated calls per user", async () => {
    const small = await startUserApp({ env: { RATE_LIMIT_AUTH_PER_MIN: "6", RATE_LIMIT_USER_RPS: "1", RATE_LIMIT_USER_BURST: "3" } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) statuses.push((await fetch(`${small.base}/api/auth/nonce`)).status);
      expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]); // burst max(5, 6/3)
      expect(statuses.at(-1)).toBe(429);

      const fresh = await startUserApp({ env: { RATE_LIMIT_USER_RPS: "1", RATE_LIMIT_USER_BURST: "3" }, db: small.db });
      try {
        const b = new Browser(fresh);
        await b.signIn();
        const me: number[] = [];
        for (let i = 0; i < 5; i++) me.push((await b.req("GET", "/api/me")).status);
        expect(me.slice(0, 3)).toEqual([200, 200, 200]);
        expect(me.at(-1)).toBe(429);
      } finally {
        await fresh.close();
      }
    } finally {
      await small.close();
    }
  }, 60_000);
});

describe("config", () => {
  test("PUBLIC_ORIGIN must be https unless it is loopback; origins are bare", () => {
    expect(loadConfig({}).auth).toMatchObject({
      publicOrigin: "http://127.0.0.1:8787",
      siwsDomain: "127.0.0.1:8787",
      cookieName: "__Host-zf_session",
    });
    expect(loadConfig({ PUBLIC_ORIGIN: "http://localhost:5173" }).auth.siwsDomain).toBe("localhost:5173");
    expect(() => loadConfig({ PUBLIC_ORIGIN: "http://zerofee.example" })).toThrow("https");
    expect(() => loadConfig({ PUBLIC_ORIGIN: "https://zerofee.example/app" })).toThrow("bare origin");
    const c = loadConfig({ PUBLIC_ORIGIN: "https://zerofee.example", ALLOWED_ORIGINS: "http://127.0.0.1:5173" });
    expect(c.auth.allowedOrigins).toEqual(["https://zerofee.example", "http://127.0.0.1:5173"]);
    expect(() => loadConfig({ ALLOWED_ORIGINS: "http://evil.example" })).toThrow();
    expect(() => loadConfig({ DATABASE_URL: "mysql://x" })).toThrow("postgres");
  });
});
