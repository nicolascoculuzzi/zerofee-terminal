import { describe, expect, test } from "bun:test";
import type { ActivityItem, PnlPoint, Position, WalletStatus } from "../../protocol";
import { dailyPnl, fillMarketCaps, fmtUtcStamp, isDust, marketCapSol, monthWeeks, positionPnl, summarize } from "./helpers";
import { buildShareData } from "./shareData";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 3, 14, 22, 0);

function pos(p: Partial<Position> & { mint: string }): Position {
  return {
    symbol: p.mint.toUpperCase(),
    name: `${p.mint} token`,
    imageUri: null,
    launchpad: "pump",
    boughtSol: 1,
    soldSol: 0,
    boughtTokens: 1_000_000,
    soldTokens: 0,
    holdingTokens: 1_000_000,
    avgEntryPriceSol: 0.000001,
    avgExitPriceSol: null,
    costBasisSol: 1,
    realizedPnlSol: 0,
    unrealizedPnlSol: 0,
    valueSol: 1,
    feesSol: 0.0001,
    openedAt: NOW - 2 * DAY,
    lastTradeAt: NOW - DAY,
    closed: false,
    ...p,
  };
}

function act(a: Partial<ActivityItem> & { id: string; kind: ActivityItem["kind"] }): ActivityItem {
  return { mint: "wif", symbol: "WIF", solAmount: 1, tokenAmount: 1000, marketCapUsd: 10_000, ts: NOW - DAY, signature: "sig", ...a };
}

function wallet(positions: Position[], activity: ActivityItem[] = []): WalletStatus {
  return { address: "w", solBalance: 5, reservedSol: 0.5, nonceSlots: { used: 2, total: 10 }, positions, activity };
}

describe("summarize (header strip and Performance, DESIGN.md 5.3)", () => {
  test("open value and unrealized count every open position; realized and buckets follow the range", () => {
    const s = summarize(
      wallet([
        pos({ mint: "a", valueSol: 2, unrealizedPnlSol: 1, boughtSol: 1 }), // +100%: 0 to 200%
        pos({ mint: "b", closed: true, holdingTokens: 0, valueSol: 0, boughtSol: 1, soldSol: 7, realizedPnlSol: 6 }), // +600%
        pos({ mint: "c", closed: true, holdingTokens: 0, valueSol: 0, boughtSol: 2, soldSol: 0.4, realizedPnlSol: -1.6 }), // −80%
        pos({ mint: "old", closed: true, holdingTokens: 0, valueSol: 0, realizedPnlSol: 3, lastTradeAt: NOW - 40 * DAY }),
      ]),
      "30d",
      NOW,
    );
    expect(s.openCount).toBe(1);
    expect(s.positionsSol).toBe(2);
    expect(s.unrealizedSol).toBe(1);
    expect(s.realizedSol).toBeCloseTo(4.4);
    expect(s.totalPnlSol).toBeCloseTo(5.4);
    expect(s.closed).toBe(2);
    expect(s.wins).toBe(1);
    expect(s.buckets).toEqual([1, 0, 1, 0, 1]);
  });

  test("Max includes positions outside 30 days; trades count buys and sells only", () => {
    const status = wallet(
      [pos({ mint: "old", closed: true, holdingTokens: 0, valueSol: 0, realizedPnlSol: 3, lastTradeAt: NOW - 40 * DAY })],
      [
        act({ id: "1", kind: "buy" }),
        act({ id: "2", kind: "sell" }),
        act({ id: "3", kind: "deposit", mint: null }),
        act({ id: "4", kind: "buy", ts: NOW - 40 * DAY }),
      ],
    );
    expect(summarize(status, "max", NOW).realizedSol).toBe(3);
    const d30 = summarize(status, "30d", NOW);
    expect(d30.realizedSol).toBe(0);
    expect([d30.buys, d30.sells]).toEqual([1, 1]);
  });

  test("PnL is realized plus unrealized; dust is open and under 0.001 SOL", () => {
    expect(positionPnl(pos({ mint: "x", realizedPnlSol: 0.5, unrealizedPnlSol: -0.2 }))).toBeCloseTo(0.3);
    expect(isDust(pos({ mint: "x", valueSol: 0.0004 }))).toBe(true);
    expect(isDust(pos({ mint: "x", valueSol: 0.0004, closed: true }))).toBe(false);
  });
});

describe("market caps at fills", () => {
  test("SOL-weighted average MC at buys and sells", () => {
    const m = fillMarketCaps([
      act({ id: "1", kind: "buy", solAmount: 1, marketCapUsd: 10_000 }),
      act({ id: "2", kind: "buy", solAmount: 3, marketCapUsd: 20_000 }),
      act({ id: "3", kind: "sell", solAmount: 2, marketCapUsd: 50_000 }),
      act({ id: "4", kind: "deposit", mint: null, marketCapUsd: null }),
    ]).get("wif");
    expect(m?.entryUsd).toBe(17_500);
    expect(m?.exitUsd).toBe(50_000);
  });

  test("live supply wins; otherwise the recorded MC converts at the live SOL/USD", () => {
    expect(marketCapSol(0.0000001, 1_000_000_000, 12_000, 120)).toBeCloseTo(100);
    expect(marketCapSol(0.0000001, null, 12_000, 120)).toBe(100);
    expect(marketCapSol(null, null, null, 120)).toBeNull();
  });
});

describe("History calendar", () => {
  test("daily PnL is each day's change in the cumulative series", () => {
    const start = new Date(2026, 9, 1).getTime();
    const pts: PnlPoint[] = [
      { t: start, pnlSol: 1 },
      { t: start + DAY, pnlSol: 1.5 },
      { t: start + 2 * DAY, pnlSol: 1.2 },
    ];
    const d = dailyPnl(pts);
    expect(d.size).toBe(2);
    expect(d.get("2026-9-2")).toBeCloseTo(0.5);
    expect(d.get("2026-9-3")).toBeCloseTo(-0.3);
  });

  test("weeks start on Sunday with blanks around the month (October 2026 starts on a Thursday)", () => {
    const weeks = monthWeeks(new Date(2026, 9, 1).getDay(), 31);
    expect(weeks).toHaveLength(5);
    expect(weeks[0]).toEqual([null, null, null, null, 1, 2, 3]);
    expect(weeks[4]).toEqual([25, 26, 27, 28, 29, 30, 31]);
    expect(monthWeeks(0, 28)).toHaveLength(4);
  });
});

describe("PnL share card data (DESIGN.md 4.21)", () => {
  const activity = [
    act({ id: "b1", kind: "buy", mint: "wif", ts: NOW - 3 * DAY, marketCapUsd: 12_400, solAmount: 0.5 }),
    act({ id: "s1", kind: "sell", mint: "wif", ts: NOW - DAY, marketCapUsd: 43_200, solAmount: 1.74 }),
  ];

  test("a closed position: % hero, invested and returned from fills, entry and exit MC", () => {
    const d = buildShareData({
      position: pos({ mint: "wif", closed: true, boughtSol: 0.5, soldSol: 1.74, realizedPnlSol: 1.24, valueSol: 0, holdingTokens: 0 }),
      activity,
      supply: null,
      liveMcUsd: null,
      solUsd: 120,
      now: NOW,
      walletLabel: "Main",
    });
    expect(d.pct).toBe("+248%");
    expect(d.sol).toBe("+1.24 SOL");
    expect(d.usd).toBe("+$148.80");
    expect(d.sign).toBe(1);
    expect(d.stats.map((s) => s.label)).toEqual(["Invested", "Returned", "Held", "Entry to exit MC"]);
    expect(d.stats[3]).toMatchObject({ value: "$12.4K", arrowTo: "$43.2K" });
    expect([d.entryIndex, d.exitIndex]).toEqual([0, 1]);
    expect(d.stamp).toBe("Oct 3, 2026 · 14:22 UTC");
  });

  test("an open position ends its path at the live MC and has no exit dot; zero cost basis has no %", () => {
    const d = buildShareData({
      position: pos({ mint: "wif", boughtSol: 0, unrealizedPnlSol: 0.2, valueSol: 0.2 }),
      activity,
      supply: null,
      liveMcUsd: 30_000,
      solUsd: 120,
      now: NOW,
      walletLabel: null,
    });
    expect(d.pct).toBeNull();
    expect(d.stats[1]?.label).toBe("Worth now");
    expect(d.path[d.path.length - 1]).toEqual({ t: NOW, v: 30_000 });
    expect(d.exitIndex).toBeNull();
  });

  test("UTC stamp", () => {
    expect(fmtUtcStamp(Date.UTC(2025, 0, 9, 3, 5))).toBe("Jan 9, 2025 · 03:05 UTC");
  });
});
