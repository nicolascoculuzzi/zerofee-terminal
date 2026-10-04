/** In-memory ring buffer of signing decisions (summaries only; never keys or full transactions). */
export interface AuditEntry {
  readonly at: number;
  readonly walletId: string;
  readonly status: "signed" | "refused";
  /** Base58 transaction signature, when signed. */
  readonly signature?: string;
  /** Plain-language summary of what was signed. */
  readonly summary?: string;
  readonly violations?: readonly string[];
}

export class AuditLog {
  readonly #capacity: number;
  readonly #entries: AuditEntry[] = [];

  constructor(capacity = 200) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("capacity must be a positive integer");
    this.#capacity = capacity;
  }

  append(entry: AuditEntry): void {
    this.#entries.push(Object.freeze({ ...entry }));
    if (this.#entries.length > this.#capacity) this.#entries.splice(0, this.#entries.length - this.#capacity);
  }

  /** Oldest first. */
  list(): AuditEntry[] {
    return [...this.#entries];
  }

  clear(): void {
    this.#entries.length = 0;
  }
}
