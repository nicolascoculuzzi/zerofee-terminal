import { describe, expect, test } from "bun:test";
import { BLACKLIST_KINDS, CHANNEL_KINDS, DEFAULT_PRESETS, DEFAULT_USER_SETTINGS, USER_LIMITS } from "../src";

describe("shared user defaults", () => {
  test("three presets in slot order with lean tips", () => {
    expect(DEFAULT_PRESETS.map((p) => p.slot)).toEqual([1, 2, 3]);
    expect(DEFAULT_PRESETS.map((p) => p.buy.landing)).toEqual(["reduced", "secure", "fast"]);
    for (const p of DEFAULT_PRESETS) {
      for (const side of [p.buy, p.sell]) {
        expect(side.slippageBps).toBeGreaterThan(0);
        expect(side.tipSol).toBeLessThanOrEqual(0.001);
      }
    }
  });

  test("default settings only reference known channels and an existing preset", () => {
    const n = DEFAULT_USER_SETTINGS.notifications;
    for (const c of [...n.walletChannels, ...n.orderChannels]) expect(CHANNEL_KINDS).toContain(c);
    expect(DEFAULT_PRESETS.some((p) => p.slot === DEFAULT_USER_SETTINGS.activePreset)).toBe(true);
    expect(DEFAULT_USER_SETTINGS.autoLockMinutes).toBe(15);
  });

  test("limits match the spec (25 trading wallets, 10,000 tracked wallets)", () => {
    expect(USER_LIMITS.tradingWallets).toBe(25);
    expect(USER_LIMITS.trackedWallets).toBe(10_000);
    expect(BLACKLIST_KINDS).toEqual(["token", "dev", "funder", "x"]);
  });
});
