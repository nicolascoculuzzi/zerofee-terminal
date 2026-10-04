/** Hashing and comparison helpers for secrets (tokens, codes, user agents). */
import { createHash, timingSafeEqual } from "node:crypto";

/** SHA-256 of the UTF-8 text, lowercase hex. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Constant-time string comparison. Both sides are hashed first, so the comparison time depends
 * neither on where the strings differ nor on their lengths.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}

/** User agents are stored hashed (enough to tell sessions apart, no fingerprint kept in clear). */
export function userAgentHash(req: Request): string | null {
  const ua = req.headers.get("user-agent");
  return ua ? sha256Hex(ua.slice(0, 512)) : null;
}
