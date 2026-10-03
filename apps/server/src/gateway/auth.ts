/**
 * Authentication seam. With the accounts layer (src/user.ts) the provider is the SIWS
 * SessionService (auth/sessions.ts): the `__Host-zf_session` cookie resolves to a signed-in session,
 * anything else to an anonymous one. Without it (tests, feed-only runs) every request is anonymous:
 * market data is public, and POST /api/tx only accepts anonymous callers while DRY_RUN=true (or
 * ALLOW_ANONYMOUS_TX=true).
 */

export interface Session {
  id: string;
  /** Wallet that signed in (null for anonymous sessions). */
  wallet: string | null;
  /** Account id (null for anonymous sessions). */
  userId: string | null;
  anonymous: boolean;
  expiresAt: number | null;
}

export interface AuthProvider {
  /** Resolves the caller's session from the request (cookie / header); null = reject. */
  authenticate(req: Request): Promise<Session | null>;
}

export class AnonymousAuth implements AuthProvider {
  async authenticate(_req: Request): Promise<Session> {
    return { id: crypto.randomUUID(), wallet: null, userId: null, anonymous: true, expiresAt: null };
  }
}
