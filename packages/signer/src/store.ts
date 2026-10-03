/**
 * Storage adapter for the vault and the spend tracker: one record per store, written with
 * compare-and-swap on a revision counter. Two tabs share IndexedDB, and a lost update on the vault
 * would silently drop a wallet's encrypted seed, so every read-modify-write must detect conflicts.
 */
export interface StoredRecord<T> {
  readonly value: T;
  readonly revision: number;
}

export interface VersionedStore<T> {
  load(): Promise<StoredRecord<T> | undefined>;
  /**
   * Writes `value` if the stored revision equals `expectedRevision` (`undefined` = no record may
   * exist yet). Resolves to the new revision, or `undefined` on conflict (nothing written).
   */
  save(value: T, expectedRevision: number | undefined): Promise<number | undefined>;
}

/** In-memory store (tests, or ephemeral sessions). Values are deep-copied on the way in and out. */
export class MemoryStore<T> implements VersionedStore<T> {
  #record: StoredRecord<T> | undefined;

  async load(): Promise<StoredRecord<T> | undefined> {
    return this.#record && { value: structuredClone(this.#record.value), revision: this.#record.revision };
  }

  async save(value: T, expectedRevision: number | undefined): Promise<number | undefined> {
    if (this.#record?.revision !== expectedRevision) return undefined;
    const revision = (expectedRevision ?? 0) + 1;
    this.#record = { value: structuredClone(value), revision };
    return revision;
  }

  /** Test hook: overwrite the stored value as an attacker with storage access could. */
  tamper(mutate: (value: T) => T): void {
    if (!this.#record) throw new Error("nothing stored");
    this.#record = { value: mutate(structuredClone(this.#record.value)), revision: this.#record.revision };
  }
}
