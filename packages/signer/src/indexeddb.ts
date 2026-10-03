/**
 * IndexedDB implementation of VersionedStore (browser / worker). Each store holds one record
 * `{ value, revision }` under a fixed key. The compare-and-swap runs inside a single readwrite
 * transaction (IndexedDB serializes overlapping readwrite transactions), so two tabs cannot both
 * win a race. Writes request strict durability so a reported success is on disk.
 *
 * Only the encrypted vault blob, public wallet metadata and spend totals are ever written here.
 * Not exercised by `bun test` (Bun has no IndexedDB); see MemoryStore for the tested semantics.
 */
import type { StoredRecord, VersionedStore } from "./store";

export interface IndexedDbStoreOptions {
  /** Record key, e.g. "vault" or "spend". */
  key: string;
  /** Default "zerofee-signer". */
  dbName?: string;
  /** Default "records". */
  storeName?: string;
  /** Defaults to globalThis.indexedDB. */
  indexedDB?: IDBFactory;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

export class IndexedDbStore<T> implements VersionedStore<T> {
  readonly #key: string;
  readonly #dbName: string;
  readonly #storeName: string;
  readonly #factory: IDBFactory;
  #db: Promise<IDBDatabase> | undefined;

  constructor(options: IndexedDbStoreOptions) {
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error("IndexedDB is not available in this environment");
    this.#key = options.key;
    this.#dbName = options.dbName ?? "zerofee-signer";
    this.#storeName = options.storeName ?? "records";
    this.#factory = factory;
  }

  #open(): Promise<IDBDatabase> {
    this.#db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.#factory.open(this.#dbName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(this.#storeName)) request.result.createObjectStore(this.#storeName);
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another tab upgrading the schema: close so it can proceed, reopen lazily next time.
        db.onversionchange = () => {
          db.close();
          this.#db = undefined;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
      request.onblocked = () => reject(new Error("IndexedDB open blocked by another tab"));
    }).catch((e) => {
      this.#db = undefined;
      throw e;
    });
    return this.#db;
  }

  async load(): Promise<StoredRecord<T> | undefined> {
    const db = await this.#open();
    const tx = db.transaction(this.#storeName, "readonly");
    const record = (await promisify(tx.objectStore(this.#storeName).get(this.#key))) as StoredRecord<T> | undefined;
    return record ?? undefined;
  }

  async save(value: T, expectedRevision: number | undefined): Promise<number | undefined> {
    const db = await this.#open();
    return new Promise<number | undefined>((resolve, reject) => {
      const tx = db.transaction(this.#storeName, "readwrite", { durability: "strict" });
      const store = tx.objectStore(this.#storeName);
      let outcome: number | undefined;
      const get = store.get(this.#key);
      get.onsuccess = () => {
        const current = get.result as StoredRecord<T> | undefined;
        if (current?.revision !== expectedRevision) return; // conflict: write nothing
        outcome = (expectedRevision ?? 0) + 1;
        store.put({ value, revision: outcome } satisfies StoredRecord<T>, this.#key);
      };
      tx.oncomplete = () => resolve(outcome);
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted"));
    });
  }
}
