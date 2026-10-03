import { describe, expect, test } from "bun:test";
import { CandleBook, type CandleTrade, MEMORY_CAP } from "../src/market/candles";
import { RollingWindows } from "../src/market/windows";

const t = (tsMs: number, price: number, key: [number, number, number], volume = 1): CandleTrade => ({
  tsMs,
  price,
  volume,
  key,
  solUsd: 120,
});
const BASE = 1_791_046_800_000; // aligned to 1 h (497,513 h since the epoch)

describe("candle builder", () => {
  test("buckets per timeframe, OHLC + volume + count", () => {
    const b = new CandleBook();
    b.addTrade("M", t(BASE + 100, 10, [1, 0, 0], 2));
    b.addTrade("M", t(BASE + 900, 12, [1, 1, 0], 3));
    b.addTrade("M", t(BASE + 1_500, 9, [2, 0, 0], 1));
    const s1 = b.range("M", "1s");
    expect(s1).toEqual([
      { t: BASE, o: 10, h: 12, l: 10, c: 12, v: 5, n: 2, solUsd: 120 },
      { t: BASE + 1_000, o: 9, h: 9, l: 9, c: 9, v: 1, n: 1, solUsd: 120 },
    ]);
    expect(b.range("M", "1m")).toEqual([{ t: BASE, o: 10, h: 12, l: 9, c: 9, v: 6, n: 3, solUsd: 120 }]);
    expect(b.range("M", "1h")[0]?.t).toBe(BASE);
  });

  test("open/close follow the ordering key, not arrival order", () => {
    const b = new CandleBook();
    b.addTrade("M", t(BASE + 10, 20, [5, 2, 0]));
    b.addTrade("M", t(BASE + 20, 30, [5, 9, 0]));
    b.addTrade("M", t(BASE + 5, 10, [5, 0, 0])); // executed first, arrived last
    expect(b.range("M", "1m")[0]).toMatchObject({ o: 10, c: 30, h: 30, l: 10, n: 3 });
  });

  test("a trade for an older bucket is flagged late (sent as a correction)", () => {
    const b = new CandleBook();
    b.addTrade("M", t(BASE + 5_000, 1, [10, 0, 0]));
    const late = b.addTrade("M", t(BASE + 1_000, 2, [9, 0, 0]));
    expect(late.find((u) => u.tf === "1s")?.late).toBe(true);
    expect(late.find((u) => u.tf === "1m")?.late).toBe(false); // same minute bucket as the newest
  });

  test("dead-slot rebuild: exact for buckets covered by memory, adjusted otherwise", () => {
    const b = new CandleBook();
    const a1 = t(BASE + 100, 10, [1, 0, 0], 1);
    const a2 = t(BASE + 200, 50, [2, 0, 0], 4);
    const a3 = t(BASE + 300, 20, [3, 0, 0], 2);
    for (const x of [a1, a2, a3]) b.addTrade("M", x);
    const exact = b.rebuildAfterRemoval("M", [a2], [a1, a3], 0);
    expect(exact.find((u) => u.tf === "1s")?.candle).toMatchObject({ o: 10, h: 20, l: 10, c: 20, v: 3, n: 2 });
    // trade ring does not cover the bucket: volume/count exact, high kept
    const b2 = new CandleBook();
    for (const x of [a1, a2, a3]) b2.addTrade("M", x);
    const adj = b2.rebuildAfterRemoval("M", [a3], [a2], BASE + 10_000_000);
    expect(adj.find((u) => u.tf === "1m")?.candle).toMatchObject({ v: 5, n: 2, c: 50, h: 50 });
    // removing the only trade empties the bucket (n = 0 tells clients to drop it)
    const b3 = new CandleBook();
    b3.addTrade("M", a1);
    expect(b3.rebuildAfterRemoval("M", [a1], [], 0).find((u) => u.tf === "1s")?.candle.n).toBe(0);
    expect(b3.range("M", "1s")).toEqual([]);
  });

  test("memory keeps a bounded tail per series", () => {
    const b = new CandleBook();
    for (let i = 0; i < MEMORY_CAP["1s"] + 50; i++) b.addTrade("M", t(BASE + i * 1_000, 1, [i, 0, 0]));
    expect(b.range("M", "1s").length).toBeLessThanOrEqual(MEMORY_CAP["1s"]);
  });

  test("non-positive prices are ignored", () => {
    expect(new CandleBook().addTrade("M", t(BASE, 0, [1, 0, 0]))).toEqual([]);
  });
});

describe("rolling windows", () => {
  test("5m / 1h / 24h volume and counts expire with time; removals subtract", () => {
    const w = new RollingWindows();
    const now = BASE + 24 * 3_600_000;
    w.add(now - 30_000, 1, true); // in all windows
    w.add(now - 10 * 60_000, 2, false); // 1h + 24h
    w.add(now - 3 * 3_600_000, 4, true); // 24h only
    w.add(now - 25 * 3_600_000, 8, true); // expired
    expect(w.totals(now)).toEqual({ volume5m: 1, volume1h: 3, volume24h: 7, txns: 3, buys: 2, sells: 1 });
    w.remove(now - 10 * 60_000, 2, false);
    expect(w.totals(now)).toEqual({ volume5m: 1, volume1h: 1, volume24h: 5, txns: 2, buys: 2, sells: 0 });
    expect(w.totals(now + 6 * 60_000).volume5m).toBe(0);
  });

  test("late trades land in their own minute", () => {
    const w = new RollingWindows();
    const now = BASE;
    w.add(now - 1_000, 1, true);
    w.add(now - 120_000, 5, true); // arrives after a newer one
    expect(w.totals(now).volume5m).toBe(6);
    expect(w.size).toBe(2);
  });
});
