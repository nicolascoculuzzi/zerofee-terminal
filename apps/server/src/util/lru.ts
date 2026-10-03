/** Insertion-ordered bounded set / map (oldest evicted first). Map iteration order makes this O(1). */

export class BoundedSet<T> {
  private readonly items = new Set<T>();

  constructor(private readonly max: number) {}

  /** Adds `v`; returns false if it was already present. */
  add(v: T): boolean {
    if (this.items.has(v)) return false;
    this.items.add(v);
    if (this.items.size > this.max) {
      const oldest = this.items.values().next().value as T;
      this.items.delete(oldest);
    }
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

export class LruMap<K, V> {
  private readonly items = new Map<K, V>();

  constructor(private readonly max: number) {}

  get(k: K): V | undefined {
    const v = this.items.get(k);
    if (v !== undefined) {
      this.items.delete(k);
      this.items.set(k, v);
    }
    return v;
  }

  peek(k: K): V | undefined {
    return this.items.get(k);
  }

  set(k: K, v: V): void {
    if (this.items.has(k)) this.items.delete(k);
    this.items.set(k, v);
    if (this.items.size > this.max) {
      const oldest = this.items.keys().next().value as K;
      this.items.delete(oldest);
    }
  }

  has(k: K): boolean {
    return this.items.has(k);
  }

  delete(k: K): boolean {
    return this.items.delete(k);
  }

  get size(): number {
    return this.items.size;
  }
}
