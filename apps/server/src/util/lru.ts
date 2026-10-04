/**
 * Bounded set (FIFO) and LRU map with O(1) operations.
 *
 * Neither evicts by iterating a Set/Map from the front (`keys().next()`): in JavaScriptCore deleted entries
 * stay in the iteration list until the table is rehashed, so after a large structure fills up each
 * front-eviction walks past every earlier deletion. Measured in Bun 1.3: a 200k BoundedSet built that way
 * took 0.3 s for its first 200k adds, then 37.7 s and 132 s for the next two 200k, which stalled the
 * ingest loop about five minutes into a live run (NOTES.md, 2026-10-03).
 */

/** Insertion-ordered bounded set: adding past `max` drops the oldest entry. */
export class BoundedSet<T> {
  /** value -> insertion sequence number (identifies which ring slot owns it). */
  private readonly items = new Map<T, number>();
  private readonly ring: (T | undefined)[];
  private seq = 0;

  constructor(private readonly max: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error("BoundedSet max must be a positive integer");
    this.ring = new Array(max);
  }

  /** Adds `v`; returns false if it was already present. */
  add(v: T): boolean {
    if (this.items.has(v)) return false;
    const slot = this.seq % this.max;
    const old = this.ring[slot];
    // The slot's previous value is evicted unless it was deleted (and maybe re-added) since.
    if (old !== undefined && this.items.get(old) === this.seq - this.max) this.items.delete(old);
    this.ring[slot] = v;
    this.items.set(v, this.seq);
    this.seq++;
    return true;
  }

  has(v: T): boolean {
    return this.items.has(v);
  }

  delete(v: T): boolean {
    return this.items.delete(v);
  }

  get size(): number {
    return this.items.size;
  }
}

interface LruNode<K, V> {
  key: K;
  value: V;
  prev: LruNode<K, V> | null;
  next: LruNode<K, V> | null;
}

/** Least-recently-used map: `get` / `set` refresh an entry; adding past `max` drops the least recent. */
export class LruMap<K, V> {
  private readonly items = new Map<K, LruNode<K, V>>();
  /** Least recent. */
  private head: LruNode<K, V> | null = null;
  /** Most recent. */
  private tail: LruNode<K, V> | null = null;

  constructor(private readonly max: number) {}

  private unlink(n: LruNode<K, V>): void {
    if (n.prev) n.prev.next = n.next;
    else this.head = n.next;
    if (n.next) n.next.prev = n.prev;
    else this.tail = n.prev;
    n.prev = null;
    n.next = null;
  }

  private append(n: LruNode<K, V>): void {
    n.prev = this.tail;
    n.next = null;
    if (this.tail) this.tail.next = n;
    else this.head = n;
    this.tail = n;
  }

  get(k: K): V | undefined {
    const n = this.items.get(k);
    if (!n) return undefined;
    if (n !== this.tail) {
      this.unlink(n);
      this.append(n);
    }
    return n.value;
  }

  peek(k: K): V | undefined {
    return this.items.get(k)?.value;
  }

  set(k: K, v: V): void {
    const n = this.items.get(k);
    if (n) {
      n.value = v;
      if (n !== this.tail) {
        this.unlink(n);
        this.append(n);
      }
      return;
    }
    const node: LruNode<K, V> = { key: k, value: v, prev: null, next: null };
    this.items.set(k, node);
    this.append(node);
    if (this.items.size > this.max && this.head) {
      const oldest = this.head;
      this.unlink(oldest);
      this.items.delete(oldest.key);
    }
  }

  has(k: K): boolean {
    return this.items.has(k);
  }

  delete(k: K): boolean {
    const n = this.items.get(k);
    if (!n) return false;
    this.unlink(n);
    return this.items.delete(k);
  }

  get size(): number {
    return this.items.size;
  }
}
