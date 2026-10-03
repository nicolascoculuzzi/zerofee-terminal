/**
 * Authentication seam. Sign-In With Solana sessions (SIWS: domain + server nonce + issued-at + expiry,
 * short-lived, bound to the wallet) arrive from the identity branch; they plug in here by implementing
 * AuthProvider. Until then every request gets an anonymous session: market data is public, and
 * POST /api/tx only accepts anonymous callers while DRY_RUN=true (or ALLOW_ANONYMOUS_TX=true).
 */

export interface Session {
  id: string;
  /** Wallet that signed in (null for anonymous sessions). */
  wallet: string | null;
  anonymous: boolean;
  expiresAt: number | null;
}

export interface AuthProvider {
  /** Resolves the caller's session from the request (cookie / header); null = reject. */
  authenticate(req: Request): Promise<Session | null>;
}

export class AnonymousAuth implements AuthProvider {
  async authenticate(_req: Request): Promise<Session> {
    return { id: crypto.randomUUID(), wallet: null, anonymous: true, expiresAt: null };
  }
}
