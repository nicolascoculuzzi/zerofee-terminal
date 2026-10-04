/**
 * WebSocket authentication: public market topics stay open; `orders` and `wallet:<address>` need the
 * session cookie (from an allowed Origin), are scoped to the signed-in user, and the socket closes
 * when the session is revoked or expires.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { WalletSnapshot } from "@zerofee/protocol";
import { WS_CLOSE_SESSION_ENDED } from "../src/gateway/server";
import { addr } from "./helpers";
import { Browser, startUserApp, type UserTestEnv, WsClient } from "./userHelpers";

let env: UserTestEnv;
const fundedLooking = addr("ws-trading-wallet");

beforeAll(async () => {
  env = await startUserApp({
    env: { WS_MAX_CONN_PER_USER: "2" },
    // Stand-in for the Phase 6 wallet feed: only this wallet has a snapshot.
    walletSnapshot: async (address): Promise<WalletSnapshot | null> =>
      address === fundedLooking ? { address, lamports: "5000", tokens: [], fills: [], slot: 1 } : null,
  });
}, 60_000);
afterAll(async () => {
  await env.close();
});

describe("anonymous sockets", () => {
  test("market topics work; user topics answer unauthorized", async () => {
    const c = await WsClient.connect(env.ws);
    c.send({ type: "subscribe", topic: "chain" });
    const snap = await c.next((m) => m.topic === "chain" && m.type === "snapshot");
    expect(snap.data.halt).toEqual({ halted: false, reason: null, since: null });
    c.send({ type: "subscribe", topic: "orders" });
    c.send({ type: "subscribe", topic: `wallet:${fundedLooking}` });
    const errs = await Promise.all([
      c.next((m) => m.type === "error" && m.topic === "orders"),
      c.next((m) => m.type === "error" && m.topic === `wallet:${fundedLooking}`),
    ]);
    expect(errs.map((e) => e.code)).toEqual(["unauthorized", "unauthorized"]);
    c.ws.close();
  });

  test("a forged or foreign-origin cookie never upgrades a signed-in socket", async () => {
    const b = new Browser(env);
    await b.signIn();
    // Cookie present but from another site: refused outright (cross-site WebSocket hijacking).
    await expect(WsClient.connect(env.ws, { cookie: b.cookie as string, origin: "https://evil.example" })).rejects.toThrow();
    await expect(WsClient.connect(env.ws, { cookie: b.cookie as string })).rejects.toThrow();
    // A bogus cookie is just anonymous.
    const anon = await WsClient.connect(env.ws, { cookie: "__Host-zf_session=forged", origin: "https://evil.example" });
    anon.send({ type: "subscribe", topic: "orders" });
    expect((await anon.next((m) => m.type === "error")).code).toBe("unauthorized");
    anon.ws.close();
  });
});

describe("signed-in sockets", () => {
  test("orders: snapshot from the armed-orders table, deltas only reach their owner", async () => {
    const alice = new Browser(env);
    const bob = new Browser(env);
    const { me: aliceMe } = await alice.signIn();
    await bob.signIn();
    const a = await alice.socket();
    const b = await bob.socket();
    a.send({ type: "subscribe", topic: "orders" });
    b.send({ type: "subscribe", topic: "orders" });
    const snapA = await a.next((m) => m.topic === "orders" && m.type === "snapshot");
    await b.next((m) => m.topic === "orders" && m.type === "snapshot");
    expect(snapA.data).toEqual({ orders: [] });

    const aliceId = (await env.user.store.users.byWallet(aliceMe.wallet))?.id as string;
    const order = {
      id: "o1",
      kind: "stop_loss" as const,
      status: "armed" as const,
      mint: addr("m"),
      side: "sell" as const,
      amount: "1",
      trigger: { metric: "mc_sol" as const, op: "lte" as const, value: 10 },
      nonceAccount: null,
      signature: null,
      createdAt: 1,
      updatedAt: 1,
      error: null,
    };
    expect(env.app.gateway.publishOrders(aliceId, { upsert: [order], remove: [] })).toBe(true);
    const delta = await a.next((m) => m.topic === "orders" && m.type === "delta");
    expect(delta.seq).toBe((snapA.seq ?? 0) + 1);
    expect(delta.data.upsert[0].id).toBe("o1");
    await Bun.sleep(100);
    expect(b.msgs.filter((m) => m.type === "delta")).toEqual([]);
    a.ws.close();
    b.ws.close();
  });

  test("wallet: own main or trading wallet only; unknown feeds answer unavailable", async () => {
    const b = new Browser(env);
    const { me } = await b.signIn();
    const userId = (await env.user.store.users.byWallet(me.wallet))?.id as string;
    await env.user.store.users.upsertTradingWallet(userId, fundedLooking, "trading", Date.now(), 25);
    const c = await b.socket();
    c.send({ type: "subscribe", topic: `wallet:${addr("someone-else")}` });
    expect((await c.next((m) => m.type === "error")).code).toBe("forbidden");
    c.send({ type: "subscribe", topic: `wallet:${me.wallet}` });
    expect((await c.next((m) => m.type === "error" && m.topic === `wallet:${me.wallet}`)).code).toBe("unavailable");
    c.send({ type: "subscribe", topic: `wallet:${fundedLooking}` });
    const snap = await c.next((m) => m.type === "snapshot" && m.topic === `wallet:${fundedLooking}`);
    expect(snap.data).toMatchObject({ address: fundedLooking, lamports: "5000" });
    expect(env.app.gateway.publishWallet(fundedLooking, { lamports: "4000" })).toBe(true);
    expect((await c.next((m) => m.type === "delta" && m.topic === `wallet:${fundedLooking}`)).data).toEqual({ lamports: "4000" });
    c.send({ type: "unsubscribe", topic: `wallet:${fundedLooking}` });
    await Bun.sleep(50);
    expect(env.app.gateway.publishWallet(fundedLooking, { lamports: "1" })).toBe(false); // nobody listens any more
    c.ws.close();
  });

  test("signing out closes the account's sockets with 4401", async () => {
    const b = new Browser(env);
    await b.signIn();
    const c = await b.socket();
    c.send({ type: "subscribe", topic: "orders" });
    await c.next((m) => m.type === "snapshot");
    await b.req("POST", "/api/auth/signout", {});
    expect((await c.waitClosed()).code).toBe(WS_CLOSE_SESSION_ENDED);
  });

  test("expired sessions are closed by the sweep", async () => {
    const b = new Browser(env);
    const { me } = await b.signIn();
    const c = await b.socket();
    env.app.gateway.closeExpiredSessions(me.session.expiresAt - 1);
    await Bun.sleep(50);
    expect(c.closed).toBeNull();
    env.app.gateway.closeExpiredSessions(me.session.expiresAt);
    expect((await c.waitClosed()).code).toBe(WS_CLOSE_SESSION_ENDED);
  });

  test("per-account connection cap", async () => {
    const b = new Browser(env);
    await b.signIn();
    const s1 = await b.socket();
    const s2 = await b.socket();
    await expect(b.socket()).rejects.toThrow();
    s1.ws.close();
    await Bun.sleep(50);
    const s3 = await b.socket();
    s2.ws.close();
    s3.ws.close();
  });
});
