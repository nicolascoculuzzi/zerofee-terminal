/**
 * User-state database: migrations and every repository, run twice - through PGlite (dev/tests) and
 * through Bun.sql speaking the Postgres wire protocol (production driver) - so the SQL is known to
 * behave the same on both.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  iso,
  isUniqueViolation,
  LimitExceededError,
  MIGRATIONS,
  migrate,
  sqlState,
  toBytes,
  toInt,
  toJson,
  toMs,
  UserStore,
} from "../src/db/pg";
import type { TrackedWalletWrite } from "../src/db/pg/tracked";
import { setLogLevel } from "../src/log";
import { addr } from "./helpers";
import { bunSqlDb, DRIVERS, type TestDb } from "./pgHelpers";

setLogLevel("error");
const T0 = Date.UTC(2026, 9, 3, 12, 0, 0);
/** Latest schema version (assertions follow MIGRATIONS so adding one does not rewrite them). */
const LATEST = Math.max(...MIGRATIONS.map((m) => m.version));

describe("migrations through Bun.sql (production path)", () => {
  test("an empty database migrates over the wire protocol, in one transaction, idempotently", async () => {
    const t = await bunSqlDb({ migrate: false });
    try {
      expect(await t.db.query("SELECT to_regclass('public.users') AS t")).toEqual([{ t: null }]);
      expect(await migrate(t.db, MIGRATIONS, () => T0)).toEqual({ applied: MIGRATIONS.map((m) => m.version), version: LATEST });
      expect(await migrate(t.db)).toEqual({ applied: [], version: LATEST });
      const tables = (await t.db.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).map(
        (r) => r.tablename,
      );
      expect(tables).toEqual([
        "admin_audit_log",
        "alert_deliveries",
        "alerts",
        "armed_orders",
        "blacklists",
        "copy_signals",
        "copy_tasks",
        "nonce_slots",
        "notification_channels",
        "presets",
        "push_subscriptions",
        "schema_migrations",
        "sessions",
        "settings",
        "tracked_wallets",
        "trading_wallets",
        "users",
        "watchlist",
      ]);
      // The plpgsql trigger body ($$ ... $$) made it through the simple query protocol intact.
      await t.db.query("INSERT INTO admin_audit_log (at, actor, action, ok) VALUES (now(), 'x', 'y', true)");
      await expect(t.db.query("DELETE FROM admin_audit_log")).rejects.toThrow("append-only");
      // A failing migration rolls back entirely.
      const broken = [
        ...MIGRATIONS,
        { version: LATEST + 1, name: "broken", up: "CREATE TABLE ok_part (x int); SELECT no_such_function();" },
      ];
      await expect(migrate(t.db, broken)).rejects.toThrow();
      expect(await t.db.query("SELECT to_regclass('public.ok_part') AS t")).toEqual([{ t: null }]);
      expect((await t.db.query("SELECT max(version) AS v FROM schema_migrations"))[0]?.v).toBe(LATEST);
    } finally {
      await t.close();
    }
  }, 60_000);
});

describe.each(DRIVERS)("$name", ({ open }) => {
  let t: TestDb;
  let store: UserStore;

  beforeAll(async () => {
    t = await open();
    store = new UserStore(t.db);
  }, 60_000);
  afterAll(async () => {
    await t.close();
  });

  describe("driver", () => {
    test("migrations are recorded and idempotent; a newer schema refuses to start", async () => {
      const again = await migrate(t.db);
      expect(again).toEqual({ applied: [], version: LATEST });
      const rows = await t.db.query("SELECT version, name FROM schema_migrations ORDER BY version");
      expect(rows.map((r) => toInt(r.version))).toEqual(MIGRATIONS.map((m) => m.version));
      await expect(migrate(t.db, [])).rejects.toThrow("newer than this server");
    });

    test("value round-trips: uuid, timestamptz, jsonb, bytea, int8, float, bool", async () => {
      await t.db.exec("CREATE TEMP TABLE rt (id UUID, at TIMESTAMPTZ, j JSONB, b BYTEA, n BIGINT, f DOUBLE PRECISION, ok BOOLEAN)");
      const id = crypto.randomUUID();
      await t.db.query("INSERT INTO rt VALUES ($1::uuid, $2::timestamptz, $3::text::jsonb, $4, $5, $6, $7)", [
        id,
        iso(T0),
        JSON.stringify({ a: [1, "x"], nested: { y: true } }),
        new Uint8Array([0, 1, 254, 255]),
        "9000000000",
        0.000012345,
        true,
      ]);
      const [r] = await t.db.query("SELECT * FROM rt");
      expect(String(r?.id)).toBe(id);
      expect(toMs(r?.at)).toBe(T0);
      expect(toJson<Record<string, unknown>>(r?.j)).toEqual({ a: [1, "x"], nested: { y: true } });
      expect([...toBytes(r?.b)]).toEqual([0, 1, 254, 255]);
      expect(toInt(r?.n)).toBe(9_000_000_000);
      expect(Number(r?.f)).toBeCloseTo(0.000012345, 12);
      expect(r?.ok).toBe(true);
      // Stored as a document, not a JSON string scalar (what a bare `$3::jsonb` does through Bun.sql).
      expect((await t.db.query("SELECT jsonb_typeof(j) AS t FROM rt"))[0]?.t).toBe("object");
    });

    test("errors expose the SQLSTATE; transactions roll back on throw", async () => {
      await t.db.exec("CREATE TEMP TABLE uq (k TEXT PRIMARY KEY)");
      await t.db.query("INSERT INTO uq VALUES ($1)", ["a"]);
      const err = await t.db.query("INSERT INTO uq VALUES ($1)", ["a"]).catch((e) => e);
      expect(sqlState(err)).toBe("23505");
      expect(isUniqueViolation(err)).toBe(true);
      await expect(
        t.db.transaction(async (tx) => {
          await tx.query("INSERT INTO uq VALUES ($1)", ["b"]);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect((await t.db.query("SELECT k FROM uq ORDER BY k")).map((r) => r.k)).toEqual(["a"]);
      const v = await t.db.transaction(async (tx) => {
        await tx.query("INSERT INTO uq VALUES ($1)", ["c"]);
        return (await tx.query("SELECT count(*) AS n FROM uq"))[0]?.n;
      });
      expect(toInt(v)).toBe(2);
    });
  });

  describe("users and sessions", () => {
    test("first sign-in creates the user, later ones record the login", async () => {
      const wallet = addr("pg-user-1");
      const u1 = await store.users.upsertOnLogin(wallet, T0);
      const u2 = await store.users.upsertOnLogin(wallet, T0 + 5_000);
      expect(u2.id).toBe(u1.id);
      expect(u2.createdAt).toBe(T0);
      expect(u2.lastLoginAt).toBe(T0 + 5_000);
      expect((await store.users.byWallet(wallet))?.id).toBe(u1.id);
      expect((await store.users.byId(u1.id))?.wallet).toBe(wallet);
      expect(await store.users.byWallet(addr("nobody"))).toBeNull();
    });

    test("sessions resolve by token hash until they expire or are revoked; oldest beyond the cap are revoked", async () => {
      const u = await store.users.upsertOnLogin(addr("pg-user-2"), T0);
      const mk = (hash: string, at: number) =>
        store.users.createSession({ userId: u.id, tokenHash: hash, expiresAt: at + 3_600_000, userAgentHash: "ua", now: at, maxActive: 2 });
      const { session: s1, revoked: none } = await mk("h1", T0);
      expect(none).toEqual([]);
      expect(s1).toMatchObject({ userId: u.id, wallet: u.wallet, createdAt: T0, expiresAt: T0 + 3_600_000 });
      expect((await store.users.findSession("h1", T0 + 1))?.id).toBe(s1.id);
      expect(await store.users.findSession("h1", T0 + 3_600_000)).toBeNull(); // expired
      expect(await store.users.findSession("nope", T0)).toBeNull();

      await mk("h2", T0 + 1_000);
      const { revoked } = await mk("h3", T0 + 2_000); // cap 2: h1 (oldest) is revoked
      expect(revoked).toEqual([s1.id]);
      expect(await store.users.findSession("h1", T0 + 3_000)).toBeNull();
      expect(await store.users.findSession("h2", T0 + 3_000)).not.toBeNull();
      expect(await store.users.activeSessionCount(T0 + 3_000, u.id)).toBe(2);

      const s2 = await store.users.findSession("h2", T0 + 3_000);
      expect(await store.users.revokeSession(s2!.id, T0 + 4_000)).toBe(true);
      expect(await store.users.revokeSession(s2!.id, T0 + 4_000)).toBe(false);
      expect(await store.users.findSession("h2", T0 + 5_000)).toBeNull();
      expect((await store.users.revokeAllSessions(u.id, T0 + 6_000)).length).toBe(1);
      expect(await store.users.findSession("h3", T0 + 7_000)).toBeNull();
      expect(await store.users.purgeSessions(T0 + 10 * 3_600_000)).toBeGreaterThanOrEqual(3);
    });

    test("trading wallets: public keys + labels, capped, and ownership for wallet topics", async () => {
      const u = await store.users.upsertOnLogin(addr("pg-user-3"), T0);
      const k1 = addr("tw-1");
      await store.users.upsertTradingWallet(u.id, k1, "main", T0, 2);
      await store.users.upsertTradingWallet(u.id, k1, undefined, T0 + 1, 2); // no label: keeps "main"
      expect(await store.users.listTradingWallets(u.id)).toEqual([{ publicKey: k1, label: "main", createdAt: T0 }]);
      await store.users.upsertTradingWallet(u.id, addr("tw-2"), "", T0, 2);
      await expect(store.users.upsertTradingWallet(u.id, addr("tw-3"), "", T0, 2)).rejects.toBeInstanceOf(LimitExceededError);
      expect((await store.users.listTradingWallets(u.id)).length).toBe(2); // rolled back
      expect((await store.users.setTradingWalletLabel(u.id, k1, "renamed"))?.label).toBe("renamed");
      expect(await store.users.ownsWallet(u.id, k1)).toBe(true);
      expect(await store.users.ownsWallet(u.id, u.wallet)).toBe(true);
      expect(await store.users.ownsWallet(u.id, addr("someone-else"))).toBe(false);
      expect(await store.users.deleteTradingWallet(u.id, k1)).toBe(true);
      expect(await store.users.ownsWallet(u.id, k1)).toBe(false);
    });

    test("armed orders (placeholder table) feed the orders snapshot", async () => {
      const u = await store.users.upsertOnLogin(addr("pg-user-orders"), T0);
      expect(await store.users.listOrders(u.id)).toEqual([]);
      await t.db.query(
        `INSERT INTO armed_orders (id, user_id, kind, status, mint, side, amount, trigger, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'take_profit', 'armed', $3, 'sell', '1000', $4::text::jsonb, $5::timestamptz, $5::timestamptz)`,
        [crypto.randomUUID(), u.id, addr("mint"), JSON.stringify({ metric: "mc_sol", op: "gte", value: 500 }), iso(T0)],
      );
      const [o] = await store.users.listOrders(u.id);
      expect(o).toMatchObject({ kind: "take_profit", status: "armed", side: "sell", amount: "1000", nonceAccount: null });
      expect(o?.trigger).toEqual({ metric: "mc_sol", op: "gte", value: 500 });
    });
  });

  describe("presets, settings, watchlist, blacklists", () => {
    test("presets and settings store validated JSON", async () => {
      const u = await store.users.upsertOnLogin(addr("pg-user-4"), T0);
      expect(await store.prefs.listPresets(u.id)).toEqual([]);
      await store.prefs.putPreset(u.id, 2, "Safe", { buy: { slippageBps: 500 } }, T0);
      await store.prefs.putPreset(u.id, 2, "Safer", { buy: { slippageBps: 300 } }, T0 + 1);
      expect(await store.prefs.listPresets(u.id)).toEqual([
        { slot: 2, name: "Safer", config: { buy: { slippageBps: 300 } }, updatedAt: T0 + 1 },
      ]);
      expect(await store.prefs.getSettings(u.id)).toBeNull();
      await store.prefs.putSettings(u.id, { theme: "light" }, T0);
      expect(await store.prefs.getSettings(u.id)).toEqual({ theme: "light" });
      const many = await store.prefs.settingsOf([u.id, crypto.randomUUID()]);
      expect([...many.entries()]).toEqual([[u.id, { theme: "light" }]]);
    });

    test("watchlist is idempotent and capped; blacklists per kind", async () => {
      const u = await store.users.upsertOnLogin(addr("pg-user-5"), T0);
      const m1 = addr("w1");
      expect(await store.prefs.addWatch(u.id, m1, T0, 2)).toEqual({ mint: m1, addedAt: T0 });
      expect(await store.prefs.addWatch(u.id, m1, T0 + 9, 2)).toEqual({ mint: m1, addedAt: T0 });
      await store.prefs.addWatch(u.id, addr("w2"), T0 + 1, 2);
      await expect(store.prefs.addWatch(u.id, addr("w3"), T0 + 2, 2)).rejects.toBeInstanceOf(LimitExceededError);
      expect((await store.prefs.listWatchlist(u.id)).map((w) => w.mint)).toEqual([addr("w2"), m1]);
      expect(await store.prefs.removeWatch(u.id, m1)).toBe(true);
      expect(await store.prefs.removeWatch(u.id, m1)).toBe(false);

      await store.prefs.addBlacklist(u.id, "dev", addr("dev1"), "rugger", T0, 1);
      await store.prefs.addBlacklist(u.id, "dev", addr("dev1"), undefined, T0 + 5, 1); // keeps the note
      await store.prefs.addBlacklist(u.id, "x", "scamcaller", "", T0, 1); // separate cap per kind
      await expect(store.prefs.addBlacklist(u.id, "dev", addr("dev2"), "", T0, 1)).rejects.toBeInstanceOf(LimitExceededError);
      const bl = await store.prefs.listBlacklists(u.id);
      expect(bl).toEqual([
        { kind: "dev", value: addr("dev1"), note: "rugger", addedAt: T0 },
        { kind: "x", value: "scamcaller", note: "", addedAt: T0 },
      ]);
      expect(await store.prefs.removeBlacklist(u.id, "x", "scamcaller")).toBe(true);
    });
  });

  describe("tracked wallets", () => {
    const w = (tag: string, o: Partial<TrackedWalletWrite> = {}): TrackedWalletWrite => ({
      address: addr(tag),
      label: tag,
      emoji: "🐳",
      tags: [],
      alerts: { buy: false, sell: false, create: false, minSol: 0 },
      ...o,
    });

    test("bulk upsert (merge keeps alert flags), replace, update, remove, alerting index", async () => {
      const u = await store.users.upsertOnLogin(addr("pg-user-6"), T0);
      const r1 = await store.tracked.upsertMany(u.id, [w("a", { alerts: { buy: true, sell: false, create: false, minSol: 1 } }), w("b")], {
        now: T0,
        max: 10,
        overwriteAlerts: true,
      });
      expect(r1).toEqual({ added: 2, updated: 0, removed: 0 });
      // An import relabels "a" without touching its alerts, and adds "c".
      const r2 = await store.tracked.upsertMany(u.id, [w("a", { label: "whale A", tags: ["kol"] }), w("c")], { now: T0 + 1, max: 10 });
      expect(r2).toEqual({ added: 1, updated: 1, removed: 0 });
      const a = await store.tracked.get(u.id, addr("a"));
      expect(a).toMatchObject({ label: "whale A", tags: ["kol"], alerts: { buy: true, minSol: 1 }, createdAt: T0, updatedAt: T0 + 1 });

      const alerting = await store.tracked.listAlerting();
      expect(alerting.filter((x) => x.userId === u.id)).toEqual([
        {
          userId: u.id,
          address: addr("a"),
          label: "whale A",
          emoji: "🐳",
          alerts: { buy: true, sell: false, create: false, minSol: 1, firstBuyOnly: false },
        },
      ]);

      const r3 = await store.tracked.upsertMany(u.id, [w("c"), w("d")], { now: T0 + 2, max: 10, replace: true });
      expect(r3).toEqual({ added: 1, updated: 1, removed: 2 });
      expect((await store.tracked.list(u.id)).map((x) => x.label)).toEqual(["c", "d"]);

      const upd = await store.tracked.update(u.id, addr("d"), { emoji: "🔥", alerts: { sell: true, minSol: 0.5 } }, T0 + 3);
      expect(upd).toMatchObject({ emoji: "🔥", label: "d", alerts: { buy: false, sell: true, create: false, minSol: 0.5 } });
      expect(await store.tracked.update(u.id, addr("zz"), { label: "x" }, T0)).toBeNull();
      expect(await store.tracked.remove(u.id, addr("c"))).toBe(true);
      expect(await store.tracked.remove(u.id, addr("c"))).toBe(false);
    });

    test("caps the list (and rolls the whole import back)", async () => {
      const u = await store.users.upsertOnLogin(addr("pg-user-7"), T0);
      await store.tracked.upsertMany(u.id, [w("x1"), w("x2")], { now: T0, max: 3 });
      await expect(store.tracked.upsertMany(u.id, [w("x3"), w("x4")], { now: T0, max: 3 })).rejects.toBeInstanceOf(LimitExceededError);
      expect((await store.tracked.list(u.id)).length).toBe(2);
    });

    test("2,500 wallets in one import (chunked statements)", async () => {
      const u = await store.users.upsertOnLogin(addr("pg-user-8"), T0);
      const many = Array.from({ length: 2_500 }, (_, i) => w(`bulk-${i}`));
      expect(await store.tracked.upsertMany(u.id, many, { now: T0, max: 10_000 })).toEqual({ added: 2_500, updated: 0, removed: 0 });
      expect((await store.tracked.list(u.id)).length).toBe(2_500);
    });
  });

  describe("alerts, channels, push, deliveries", () => {
    const alert = {
      type: "price" as const,
      params: { mint: addr("alert-mint"), currency: "usd" as const, direction: "above" as const, value: 0.001 },
      channels: ["push" as const, "telegram" as const],
      priority: "high" as const,
      repeat: "once" as const,
      cooldownSec: 900,
      enabled: true,
      note: "",
    };

    test("alert CRUD, firing and re-arming", async () => {
      const u = await store.users.upsertOnLogin(addr("pg-user-9"), T0);
      const a = await store.notify.createAlert(u.id, alert, T0, 5);
      expect(a).toMatchObject({ userId: u.id, armed: true, enabled: true, fireCount: 0, lastFiredAt: null, params: alert.params });
      expect((await store.notify.listEnabledAlerts()).some((x) => x.id === a.id)).toBe(true);
      await store.notify.recordFire(a.id, T0 + 10, true);
      const fired = await store.notify.getAlert(u.id, a.id);
      expect(fired).toMatchObject({ enabled: false, armed: false, fireCount: 1, lastFiredAt: T0 + 10 });
      expect((await store.notify.listEnabledAlerts()).some((x) => x.id === a.id)).toBe(false);
      const re = await store.notify.updateAlert(u.id, a.id, { ...alert, repeat: "rearm" }, true, T0 + 20);
      expect(re).toMatchObject({ enabled: true, armed: true, repeat: "rearm", fireCount: 1 });
      expect(await store.notify.updateAlert(crypto.randomUUID(), a.id, alert, false, T0)).toBeNull(); // not the owner
      expect(await store.notify.deleteAlert(u.id, a.id)).toBe(true);
    });

    test("telegram link: single use, expires, binds the chat; /stop disables it", async () => {
      const u = await store.users.upsertOnLogin(addr("pg-user-10"), T0);
      await store.notify.createTelegramLink(u.id, "codehash-old", T0 + 600_000, T0, 5);
      await store.notify.createTelegramLink(u.id, "codehash-1", T0 + 600_000, T0 + 1, 5); // replaces the pending one
      expect((await store.notify.listChannels(u.id)).filter((c) => c.status === "pending").length).toBe(1);
      expect(await store.notify.consumeTelegramLink("codehash-old", "111", "@old", T0 + 2)).toBeNull();
      expect(await store.notify.consumeTelegramLink("codehash-1", "111", "@alice", T0 + 700_000)).toBeNull(); // expired
      await store.notify.createTelegramLink(u.id, "codehash-2", T0 + 600_000, T0 + 3, 5);
      const linked = await store.notify.consumeTelegramLink("codehash-2", "111", "@alice", T0 + 4);
      expect(linked).toMatchObject({ userId: u.id, wallet: u.wallet });
      expect(await store.notify.consumeTelegramLink("codehash-2", "111", "@alice", T0 + 5)).toBeNull(); // single use
      const [ch] = await store.notify.listChannels(u.id);
      expect(ch).toMatchObject({ kind: "telegram", status: "active", target: "@alice" });
      expect(await store.notify.targets(u.id, ["telegram"])).toEqual([{ kind: "telegram", id: linked!.channelId, chatId: "111" }]);
      expect(await store.notify.disableTelegramChat("111", "user sent /stop", T0 + 6)).toEqual([u.id]);
      expect(await store.notify.targets(u.id, ["telegram"])).toEqual([]);
    });

    test("discord channels keep only ciphertext; push subscriptions move between users", async () => {
      const u = await store.users.upsertOnLogin(addr("pg-user-11"), T0);
      const enc = new Uint8Array([1, 2, 3, 4, 5]);
      const id = crypto.randomUUID();
      const ch = await store.notify.createDiscordChannel(
        u.id,
        { id, label: "alpha", webhookEnc: enc, webhookHash: "hh", hint: "discord.com/…" },
        T0,
        5,
      );
      expect(ch).toMatchObject({ id, kind: "discord", status: "active", target: "discord.com/…" });
      const dup = await store.notify
        .createDiscordChannel(u.id, { id: crypto.randomUUID(), label: "", webhookEnc: enc, webhookHash: "hh", hint: "" }, T0, 5)
        .catch((e) => e);
      expect(isUniqueViolation(dup)).toBe(true);
      const t1 = await store.notify.getChannelTarget(u.id, id);
      expect(t1?.kind === "discord" && [...t1.webhookEnc]).toEqual([1, 2, 3, 4, 5]);

      const endpoint = "https://fcm.googleapis.com/fcm/send/abc";
      const first = await store.notify.upsertPush(u.id, { endpoint, p256dh: "k", auth: "a", userAgentHash: null }, T0, 5);
      expect(first).toMatchObject({ info: { endpointHost: "fcm.googleapis.com", lastSuccessAt: null }, previousOwners: [] });
      const again = await store.notify.upsertPush(u.id, { endpoint, p256dh: "k1", auth: "a1", userAgentHash: null }, T0, 5);
      expect(again.info.id).toBe(first.info.id); // same browser, same account: keys refreshed in place
      const other = await store.users.upsertOnLogin(addr("pg-user-12"), T0);
      const moved = await store.notify.upsertPush(other.id, { endpoint, p256dh: "k2", auth: "a2", userAgentHash: null }, T0 + 1, 5);
      expect(moved.previousOwners).toEqual([u.id]);
      expect(moved.info.id).not.toBe(first.info.id); // a new row: nothing of the old owner follows it
      expect(await store.notify.listPush(u.id)).toEqual([]);
      expect((await store.notify.targets(other.id, ["push", "discord"])).map((x) => x.kind)).toEqual(["push"]);
      expect((await store.notify.targets(u.id, ["push", "discord"])).map((x) => x.kind)).toEqual(["discord"]);
      await store.notify.pushOk(moved.info.id, T0 + 2);
      expect((await store.notify.listPush(other.id))[0]?.lastSuccessAt).toBe(T0 + 2);
      expect(await store.notify.deletePushByEndpoint(other.id, endpoint)).toBe(true);
      expect(await store.notify.deleteChannel(u.id, id)).toBe(true);
    });

    test("deliveries: batch insert survives deleted alerts, newest first, purge", async () => {
      const u = await store.users.upsertOnLogin(addr("pg-user-13"), T0);
      const a = await store.notify.createAlert(u.id, alert, T0, 5);
      await store.notify.deleteAlert(u.id, a.id);
      const base = { userId: u.id, source: "price" as const, targetId: null, priority: "high" as const, digestCount: 1, error: null };
      await store.notify.recordDeliveries([
        { ...base, alertId: a.id, channel: "push", status: "sent", title: "first", createdAt: T0 },
        { ...base, alertId: null, channel: "telegram", status: "failed", title: "second", error: "403", createdAt: T0 + 1 },
        { ...base, userId: crypto.randomUUID(), alertId: null, channel: "push", status: "sent", title: "ghost", createdAt: T0 },
      ]);
      const list = await store.notify.listDeliveries(u.id, 10);
      expect(list.map((d) => [d.title, d.status, d.alertId])).toEqual([
        ["second", "failed", null],
        ["first", "sent", null],
      ]);
      expect(await store.notify.purgeDeliveries(T0 + 1)).toBe(1);
    });
  });

  describe("admin audit log", () => {
    test("append-only; the latest halt/resume is recoverable", async () => {
      expect(await store.audit.lastHaltChange()).toBeNull();
      await store.audit.append({ at: T0, actor: "ops", action: "halt", ok: true, ip: "10.0.0.1", detail: { reason: "incident" } });
      await store.audit.append({ at: T0 + 1, actor: "ops", action: "lookup_user", target: addr("x"), ok: true });
      await store.audit.append({ at: T0 + 2, actor: "anonymous", action: "auth_failed", ok: false });
      const last = await store.audit.lastHaltChange();
      expect(last).toMatchObject({ action: "halt", actor: "ops", detail: { reason: "incident" }, at: T0 });
      const page = await store.audit.list(2);
      expect(page.map((e) => e.action)).toEqual(["auth_failed", "lookup_user"]);
      expect((await store.audit.list(10, page[1]!.id)).map((e) => e.action)).toEqual(["halt"]);
      await expect(t.db.query("UPDATE admin_audit_log SET actor = 'x'")).rejects.toThrow("append-only");
      await expect(t.db.query("DELETE FROM admin_audit_log")).rejects.toThrow("append-only");
      await expect(t.db.exec("TRUNCATE admin_audit_log")).rejects.toThrow("append-only");
      expect((await store.audit.list(10)).length).toBe(3);
    });
  });
});
