/**
 * Server-side pure logic: the status machine, the trigger engine (variant choice with a safety
 * margin, trailing stops bounded by the grid, dev-sell and migration events), live quotes,
 * staleness detection, safety validators and reservations. Orders here are synthetic (no signing).
 */
import { describe, expect, test } from "bun:test";
import { type Address, address, getAddressDecoder } from "@solana/kit";
import {
  type AmmSwapEvent,
  type ArmedAttempt,
  type ArmedOrder,
  ArmedTransitionError,
  type ArmedTrigger,
  type ArmedVariant,
  aggregateReservations,
  ammFeeRates,
  applyArmedOrderEvent,
  applyMarketEvent,
  armedNotional,
  armedSignatures,
  bondingCurvePda,
  changedInterfaces,
  classifyStaleness,
  currentInterfaceVersion,
  curveFeeRates,
  DEFAULT_ARMED_SAFETY_POLICY,
  decodeBondingCurve,
  decodeFeeConfig,
  decodeMint,
  decodePool,
  decodeTokenAccount,
  detectStaleness,
  evaluateTrigger,
  formatInterfaceVersion,
  gridDepthBps,
  hasReservedBalance,
  interfacesForVenue,
  isCanonicalPumpPool,
  type LookupTableState,
  liveQuoteOut,
  marketEventFromDecoded,
  nextLiveAttempt,
  PUMP_AMM_FEE_CONFIG,
  PUMP_FEE_CONFIG,
  parseInterfaceVersion,
  pickVariant,
  quoteAmmSell,
  quoteBuyExactQuoteIn,
  quoteSell,
  reservationHeld,
  signaturesOnNonce,
  trailingHighWaterCap,
  trailingStop,
  validateArmedOrder,
  validateUserArmedOrders,
} from "../src";
import { ammGlobalConfig, pumpGlobal } from "./armedTestKit";
import { CURVE_MINT, fixture, POOL } from "./fixtures";

const WALLET = address("HpqMfMw5r9DT3qWMHup63YndJF6hsjGAcy9qkFGtdpq4");
const MINT = address("8iF53SDsUDd3WpcJ1XQcwFxHD36t2RVEBescHU56pump");
const CREATOR = address("Hy5oibb1cYdmjyPJ2fiypDtKYvp1uZTuPkmFzVy7TL8c");
const FEE = address("62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV");
const BUYBACK = address("5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD");
const TABLE = address("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
const nonceAddr = (i: number) => getAddressDecoder().decode(new Uint8Array(32).fill(i + 10));

interface SynthArgs {
  id?: string;
  side?: "buy" | "sell";
  kind?: ArmedOrder["kind"];
  attempts?: number;
  /** Shared nonce indices per attempt (default 0..n-1). */
  nonceIdx?: number[];
  minOuts?: bigint[];
  tipLevels?: number[];
  venues?: ArmedVariant["venue"][];
  trigger?: ArmedTrigger;
  fullExit?: boolean;
  ocoGroup?: string;
  amount?: bigint;
  armingQuoteOut?: bigint;
  /** Nonce value per attempt (default `nonce-<index>`): a re-armed slot has a new value. */
  nonceValues?: string[];
  mint?: Address;
}

function synth(a: SynthArgs = {}): ArmedOrder {
  const id = a.id ?? "o1";
  const mint = a.mint ?? MINT;
  const side = a.side ?? "sell";
  const minOuts = a.minOuts ?? [1_000n, 900n, 800n];
  const tips = a.tipLevels ?? [0, 1];
  const venues = a.venues ?? ["pump"];
  const attempts: ArmedAttempt[] = Array.from({ length: a.attempts ?? 1 }, (_v, index) => {
    const n = a.nonceIdx?.[index] ?? index;
    const variants: ArmedVariant[] = [];
    for (const venue of venues) {
      for (const [mi, minOut] of minOuts.entries()) {
        for (const tipLevel of tips) {
          variants.push({
            id: `${id}/${index}/${venue}/${mi}/${tipLevel}`,
            venue,
            minOut,
            tipLevel,
            tipLamports: 10_000n * BigInt(tipLevel + 1),
            priorityFeeLamports: 15_000n,
            tx: { wireBase64: "AA==", signature: `sig-${id}-${index}-${venue}-${mi}-${tipLevel}`, size: 900 },
          });
        }
      }
    }
    return {
      index,
      nonce: {
        account: nonceAddr(n),
        authority: WALLET,
        value: a.nonceValues?.[index] ?? `nonce-${n}`,
        // OCO orders share the exact cancel bytes of a nonce generation.
        cancel: { wireBase64: "AA==", signature: `cancel-${a.nonceValues?.[index] ?? n}`, size: 200 },
      },
      variants,
      status: "live",
    };
  });
  return {
    id,
    wallet: WALLET,
    kind: a.kind ?? (side === "buy" ? "limit-buy" : "stop-loss"),
    side,
    mint,
    amount: a.amount ?? 1_000_000n,
    fullExit: a.fullExit ?? side === "sell",
    trigger: a.trigger ?? { type: "quote-at-most", threshold: 1_100n },
    attempts,
    ...(a.ocoGroup ? { ocoGroup: a.ocoGroup } : {}),
    armingQuoteOut: a.armingQuoteOut ?? 1_200n,
    armedAtMs: 0,
    frozen: {
      mint: MINT,
      baseTokenProgram: address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
      quoteMint: address("So11111111111111111111111111111111111111112"),
      venues: venues.map((venue) => ({
        venue,
        creator: CREATOR,
        market: venue === "pump" ? nonceAddr(2) : POOL,
        feeRecipient: FEE,
        buybackFeeRecipient: BUYBACK,
      })),
      tipAccounts: [address("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5")],
      lookupTables: [TABLE],
      interfaceVersion: currentInterfaceVersion(),
    },
    reservation: { lamports: 50_000n, mint, tokens: side === "sell" ? (a.amount ?? 1_000_000n) : 0n },
    capCost: { buyLamports: 0n, buyQuote: {}, feeLamports: 0n },
    status: "armed",
  };
}

const variant = (o: ArmedOrder, attempt: number, mi: number, tip = 0, venue = "pump") =>
  o.attempts[attempt]?.variants.find((v) => v.id === `${o.id}/${attempt}/${venue}/${mi}/${tip}`) as ArmedVariant;

// ---------------------------------------------------------------------------------------------

describe("pickVariant: min-out just below the live quote, with a safety margin", () => {
  const o = synth({ minOuts: [1_000n, 900n, 800n], tipLevels: [0, 1, 2] });
  const vs = o.attempts[0]?.variants ?? [];

  test("highest min-out at or below quote x (1 - margin)", () => {
    expect(pickVariant(vs, 1_100n, { safetyMarginBps: 0 })?.minOut).toBe(1_000n);
    expect(pickVariant(vs, 1_000n, { safetyMarginBps: 0 })?.minOut).toBe(1_000n);
    expect(pickVariant(vs, 1_000n, { safetyMarginBps: 100 })?.minOut).toBe(900n); // floor 990
    expect(pickVariant(vs, 1_010n, { safetyMarginBps: 100 })?.minOut).toBe(900n); // floor 999 < 1,000
    expect(pickVariant(vs, 1_011n, { safetyMarginBps: 100 })?.minOut).toBe(1_000n); // floor 1,000
    expect(pickVariant(vs, 820n, { safetyMarginBps: 300 })).toBeNull(); // floor 795 < 800
  });

  test("none when the quote is below the widest variant (never submit a likely failure: it burns the nonce)", () => {
    expect(pickVariant(vs, 799n, { safetyMarginBps: 0 })).toBeNull();
  });

  test("tip level: lowest by default; preferred level, else next higher, else highest available", () => {
    expect(pickVariant(vs, 2_000n, { safetyMarginBps: 0 })?.tipLevel).toBe(0);
    expect(pickVariant(vs, 2_000n, { safetyMarginBps: 0, tipLevel: 1 })?.tipLevel).toBe(1);
    const sparse = vs.filter((v) => v.tipLevel !== 1);
    expect(pickVariant(sparse, 2_000n, { safetyMarginBps: 0, tipLevel: 1 })?.tipLevel).toBe(2);
    expect(pickVariant(vs, 2_000n, { safetyMarginBps: 0, tipLevel: 9 })?.tipLevel).toBe(2);
  });

  test("venue filter and margin validation", () => {
    const dual = synth({ venues: ["pump", "pumpswap"] }).attempts[0]?.variants ?? [];
    expect(pickVariant(dual, 2_000n, { safetyMarginBps: 0 }, "pumpswap")?.venue).toBe("pumpswap");
    expect(() => pickVariant(vs, 1n, { safetyMarginBps: 10_000 })).toThrow();
  });
});

describe("evaluateTrigger", () => {
  const policy = { safetyMarginBps: 100 };
  const input = (q: bigint | null, extra: Partial<Parameters<typeof evaluateTrigger>[2]> = {}) => ({
    liveQuoteOut: q,
    venue: "pump" as const,
    nowMs: 1_000,
    ...extra,
  });

  test("stop-loss (quote-at-most) fires below the threshold with the right variant", () => {
    const o = synth({ trigger: { type: "quote-at-most", threshold: 950n } });
    expect(evaluateTrigger(o, {}, input(1_000n), policy)).toMatchObject({ fire: false, reason: "condition-not-met" });
    const d = evaluateTrigger(o, {}, input(940n), policy);
    expect(d.fire && d.variant.minOut).toBe(900n);
    expect(d.fire && d.attempt).toBe(0);
    expect(evaluateTrigger(o, {}, input(790n), policy)).toMatchObject({ fire: false, reason: "below-grid" });
  });

  test("take-profit / limit buy (quote-at-least)", () => {
    const o = synth({ kind: "take-profit", trigger: { type: "quote-at-least", threshold: 1_050n } });
    expect(evaluateTrigger(o, {}, input(1_000n), policy).fire).toBe(false);
    const d = evaluateTrigger(o, {}, input(1_060n), policy);
    expect(d.fire && d.variant.minOut).toBe(1_000n);
  });

  test("DCA tranche (time + band)", () => {
    const o = synth({ side: "buy", kind: "dca-tranche", trigger: { type: "time", notBeforeMs: 5_000, minQuoteOut: 950n } });
    expect(evaluateTrigger(o, {}, input(2_000n, { nowMs: 4_999 }), policy).fire).toBe(false);
    expect(evaluateTrigger(o, {}, input(940n, { nowMs: 6_000 }), policy).fire).toBe(false);
    expect(evaluateTrigger(o, {}, input(2_000n, { nowMs: 6_000 }), policy).fire).toBe(true);
  });

  test("migration snipe: needs the migration event AND the live pool (PumpSwap quote)", () => {
    const o = synth({ side: "buy", kind: "migration-snipe", venues: ["pumpswap"], trigger: { type: "migration" } });
    const ev = { type: "migration" as const, mint: MINT, pool: POOL };
    expect(evaluateTrigger(o, {}, input(2_000n, { venue: "pumpswap" }), policy)).toMatchObject({
      fire: false,
      reason: "condition-not-met",
    });
    const noPool = evaluateTrigger(o, {}, input(null, { venue: "pumpswap", events: [ev] }), policy);
    expect(noPool).toMatchObject({ fire: false, reason: "no-quote" });
    expect(noPool.state.migrated).toBe(true);
    const d = evaluateTrigger(o, noPool.state, input(2_000n, { venue: "pumpswap" }), policy);
    expect(d.fire && d.variant.venue).toBe("pumpswap");
    // Events for other mints are ignored.
    expect(applyMarketEvent(o, {}, { ...ev, mint: CREATOR })).toEqual({});
  });

  test("dev-sell exit: only the creator's sell of at least minTokenAmount arms it (sticky)", () => {
    const o = synth({ kind: "dev-sell-exit", trigger: { type: "dev-sell", creator: CREATOR, minTokenAmount: 1_000n } });
    const sell = (trader: Address, tokenAmount: bigint) => ({
      type: "trade" as const,
      mint: MINT,
      trader,
      side: "sell" as const,
      tokenAmount,
    });
    expect(evaluateTrigger(o, {}, input(2_000n, { events: [sell(WALLET, 5_000n)] }), policy).fire).toBe(false);
    expect(evaluateTrigger(o, {}, input(2_000n, { events: [sell(CREATOR, 999n)] }), policy).fire).toBe(false);
    expect(evaluateTrigger(o, {}, input(2_000n, { events: [{ ...sell(CREATOR, 5_000n), side: "buy" }] }), policy).fire).toBe(false);
    const d = evaluateTrigger(o, {}, input(2_000n, { events: [sell(CREATOR, 5_000n)] }), policy);
    expect(d.fire).toBe(true);
    // Sticky: later evaluations still fire (e.g. after a below-grid hold).
    expect(evaluateTrigger(o, d.state, input(2_000n), policy).fire).toBe(true);
  });

  test("hold reasons: not armed, attempt in flight, venue not armed, no quote", () => {
    const o = synth({ trigger: { type: "quote-at-most", threshold: 5_000n } });
    expect(evaluateTrigger({ ...o, status: "stale" }, {}, input(1_000n), policy)).toMatchObject({ reason: "not-armed" });
    const inFlight: ArmedOrder = { ...o, attempts: o.attempts.map((a) => ({ ...a, status: "submitted" })) };
    expect(evaluateTrigger(inFlight, {}, input(1_000n), policy)).toMatchObject({ reason: "attempt-in-flight" });
    expect(evaluateTrigger(o, {}, input(1_000n, { venue: "pumpswap" }), policy)).toMatchObject({ reason: "venue-not-armed" });
    expect(evaluateTrigger(o, {}, input(null), policy)).toMatchObject({ reason: "no-quote" });
    const burned: ArmedOrder = { ...o, attempts: o.attempts.map((a) => ({ ...a, status: "burned" })) };
    expect(evaluateTrigger(burned, {}, input(1_000n), policy)).toMatchObject({ reason: "no-live-attempt" });
  });
});

describe("trailing stop: high-water tracking bounded by the grid", () => {
  const o = synth({ kind: "trailing-stop", minOuts: [1_000n, 900n, 800n], tipLevels: [0], trigger: { type: "trailing", trailBps: 1_000 } });
  const policy = { safetyMarginBps: 100 };
  const step = (state: { highWater?: bigint }, q: bigint) =>
    evaluateTrigger(o, state, { liveQuoteOut: q, venue: "pump", nowMs: 0 }, policy);

  test("follows the price up, fires trailBps below the high-water mark", () => {
    let d = step({}, 950n);
    expect(d.fire).toBe(false);
    d = step(d.state, 1_050n);
    expect(d.state.highWater).toBe(1_050n);
    d = step(d.state, 1_000n); // stop = 945
    expect(d.fire).toBe(false);
    d = step(d.state, 940n);
    expect(d.fire && d.variant.minOut).toBe(900n); // floor 930.6 -> 900 variant
  });

  test("above the grid the trail is capped where the tightest variant still fills with the margin", () => {
    // Lowest quote for the 1,000 variant at a 1% margin: ceil(1000 / 0.99) = 1,011; cap: ceil(1,011 / 0.9) = 1,124.
    const cap = trailingHighWaterCap(1_000n, 1_000, 100);
    expect(cap).toBe(1_124n);
    const view = trailingStop(o.attempts[0]?.variants ?? [], { trailBps: 1_000 }, undefined, 5_000n, 100);
    expect(view).toMatchObject({ highWater: 5_000n, effectiveHighWater: 1_124n, capped: true });
    expect(view.stopQuote).toBe(1_011n);
    // Price ran to 5,000 then fell: at the capped stop level the TIGHTEST variant fills...
    const d = step({ highWater: 5_000n }, 1_011n);
    expect(d.fire && d.variant.minOut).toBe(1_000n);
    expect(d.trailing?.capped).toBe(true);
    // ...and a gap below it takes the next variant down.
    const d2 = step({ highWater: 5_000n }, 1_005n);
    expect(d2.fire && d2.variant.minOut).toBe(900n);
  });

  test("a single-variant trailing stop always fires at its stop level (no rounding gap), across parameters", () => {
    for (const [minOut, trailBps, marginBps] of [
      [1_000_000n, 1_000, 100],
      [999_999_937n, 1_234, 77],
      [3n, 500, 50],
      [123_456_789_012n, 9_999, 0],
      [10n ** 15n, 1, 9_999],
    ] as const) {
      const single = synth({ minOuts: [minOut], tipLevels: [0], trigger: { type: "trailing", trailBps } });
      const policy = { safetyMarginBps: marginBps };
      // A high-water mark above the cap: the capped stop level must still pick the (only) variant.
      const highWater = trailingHighWaterCap(minOut, trailBps, marginBps) * 2n;
      const capView = trailingStop(single.attempts[0]?.variants ?? [], { trailBps }, highWater, highWater, marginBps);
      expect(capView.capped).toBe(true);
      const d = evaluateTrigger(single, { highWater }, { liveQuoteOut: capView.stopQuote, venue: "pump", nowMs: 0 }, policy);
      expect(d.fire && d.variant.minOut).toBe(minOut);
    }
  });

  test("activation level", () => {
    const view = trailingStop([{ minOut: 1_000n }], { trailBps: 1_000, activationQuoteOut: 2_000n }, 1_500n, 900n, 0);
    expect(view.active).toBe(false);
    expect(() => trailingHighWaterCap(1n, 0, 0)).toThrow();
    expect(() => trailingHighWaterCap(1n, 100, 10_000)).toThrow();
  });
});

describe("live quotes from market state (same math as arming)", async () => {
  const curve = decodeBondingCurve(fixture(await bondingCurvePda(CURVE_MINT)).data);
  const mint = decodeMint(fixture(CURVE_MINT).data, fixture(CURVE_MINT).owner);
  const global = pumpGlobal();
  const feeConfig = decodeFeeConfig(fixture(PUMP_FEE_CONFIG).data);

  test("curve: buy tokens out and sell quote out match the quote functions", () => {
    const market = { venue: "pump" as const, curve, global, feeConfig, mintSupply: mint.supply };
    const rates = curveFeeRates({ curve, global, feeConfig, mintSupply: mint.supply });
    expect(liveQuoteOut("buy", 10_000_000n, market)).toBe(quoteBuyExactQuoteIn(curve, 10_000_000n, rates).tokenAmount);
    expect(liveQuoteOut("sell", 1_000_000_000n, market)).toBe(quoteSell(curve, 1_000_000_000n, rates).quoteNet);
    expect(liveQuoteOut("sell", 1_000_000_000n, { ...market, curve: { ...curve, complete: true } })).toBeNull();
  });

  test("PumpSwap: effective reserves, null when the real vault cannot pay", async () => {
    const pool = decodePool(fixture(POOL).data);
    const reserves = {
      baseReserve: decodeTokenAccount(fixture(pool.poolBaseTokenAccount).data).amount,
      quoteVaultReserve: decodeTokenAccount(fixture(pool.poolQuoteTokenAccount).data).amount,
      virtualQuoteReserves: pool.virtualQuoteReserves,
    };
    const supply = decodeMint(fixture(pool.baseMint).data, fixture(pool.baseMint).owner).supply;
    const amm = {
      venue: "pumpswap" as const,
      pool,
      reserves,
      isCanonical: await isCanonicalPumpPool(pool),
      baseMintSupply: supply,
      feeConfig: decodeFeeConfig(fixture(PUMP_AMM_FEE_CONFIG).data),
      globalConfig: ammGlobalConfig(),
    };
    const rates = ammFeeRates({ ...amm, pool, reserves });
    expect(liveQuoteOut("sell", 1_000_000_000n, amm)).toBe(quoteAmmSell(reserves, 1_000_000_000n, rates).quoteOutNet);
    expect(liveQuoteOut("sell", 10n ** 20n, { ...amm, reserves: { ...reserves, quoteVaultReserve: 1n } })).toBeNull();
  });
});

describe("status machine", () => {
  test("armed -> submitted -> filled; a fill cancels the ladder's other nonces", () => {
    const o = synth({ attempts: 3 });
    const v = variant(o, 0, 1);
    const s1 = applyArmedOrderEvent(o, { type: "submitted", attempt: 0, variantId: v.id, slot: 10n });
    expect(s1.order.status).toBe("submitted");
    expect(s1.order.attempts[0]).toMatchObject({ status: "submitted", submittedVariantId: v.id, submittedAtSlot: 10n });
    expect(nextLiveAttempt(s1.order)).toBeNull();
    const s2 = applyArmedOrderEvent(s1.order, {
      type: "nonce-consumed",
      nonce: nonceAddr(0),
      nonceValue: "nonce-0",
      signature: v.tx.signature,
      success: true,
    });
    expect(s2.order.status).toBe("filled");
    expect(s2.order.attempts.map((a) => a.status)).toEqual(["landed-ok", "cancelling", "cancelling"]);
    expect(s2.effects.filter((e) => e.type === "fire-cancel").map((e) => e.type === "fire-cancel" && e.nonce)).toEqual([
      nonceAddr(1),
      nonceAddr(2),
    ]);
    expect(s2.effects.some((e) => e.type === "notify" && e.kind === "filled")).toBe(true);
    expect(reservationHeld(s2.order)).toBe(true); // until those cancels land
    const s3 = applyArmedOrderEvent(s2.order, {
      type: "nonce-consumed",
      nonce: nonceAddr(1),
      nonceValue: "nonce-1",
      signature: "cancel-1",
      success: true,
    });
    const s4 = applyArmedOrderEvent(s3.order, {
      type: "nonce-consumed",
      nonce: nonceAddr(2),
      nonceValue: "nonce-2",
      signature: "cancel-2",
      success: true,
    });
    expect(s4.order.status).toBe("filled");
    expect(reservationHeld(s4.order)).toBe(false);
  });

  test("landed but failed: single attempt -> failed-consumed (re-arm); ladder -> next attempt stays armed", () => {
    const single = synth();
    const v = variant(single, 0, 0);
    const sub = applyArmedOrderEvent(single, { type: "submitted", attempt: 0, variantId: v.id }).order;
    const r = applyArmedOrderEvent(sub, {
      type: "nonce-consumed",
      nonce: nonceAddr(0),
      nonceValue: "nonce-0",
      signature: v.tx.signature,
      success: false,
    });
    expect(r.order.status).toBe("failed-consumed");
    expect(r.order.attempts[0]?.status).toBe("landed-failed");
    expect(r.effects).toContainEqual(expect.objectContaining({ type: "notify", kind: "consumed" }));

    const ladder = synth({ attempts: 2 });
    const lv = variant(ladder, 0, 0);
    const l1 = applyArmedOrderEvent(applyArmedOrderEvent(ladder, { type: "submitted", attempt: 0, variantId: lv.id }).order, {
      type: "nonce-consumed",
      nonce: nonceAddr(0),
      nonceValue: "nonce-0",
      signature: lv.tx.signature,
      success: false,
    });
    expect(l1.order.status).toBe("armed");
    expect(nextLiveAttempt(l1.order)?.index).toBe(1);
    expect(l1.effects).toContainEqual(expect.objectContaining({ kind: "ladder-continues" }));
    const lv2 = variant(ladder, 1, 0);
    const l2 = applyArmedOrderEvent(applyArmedOrderEvent(l1.order, { type: "submitted", attempt: 1, variantId: lv2.id }).order, {
      type: "nonce-consumed",
      nonce: nonceAddr(1),
      nonceValue: "nonce-1",
      signature: lv2.tx.signature,
      success: true,
    });
    expect(l2.order.status).toBe("filled");
  });

  test("a missed submission fires the cancel; the outcome is whichever tx consumed the nonce", () => {
    const o = synth({ attempts: 2 });
    const v = variant(o, 0, 0);
    const sub = applyArmedOrderEvent(o, { type: "submitted", attempt: 0, variantId: v.id }).order;
    const missed = applyArmedOrderEvent(sub, { type: "submit-missed", attempt: 0 });
    expect(missed.effects[0]).toMatchObject({ type: "fire-cancel", nonce: nonceAddr(0) });
    expect(missed.order.attempts[0]?.status).toBe("cancelling");
    // The cancel landed: ladder continues on the next nonce.
    const burned = applyArmedOrderEvent(missed.order, {
      type: "nonce-consumed",
      nonce: nonceAddr(0),
      nonceValue: "nonce-0",
      signature: "cancel-0",
      success: true,
    });
    expect(burned.order.attempts[0]?.status).toBe("burned");
    expect(burned.order.status).toBe("armed");
    // Or the missed variant landed after all: truth wins.
    const late = applyArmedOrderEvent(missed.order, {
      type: "nonce-consumed",
      nonce: nonceAddr(0),
      nonceValue: "nonce-0",
      signature: v.tx.signature,
      success: true,
    });
    expect(late.order.status).toBe("filled");
    // Single attempt: the cancel burning it means failed-consumed.
    const s = synth();
    const sv = variant(s, 0, 0);
    const sm = applyArmedOrderEvent(applyArmedOrderEvent(s, { type: "submitted", attempt: 0, variantId: sv.id }).order, {
      type: "submit-missed",
      attempt: 0,
    });
    expect(
      applyArmedOrderEvent(sm.order, {
        type: "nonce-consumed",
        nonce: nonceAddr(0),
        nonceValue: "nonce-0",
        signature: "cancel-0",
        success: true,
      }).order.status,
    ).toBe("failed-consumed");
  });

  test("OCO: the sibling's fill burns the shared nonce and cancels this order's extra ladder nonces", () => {
    const sl = synth({ id: "sl", attempts: 2, nonceIdx: [0, 1], ocoGroup: "g" });
    const r = applyArmedOrderEvent(sl, {
      type: "nonce-consumed",
      nonce: nonceAddr(0),
      nonceValue: "nonce-0",
      signature: "sig-tp-0-pump-0-0",
      success: true,
      bySiblingOrderId: "tp",
    });
    expect(r.order.status).toBe("cancelled");
    expect(r.order.attempts.map((a) => a.status)).toEqual(["burned", "cancelling"]);
    expect(r.effects).toContainEqual(expect.objectContaining({ type: "fire-cancel", nonce: nonceAddr(1) }));
    // A sibling that landed but failed consumes the shared nonce: re-arm.
    const tp = synth({ id: "tp", ocoGroup: "g" });
    const f = applyArmedOrderEvent(tp, {
      type: "nonce-consumed",
      nonce: nonceAddr(0),
      nonceValue: "nonce-0",
      signature: "sig-sl-0-pump-0-0",
      success: false,
      bySiblingOrderId: "sl",
    });
    expect(f.order.status).toBe("failed-consumed");
    // A failed sibling on the shared nonce leaves this order's other ladder nonces armed.
    const slFail = applyArmedOrderEvent(sl, {
      type: "nonce-consumed",
      nonce: nonceAddr(0),
      nonceValue: "nonce-0",
      signature: "sig-tp-0-pump-0-0",
      success: false,
    });
    expect(slFail.order.status).toBe("armed");
    expect(nextLiveAttempt(slFail.order)?.index).toBe(1);
    // An unknown transaction that EXECUTED on the nonce (sibling not named): burn everything anyway.
    const foreign = applyArmedOrderEvent(sl, {
      type: "nonce-consumed",
      nonce: nonceAddr(0),
      nonceValue: "nonce-0",
      signature: "someone-else",
      success: true,
    });
    expect(foreign.order.status).toBe("cancelled");
    expect(foreign.effects).toContainEqual(expect.objectContaining({ type: "fire-cancel", nonce: nonceAddr(1) }));
  });

  test("cancel / Panic / halt fire every open cancel; truth still wins if a variant lands first", () => {
    const o = synth({ attempts: 2 });
    const c = applyArmedOrderEvent(o, { type: "cancel-requested", reason: "user" });
    expect(c.order.status).toBe("cancelled");
    expect(c.effects.filter((e) => e.type === "fire-cancel")).toHaveLength(2);
    const v = variant(o, 0, 2);
    const filled = applyArmedOrderEvent(c.order, {
      type: "nonce-consumed",
      nonce: nonceAddr(0),
      nonceValue: "nonce-0",
      signature: v.tx.signature,
      success: true,
    });
    expect(filled.order.status).toBe("filled");
    // Idempotent: repeating events changes nothing.
    expect(
      applyArmedOrderEvent(filled.order, {
        type: "nonce-consumed",
        nonce: nonceAddr(0),
        nonceValue: "nonce-0",
        signature: v.tx.signature,
        success: true,
      }).effects,
    ).toEqual([]);
    expect(applyArmedOrderEvent({ ...o, status: "filled" }, { type: "cancel-requested", reason: "x" }).order.status).toBe("filled");
  });

  test("stale fires cancels; flags never change status; submitting a non-armed order is an engine bug", () => {
    const o = synth();
    const st = applyArmedOrderEvent(o, { type: "stale", reason: "creator-changed" });
    expect(st.order).toMatchObject({ status: "stale", statusReason: "creator-changed" });
    expect(st.effects).toContainEqual(expect.objectContaining({ type: "fire-cancel" }));
    const fl = applyArmedOrderEvent(o, { type: "flag", reason: "interface-upgrade" });
    expect(fl.order).toMatchObject({ status: "armed", flags: ["interface-upgrade"] });
    expect(applyArmedOrderEvent(fl.order, { type: "flag", reason: "interface-upgrade" }).effects).toEqual([]);
    expect(() => applyArmedOrderEvent(st.order, { type: "submitted", attempt: 0, variantId: variant(o, 0, 0).id })).toThrow(
      ArmedTransitionError,
    );
    expect(() => applyArmedOrderEvent(o, { type: "submitted", attempt: 0, variantId: "nope" })).toThrow(ArmedTransitionError);
    expect(() => applyArmedOrderEvent(o, { type: "submitted", attempt: 5, variantId: "nope" })).toThrow(ArmedTransitionError);
  });

  test("a re-armed slot is never touched by events about its previous nonce generation", () => {
    // Order A armed slot 0 at value v1 and was cancelled; order B re-armed slot 0 at v2 (+ slot 1).
    const a = applyArmedOrderEvent(synth({ id: "A", nonceValues: ["v1"] }), { type: "cancel-requested", reason: "user" }).order;
    const b = synth({ id: "B", attempts: 2, nonceValues: ["v2", "v2b"] });
    // A's cancel landing (or being replayed) is dispatched to every order on slot 0:
    const ev = { type: "nonce-consumed" as const, nonce: nonceAddr(0), nonceValue: "v1", signature: "cancel-v1", success: true };
    expect(applyArmedOrderEvent(a, ev).order.attempts[0]?.status).toBe("burned");
    const bAfter = applyArmedOrderEvent(b, ev);
    expect(bAfter.order).toEqual(b);
    expect(bAfter.effects).toEqual([]);
    // B's own fill on v2 is resolved to B, not to A's old cancel.
    const fill = variant(b, 0, 0);
    expect(signaturesOnNonce([a, b], nonceAddr(0), "v2").map((s) => s.orderId)).not.toContain("A");
    const filled = applyArmedOrderEvent(applyArmedOrderEvent(b, { type: "submitted", attempt: 0, variantId: fill.id }).order, {
      type: "nonce-consumed",
      nonce: nonceAddr(0),
      nonceValue: "v2",
      signature: fill.tx.signature,
      success: true,
    });
    expect(filled.order.status).toBe("filled");
    expect(filled.effects).toContainEqual(expect.objectContaining({ type: "fire-cancel", nonce: nonceAddr(1) }));
  });

  test("signature indexes for resolving which tx consumed a nonce", () => {
    const tp = synth({ id: "tp", ocoGroup: "g" });
    const sl = synth({ id: "sl", ocoGroup: "g" });
    const onNonce = signaturesOnNonce([tp, sl], nonceAddr(0), "nonce-0");
    expect(signaturesOnNonce([tp, sl], nonceAddr(0), "older-generation")).toEqual([]);
    expect(onNonce.filter((s) => s.kind === "cancel")).toHaveLength(1);
    expect(onNonce.filter((s) => s.kind === "variant")).toHaveLength(12);
    expect(armedSignatures(tp)).toHaveLength(7);
  });
});

describe("staleness detection", () => {
  const o = synth({ attempts: 1 });
  const liveNonce = { [nonceAddr(0)]: { account: nonceAddr(0), authority: WALLET, value: "nonce-0" as never, lamports: 1n } };
  const table = (deactivationSlot: bigint): LookupTableState => ({
    deactivationSlot,
    lastExtendedSlot: 1n,
    lastExtendedSlotStartIndex: 0,
    authority: WALLET,
    addresses: [],
  });

  test("nothing changed -> no findings", () => {
    const U64_MAX = (1n << 64n) - 1n;
    expect(
      detectStaleness(o, {
        curve: { creator: CREATOR, complete: false },
        feeRecipients: { pump: [FEE] },
        buybackFeeRecipients: { pump: [BUYBACK] },
        nonces: liveNonce,
        lookupTables: { [TABLE]: table(U64_MAX) },
        currentSlot: 100n,
        interfaceVersion: currentInterfaceVersion(),
        jitoTipAccounts: [address("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5")],
        walletTokenBalance: o.amount,
      }),
    ).toEqual([]);
  });

  test("creator change, migration of a curve-only order, rotated recipients: definitive", () => {
    const reasons = (obs: Parameters<typeof detectStaleness>[1], ord = o) =>
      detectStaleness(ord, obs).map((f) => `${f.reason}:${f.definitive}`);
    expect(reasons({ curve: { creator: WALLET, complete: false } })).toEqual(["creator-changed:true"]);
    expect(reasons({ curve: { creator: CREATOR, complete: true } })).toEqual(["migrated:true"]);
    expect(reasons({ curve: { creator: CREATOR, complete: true } }, synth({ venues: ["pump", "pumpswap"] }))).toEqual([]);
    expect(reasons({ curve: null })).toEqual(["curve-missing:true"]);
    expect(reasons({ feeRecipients: { pump: [BUYBACK] } })).toEqual(["fee-recipient-rotated:true"]);
    expect(reasons({ buybackFeeRecipients: { pump: [FEE] } })).toEqual(["buyback-recipient-rotated:true"]);
    expect(reasons({ pool: { coinCreator: WALLET } }, synth({ venues: ["pumpswap"] }))).toEqual(["creator-changed:true"]);
    expect(reasons({ pool: null }, synth({ venues: ["pumpswap"] }))).toEqual([]); // migration snipe: pool not yet live
  });

  test("nonce and lookup-table changes", () => {
    const f = (obs: Parameters<typeof detectStaleness>[1]) => detectStaleness(o, obs).map((x) => x.reason);
    expect(f({ nonces: { [nonceAddr(0)]: null } })).toEqual(["nonce-missing"]);
    expect(f({ nonces: { [nonceAddr(0)]: { ...(liveNonce[nonceAddr(0)] as never), authority: CREATOR } } })).toEqual([
      "nonce-authority-changed",
    ]);
    expect(f({ nonces: { [nonceAddr(0)]: { ...(liveNonce[nonceAddr(0)] as never), value: "other" } } })).toEqual(["nonce-advanced"]);
    expect(f({ lookupTables: { [TABLE]: null } })).toEqual(["lookup-table-missing"]);
    expect(f({ lookupTables: { [TABLE]: table(50n) }, currentSlot: 100n })).toEqual(["lookup-table-deactivated"]);
  });

  test("an advanced nonce is expected for submitted / cancelling attempts: not staleness", () => {
    const ladder = synth({ attempts: 2 });
    const sub = applyArmedOrderEvent(ladder, { type: "submitted", attempt: 0, variantId: variant(ladder, 0, 0).id }).order;
    const advanced = { [nonceAddr(0)]: { account: nonceAddr(0), authority: WALLET, value: "next" as never, lamports: 1n } };
    expect(detectStaleness(sub, { nonces: advanced })).toEqual([]);
    const cancelling = applyArmedOrderEvent(ladder, { type: "cancel-requested", reason: "x" }).order;
    expect(detectStaleness(cancelling, { nonces: advanced })).toEqual([]);
    expect(detectStaleness(ladder, { nonces: advanced }).map((x) => x.reason)).toEqual(["nonce-advanced"]);
  });

  test("migration snipe (pool not live): a curve creator change or coin-flag change is caught before migration", () => {
    const snipe = synth({ side: "buy", kind: "migration-snipe", venues: ["pumpswap"], trigger: { type: "migration" } });
    snipe.frozen.venues[0] = { ...(snipe.frozen.venues[0] as never), isMayhemMode: false, isCashbackCoin: false };
    const reasons = (obs: Parameters<typeof detectStaleness>[1]) => detectStaleness(snipe, obs).map((x) => `${x.reason}:${x.definitive}`);
    expect(reasons({ pool: null, curve: { creator: CREATOR, complete: false } })).toEqual([]);
    expect(reasons({ pool: null, curve: { creator: WALLET, complete: false } })).toEqual(["creator-changed:true"]);
    expect(reasons({ curve: { creator: CREATOR, complete: true, isCashbackCoin: true } })).toEqual(["coin-flags-changed:true"]);
    // Once the pool is live, the pool is what counts.
    expect(reasons({ pool: { coinCreator: CREATOR, isMayhemMode: true }, curve: { creator: WALLET, complete: true } })).toEqual([
      "coin-flags-changed:true",
    ]);
  });

  test("IDL watcher: only interfaces the order's venues use; suspect, not definitive", () => {
    const changedPumpAmm = formatInterfaceVersion({ ...parseRaw(), "pump_amm.json": "f".repeat(64) });
    expect(detectStaleness(o, { interfaceVersion: changedPumpAmm })).toEqual([]);
    const changedPump = formatInterfaceVersion({ ...parseRaw(), "pump.json": "e".repeat(64) });
    const [finding] = detectStaleness(o, { interfaceVersion: changedPump });
    expect(finding).toMatchObject({ reason: "interface-upgrade", definitive: false });
    expect(
      classifyStaleness(detectStaleness(o, { interfaceVersion: changedPump, curve: { creator: WALLET, complete: false } })),
    ).toMatchObject({
      stale: { reason: "creator-changed" },
      flags: [{ reason: "interface-upgrade" }],
    });
    expect(changedInterfaces(currentInterfaceVersion(), changedPump)).toEqual(["pump"]);
    expect(interfacesForVenue("pumpswap")).toEqual(["pump_amm", "pump_fees"]);
    expect(Object.keys(parseInterfaceVersion(currentInterfaceVersion()))).toEqual(["pump", "pump_amm", "pump_fees"]);
  });

  test("retired Jito tip account (flag) and balance changes (definitive)", () => {
    expect(detectStaleness(o, { jitoTipAccounts: [CREATOR] })).toEqual([
      expect.objectContaining({ reason: "tip-account-retired", definitive: false }),
    ]);
    expect(detectStaleness(o, { walletTokenBalance: o.amount + 1n })).toEqual([
      expect.objectContaining({ reason: "balance-changed", definitive: true }),
    ]);
    const partial = synth({ fullExit: false });
    expect(detectStaleness(partial, { walletTokenBalance: partial.amount + 1n })).toEqual([]);
    expect(detectStaleness(partial, { walletTokenBalance: partial.amount - 1n })[0]?.reason).toBe("balance-changed");
  });
});

/** Current IDL hashes as `file -> 64-hex` (reconstructed from the 12-hex version for formatting). */
function parseRaw(): Record<string, string> {
  const v = parseInterfaceVersion(currentInterfaceVersion());
  return { "pump.json": `${v.pump}`, "pump_amm.json": `${v.pump_amm}`, "pump_fees.json": `${v.pump_fees}` };
}

describe("safety validators and reservations", () => {
  test("grid depth below the arming quote is capped", () => {
    const o = synth({ minOuts: [1_000n, 500n], armingQuoteOut: 1_200n });
    expect(gridDepthBps(o)).toBe(5_833);
    expect(validateArmedOrder(o).map((v) => v.code)).toContain("grid-too-deep");
    expect(validateArmedOrder(o, { ...DEFAULT_ARMED_SAFETY_POLICY, maxGridDepthBps: 6_000 })).toEqual([]);
    expect(gridDepthBps(synth({ minOuts: [2_000n], armingQuoteOut: 1_200n }))).toBeLessThan(0);
  });

  test("structural rules: cancel per nonce, ladders only for full-exit sells, caps", () => {
    const codes = (o: ArmedOrder, p = DEFAULT_ARMED_SAFETY_POLICY) => validateArmedOrder(o, p).map((v) => v.code);
    const noCancel = synth();
    (noCancel.attempts[0] as ArmedAttempt).nonce.cancel = { wireBase64: "", signature: "", size: 0 };
    expect(codes(noCancel)).toContain("no-cancel");
    expect(codes(synth({ side: "buy", attempts: 2 }))).toContain("ladder-not-allowed");
    expect(codes(synth({ attempts: 2, fullExit: false }))).toContain("ladder-not-allowed");
    expect(codes(synth({ side: "buy", minOuts: [3n, 2n], tipLevels: [0, 1] }))).toContain("too-many-buy-variants");
    expect(codes(synth({ side: "buy", amount: 6_000_000_000n, minOuts: [1n], tipLevels: [0] }))).toContain("buy-cap");
    expect(codes(synth(), { ...DEFAULT_ARMED_SAFETY_POLICY, maxTipLamports: 1n })).toContain("tip-cap");
    expect(codes(synth({ attempts: 2, nonceIdx: [0, 0] }))).toContain("duplicate-nonce");
    expect(codes(synth({ attempts: 6 }), { ...DEFAULT_ARMED_SAFETY_POLICY, maxAttempts: 5 })).toContain("too-many-attempts");
  });

  test("per-user: notional cap (OCO counts once), nonce sharing only inside one OCO group", () => {
    const grid = { minOuts: [3n * 10n ** 9n, 29n * 10n ** 8n], armingQuoteOut: 3n * 10n ** 9n };
    const tp = synth({ id: "tp", ocoGroup: "g", ...grid });
    const sl = synth({ id: "sl", ocoGroup: "g", ...grid });
    expect(armedNotional([tp, sl])).toBe(3n * 10n ** 9n);
    expect(validateUserArmedOrders([tp, sl])).toEqual([]);
    const loose = synth({ id: "x", ...grid }); // same nonce 0, no OCO group
    expect(validateUserArmedOrders([tp, loose]).map((v) => v.code)).toContain("nonce-shared");
    const big = Array.from({ length: 10 }, (_v, i) => synth({ id: `b${i}`, nonceIdx: [i], ...grid }));
    expect(validateUserArmedOrders(big).map((v) => v.code)).toContain("notional-cap");
    expect(validateUserArmedOrders([tp, tp]).map((v) => v.code)).toContain("duplicate-order");
  });

  test("exclusivity comes from shared nonces, never from the ocoGroup label", () => {
    const SOL3 = 3n * 10n ** 9n;
    // Two independent 3 SOL buys on different nonces claiming one group: both can fill.
    const b1 = synth({ id: "b1", side: "buy", amount: SOL3, minOuts: [1n], tipLevels: [0], ocoGroup: "g" });
    const b2 = synth({ id: "b2", side: "buy", amount: SOL3, minOuts: [1n], tipLevels: [0], ocoGroup: "g", nonceIdx: [1] });
    expect(armedNotional([b1, b2])).toBe(2n * SOL3);
    expect(aggregateReservations([b1, b2]).lamports).toBe(100_000n);
    expect(
      validateUserArmedOrders([b1, b2], { ...DEFAULT_ARMED_SAFETY_POLICY, maxArmedNotionalLamports: 5n * 10n ** 9n }).map((v) => v.code),
    ).toEqual(expect.arrayContaining(["notional-cap", "oco-without-shared-nonce"]));
    // Buys sharing a nonce are still counted in full (only same-mint sells are treated as exclusive).
    const b3 = synth({ id: "b3", side: "buy", amount: SOL3, minOuts: [1n], tipLevels: [0], ocoGroup: "h" });
    expect(armedNotional([b1, { ...b3, ocoGroup: "g" }])).toBe(2n * SOL3);
    // A chain X(A) - Z(A,B) - Y(B) has no common nonce: X and Y could both fill.
    const grid = { minOuts: [SOL3], armingQuoteOut: SOL3 };
    const x = synth({ id: "x", ocoGroup: "c", fullExit: false, ...grid });
    const z = synth({ id: "z", ocoGroup: "c", attempts: 2, nonceIdx: [0, 1], ...grid });
    const y = synth({ id: "y", ocoGroup: "c", fullExit: false, nonceIdx: [1], ...grid });
    expect(armedNotional([x, z, y])).toBe(3n * SOL3);
    // Sells of different mints on one nonce are not exclusive either (and each mint keeps its own tokens).
    const other = synth({ id: "o", ocoGroup: "m", mint: CREATOR, ...grid });
    const same = synth({ id: "s", ocoGroup: "m", ...grid });
    expect(armedNotional([other, same])).toBe(2n * SOL3);
    expect(aggregateReservations([other, same]).tokens).toEqual({ [CREATOR]: 1_000_000n, [MINT]: 1_000_000n });
  });

  test("re-arming a slot whose previous generation is still being cancelled is not 'shared'", () => {
    const filledLadder = applyArmedOrderEvent(synth({ id: "old", attempts: 2 }), {
      type: "nonce-consumed",
      nonce: nonceAddr(0),
      nonceValue: "nonce-0",
      signature: "sig-old-0-pump-0-0",
      success: true,
    }).order;
    expect(filledLadder.attempts[1]?.status).toBe("cancelling");
    const rearmed = synth({ id: "new", nonceIdx: [1], nonceValues: ["fresh"] });
    expect(validateUserArmedOrders([filledLadder, rearmed]).map((v) => v.code)).not.toContain("nonce-shared");
  });

  test("reserved balances (UI) and the pre-submit balance check", () => {
    const tp = synth({ id: "tp", ocoGroup: "g" });
    const sl = synth({ id: "sl", ocoGroup: "g" });
    const buy = synth({ id: "b", side: "buy", nonceIdx: [1] });
    const r = aggregateReservations([tp, sl, buy]);
    expect(r.lamports).toBe(100_000n);
    expect(r.tokens[MINT]).toBe(1_000_000n);
    expect(hasReservedBalance(tp, { lamports: 50_000n, tokens: 1_000_000n })).toEqual({ ok: true });
    expect(hasReservedBalance(tp, { lamports: 49_999n, tokens: 1_000_000n }).ok).toBe(false);
    expect(hasReservedBalance(tp, { lamports: 50_000n, tokens: 1_000_001n }).reason).toContain("full-exit");
    const done = { ...tp, attempts: tp.attempts.map((a) => ({ ...a, status: "landed-ok" as const })) };
    expect(aggregateReservations([done]).lamports).toBe(0n);
  });
});

describe("market events from the stream decoders", () => {
  test("migration, curve trades and PumpSwap swaps", () => {
    const migrate = {
      kind: "pumpMigrate" as const,
      user: WALLET,
      mint: MINT,
      mintAmount: 1n,
      solAmount: 1n,
      poolMigrationFee: 1n,
      bondingCurve: CREATOR,
      timestamp: 0n,
      pool: POOL,
      quoteMint: MINT,
    };
    expect(marketEventFromDecoded(migrate, { slot: 7n })).toEqual({ type: "migration", mint: MINT, pool: POOL, slot: 7n });
    const swap = { kind: "ammSell", user: CREATOR, pool: POOL, baseAmount: 42n } as unknown as AmmSwapEvent;
    expect(marketEventFromDecoded(swap)).toBeNull();
    expect(marketEventFromDecoded(swap, { baseMintOfPool: () => MINT })).toEqual({
      type: "trade",
      mint: MINT,
      trader: CREATOR,
      side: "sell",
      tokenAmount: 42n,
    });
  });
});
