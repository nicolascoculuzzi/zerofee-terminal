import { describe, expect, test } from "bun:test";
import {
  applyCurveBuy,
  applyCurveSell,
  curvePrice,
  curveProgress,
  newCurve,
  PUMP,
  poolFromCurve,
  poolPrice,
  quoteCurveBuy,
  quoteCurveSell,
} from "./curve";

describe("pump-style bonding curve (simulation)", () => {
  test("starts at 30 SOL / 1.073B virtual reserves", () => {
    const c = newCurve();
    expect(curvePrice(c)).toBeCloseTo(30 / 1_073_000_000, 15);
    // ≈ 27.96 SOL market cap at launch
    expect(curvePrice(c) * PUMP.totalSupply).toBeCloseTo(27.96, 2);
    expect(curveProgress(c)).toBe(0);
  });

  test("graduates after ~85 SOL with a ~411 SOL market cap", () => {
    const c = newCurve();
    const q = quoteCurveBuy(c, 1_000);
    expect(q.capped).toBe(true);
    applyCurveBuy(c, q);
    expect(c.complete).toBe(true);
    expect(c.realTok).toBe(0);
    expect(c.realSol).toBeGreaterThan(84.9);
    expect(c.realSol).toBeLessThan(85.1);
    expect(curveProgress(c)).toBe(1);
    expect(curvePrice(c) * PUMP.totalSupply).toBeCloseTo(410.9, 0);
  });

  test("the migrated pool opens at about the curve's final price", () => {
    const c = newCurve();
    applyCurveBuy(c, quoteCurveBuy(c, 1_000));
    const pool = poolFromCurve(c, "pool");
    expect(pool.tok).toBe(206_900_000);
    expect(poolPrice(pool) / curvePrice(c)).toBeCloseTo(1, 3);
  });

  test("a round trip loses the 1.25% venue fee on each side", () => {
    const c = newCurve();
    const buy = quoteCurveBuy(c, 1);
    applyCurveBuy(c, buy);
    const sell = quoteCurveSell(c, buy.tokens);
    applyCurveSell(c, sell);
    expect(buy.feeSol).toBeCloseTo(1 - 1 / 1.0125, 9);
    expect(sell.sol).toBeLessThan(1);
    expect(sell.sol).toBeGreaterThan(0.97);
  });

  test("progress follows 1 − real/initial real tokens (mayhem 2B supply too)", () => {
    const c = newCurve(2);
    applyCurveBuy(c, quoteCurveBuy(c, 5));
    expect(curveProgress(c)).toBeCloseTo(1 - c.realTok / (PUMP.initialRealTokens * 2), 12);
  });
});
