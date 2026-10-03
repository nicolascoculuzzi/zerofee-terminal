/** GET /api/auth/nonce, POST /api/auth/signin, POST /api/auth/signout, GET /api/me (protocol user.ts). */
import type { SessionService } from "../auth/sessions";
import { apiError, json } from "./http";
import type { Route } from "./router";
import { bool, obj, strict } from "./validate";

export function authRoutes(sessions: SessionService): Route[] {
  return [
    {
      method: "GET",
      path: "/api/auth/nonce",
      auth: "public",
      authLimit: true,
      handler: async () => json(await sessions.issueNonce()),
    },
    {
      method: "POST",
      path: "/api/auth/signin",
      auth: "public",
      authLimit: true,
      origin: true,
      handler: async (c) => {
        const r = await sessions.signIn(await c.json(16 * 1024), c.req);
        if (!r.ok) return apiError(r.status, r.status === 400 ? "bad_request" : "unauthorized", r.error);
        return json(r.me, 200, { "set-cookie": r.setCookie });
      },
    },
    {
      method: "POST",
      path: "/api/auth/signout",
      auth: "public",
      origin: true,
      handler: async (c) => {
        const body = obj(await c.json(1024));
        strict(body, ["all"]);
        const all = body.all === undefined ? false : bool(body.all, "all");
        const r = await sessions.signOut(c.req, all);
        return json({ ok: true }, 200, { "set-cookie": r.setCookie });
      },
    },
    {
      method: "GET",
      path: "/api/me",
      auth: "session",
      handler: async (c) => json(await sessions.me(c.session)),
    },
  ];
}
