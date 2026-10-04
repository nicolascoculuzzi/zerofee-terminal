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

interface NonceEntry {
  expiresAt: number;
  /** Issue sequence number: tells the live entry from a stale copy in the issue-order queue. */
  seq: number;
}

/**
 * Single-process nonce store with TTL. Entries are removed on use; expired and evicted ones leave from
 * the front of an issue-order queue, so `issue` costs amortized O(1) however many nonces are
 * outstanding (issuing is unauthenticated: it must stay cheap).
 *
 * The queue replaces evicting with `map.keys().next()` and sweeping the whole map on every issue: the
 * sweep was O(outstanding) per issue, and in JavaScriptCore deleted entries stay in a Map's iteration
 * list until the table is rehashed, so every front read walks past all earlier deletions.
 */
export class InMemoryNonceStore implements NonceStore {
  readonly #entries = new Map<string, NonceEntry>();
  /** Issue order (oldest first, from #head); entries consumed or evicted since stay as stale copies. */
  #queue: { nonce: string; seq: number }[] = [];
  #head = 0;
  #seq = 0;
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
    if (this.#entries.has(nonce)) throw new Error("nonce already issued");
    const now = this.#now();
    this.#prune(now);
    // over capacity: evict the oldest outstanding nonce (front of the queue)
    while (this.#entries.size >= this.#maxEntries && this.#head < this.#queue.length) {
      const q = this.#queue[this.#head++] as { nonce: string; seq: number };
      if (this.#entries.get(q.nonce)?.seq === q.seq) this.#entries.delete(q.nonce);
    }
    const seq = this.#seq++;
    this.#entries.set(nonce, { expiresAt: now + ttlMs, seq });
    this.#queue.push({ nonce, seq });
    this.#compact();
  }

  consume(nonce: string): boolean {
    const e = this.#entries.get(nonce);
    if (e === undefined) return false;
    this.#entries.delete(nonce);
    return this.#now() < e.expiresAt;
  }

  /** Drops stale and expired entries at the front of the queue (stops at the first live, unexpired one). */
  #prune(now: number): void {
    while (this.#head < this.#queue.length) {
      const q = this.#queue[this.#head] as { nonce: string; seq: number };
      const e = this.#entries.get(q.nonce);
      if (e && e.seq === q.seq && e.expiresAt > now) break;
      if (e && e.seq === q.seq) this.#entries.delete(q.nonce);
      this.#head++;
    }
  }

  /** Keeps the queue O(outstanding nonces): drops the consumed prefix and, if needed, stale copies. */
  #compact(): void {
    if (this.#head > 1_024 && this.#head * 2 > this.#queue.length) {
      this.#queue = this.#queue.slice(this.#head);
      this.#head = 0;
    }
    // Consumed nonces behind a long-lived one cannot leave from the front: filter them out once the
    // queue holds twice the capacity (at most once per `maxEntries` issues, so still amortized O(1)).
    if (this.#queue.length - this.#head > 2 * this.#maxEntries) {
      this.#queue = this.#queue.slice(this.#head).filter((q) => this.#entries.get(q.nonce)?.seq === q.seq);
      this.#head = 0;
    }
  }

  /** Drops every expired entry (a full pass; `issue` only prunes the front of the queue). */
  sweep(): void {
    const now = this.#now();
    this.#prune(now);
    for (const [nonce, e] of this.#entries) if (e.expiresAt <= now) this.#entries.delete(nonce);
  }

  get size(): number {
    return this.#entries.size;
  }
}
