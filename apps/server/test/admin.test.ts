/**
 * Admin kill switch and operator endpoints: bearer-token auth (constant-time, named operators),
 * every call audited (failures included), halt refuses POST /api/tx and is published on the `chain`
 * topic, the state survives a restart, and the user lookup exposes counts only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AdminAuditEntry, AdminStatusResponse, AdminUserLookup, HaltState } from "@zerofee/protocol";
import { parseAdminTokens } from "../src/config";
import { constantTimeEqual } from "../src/util/hash";
import { addr } from "./helpers";
import { Browser, ORIGIN, startUserApp, type UserTestEnv, WsClient } from "./userHelpers";

const ALICE_TOKEN = "alice-ops-token-0123456789abcdefghijklmnop";
const BOB_TOKEN = "bob-ops-token-0123456789abcdefghijklmnopqrs";
let env: UserTestEnv;

beforeAll(async () => {
  env = await startUserApp({ env: { ADMIN_TOKEN: `alice:${ALICE_TOKEN},bob:${BOB_TOKEN}`, RATE_LIMIT_ADMIN_PER_MIN: "60000" } });
}, 60_000);
afterAll(async () => {
  await env.close();
});

const admin = (path: string, token: string | null, init: { method?: string; body?: unknown } = {}) =>
  fetch(`${env.base}${path}`, {
    method: init.method ?? "GET",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "user-agent": "ops-cli/1.0" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

const TX = Buffer.from(new Uint8Array([1, ...new Array(64).fill(0), 0x80, 1, 0, 1, 1, ...new Array(32).fill(3)])).toString("base64");
const postTx = (headers: Record<string, string> = {}) =>
  fetch(`${env.base}/api/tx`, { method: "POST", headers, body: JSON.stringify({ tx: TX, preset: "reduced" }) });

describe("admin authentication", () => {
  test("constant-time compare and token parsing", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(parseAdminTokens(ALICE_TOKEN)).toEqual([{ name: "admin", token: ALICE_TOKEN, named: false }]);
    expect(parseAdminTokens(`alice:${ALICE_TOKEN}, bob:${BOB_TOKEN}`).map((e) => e.name)).toEqual(["alice", "bob"]);
    expect(() => parseAdminTokens("short")).toThrow("32 characters");
    expect(() => parseAdminTokens(`${ALICE_TOKEN},bob:${BOB_TOKEN}`)).toThrow("name:token");
    expect(() => parseAdminTokens(`a:${ALICE_TOKEN},a:${BOB_TOKEN}`)).toThrow("unique");
  });

  test("no token, a wrong token or a session cookie: 401, and each attempt is audited", async () => {
    const before = (await env.user.store.audit.list(500)).filter((e) => e.action === "auth_failed").length;
    expect((await admin("/api/admin/status", null)).status).toBe(401);
    expect((await admin("/api/admin/status", `${ALICE_TOKEN}x`)).status).toBe(401);
    const user = new Browser(env);
    await user.signIn();
    expect((await fetch(`${env.base}/api/admin/status`, { headers: { cookie: user.cookie as string, origin: ORIGIN } })).status).toBe(401);
    const failures = (await env.user.store.audit.list(500)).filter((e) => e.action === "auth_failed");
    expect(failures.length - before).toBe(3);
    expect(failures[0]).toMatchObject({ actor: "unauthenticated", ok: false, target: "/api/admin/status", ip: "127.0.0.1" });
  });

  test("admin calls are rate limited per IP (failed attempts included, so they cannot flood the log)", async () => {
    const slow = await startUserApp({ db: env.db, env: { ADMIN_TOKEN: ALICE_TOKEN, RATE_LIMIT_ADMIN_PER_MIN: "60" } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++)
        statuses.push((await fetch(`${slow.base}/api/admin/status`, { headers: { authorization: "Bearer wrong" } })).status);
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(statuses.at(-1)).toBe(429);
    } finally {
      await slow.close();
    }
  }, 60_000);

  test("admin endpoints are off without ADMIN_TOKEN", async () => {
    const off = await startUserApp({ db: env.db });
    try {
      expect((await fetch(`${off.base}/api/admin/status`, { headers: { authorization: `Bearer ${ALICE_TOKEN}` } })).status).toBe(404);
    } finally {
      await off.close();
    }
  }, 60_000);
});

describe("kill switch", () => {
  test("halt refuses POST /api/tx (signed in or not), is published on chain, and resume restores trading", async () => {
    const ws = await WsClient.connect(env.ws);
    ws.send({ type: "subscribe", topic: "chain" });
    const snap = await ws.next((m) => m.topic === "chain" && m.type === "snapshot");
    expect(snap.data.halt).toEqual({ halted: false, reason: null, since: null });
    expect((await postTx()).status).toBe(200);

    const r = await admin("/api/admin/halt", ALICE_TOKEN, { method: "POST", body: { reason: "incident: relay outage" } });
    expect(r.status).toBe(200);
    const state = (await r.json()) as HaltState;
    expect(state).toMatchObject({ halted: true, reason: "incident: relay outage" });
    expect(state.since).toBeGreaterThan(0);

    const delta = await ws.next((m) => m.topic === "chain" && m.type === "delta" && m.data.halt?.halted === true);
    expect(delta.data.halt).toEqual(state);

    const refused = await postTx();
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: "trading is halted: incident: relay outage", code: "halted" });
    const user = new Browser(env);
    await user.signIn();
    expect((await postTx({ cookie: user.cookie as string, origin: ORIGIN })).status).toBe(503);

    const status = (await (await admin("/api/admin/status", BOB_TOKEN)).json()) as AdminStatusResponse;
    expect(status.halt.halted).toBe(true);
    expect(status.users).toBeGreaterThanOrEqual(1);

    expect((await admin("/api/admin/resume", BOB_TOKEN, { method: "POST" })).status).toBe(200);
    await ws.next((m) => m.topic === "chain" && m.type === "delta" && m.data.halt?.halted === false);
    expect((await postTx()).status).toBe(200);

    const log = await env.user.store.audit.list(20);
    const halt = log.find((e) => e.action === "halt");
    const resume = log.find((e) => e.action === "resume");
    expect(halt).toMatchObject({ actor: "alice", ok: true, ip: "127.0.0.1", detail: { reason: "incident: relay outage" } });
    expect(resume).toMatchObject({ actor: "bob", ok: true, detail: { wasHalted: true } });
    ws.ws.close();
  });

  test("the halt survives a restart (state comes back from the audit log)", async () => {
    expect((await admin("/api/admin/halt", ALICE_TOKEN, { method: "POST", body: {} })).status).toBe(200);
    const restarted = await startUserApp({ db: env.db, env: { ADMIN_TOKEN: `alice:${ALICE_TOKEN}` } });
    try {
      expect((await fetch(`${restarted.base}/api/tx`, { method: "POST", body: JSON.stringify({ tx: TX }) })).status).toBe(503);
      const ws = await WsClient.connect(restarted.ws);
      ws.send({ type: "subscribe", topic: "chain" });
      expect((await ws.next((m) => m.type === "snapshot")).data.halt).toMatchObject({ halted: true, reason: null });
      ws.ws.close();
      const r = await fetch(`${restarted.base}/api/admin/resume`, { method: "POST", headers: { authorization: `Bearer ${ALICE_TOKEN}` } });
      expect(r.status).toBe(200);
    } finally {
      await restarted.close();
    }
    // The first instance's in-memory state is stale now; resume it too so later tests start clean.
    await admin("/api/admin/resume", ALICE_TOKEN, { method: "POST" });
  }, 60_000);
});

describe("lookups", () => {
  test("user lookup returns counts only and is audited; the audit log read is audited too", async () => {
    const b = new Browser(env);
    const { me } = await b.signIn();
    await b.req("POST", "/api/trading-wallets", { publicKey: addr("lookup-tw") });
    await b.req("POST", "/api/tracked-wallets", { address: addr("lookup-kol") });
    const r = await admin(`/api/admin/users/${me.wallet}`, ALICE_TOKEN);
    expect(r.status).toBe(200);
    const body = (await r.json()) as AdminUserLookup;
    expect(body).toMatchObject({
      wallet: me.wallet,
      tradingWallets: 1,
      trackedWallets: 1,
      alerts: 0,
      notificationChannels: 0,
      activeSessions: 1,
    });
    expect(JSON.stringify(body)).not.toContain(addr("lookup-tw"));
    expect(JSON.stringify(body)).not.toContain(addr("lookup-kol"));
    expect((await admin(`/api/admin/users/${addr("nobody-here")}`, ALICE_TOKEN)).status).toBe(404);
    expect((await admin("/api/admin/users/not-a-wallet", ALICE_TOKEN)).status).toBe(400);

    const entries = (await (await admin("/api/admin/audit?limit=5", BOB_TOKEN)).json()) as AdminAuditEntry[];
    expect(entries.map((e) => e.action)).toEqual(["read_audit", "lookup_user", "lookup_user", "resume", "resume"].slice(0, entries.length));
    expect(entries[0]).toMatchObject({ actor: "bob", detail: { limit: 5 } });
    expect(entries[1]).toMatchObject({ actor: "alice", target: addr("nobody-here"), ok: false });
    expect(entries[2]).toMatchObject({ actor: "alice", target: me.wallet, ok: true });
    const older = (await (await admin(`/api/admin/audit?limit=2&before=${entries[2]?.id}`, BOB_TOKEN)).json()) as AdminAuditEntry[];
    expect(older.every((e) => e.id < (entries[2]?.id ?? 0))).toBe(true);
    // The log cannot be edited through the database either.
    await expect(env.db.db.query("UPDATE admin_audit_log SET actor = 'mallory'")).rejects.toThrow("append-only");
  });
});
