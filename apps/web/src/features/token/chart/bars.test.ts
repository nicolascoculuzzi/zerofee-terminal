import { describe, expect, test } from "bun:test";
import type { Candle } from "../../../protocol";
import {
  bucketStart,
  defaultTimeframe,
  lowerBound,
  mergeLive,
  mergeOlder,
  mergeSnapshot,
  normalize,
  padRange,
  sanitize,
  visibleRange,
} from "./bars";

const c = (time: number, o: number, h: number, l: number, cl: number, v = 1): Candle => ({
  time,
  open: o,
  high: h,
  low: l,
  close: cl,
  volumeSol: v,
  buys: 0,
  sells: 0,
  solUsd: 120,
});

describe("bucketStart", () => {
  test("aligns to UTC epoch multiples like the server", () => {
    const ts = Date.UTC(2026, 9, 4, 6, 34, 58, 750);
    expect(bucketStart(ts, "1s")).toBe(Math.floor(ts / 1000));
    expect(bucketStart(ts, "15s")).toBe(Date.UTC(2026, 9, 4, 6, 34, 45) / 1000);
    expect(bucketStart(ts, "1m")).toBe(Date.UTC(2026, 9, 4, 6, 34) / 1000);
    expect(bucketStart(ts, "5m")).toBe(Date.UTC(2026, 9, 4, 6, 30) / 1000);
    expect(bucketStart(ts, "15m")).toBe(Date.UTC(2026, 9, 4, 6, 30) / 1000);
    expect(bucketStart(ts, "1h")).toBe(Date.UTC(2026, 9, 4, 6) / 1000);
  });
  test("a bucket boundary belongs to the new bucket", () => {
    expect(bucketStart(15_000, "15s")).toBe(15);
    expect(bucketStart(14_999, "15s")).toBe(0);
  });
});

describe("sanitize / normalize", () => {
  test("drops undrawable candles and fixes wicks", () => {
    expect(sanitize(c(1, 0, 0, 0, 0))).toBeNull();
    expect(sanitize(c(1, 1, 0.5, 2, 1.5))).toMatchObject({ high: 2, low: 0.5 });
    expect(sanitize(c(1, 0, 2, 1, 1.5))).toMatchObject({ open: 1.5 });
  });
  test("dedupes (last wins), sorts and chains opens to the previous close", () => {
    const out = normalize([c(3, 9, 9, 9, 9), c(1, 1, 1, 1, 1), c(2, 5, 6, 4, 5), c(3, 2, 3, 2, 3)]);
    expect(out.map((x) => x.time)).toEqual([1, 2, 3]);
    // Bucket 2 opens at 1 (previous close): its low widens to cover it.
    expect(out[1]).toMatchObject({ open: 1, low: 1, high: 6, close: 5 });
    expect(out[2]).toMatchObject({ open: 5, high: 5, low: 2, close: 3 });
    // The first candle keeps its own open (the first trade).
    expect(out[0]?.open).toBe(1);
  });
});

describe("mergeLive", () => {
  const base = normalize([c(10, 1, 1, 1, 1), c(11, 1, 2, 1, 2)]);
  test("updates the current bucket in place", () => {
    const m = mergeLive(base, [c(11, 2, 3, 2, 3, 5)]);
    expect(m.rewrite).toBe(false);
    expect(m.touched).toEqual([1]);
    expect(m.bars[1]).toMatchObject({ open: 1, high: 3, close: 3, volumeSol: 5 });
    expect(base[1]?.close).toBe(2);
  });
  test("appends a new bucket at an interval boundary, opened at the previous close", () => {
    const m = mergeLive(base, [c(12, 7, 7, 7, 7)]);
    expect(m.touched).toEqual([2]);
    expect(m.bars[2]).toMatchObject({ time: 12, open: 2, low: 2, high: 7, close: 7 });
  });
  test("out-of-order and duplicate deltas in one batch", () => {
    const m = mergeLive(base, [c(13, 4, 4, 4, 4), c(12, 3, 3, 3, 3), c(12, 3, 3.5, 3, 3.5)]);
    expect(m.bars.map((x) => x.time)).toEqual([10, 11, 12, 13]);
    expect(m.bars[2]?.close).toBe(3.5);
    expect(m.bars[3]?.open).toBe(3.5);
    expect(m.rewrite).toBe(false);
  });
  test("a late bucket inside the series needs a rewrite", () => {
    const sparse = normalize([c(10, 1, 1, 1, 1), c(20, 2, 2, 2, 2)]);
    const m = mergeLive(sparse, [c(15, 1.5, 1.5, 1.5, 1.5)]);
    expect(m.rewrite).toBe(true);
    expect(m.bars.map((x) => x.time)).toEqual([10, 15, 20]);
    expect(m.bars[2]?.open).toBe(1.5);
  });
  test("a corrected older bucket re-opens the bar after it (historical update)", () => {
    const three = normalize([c(10, 1, 1, 1, 1), c(11, 1, 2, 1, 2), c(12, 2, 3, 2, 3)]);
    const m = mergeLive(three, [c(11, 1, 2.5, 1, 2.5)]);
    expect(m.touched).toEqual([1, 2]);
    expect(m.bars[2]?.open).toBe(2.5);
  });
  test("invalid candles are ignored", () => {
    const m = mergeLive(base, [c(12, 0, 0, 0, 0)]);
    expect(m.bars).toHaveLength(2);
    expect(m.touched).toEqual([]);
  });
});

describe("mergeOlder / mergeSnapshot", () => {
  test("prepends an older page; bars already loaded win", () => {
    const now = normalize([c(100, 5, 5, 5, 5), c(101, 5, 6, 5, 6)]);
    const m = mergeOlder(now, [c(98, 1, 1, 1, 1), c(99, 2, 2, 2, 2), c(100, 9, 9, 9, 9)]);
    expect(m.added).toBe(2);
    expect(m.bars.map((x) => x.time)).toEqual([98, 99, 100, 101]);
    expect(m.bars[2]).toMatchObject({ close: 5, open: 2 });
  });
  test("an empty or fully overlapping page adds nothing", () => {
    const now = normalize([c(100, 5, 5, 5, 5)]);
    expect(mergeOlder(now, []).added).toBe(0);
    expect(mergeOlder(now, [c(100, 1, 1, 1, 1)]).added).toBe(0);
  });
  test("a re-snapshot replaces its window and keeps older pages", () => {
    const loaded = normalize([c(1, 1, 1, 1, 1), c(2, 2, 2, 2, 2), c(3, 3, 3, 3, 3)]);
    const out = mergeSnapshot(loaded, [c(2, 2, 2, 2, 2.2), c(4, 4, 4, 4, 4)]);
    expect(out.map((x) => x.time)).toEqual([1, 2, 4]);
    expect(out[1]?.close).toBe(2.2);
  });
});

describe("padRange (autoscale floor)", () => {
  test("a zero range is padded around its midpoint", () => {
    expect(padRange(42700, 42700)).toEqual({ min: 42700 - 213.5, max: 42700 + 213.5 });
  });
  test("thin ranges widen to 1% of the price, wide ranges are untouched", () => {
    const r = padRange(42680, 42710);
    expect(r.max - r.min).toBeCloseTo(426.95, 6);
    expect(padRange(100, 200)).toEqual({ min: 100, max: 200 });
  });
  test("zero midpoint and non-finite input", () => {
    expect(padRange(0, 0)).toEqual({ min: -0.5, max: 0.5 });
    expect(padRange(Number.NaN, 1).min).toBeNaN();
  });
});

describe("visibleRange (launch candle trim)", () => {
  const bars = [
    { high: 100, low: 1, close: 90 },
    { high: 95, low: 85, close: 92 },
    { high: 98, low: 88, close: 96 },
  ];
  test("the launch candle's open and wick don't flatten the rest", () => {
    expect(visibleRange(bars, -5, 10, true)).toEqual({ min: 85, max: 98 });
  });
  test("only when the first bar is visible, there are enough bars and it is an outlier", () => {
    expect(visibleRange(bars, 1, 10, true)).toBeNull();
    expect(visibleRange(bars, -5, 10, false)).toBeNull();
    expect(visibleRange(bars.slice(0, 2), -5, 10, true)).toBeNull();
    const calm = [{ high: 91, low: 89, close: 90 }, ...bars.slice(1)];
    expect(visibleRange(calm, -5, 10, true)).toBeNull();
  });
});

describe("lowerBound", () => {
  test("first index at or after a time", () => {
    const list = [{ time: 1 }, { time: 3 }, { time: 5 }];
    expect(lowerBound(list, 0)).toBe(0);
    expect(lowerBound(list, 3)).toBe(1);
    expect(lowerBound(list, 4)).toBe(2);
    expect(lowerBound(list, 9)).toBe(3);
  });
});

describe("defaultTimeframe", () => {
  const now = Date.UTC(2026, 9, 4);
  const min = 60_000;
  test("by coin age", () => {
    expect(defaultTimeframe(now - 2 * min, now, "1m")).toBe("1s");
    expect(defaultTimeframe(now - 2 * 60 * min, now, "1m")).toBe("15s");
    expect(defaultTimeframe(now - 30 * 60 * min, now, "15s")).toBe("1m");
    expect(defaultTimeframe(now - 7 * 24 * 60 * min, now, "15s")).toBe("5m");
    expect(defaultTimeframe(now - 60 * 24 * 60 * min, now, "15s")).toBe("15m");
  });
  test("unknown or future age keeps the fallback", () => {
    expect(defaultTimeframe(null, now, "15s")).toBe("15s");
    expect(defaultTimeframe(0, now, "1m")).toBe("1m");
    expect(defaultTimeframe(now + 10 * min, now, "5m")).toBe("5m");
  });
});
