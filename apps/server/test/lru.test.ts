/** BoundedSet / LruMap semantics, and the eviction-cost regression that stalled the ingest loop. */
import { describe, expect, test } from "bun:test";
import { BoundedSet, LruMap } from "../src/util/lru";

describe("BoundedSet", () => {
  test("drops the oldest entries past max; re-added values get a fresh slot", () => {
    const s = new BoundedSet<string>(3);
    expect(["a", "b", "c"].map((v) => s.add(v))).toEqual([true, true, true]);
    expect(s.add("a")).toBe(false);
    s.add("d"); // evicts a
    expect([s.has("a"), s.has("b"), s.has("d"), s.size]).toEqual([false, true, true, 3]);
    s.delete("b");
    s.add("b"); // re-added into b's old slot (whose stale copy must not evict the new one)
    s.add("e"); // evicts c
    expect([s.has("b"), s.has("c"), s.has("e")]).toEqual([true, false, true]);
    s.add("f"); // evicts d
    expect([s.has("d"), s.size]).toEqual([false, 3]);
  });

  test("a stale ring slot never evicts a value that was deleted and re-added elsewhere", () => {
    const s = new BoundedSet<string>(3);
    s.add("a"); // slot 0
    s.delete("a");
    s.add("b"); // slot 1
    s.add("a"); // slot 2 (slot 0 still holds the stale copy)
    s.add("c"); // reuses slot 0: must not drop the live "a"
    expect([s.has("a"), s.has("b"), s.has("c"), s.size]).toEqual([true, true, true, 3]);
  });

  test("eviction stays O(1) long after the set fills (JavaScriptCore front-iteration regression)", () => {
    const s = new BoundedSet<string>(50_000);
    const t0 = performance.now();
    for (let i = 0; i < 300_000; i++) s.add(`sig-${i}`);
    // The old Set-iteration eviction needed tens of seconds here; the ring needs a fraction of one.
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(s.size).toBe(50_000);
    expect(s.has("sig-299999")).toBe(true);
    expect(s.has("sig-249999")).toBe(false);
  });
});

describe("LruMap", () => {
  test("get / set refresh recency; the least recently used entry is evicted", () => {
    const m = new LruMap<string, number>(3);
    m.set("a", 1);
    m.set("b", 2);
    m.set("c", 3);
    expect(m.get("a")).toBe(1); // a is now most recent
    m.set("d", 4); // evicts b
    expect([m.has("b"), m.peek("a"), m.size]).toEqual([false, 1, 3]);
    m.set("c", 30); // update refreshes c
    m.set("e", 5); // evicts a (least recent: a was refreshed before c's update and d, e)
    expect(m.has("a")).toBe(false);
    expect(m.get("c")).toBe(30); // order now d, e, c
    expect(m.delete("d")).toBe(true);
    expect(m.delete("d")).toBe(false);
    m.set("f", 6); // e, c, f
    m.set("g", 7); // evicts e
    expect(["c", "e", "f", "g"].map((k) => m.has(k))).toEqual([true, false, true, true]);
  });

  test("eviction stays O(1) under churn", () => {
    const m = new LruMap<string, number>(50_000);
    const t0 = performance.now();
    for (let i = 0; i < 300_000; i++) {
      m.set(`k-${i}`, i);
      if (i % 3 === 0) m.get(`k-${i >> 1}`);
    }
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(m.size).toBe(50_000);
  });
});
