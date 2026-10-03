/**
 * Router for the account, settings, alert and admin endpoints. Each route declares how it is
 * authenticated; the router applies, in order:
 *   public   per-IP auth rate limit (`authLimit`), allowed Origin (`origin`) - nonce, sign-in, sign-out
 *   session  allowed Origin on mutations (CSRF), session cookie (401), per-user rate limit (429)
 *   admin    per-IP admin rate limit, `Authorization: Bearer <ADMIN_TOKEN>` (constant-time; failures audited)
 * and maps thrown errors to `{ error, code }` responses.
 */
import { isMutation, type OriginPolicy } from "../auth/origin";
import type { SessionService, UserSession } from "../auth/sessions";
import { isUniqueViolation, LimitExceededError } from "../db/pg";
import type { RateLimiter } from "../gateway/rateLimit";
import { logger } from "../log";
import { apiError, HttpError, readJson } from "./http";
import { ValidationError } from "./validate";

const log = logger("api");

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface BaseCtx {
  req: Request;
  url: URL;
  ip: string;
  params: Record<string, string>;
  /** Parses the JSON body (default cap 64 KiB). */
  json(maxBytes?: number): Promise<unknown>;
}
export interface SessionCtx extends BaseCtx {
  session: UserSession;
}
export interface AdminIdentity {
  /** Recorded in the audit log. */
  actor: string;
}
export interface AdminCtx extends BaseCtx {
  admin: AdminIdentity;
}

export type Route =
  | {
      method: Method;
      path: string;
      auth: "public";
      /** Require an allowed Origin header (sign-in / sign-out: login CSRF). */
      origin?: boolean;
      /** Count against the per-IP auth limiter. */
      authLimit?: boolean;
      handler: (c: BaseCtx) => Promise<Response>;
    }
  | { method: Method; path: string; auth: "session"; handler: (c: SessionCtx) => Promise<Response> }
  | { method: Method; path: string; auth: "admin"; handler: (c: AdminCtx) => Promise<Response> };

export interface AdminAuthenticator {
  check(req: Request): AdminIdentity | null;
}

export interface RouterDeps {
  sessions: SessionService;
  origins: OriginPolicy;
  limits: { auth: RateLimiter; user: RateLimiter; admin: RateLimiter };
  admin: AdminAuthenticator | null;
  /** Called on a failed admin authentication (audit it). */
  onAdminDenied?(c: BaseCtx): Promise<void>;
}

interface Compiled {
  route: Route;
  re: RegExp;
  keys: string[];
}

function compile(path: string): { re: RegExp; keys: string[] } {
  const keys: string[] = [];
  const src = path
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":")) {
        keys.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { re: new RegExp(`^${src}$`), keys };
}

export class ApiRouter {
  private readonly routes: Compiled[] = [];

  constructor(private readonly d: RouterDeps) {}

  add(routes: Route[]): this {
    for (const route of routes) this.routes.push({ route, ...compile(route.path) });
    return this;
  }

  /** Response for a known /api path, null when no route matches (the gateway answers 404). */
  async handle(req: Request, ip: string): Promise<Response | null> {
    const url = new URL(req.url);
    let pathMatched = false;
    for (const c of this.routes) {
      const m = c.re.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (c.route.method !== req.method) continue;
      const params: Record<string, string> = {};
      try {
        c.keys.forEach((k, i) => {
          params[k] = decodeURIComponent(m[i + 1] as string);
        });
      } catch {
        return apiError(400, "bad_request", "malformed path");
      }
      return this.run(c.route, { req, url, ip, params, json: (max) => readJson(req, max) });
    }
    return pathMatched ? apiError(405, "bad_request", "method not allowed") : null;
  }

  private async run(route: Route, base: BaseCtx): Promise<Response> {
    const { req, ip } = base;
    const origin = req.headers.get("origin");
    try {
      switch (route.auth) {
        case "public": {
          if (route.authLimit && !this.d.limits.auth.allow(ip))
            return apiError(429, "rate_limited", "too many sign-in attempts, slow down");
          if (route.origin && !this.d.origins.isAllowed(origin)) return apiError(403, "forbidden", "cross-origin request refused");
          return await route.handler(base);
        }
        case "session": {
          if (isMutation(req.method) && !this.d.origins.isAllowed(origin))
            return apiError(403, "forbidden", "cross-origin request refused");
          const session = await this.d.sessions.resolve(req);
          if (!session) return apiError(401, "unauthorized", "sign in first");
          if (!this.d.limits.user.allow(session.userId)) return apiError(429, "rate_limited", "slow down");
          return await route.handler({ ...base, session });
        }
        case "admin": {
          if (!this.d.admin) return apiError(404, "not_found", "admin endpoints are disabled (set ADMIN_TOKEN)");
          if (!this.d.limits.admin.allow(ip)) return apiError(429, "rate_limited", "slow down");
          const admin = this.d.admin.check(req);
          if (!admin) {
            await this.d.onAdminDenied?.(base).catch((e) => log.error(`audit of a denied admin call failed: ${e}`));
            return apiError(401, "unauthorized", "admin token required");
          }
          return await route.handler({ ...base, admin });
        }
      }
    } catch (e) {
      return errorResponse(e, `${req.method} ${base.url.pathname}`);
    }
  }
}

export function errorResponse(e: unknown, what: string): Response {
  if (e instanceof HttpError) return apiError(e.status, e.code, e.message);
  if (e instanceof ValidationError) return apiError(400, "bad_request", e.message);
  if (e instanceof LimitExceededError) return apiError(422, "limit_exceeded", e.message);
  if (isUniqueViolation(e)) return apiError(409, "conflict", "already exists");
  log.error(`${what} failed: ${e instanceof Error ? e.message : String(e)}`);
  return apiError(500, "internal", "internal error");
}
