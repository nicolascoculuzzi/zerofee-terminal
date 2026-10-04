/**
 * Sign-In With Solana sessions (SPEC "Sessions"): the SIWS message binds our domain, a server nonce,
 * issued-at and a <= 10 minute expiry (packages/auth verifySignIn checks all of it, then burns the
 * nonce). A successful sign-in creates a short-lived session tied to the wallet: a 256-bit random
 * token in the `__Host-zf_session` cookie (HttpOnly, Secure, SameSite=Strict, Path=/), with only its
 * SHA-256 in Postgres. Sessions have an absolute expiry (SESSION_TTL_HOURS, default 24 h) and are
 * never extended by activity. Sign-in rotates any session the browser already had; signing out
 * revokes it (or all of the user's sessions). Revocations are broadcast so open WebSockets close.
 *
 * Local development over http://127.0.0.1 or http://localhost: browsers treat loopback as a secure
 * context, so Chromium and Firefox accept this Secure, `__Host-` cookie over plain http there; any
 * other plain-http host cannot hold the session (config refuses a non-loopback http PUBLIC_ORIGIN).
 */
import {
  createSignInInput,
  DEFAULT_NONCE_TTL_MS,
  DEFAULT_SIGN_IN_STATEMENT,
  generateSessionToken,
  hashSessionToken,
  InMemoryNonceStore,
  isSessionTokenFormat,
  issueNonce,
  type NonceStore,
  readCookie,
  type SolanaSignInOutput,
  serializeExpiredSessionCookie,
  serializeSessionCookie,
  verifySignIn,
} from "@zerofee/auth";
import type { MeResponse, NonceResponse, SignInInputWire } from "@zerofee/protocol";
import type { UserStore } from "../db/pg";
import type { AuthProvider, Session } from "../gateway/auth";
import { logger } from "../log";
import { userAgentHash } from "../util/hash";

const log = logger("sessions");

/** A signed-in session (Session with the user fields filled in). */
export interface UserSession extends Session {
  userId: string;
  wallet: string;
  anonymous: false;
  expiresAt: number;
  createdAt: number;
}

export function isUserSession(s: Session | null | undefined): s is UserSession {
  return !!s && !s.anonymous && typeof s.userId === "string" && typeof s.wallet === "string";
}

export interface SessionServiceOptions {
  store: UserStore;
  /** SIWS domain (host[:port] of PUBLIC_ORIGIN unless overridden). */
  domain: string;
  /** SIWS URI: PUBLIC_ORIGIN. */
  uri: string;
  cookieName: string;
  ttlMs: number;
  maxPerUser: number;
  nonceStore?: NonceStore;
  now?: () => number;
}

export type SignInResult =
  | { ok: true; me: MeResponse; session: UserSession; setCookie: string }
  | { ok: false; status: number; reason: string; error: string };

/** last_seen_at is written at most this often per session. */
const TOUCH_EVERY_MS = 5 * 60_000;
const MAX_B64 = Math.ceil((4096 * 4) / 3) + 4;

function anonymous(): Session {
  return { id: crypto.randomUUID(), wallet: null, userId: null, anonymous: true, expiresAt: null };
}

/** Standard or URL-safe base64 -> bytes; null when malformed or longer than `maxChars`. */
function b64(value: unknown, maxChars: number): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) return null;
  const norm = value.replaceAll("-", "+").replaceAll("_", "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(norm)) return null;
  return new Uint8Array(Buffer.from(norm, "base64"));
}

/** Validates the JSON body of POST /api/auth/signin into the Wallet Standard output shape. */
export function decodeSignInRequest(body: unknown): SolanaSignInOutput | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const account = b.account as Record<string, unknown> | undefined;
  if (!account || typeof account !== "object" || typeof account.address !== "string" || account.address.length > 64) return null;
  const publicKey = b64(account.publicKey, 64);
  const signature = b64(b.signature, 128);
  const signedMessage = b64(b.signedMessage, MAX_B64);
  if (!publicKey || !signature || !signedMessage) return null;
  if (b.signatureType !== undefined && b.signatureType !== "ed25519") return null;
  return {
    account: { address: account.address, publicKey },
    signedMessage,
    signature,
    ...(b.signatureType === "ed25519" ? { signatureType: "ed25519" as const } : {}),
  };
}

export class SessionService implements AuthProvider {
  readonly nonces: NonceStore;
  private readonly now: () => number;
  private readonly revokeListeners = new Set<(sessionIds: string[]) => void>();
  private readonly touched = new Map<string, number>();

  constructor(private readonly o: SessionServiceOptions) {
    this.now = o.now ?? Date.now;
    this.nonces = o.nonceStore ?? new InMemoryNonceStore({ now: this.now });
  }

  get cookieName(): string {
    return this.o.cookieName;
  }

  /** Called with the ids of revoked sessions (sign-out, rotation, cap): the gateway closes their sockets. */
  onRevoke(fn: (sessionIds: string[]) => void): void {
    this.revokeListeners.add(fn);
  }

  private revoked(ids: string[]): void {
    if (!ids.length) return;
    for (const id of ids) this.touched.delete(id);
    for (const fn of this.revokeListeners) {
      try {
        fn(ids);
      } catch (e) {
        log.warn(`revoke listener failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  /** GET /api/auth/nonce: a fresh single-use nonce inside the exact input the wallet should sign. */
  async issueNonce(): Promise<NonceResponse> {
    const nonce = await issueNonce(this.nonces, DEFAULT_NONCE_TTL_MS);
    const issuedAt = this.now();
    const input = createSignInInput({ domain: this.o.domain, uri: this.o.uri, nonce, issuedAt });
    return { input: input as SignInInputWire, expiresAt: issuedAt + DEFAULT_NONCE_TTL_MS };
  }

  /** POST /api/auth/signin. `req` supplies the cookie being rotated and the user agent. */
  async signIn(body: unknown, req: Request): Promise<SignInResult> {
    const output = decodeSignInRequest(body);
    if (!output) {
      return {
        ok: false,
        status: 400,
        reason: "malformed_output",
        error: "body must be { account: { address, publicKey }, signedMessage, signature } with base64 bytes",
      };
    }
    const v = await verifySignIn(output, {
      domain: this.o.domain,
      uri: this.o.uri,
      statement: DEFAULT_SIGN_IN_STATEMENT,
      nonceStore: this.nonces,
      now: this.now,
    });
    if (!v.ok) return { ok: false, status: 401, reason: v.reason, error: `sign-in rejected: ${v.reason} (${v.detail})` };

    const now = this.now();
    const user = await this.o.store.users.upsertOnLogin(v.address, now);
    // Rotate: whatever session this browser held before is revoked (no session fixation).
    const previous = await this.resolve(req);
    if (previous && (await this.o.store.users.revokeSession(previous.id, now))) this.revoked([previous.id]);

    const token = generateSessionToken();
    const { session: rec, revoked } = await this.o.store.users.createSession({
      userId: user.id,
      tokenHash: await hashSessionToken(token),
      expiresAt: now + this.o.ttlMs,
      userAgentHash: userAgentHash(req),
      now,
      maxActive: this.o.maxPerUser,
    });
    this.revoked(revoked);
    const session: UserSession = {
      id: rec.id,
      userId: rec.userId,
      wallet: rec.wallet,
      anonymous: false,
      createdAt: rec.createdAt,
      expiresAt: rec.expiresAt,
    };
    return {
      ok: true,
      session,
      me: {
        wallet: user.wallet,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
        session: { createdAt: rec.createdAt, expiresAt: rec.expiresAt },
      },
      setCookie: serializeSessionCookie(this.o.cookieName, token, { maxAgeSeconds: Math.max(1, Math.floor(this.o.ttlMs / 1000)) }),
    };
  }

  /** The signed-in session behind the request's cookie, or null. Never throws for bad cookies. */
  async resolve(req: Request): Promise<UserSession | null> {
    const token = readCookie(req.headers.get("cookie"), this.o.cookieName);
    if (!token || !isSessionTokenFormat(token)) return null;
    const now = this.now();
    const rec = await this.o.store.users.findSession(await hashSessionToken(token), now);
    if (!rec) return null;
    const last = this.touched.get(rec.id) ?? rec.lastSeenAt;
    if (now - last >= TOUCH_EVERY_MS) {
      this.touched.set(rec.id, now);
      if (this.touched.size > 50_000) this.touched.clear();
      void this.o.store.users.touchSession(rec.id, now).catch(() => {});
    }
    return { id: rec.id, userId: rec.userId, wallet: rec.wallet, anonymous: false, createdAt: rec.createdAt, expiresAt: rec.expiresAt };
  }

  /**
   * AuthProvider for the gateway: the signed-in session, else an anonymous one. A database error
   * degrades to anonymous (fewer privileges, public data keeps flowing) and is logged.
   */
  async authenticate(req: Request): Promise<Session> {
    try {
      return (await this.resolve(req)) ?? anonymous();
    } catch (e) {
      log.error(`session lookup failed: ${e instanceof Error ? e.message : e}`);
      return anonymous();
    }
  }

  /** POST /api/auth/signout: revokes this session (or all of the user's) and returns the clearing cookie. */
  async signOut(req: Request, all: boolean): Promise<{ revoked: string[]; setCookie: string }> {
    const s = await this.resolve(req);
    let revoked: string[] = [];
    if (s) {
      const now = this.now();
      if (all) revoked = await this.o.store.users.revokeAllSessions(s.userId, now);
      else if (await this.o.store.users.revokeSession(s.id, now)) revoked = [s.id];
      this.revoked(revoked);
    }
    return { revoked, setCookie: serializeExpiredSessionCookie(this.o.cookieName) };
  }

  async me(s: UserSession): Promise<MeResponse> {
    const user = await this.o.store.users.byId(s.userId);
    return {
      wallet: s.wallet,
      createdAt: user?.createdAt ?? s.createdAt,
      lastLoginAt: user?.lastLoginAt ?? s.createdAt,
      session: { createdAt: s.createdAt, expiresAt: s.expiresAt },
    };
  }

  /** Housekeeping: drop sessions that ended more than a day ago. */
  async purge(): Promise<number> {
    return this.o.store.users.purgeSessions(this.now() - 24 * 3_600_000);
  }
}
