/**
 * Trigger engine: pure functions the server order engine calls on every market update.
 *
 * One landed attempt per nonce means a failed submission is not a retry, it is the end of that
 * attempt. So the engine only submits a variant whose min-out sits BELOW the live quote by a safety
 * margin, and holds (reason "below-grid") when no variant clears it.
 */
import type { Address } from "@solana/kit";
import { BPS_DENOMINATOR as BPS, HELIUS_SENDER_TIP_ACCOUNTS } from "../constants";
import type { FeeConfig } from "../fees";
import type { PumpGlobal } from "../pump/accounts";
import { CurveCompleteError, type CurveState, curveFeeRates, quoteBuyExactQuoteIn, quoteSell } from "../pump/curve";
import type { AmmGlobalConfig, Pool } from "../pumpswap/accounts";
import { type AmmReserves, ammFeeRates, quoteAmmBuyExactQuoteIn, quoteAmmSell } from "../pumpswap/math";
import { type LookupTableState, lookupTableStatus } from "./alt";
import type { ArmedMarketEvent } from "./events";
import { changedInterfaces, interfacesForVenue } from "./interfaceVersion";
import { type ArmedOrder, type ArmedSide, type ArmedVariant, type ArmedVenue, isAttemptOpen, nextLiveAttempt } from "./model";
import type { NonceSlotSnapshot } from "./nonce";

// ---------------------------------------------------------------------------------------------
// Variant selection
// ---------------------------------------------------------------------------------------------

export interface TriggerPolicy {
  /** The chosen variant's min-out must be at least this many bps below the live quote. */
  safetyMarginBps: number;
  /** Preferred tip level (e.g. from congestion): exact, else the next higher, else the highest below. Default: lowest. */
  tipLevel?: number;
}

export const DEFAULT_TRIGGER_POLICY: TriggerPolicy = { safetyMarginBps: 100 };

function marginFloor(liveQuoteOut: bigint, marginBps: number): bigint {
  if (!Number.isInteger(marginBps) || marginBps < 0 || marginBps >= 10_000)
    throw new RangeError(`safetyMarginBps out of range: ${marginBps}`);
  return (liveQuoteOut * (BPS - BigInt(marginBps))) / BPS;
}

/**
 * The variant whose min-out is the highest one at or below `liveQuoteOut x (1 - margin)`, at the
 * preferred tip level; null when none clears (do NOT submit: a failure burns the nonce).
 */
export function pickVariant(
  variants: readonly ArmedVariant[],
  liveQuoteOut: bigint,
  policy: TriggerPolicy = DEFAULT_TRIGGER_POLICY,
  venue?: ArmedVenue,
): ArmedVariant | null {
  const floor = marginFloor(liveQuoteOut, policy.safetyMarginBps);
  let best: bigint | null = null;
  for (const v of variants) {
    if ((venue === undefined || v.venue === venue) && v.minOut <= floor && (best === null || v.minOut > best)) best = v.minOut;
  }
  if (best === null) return null;
  const atBest = variants
    .filter((v) => (venue === undefined || v.venue === venue) && v.minOut === best)
    .sort((a, b) => a.tipLevel - b.tipLevel);
  const want = policy.tipLevel;
  if (want === undefined) return atBest[0] ?? null;
  return atBest.find((v) => v.tipLevel === want) ?? atBest.find((v) => v.tipLevel > want) ?? atBest[atBest.length - 1] ?? null;
}

// ---------------------------------------------------------------------------------------------
// Live quotes (same math the browser armed with)
// ---------------------------------------------------------------------------------------------

export type LiveMarketState =
  | {
      venue: "pump";
      curve: CurveState;
      global: Pick<PumpGlobal, "feeBasisPoints" | "creatorFeeBasisPoints" | "creatorFeeConfigurable" | "buybackBasisPoints">;
      feeConfig: FeeConfig | null;
      mintSupply: bigint;
    }
  | {
      venue: "pumpswap";
      pool: Pick<Pool, "quoteMint" | "isMayhemMode" | "coinCreator" | "creatorFeeBps">;
      reserves: AmmReserves;
      isCanonical: boolean;
      baseMintSupply: bigint;
      feeConfig: FeeConfig | null;
      globalConfig: Pick<
        AmmGlobalConfig,
        "lpFeeBasisPoints" | "protocolFeeBasisPoints" | "coinCreatorFeeBasisPoints" | "creatorFeeConfigurable" | "buybackBasisPoints"
      >;
    };

/**
 * Quote out for `amount` right now (buy: tokens for a fixed spend; sell: quote for fixed tokens,
 * net of fees), using the live fee tier. Null when the venue cannot quote it (curve complete,
 * insufficient reserves, ...).
 */
export function liveQuoteOut(side: ArmedSide, amount: bigint, market: LiveMarketState): bigint | null {
  try {
    if (market.venue === "pump") {
      const rates = curveFeeRates({
        curve: market.curve,
        global: market.global,
        feeConfig: market.feeConfig,
        mintSupply: market.mintSupply,
      });
      return side === "buy"
        ? quoteBuyExactQuoteIn(market.curve, amount, rates).tokenAmount
        : quoteSell(market.curve, amount, rates).quoteNet;
    }
    const rates = ammFeeRates({
      pool: market.pool,
      isCanonical: market.isCanonical,
      reserves: market.reserves,
      baseMintSupply: market.baseMintSupply,
      feeConfig: market.feeConfig,
      globalConfig: market.globalConfig,
    });
    return side === "buy"
      ? quoteAmmBuyExactQuoteIn(market.reserves, amount, rates).baseOut
      : quoteAmmSell(market.reserves, amount, rates).quoteOutNet;
  } catch (e) {
    if (e instanceof RangeError || e instanceof CurveCompleteError) return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// Trigger evaluation
// ---------------------------------------------------------------------------------------------

/** Per-order state the engine persists between evaluations. */
export interface TriggerState {
  /** Trailing stops: highest live quote seen since arming (raw, before the grid cap). */
  highWater?: bigint;
  /** Migration snipes: CompletePumpAmmMigrationEvent seen for the mint. */
  migrated?: boolean;
  /** Dev-sell exits: a qualifying dev sell was seen (sticky). */
  devSold?: boolean;
}

export function applyMarketEvent(order: Pick<ArmedOrder, "mint" | "trigger">, state: TriggerState, event: ArmedMarketEvent): TriggerState {
  if (event.mint !== order.mint) return state;
  if (event.type === "migration") return { ...state, migrated: true };
  const t = order.trigger;
  if (t.type === "dev-sell" && event.side === "sell" && event.trader === t.creator && event.tokenAmount >= (t.minTokenAmount ?? 1n)) {
    return { ...state, devSold: true };
  }
  return state;
}

/**
 * Highest high-water mark a trailing stop may follow: above it, the stop level would sit higher
 * than the tightest variant can fill with the safety margin, so the trail stops rising there
 * (the UI should prompt "re-arm higher").
 */
export function trailingHighWaterCap(maxMinOut: bigint, trailBps: number, safetyMarginBps: number): bigint {
  if (!Number.isInteger(trailBps) || trailBps <= 0 || trailBps >= 10_000) throw new RangeError(`trailBps out of range: ${trailBps}`);
  return (maxMinOut * BPS * BPS) / ((BPS - BigInt(trailBps)) * (BPS - BigInt(safetyMarginBps)));
}

export interface TrailingView {
  highWater: bigint;
  /** High-water mark after the grid cap. */
  effectiveHighWater: bigint;
  stopQuote: bigint;
  capped: boolean;
  active: boolean;
}

/** Trailing-stop bookkeeping for one live quote (pure). */
export function trailingStop(
  variants: readonly Pick<ArmedVariant, "minOut">[],
  trigger: { trailBps: number; activationQuoteOut?: bigint },
  prevHighWater: bigint | undefined,
  live: bigint,
  safetyMarginBps: number,
): TrailingView {
  const highWater = prevHighWater === undefined || live > prevHighWater ? live : prevHighWater;
  const maxMinOut = variants.reduce((m, v) => (v.minOut > m ? v.minOut : m), 0n);
  const cap = trailingHighWaterCap(maxMinOut, trigger.trailBps, safetyMarginBps);
  const effectiveHighWater = highWater > cap ? cap : highWater;
  const stopQuote = (effectiveHighWater * (BPS - BigInt(trigger.trailBps))) / BPS;
  const active = trigger.activationQuoteOut === undefined || highWater >= trigger.activationQuoteOut;
  return { highWater, effectiveHighWater, stopQuote, capped: highWater > cap, active };
}

export interface TriggerInput {
  /** Live quote out for the order's amount on `venue`; null when not quotable (e.g. pool not live). */
  liveQuoteOut: bigint | null;
  /** Where the mint trades right now. */
  venue: ArmedVenue;
  nowMs: number;
  /** Market events since the last evaluation. */
  events?: readonly ArmedMarketEvent[];
}

export type TriggerHoldReason =
  | "not-armed"
  | "attempt-in-flight"
  | "no-live-attempt"
  | "no-quote"
  | "venue-not-armed"
  | "condition-not-met"
  | "below-grid";

export type TriggerDecision =
  | { fire: false; reason: TriggerHoldReason; state: TriggerState; trailing?: TrailingView }
  | { fire: true; attempt: number; variant: ArmedVariant; liveQuoteOut: bigint; state: TriggerState; trailing?: TrailingView };

/**
 * Decides whether to submit, and which variant. Pure: persist `decision.state`, and on
 * `fire: true` submit `variant` and apply `{ type: "submitted" }` to the status machine.
 */
export function evaluateTrigger(
  order: ArmedOrder,
  state: TriggerState,
  input: TriggerInput,
  policy: TriggerPolicy = DEFAULT_TRIGGER_POLICY,
): TriggerDecision {
  let s = state;
  for (const ev of input.events ?? []) s = applyMarketEvent(order, s, ev);
  const hold = (reason: TriggerHoldReason, trailing?: TrailingView): TriggerDecision => ({
    fire: false,
    reason,
    state: s,
    ...(trailing ? { trailing } : {}),
  });

  if (order.status !== "armed") return hold("not-armed");
  const attempt = nextLiveAttempt(order);
  if (!attempt)
    return hold(
      order.attempts.some((a) => a.status === "submitted" || a.status === "cancelling") ? "attempt-in-flight" : "no-live-attempt",
    );
  const q = input.liveQuoteOut;
  if (q === null) return hold("no-quote");
  const variants = attempt.variants.filter((v) => v.venue === input.venue);
  if (variants.length === 0) return hold("venue-not-armed");

  let met: boolean;
  let trailing: TrailingView | undefined;
  const t = order.trigger;
  switch (t.type) {
    case "quote-at-least":
      met = q >= t.threshold;
      break;
    case "quote-at-most":
      met = q <= t.threshold;
      break;
    case "trailing":
      trailing = trailingStop(variants, t, s.highWater, q, policy.safetyMarginBps);
      s = { ...s, highWater: trailing.highWater };
      met = trailing.active && q <= trailing.stopQuote;
      break;
    case "time":
      met = input.nowMs >= t.notBeforeMs && (t.minQuoteOut === undefined || q >= t.minQuoteOut);
      break;
    case "migration":
      met = s.migrated === true && input.venue === "pumpswap";
      break;
    case "dev-sell":
      met = s.devSold === true;
      break;
  }
  if (!met) return hold("condition-not-met", trailing);
  const variant = pickVariant(variants, q, policy);
  if (!variant) return hold("below-grid", trailing);
  return { fire: true, attempt: attempt.index, variant, liveQuoteOut: q, state: s, ...(trailing ? { trailing } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------------------------

export type StaleReason =
  | "curve-missing"
  | "migrated"
  | "creator-changed"
  | "fee-recipient-rotated"
  | "buyback-recipient-rotated"
  | "nonce-missing"
  | "nonce-authority-changed"
  | "nonce-advanced"
  | "lookup-table-missing"
  | "lookup-table-deactivated"
  | "interface-upgrade"
  | "tip-account-retired"
  | "balance-changed";

export interface StaleFinding {
  reason: StaleReason;
  /** True: the variants can no longer succeed (mark stale, fire cancels). False: flag for re-arm. */
  definitive: boolean;
  detail: string;
}

/** What the server currently observes; omit what it does not know. */
export interface StalenessObservation {
  /** Live bonding curve (null = account gone). */
  curve?: { creator: Address; complete: boolean } | null;
  /** Live pool (null = not created yet, expected before a migration). */
  pool?: { coinCreator: Address } | null;
  /** Currently valid fee recipients per venue (pump: fee + reserved lists; pumpswap: protocol + reserved lists). */
  feeRecipients?: Partial<Record<ArmedVenue, readonly Address[]>>;
  buybackFeeRecipients?: Partial<Record<ArmedVenue, readonly Address[]>>;
  /** Live nonce slots (null = missing or uninitialized). */
  nonces?: Record<Address, NonceSlotSnapshot | null>;
  lookupTables?: Record<Address, LookupTableState | null>;
  currentSlot?: bigint;
  /** Latest interface version reported by the IDL watcher. */
  interfaceVersion?: string;
  /** Live Jito tip accounts (getTipAccounts). */
  jitoTipAccounts?: readonly Address[];
  /** Wallet's base-token balance (sells). */
  walletTokenBalance?: bigint;
}

/** Account-list changes that strand the order: creator change, migration, rotated recipients, ALT or nonce changes, IDL upgrades. */
export function detectStaleness(order: ArmedOrder, obs: StalenessObservation): StaleFinding[] {
  const out: StaleFinding[] = [];
  const add = (reason: StaleReason, definitive: boolean, detail: string) => out.push({ reason, definitive, detail });
  const venues = new Set(order.frozen.venues.map((v) => v.venue));

  for (const v of order.frozen.venues) {
    if (v.venue === "pump" && obs.curve !== undefined) {
      if (obs.curve === null) add("curve-missing", true, `bonding curve ${v.market} not found`);
      else {
        if (obs.curve.complete && !venues.has("pumpswap")) add("migrated", true, "curve completed and the order has no PumpSwap variants");
        if (obs.curve.creator !== v.creator)
          add("creator-changed", true, `curve creator ${v.creator} -> ${obs.curve.creator} (creator_vault moved)`);
      }
    }
    if (v.venue === "pumpswap" && obs.pool && obs.pool.coinCreator !== v.creator) {
      add("creator-changed", true, `pool coin_creator ${v.creator} -> ${obs.pool.coinCreator}`);
    }
    const fee = obs.feeRecipients?.[v.venue];
    if (fee && !fee.includes(v.feeRecipient))
      add("fee-recipient-rotated", true, `${v.venue} fee recipient ${v.feeRecipient} is no longer valid`);
    const buyback = obs.buybackFeeRecipients?.[v.venue];
    if (buyback && !buyback.includes(v.buybackFeeRecipient)) {
      add("buyback-recipient-rotated", true, `${v.venue} buyback recipient ${v.buybackFeeRecipient} is no longer valid`);
    }
  }

  if (obs.nonces) {
    for (const a of order.attempts) {
      if (!isAttemptOpen(a) || !(a.nonce.account in obs.nonces)) continue;
      const live = obs.nonces[a.nonce.account];
      if (!live) add("nonce-missing", true, `nonce ${a.nonce.account} is gone`);
      else if (live.authority !== order.wallet)
        add("nonce-authority-changed", true, `nonce ${a.nonce.account} authority is ${live.authority}`);
      else if (live.value !== a.nonce.value) add("nonce-advanced", true, `nonce ${a.nonce.account} advanced without a known signature`);
    }
  }

  if (obs.lookupTables) {
    for (const t of order.frozen.lookupTables) {
      if (!(t in obs.lookupTables)) continue;
      const live = obs.lookupTables[t];
      if (!live) add("lookup-table-missing", true, `lookup table ${t} is gone`);
      else if (obs.currentSlot !== undefined && lookupTableStatus(live, obs.currentSlot) !== "active") {
        add("lookup-table-deactivated", true, `lookup table ${t} is deactivated`);
      }
    }
  }

  if (obs.interfaceVersion) {
    const deps = new Set([...venues].flatMap(interfacesForVenue));
    const changed = changedInterfaces(order.frozen.interfaceVersion, obs.interfaceVersion).filter((n) => deps.has(n));
    if (changed.length) add("interface-upgrade", false, `pump interface changed (${changed.join(", ")}); verify and re-arm`);
  }

  if (obs.jitoTipAccounts?.length) {
    // Armed tips are Jito tips unless they pay a Helius Sender account.
    const live = new Set(obs.jitoTipAccounts);
    for (const a of order.frozen.tipAccounts) {
      if (!live.has(a) && !HELIUS_SENDER_TIP_ACCOUNTS.includes(a))
        add("tip-account-retired", false, `Jito tip account ${a} is no longer listed`);
    }
  }

  if (obs.walletTokenBalance !== undefined && order.side === "sell") {
    const bal = obs.walletTokenBalance;
    if (order.fullExit ? bal !== order.amount : bal < order.amount) {
      add(
        "balance-changed",
        true,
        `armed for ${order.amount} tokens, wallet holds ${bal}${order.fullExit ? " (full exit needs exactly that)" : ""}`,
      );
    }
  }
  return out;
}

/** Splits findings: the first definitive one makes the order stale; the rest become flags. */
export function classifyStaleness(findings: readonly StaleFinding[]): { stale: StaleFinding | null; flags: StaleFinding[] } {
  return { stale: findings.find((f) => f.definitive) ?? null, flags: findings.filter((f) => !f.definitive) };
}
