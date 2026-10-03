/**
 * Server-issued SIWS nonces. A nonce is valid once: `consume` must atomically check and delete it,
 * so a captured signed message cannot be replayed. A multi-process deployment needs a shared store
 * with an atomic delete (e.g. Postgres `DELETE ... WHERE nonce = $1 AND expires_at > now() RETURNING 1`);
 * the in-memory store below is for a single process and tests.
 */
import { bytesToHex, randomBytes } from "./encoding";
import { isValidNonce } from "./siws";

export interface NonceStore {
  /** Records a freshly issued nonce that stays valid for `ttlMs`. */
  issue(nonce: string, ttlMs: number): void | Promise<void>;
  /**
   * Returns true exactly once for a nonce that was issued and has not expired, and invalidates it
   * in the same step. Unknown, expired and already-used nonces return false.
   */
  consume(nonce: string): boolean | Promise<boolean>;
}

/** Default nonce lifetime: matches the 10 minute ceiling on sign-in message expiry. */
export const DEFAULT_NONCE_TTL_MS = 10 * 60 * 1000;

/** 128 random bits as 32 lowercase hex characters (alphanumeric, as SIWS requires). */
export function generateNonce(): string {
  return bytesToHex(randomBytes(16));
}

/** Generates a nonce, records it in the store and returns it for the sign-in input. */
export async function issueNonce(store: NonceStore, ttlMs: number = DEFAULT_NONCE_TTL_MS): Promise<string> {
  const nonce = generateNonce();
  await store.issue(nonce, ttlMs);
  return nonce;
}

export interface InMemoryNonceStoreOptions {
  /**
   * Upper bound on outstanding nonces. Nonce issuance is unauthenticated, so the oldest entries are
   * evicted beyond this (rate-limit the issuing endpoint as well). Default 100,000.
   */
  maxEntries?: number;
  now?: () => number;
}

/** Single-process nonce store with TTL. Entries are removed on use and swept lazily when issuing. */
export class InMemoryNonceStore implements NonceStore {
  readonly #expiresAt = new Map<string, number>();
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(options: InMemoryNonceStoreOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 100_000;
    this.#now = options.now ?? Date.now;
    if (!Number.isInteger(this.#maxEntries) || this.#maxEntries < 1) throw new RangeError("maxEntries must be a positive integer");
  }

  issue(nonce: string, ttlMs: number): void {
    if (!isValidNonce(nonce)) throw new TypeError("nonce must be at least 8 alphanumeric characters");
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError("ttlMs must be positive");
    if (this.#expiresAt.has(nonce)) throw new Error("nonce already issued");
    this.sweep();
    while (this.#expiresAt.size >= this.#maxEntries) {
      // Map iteration order is insertion order: evict the oldest outstanding nonce.
      const oldest = this.#expiresAt.keys().next();
      if (oldest.done) break;
      this.#expiresAt.delete(oldest.value);
    }
    this.#expiresAt.set(nonce, this.#now() + ttlMs);
  }

  consume(nonce: string): boolean {
    const expiresAt = this.#expiresAt.get(nonce);
    if (expiresAt === undefined) return false;
    this.#expiresAt.delete(nonce);
    return this.#now() < expiresAt;
  }

  /** Drops expired entries. */
  sweep(): void {
    const now = this.#now();
    for (const [nonce, expiresAt] of this.#expiresAt) if (expiresAt <= now) this.#expiresAt.delete(nonce);
  }

  get size(): number {
    return this.#expiresAt.size;
  }
}
