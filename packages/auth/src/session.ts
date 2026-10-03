/**
 * Session helpers as pure functions. The raw token goes to the browser in an HttpOnly cookie;
 * the server stores only its SHA-256 hash, so a database leak does not yield live sessions.
 * Tokens have 256 bits of entropy, so an unsalted fast hash is appropriate (no password KDF needed).
 */
import { base64UrlToBytes, bytesToBase64Url, bytesToHex, randomBytes } from "./encoding";

export const SESSION_TOKEN_BYTES = 32;

/** Recommended cookie name. The `__Host-` prefix makes browsers require Secure, Path=/ and no Domain. */
export const DEFAULT_SESSION_COOKIE_NAME = "__Host-zf_session";

/** Chrome caps cookie lifetimes at 400 days; we refuse anything longer. */
const MAX_COOKIE_AGE_SECONDS = 400 * 24 * 60 * 60;

/** RFC 7230 token characters (cookie-name). */
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** RFC 6265 cookie-octet: no CTLs, whitespace, DQUOTE, comma, semicolon or backslash. */
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;

/** 32 random bytes from the platform CSPRNG, base64url without padding (43 characters). */
export function generateSessionToken(): string {
  return bytesToBase64Url(randomBytes(SESSION_TOKEN_BYTES));
}

/** True for a well-formed token (canonical base64url of exactly 32 bytes). Check before hashing input. */
export function isSessionTokenFormat(token: string): boolean {
  return base64UrlToBytes(token)?.length === SESSION_TOKEN_BYTES;
}

/** SHA-256 of the token's UTF-8 bytes, lowercase hex. Store and look up sessions by this value. */
export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return bytesToHex(new Uint8Array(digest));
}

export interface SessionCookieOptions {
  /** Lifetime in whole seconds (Max-Age). 0 deletes the cookie. */
  maxAgeSeconds: number;
}

/** Serializes a Set-Cookie value: `name=value; Max-Age=n; Path=/; HttpOnly; Secure; SameSite=Strict`. */
export function serializeSessionCookie(name: string, value: string, options: SessionCookieOptions): string {
  if (!COOKIE_NAME.test(name)) throw new TypeError("invalid cookie name");
  if (!COOKIE_VALUE.test(value)) throw new TypeError("invalid cookie value");
  const { maxAgeSeconds } = options;
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 0 || maxAgeSeconds > MAX_COOKIE_AGE_SECONDS) {
    throw new RangeError(`maxAgeSeconds must be an integer in [0, ${MAX_COOKIE_AGE_SECONDS}]`);
  }
  return `${name}=${value}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

/** Set-Cookie value that deletes the session cookie (logout). */
export function serializeExpiredSessionCookie(name: string): string {
  return serializeSessionCookie(name, "", { maxAgeSeconds: 0 });
}

/**
 * Reads one cookie from a `Cookie` request header. Returns undefined if absent or if the name
 * appears more than once (a duplicate can be planted by a sibling subdomain; refuse to guess).
 */
export function readCookie(cookieHeader: string | null | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  let found: string | undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    if (found !== undefined) return undefined;
    found = part.slice(eq + 1).trim();
  }
  return found;
}
