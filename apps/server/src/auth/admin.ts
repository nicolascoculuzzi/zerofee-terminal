/**
 * Operator authentication for /api/admin: `Authorization: Bearer <token>` checked against ADMIN_TOKEN
 * (one token, or `name:token,...` so each operator has an identity in the audit log). Every
 * configured token is compared, in constant time, on every request: neither timing nor the number of
 * comparisons reveals which token, if any, matched. Session cookies never grant admin access.
 */
import type { AdminAuthenticator, AdminIdentity } from "../api/router";
import { type AdminTokenEntry, parseAdminTokens } from "../config";
import { constantTimeEqual, sha256Hex } from "../util/hash";

export class AdminAuth implements AdminAuthenticator {
  private readonly entries: AdminTokenEntry[];

  constructor(spec: string) {
    this.entries = parseAdminTokens(spec);
  }

  check(req: Request): AdminIdentity | null {
    const m = /^Bearer[ \t]+(\S{1,512})$/i.exec(req.headers.get("authorization") ?? "");
    if (!m) return null;
    const presented = m[1] as string;
    let match: AdminTokenEntry | null = null;
    for (const e of this.entries) if (constantTimeEqual(presented, e.token)) match = e;
    if (!match) return null;
    return { actor: match.named ? match.name : `admin:${sha256Hex(match.token).slice(0, 12)}` };
  }
}
