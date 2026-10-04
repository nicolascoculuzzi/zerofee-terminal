/**
 * Operator endpoints (protocol admin.ts). Bearer ADMIN_TOKEN only (router.ts), per-IP rate limited,
 * and every call is written to the append-only audit log with who (token name or fingerprint), what,
 * when and from where - including lookups and reads of the audit log itself (SPEC "Insider risk").
 * The user lookup returns counts only: no trading-wallet, tracked-wallet or channel details.
 */
import type { AdminAuditEntry, AdminStatusResponse, AdminUserLookup, HaltState } from "@zerofee/protocol";
import type { AuditMeta, HaltController } from "../admin/halt";
import type { UserStore } from "../db/pg";
import { userAgentHash } from "../util/hash";
import { apiError, json } from "./http";
import type { AdminCtx, BaseCtx, Route } from "./router";
import { address, obj, str, strict } from "./validate";

export function auditMeta(c: BaseCtx, actor: string): AuditMeta {
  return { actor, ip: c.ip, userAgentHash: userAgentHash(c.req) };
}

export function adminRoutes(store: UserStore, halt: HaltController, now: () => number): Route[] {
  const audit = (c: AdminCtx, action: string, ok: boolean, target: string | null = null, detail: Record<string, unknown> = {}) =>
    store.audit.append({ at: now(), ...auditMeta(c, c.admin.actor), action, target, ok, detail });

  return [
    {
      method: "POST",
      path: "/api/admin/halt",
      auth: "admin",
      handler: async (c) => {
        const b = obj(await c.json(4 * 1024));
        strict(b, ["reason"]);
        const reason = b.reason === undefined ? null : str(b.reason, "reason", { max: 200 }) || null;
        try {
          return json((await halt.halt(reason, auditMeta(c, c.admin.actor))) satisfies HaltState);
        } catch (e) {
          return apiError(
            500,
            "internal",
            `trading IS HALTED, but the audit log write failed (the halt will not survive a restart): ${e instanceof Error ? e.message : e}`,
          );
        }
      },
    },
    {
      method: "POST",
      path: "/api/admin/resume",
      auth: "admin",
      handler: async (c) => json((await halt.resume(auditMeta(c, c.admin.actor))) satisfies HaltState),
    },
    {
      method: "GET",
      path: "/api/admin/status",
      auth: "admin",
      handler: async (c) => {
        const body: AdminStatusResponse = {
          halt: halt.state,
          users: await store.users.count(),
          activeSessions: await store.users.activeSessionCount(now()),
        };
        await audit(c, "status", true);
        return json(body);
      },
    },
    {
      method: "GET",
      path: "/api/admin/users/:wallet",
      auth: "admin",
      handler: async (c) => {
        const wallet = address(c.params.wallet, "wallet");
        const user = await store.users.byWallet(wallet);
        await audit(c, "lookup_user", user !== null, wallet);
        if (!user) return apiError(404, "not_found", "no account for that wallet");
        const t = now();
        const counts = await store.notify.countsFor(user.id);
        const body: AdminUserLookup = {
          wallet: user.wallet,
          createdAt: user.createdAt,
          lastLoginAt: user.lastLoginAt,
          activeSessions: await store.users.activeSessionCount(t, user.id),
          tradingWallets: (await store.users.listTradingWallets(user.id)).length,
          trackedWallets: (await store.tracked.list(user.id)).length,
          alerts: counts.alerts,
          notificationChannels: counts.channels,
        };
        return json(body);
      },
    },
    {
      method: "GET",
      path: "/api/admin/audit",
      auth: "admin",
      handler: async (c) => {
        const limit = Math.min(500, Math.max(1, Number(c.url.searchParams.get("limit") ?? 100) || 100));
        const beforeRaw = c.url.searchParams.get("before");
        const before = beforeRaw === null ? undefined : Number(beforeRaw);
        if (before !== undefined && !Number.isSafeInteger(before)) return apiError(400, "bad_request", "before must be an entry id");
        await audit(c, "read_audit", true, null, { limit, before: before ?? null });
        return json((await store.audit.list(limit, before)) satisfies AdminAuditEntry[]);
      },
    },
  ];
}
