import { describe, expect, test } from "bun:test";
import { parseTopic, TIMEFRAME_MS, TIMEFRAMES, type Topic, topics } from "../src";

const MINT = "F62MDKs1XcNtTFmh6aeCDGhd2Q1u1Jt86mnWTK3Gpump";

describe("topics", () => {
  test("builders and parser round-trip", () => {
    const all: Topic[] = [
      topics.pulse("new"),
      topics.pulse("final"),
      topics.pulse("migrated"),
      topics.token(MINT),
      topics.trades(MINT),
      topics.candles(MINT, "1s"),
      topics.candles(MINT, "1h"),
      topics.tradectx(MINT),
      topics.chain,
      topics.wallet(MINT),
      topics.orders,
    ];
    expect(all).toContain("pulse:final");
    expect(all).toContain(`candles:${MINT}:1s`);
    for (const t of all) expect(parseTopic(t)).not.toBeNull();
    expect(parseTopic(`candles:${MINT}:15s`)).toEqual({ kind: "candles", mint: MINT, tf: "15s" });
    expect(parseTopic(`tradectx:${MINT}`)).toEqual({ kind: "tradectx", mint: MINT });
  });

  test("rejects malformed topics", () => {
    for (const bad of [
      "",
      "pulse",
      "pulse:old",
      `token:${MINT}0OIl`,
      "token:abc",
      `candles:${MINT}:2m`,
      `candles:${MINT}`,
      "chains",
      `x:${MINT}`,
    ]) {
      expect(parseTopic(bad)).toBeNull();
    }
  });

  test("every timeframe has a bucket length", () => {
    for (const tf of TIMEFRAMES) expect(TIMEFRAME_MS[tf]).toBeGreaterThan(0);
  });
});
