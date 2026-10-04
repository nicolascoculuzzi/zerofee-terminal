import { describe, expect, test } from "bun:test";
import type { Order } from "../../protocol";
import { firstEvents, nextEvent, sentAt } from "./orderLog";
import {
  affectedOrders,
  cancelTargets,
  groupByToken,
  nonceInfo,
  sizeText,
  TAB_TEST,
  tabCounts,
  triggerDistance,
  triggerText,
  typeLabels,
  variantsText,
} from "./orderText";

const T0 = 1_790_000_000_000;

function order(o: Partial<Order> & { id: string }): Order {
  return {
    mint: "wif",
    symbol: "WIF",
    kind: "limit_sell",
    side: "sell",
    trigger: { metric: "mc", direction: "above", value: 120_000 },
    size: { kind: "pct", pct: 25 },
    status: "armed",
    statusReason: null,
    runsWithTabClosed: true,
    needsBrowserReason: null,
    reservedSol: 0.0016,
    nonceSlots: 1,
    ocoGroupId: null,
    landing: "secure",
    variants: 6,
    armedPriceSol: 0.0000001,
    createdAt: T0,
    updatedAt: T0,
    filledAt: null,
    signature: null,
    fill: null,
    ...o,
  };
}

// Glyphs our fonts don't have (DESIGN.md 2.2): triggers are written in words.
const MISSING_GLYPHS = new Set([0x2264, 0x2265, 0x2192, 0x2248, ...Array.from({ length: 10 }, (_, i) => 0x2080 + i)]);
const hasMissingGlyph = (s: string) => Array.from(s).some((ch) => MISSING_GLYPHS.has(ch.codePointAt(0) ?? 0));

describe("trigger text (DESIGN.md 4.20: words, never comparison glyphs)", () => {
  const usd = { quote: "USD" as const, solUsd: 120, supply: null };
  test("market-cap triggers in the global quote", () => {
    expect(triggerText(order({ id: "a" }), usd)).toBe("MC above $120K");
    expect(triggerText(order({ id: "a", trigger: { metric: "mc", direction: "below", value: 8_000 } }), usd)).toBe("MC below $8.00K");
    expect(triggerText(order({ id: "a" }), { ...usd, quote: "SOL" })).toBe("MC above 1.00K SOL");
  });

  test("price triggers read as the market cap they imply when the supply is known", () => {
    const tp = order({ id: "tp", kind: "take_profit", trigger: { metric: "price", direction: "above", value: 0.0000004 } });
    expect(triggerText(tp, { ...usd, supply: 1_000_000_000 })).toBe("MC above $48.0K");
    expect(triggerText(tp, usd)).toBe("Price above 0.0000004 SOL");
  });

  test("event triggers", () => {
    expect(triggerText(order({ id: "m", trigger: { metric: "migration", direction: null, value: null } }), usd)).toBe("On migration");
    expect(triggerText(order({ id: "c", mint: null, trigger: { metric: "leader_buy", direction: null, value: null } }), usd)).toBe(
      "When the leader buys",
    );
  });

  test("no fallback glyphs", () => {
    for (const metric of ["mc", "price"] as const) {
      for (const direction of ["above", "below"] as const) {
        const text = triggerText(order({ id: "x", trigger: { metric, direction, value: 0.00000002796 } }), usd);
        expect(hasMissingGlyph(text)).toBe(false);
      }
    }
  });
});

describe("distance to trigger", () => {
  test("signed % from the live value; crossed when past it", () => {
    const o = order({ id: "a", trigger: { metric: "mc", direction: "above", value: 120_000 } });
    expect(triggerDistance(o, { mcUsd: 100_000, priceSol: null })).toEqual({ pct: 20, crossed: false });
    expect(triggerDistance(o, { mcUsd: 130_000, priceSol: null })?.crossed).toBe(true);
    const sl = order({ id: "b", kind: "stop_loss", trigger: { metric: "price", direction: "below", value: 0.00000008 } });
    expect(triggerDistance(sl, { mcUsd: null, priceSol: 0.0000001 })?.pct).toBeCloseTo(-20);
  });

  test("only open orders with a live value have a distance", () => {
    expect(triggerDistance(order({ id: "a", status: "filled" }), { mcUsd: 100_000, priceSol: null })).toBeNull();
    expect(triggerDistance(order({ id: "a" }), { mcUsd: null, priceSol: null })).toBeNull();
  });
});

describe("type, size, nonce and variant columns", () => {
  test("TP legs numbered by trigger price, a single SL stays SL", () => {
    const labels = typeLabels([
      order({ id: "tp2", kind: "take_profit", trigger: { metric: "price", direction: "above", value: 4 } }),
      order({ id: "tp1", kind: "take_profit", trigger: { metric: "price", direction: "above", value: 2 } }),
      order({ id: "sl", kind: "stop_loss", trigger: { metric: "price", direction: "below", value: 0.6 } }),
      order({ id: "mig", kind: "migration_sell" }),
    ]);
    expect(labels.get("tp1")).toBe("TP1");
    expect(labels.get("tp2")).toBe("TP2");
    expect(labels.get("sl")).toBe("SL");
    expect(labels.get("mig")).toBe("Migration sell");
  });

  test("size reads as an action", () => {
    expect(sizeText(order({ id: "a" }))).toBe("Sell 25%");
    expect(sizeText(order({ id: "b", side: "buy", size: { kind: "sol", sol: 0.5 } }))).toBe("Buy 0.5 SOL");
  });

  test("nonce: own slot, OCO-shared, or none", () => {
    expect(nonceInfo(order({ id: "a" })).text).toBe("1 slot");
    expect(nonceInfo(order({ id: "b", ocoGroupId: "g", nonceSlots: 0 }))).toMatchObject({ text: "Shared", shared: true });
    expect(nonceInfo(order({ id: "c", nonceSlots: 0 })).text).toBe("None");
    expect(variantsText(order({ id: "d", variants: 0 })).text).toBe("Live");
  });
});

describe("tabs, grouping and cancels", () => {
  const orders = [
    order({ id: "1", status: "armed" }),
    order({ id: "2", status: "submitted" }),
    order({ id: "3", status: "stale", statusReason: "pump.fun upgrade changed accounts" }),
    order({ id: "4", status: "filled", mint: "bonk", symbol: "BONK", updatedAt: T0 + 5, filledAt: T0 + 5 }),
    order({ id: "5", status: "failed" }),
    order({ id: "6", status: "cancelled", mint: "bonk", symbol: "BONK" }),
  ];

  test("counts per tab (Armed includes Sending)", () => {
    expect(tabCounts(orders)).toEqual({ all: 6, armed: 2, rearm: 1, filled: 1, consumed: 1, cancelled: 1 });
    expect(orders.filter(TAB_TEST.consumed).map((o) => o.id)).toEqual(["5"]);
  });

  test("groups with open orders first; open orders lead inside a group", () => {
    const groups = groupByToken(orders);
    expect(groups.map((g) => g.key)).toEqual(["wif", "bonk"]);
    expect(groups[0]?.orders.map((o) => o.id)).toEqual(["2", "1", "3", "5"]);
    expect(groups[0]?.openCount).toBe(3);
    expect(groups[1]?.openCount).toBe(0);
  });

  test("one cancel per durable nonce; the OCO sibling is reported as affected", () => {
    const tp = order({ id: "tp", kind: "take_profit", ocoGroupId: "g1" });
    const sl = order({ id: "sl", kind: "stop_loss", ocoGroupId: "g1", nonceSlots: 0 });
    const done = order({ id: "done", status: "filled" });
    expect(cancelTargets([tp, sl, done]).map((o) => o.id)).toEqual(["tp"]);
    expect(affectedOrders([tp], [tp, sl, done]).map((o) => o.id)).toEqual(["tp", "sl"]);
  });
});

describe("order timeline log", () => {
  test("first sighting proves armed, then the current state", () => {
    expect(firstEvents(order({ id: "a" })).map((e) => e.kind)).toEqual(["armed"]);
    expect(firstEvents(order({ id: "b", updatedAt: T0 + 60_000 })).map((e) => e.kind)).toEqual(["armed", "rearmed"]);
    const stale = firstEvents(order({ id: "c", status: "stale", statusReason: "ALT closed", updatedAt: T0 + 1 }));
    expect(stale[1]).toMatchObject({ kind: "stale", reason: "ALT closed", slot: null });
  });

  test("back to armed from stale is a re-arm; the send time gives the time to land", () => {
    expect(nextEvent("stale", order({ id: "a", updatedAt: T0 + 9 }), 312_456_789)).toMatchObject({ kind: "rearmed", slot: 312_456_789 });
    const events = [
      { at: T0, kind: "armed" as const, reason: null, slot: null },
      { at: T0 + 1_000, kind: "submitted" as const, reason: null, slot: 1 },
    ];
    expect(sentAt(events)).toBe(T0 + 1_000);
    expect(sentAt(undefined)).toBeNull();
  });
});
