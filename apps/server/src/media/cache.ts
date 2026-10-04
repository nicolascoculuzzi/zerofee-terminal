/**
 * Image caches: a byte-budgeted in-memory LRU and a disk cache with a size budget.
 *
 * Disk layout: <dir>/<2 hex>/<sha256(key) hex>, raw image bytes (the type is re-derived from the magic
 * bytes on load). Writes go to a temp file and are renamed into place, so a reader never sees half a file.
 * A sweep deletes the least recently used files (by mtime; hits refresh it) once the total passes the
 * budget, down to 90% of it.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../log";

const log = logger("media");

interface Node<V> {
  key: string;
  value: V;
  bytes: number;
  prev: Node<V> | null;
  next: Node<V> | null;
}

/** LRU map bounded by the sum of its entries' sizes (linked list: O(1) get / set / evict). */
export class ByteLru<V> {
  private readonly items = new Map<string, Node<V>>();
  private head: Node<V> | null = null;
  private tail: Node<V> | null = null;
  private used = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly sizeOf: (v: V) => number,
  ) {}

  get size(): number {
    return this.items.size;
  }

  get bytes(): number {
    return this.used;
  }

  get(key: string): V | undefined {
    const n = this.items.get(key);
    if (!n) return undefined;
    this.unlink(n);
    this.append(n);
    return n.value;
  }

  set(key: string, value: V): void {
    const bytes = this.sizeOf(value);
    const old = this.items.get(key);
    if (old) {
      this.unlink(old);
      this.items.delete(key);
      this.used -= old.bytes;
    }
    if (bytes > this.maxBytes) return;
    const n: Node<V> = { key, value, bytes, prev: null, next: null };
    this.items.set(key, n);
    this.append(n);
    this.used += bytes;
    while (this.used > this.maxBytes && this.head) {
      const victim = this.head;
      this.unlink(victim);
      this.items.delete(victim.key);
      this.used -= victim.bytes;
    }
  }

  delete(key: string): void {
    const n = this.items.get(key);
    if (!n) return;
    this.unlink(n);
    this.items.delete(key);
    this.used -= n.bytes;
  }

  private unlink(n: Node<V>): void {
    if (n.prev) n.prev.next = n.next;
    else this.head = n.next;
    if (n.next) n.next.prev = n.prev;
    else this.tail = n.prev;
    n.prev = null;
    n.next = null;
  }

  private append(n: Node<V>): void {
    n.prev = this.tail;
    if (this.tail) this.tail.next = n;
    else this.head = n;
    this.tail = n;
  }
}

export class DiskCache {
  private total = 0;
  private sweeping: Promise<void> | null = null;
  private lastSweep = 0;
  private ready: Promise<void> | null = null;
  readonly stats = { reads: 0, writes: 0, errors: 0, evicted: 0 };

  constructor(
    private readonly dir: string,
    private readonly maxBytes: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Creates the directory and measures what is already there, on first use (not at construction). */
  private init(): Promise<void> {
    this.ready ??= mkdir(this.dir, { recursive: true, mode: 0o750 })
      .then(() => this.sweep(true))
      .catch((e) => {
        this.stats.errors++;
        log.warn(`image disk cache unavailable at ${this.dir}: ${e instanceof Error ? e.message : e}`);
      });
    return this.ready;
  }

  get usedBytes(): number {
    return this.total;
  }

  private path(key: string): { dir: string; file: string } {
    const h = createHash("sha256").update(key).digest("hex");
    const sub = join(this.dir, h.slice(0, 2));
    return { dir: sub, file: join(sub, h) };
  }

  async get(key: string): Promise<Uint8Array | null> {
    const { file } = this.path(key);
    try {
      const buf = await readFile(file);
      this.stats.reads++;
      const t = new Date(this.now());
      void utimes(file, t, t).catch(() => {});
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch {
      return null;
    }
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    await this.init();
    const { dir, file } = this.path(key);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await mkdir(dir, { recursive: true, mode: 0o750 });
      await writeFile(tmp, bytes, { mode: 0o640 });
      await rename(tmp, file);
      this.stats.writes++;
      this.total += bytes.byteLength;
      if (this.total > this.maxBytes) void this.sweep();
    } catch (e) {
      this.stats.errors++;
      void unlink(tmp).catch(() => {});
      log.debug(`image cache write failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Recomputes the total and evicts the oldest files beyond the budget (at most one sweep per minute). */
  sweep(force = false): Promise<void> {
    if (this.sweeping) return this.sweeping;
    if (!force && this.now() - this.lastSweep < 60_000) return Promise.resolve();
    this.lastSweep = this.now();
    this.sweeping = this.doSweep().finally(() => {
      this.sweeping = null;
    });
    return this.sweeping;
  }

  private async doSweep(): Promise<void> {
    const files: { file: string; size: number; mtime: number }[] = [];
    let subs: string[] = [];
    try {
      subs = await readdir(this.dir);
    } catch {
      return;
    }
    for (const sub of subs) {
      if (!/^[0-9a-f]{2}$/.test(sub)) continue;
      let names: string[] = [];
      try {
        names = await readdir(join(this.dir, sub));
      } catch {
        continue;
      }
      for (const name of names) {
        const file = join(this.dir, sub, name);
        try {
          const st = await stat(file);
          if (name.endsWith(".tmp")) {
            if (this.now() - st.mtimeMs > 3_600_000) await unlink(file).catch(() => {});
            continue;
          }
          files.push({ file, size: st.size, mtime: st.mtimeMs });
        } catch {
          /* raced with a delete */
        }
      }
    }
    let total = files.reduce((a, f) => a + f.size, 0);
    if (total > this.maxBytes) {
      files.sort((a, b) => a.mtime - b.mtime);
      const target = this.maxBytes * 0.9;
      for (const f of files) {
        if (total <= target) break;
        try {
          await unlink(f.file);
          total -= f.size;
          this.stats.evicted++;
        } catch {
          /* already gone */
        }
      }
    }
    this.total = total;
  }
}
