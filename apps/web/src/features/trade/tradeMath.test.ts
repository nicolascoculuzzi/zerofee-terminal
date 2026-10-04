import { describe, expect, test } from "bun:test";
import {
  ATA_RENT_SOL,
  buyCost,
  buyIssue,
  distancePct,
  ladderNonceSlots,
  maxBuySol,
  migrationPriceSol,
  NETWORK_FEE_SOL,
  nudgePrice,
  sellCost,
  sizeBarPct,
  snapPrice,
} from "./tradeMath";

const settings = { slippagePct: 20, priorityFeeSol: 0.0001, tipSol: 0.00001, landing: "reduced" as const };

describe("cost breakdown", () => {
  test("buy total adds priority, tip, base fee and first-buy rent; the platform fee is zero", () => {
    const quote = { tokens: 1_240_000, sol: 0.5, venueFeeSol: 0.0062, impactPct: 0.42, capped: false };
    const c = buyCost(quote, 0.5, settings, true, 125);
    expect(c.venuePct).toBe(1.25);
    expect(c.rentSol).toBe(ATA_RENT_SOL);
    expect(c.totalSol).toBeCloseTo(0.5 + 0.0001 + 0.00001 + NETWORK_FEE_SOL + ATA_RENT_SOL, 12);
    expect(buyCost(quote, 0.5, settings, false, 125).rentSol).toBe(0);
  });

  test("sell net subtracts priority, tip and base fee from the venue-net proceeds", () => {
    const quote = { tokens: 620_000, sol: 0.61, venueFeeSol: 0.0077, impactPct: 0.3, capped: false };
    const c = sellCost(quote, settings, 125);
    expect(c.amountSol).toBeCloseTo(0.6177, 10);
    expect(c.totalSol).toBeCloseTo(0.61 - 0.0001 - 0.00001 - NETWORK_FEE_SOL, 12);
  });
});

describe("max and validation", () => {
  test("max leaves the reserve for fees, tip and rent", () => {
    const max = maxBuySol(2.412, settings, true);
    expect(max).toBeLessThanOrEqual(2.412 - 0.0001 - 0.00001 - NETWORK_FEE_SOL - ATA_RENT_SOL);
    expect(max).toBeGreaterThan(2.4);
    expect(maxBuySol(0, settings, true)).toBe(0);
  });

  test("issues: cap first, then balance, then minimum", () => {
    const base = { available: 1, settings, firstBuy: false, perTradeCap: 5, dailyCap: 50, spentToday: 0 };
    expect(buyIssue({ ...base, sol: null })).toBeNull();
    expect(buyIssue({ ...base, sol: 0.5 })).toBeNull();
    expect(buyIssue({ ...base, sol: 6 })?.cta).toBe("Above per-trade cap");
    expect(buyIssue({ ...base, sol: 1 })?.text).toBe("Exceeds balance by 0.000115 SOL");
    expect(buyIssue({ ...base, sol: 0.0005 })?.tone).toBe("warn");
    expect(buyIssue({ ...base, sol: 2, spentToday: 49 })?.cta).toBe("Above daily cap");
  });
});

describe("orders and lines", () => {
  test("OCO pairs share a nonce", () => {
    const legs = [{ kind: "take_profit" as const }, { kind: "take_profit" as const }, { kind: "stop_loss" as const }];
    expect(ladderNonceSlots(legs, true)).toBe(2);
    expect(ladderNonceSlots(legs, false)).toBe(3);
  });

  test("snapping to 0.5% steps of the current price", () => {
    expect(snapPrice(0.798, 1)).toBeCloseTo(0.8, 10);
    expect(snapPrice(1.0124, 1)).toBeCloseTo(1.01, 10);
    expect(distancePct(0.8, 1)).toBeCloseTo(-20, 10);
    expect(nudgePrice(1, 1, 0.5)).toBeCloseTo(1.005, 10);
    expect(nudgePrice(1, 1, -5)).toBeCloseTo(0.95, 10);
  });

  test("migration price is where the curve's real tokens run out", () => {
    const curve = {
      virtualQuoteReserves: 30,
      virtualTokenReserves: 1_073_000_000,
      realQuoteReserves: 0,
      realTokenReserves: 793_100_000,
      initialRealTokenReserves: 793_100_000,
      complete: false,
      feeBps: 125,
    };
    const p = migrationPriceSol(curve);
    expect(p).not.toBeNull();
    // About 85 SOL raised at completion: final price around 4.1e-7 SOL per token.
    expect(p as number).toBeGreaterThan(3.5e-7);
    expect(p as number).toBeLessThan(4.5e-7);
    expect(migrationPriceSol({ ...curve, complete: true })).toBeNull();
    expect(migrationPriceSol(null)).toBeNull();
  });

  test("size bars fill 60% at 10 SOL", () => {
    expect(sizeBarPct(0)).toBe(0);
    expect(sizeBarPct(10)).toBeCloseTo(60, 10);
    expect(sizeBarPct(100)).toBe(60);
    expect(sizeBarPct(1)).toBeGreaterThan(15);
  });
});
