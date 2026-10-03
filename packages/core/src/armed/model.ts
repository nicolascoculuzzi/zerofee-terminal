/**
 * Armed-order data model shared by the browser (arming), the server order engine (triggers,
 * submission, status) and the UI (armed-orders view, reserved balances).
 *
 * Vocabulary:
 *  - variant  one pre-signed transaction: a min-out level x tip level (x venue), all on one nonce.
 *  - attempt  one nonce slot with its variants and its pre-signed cancel. Only ONE transaction per
 *             nonce can ever land, and a landed failure still consumes the nonce
 *             (docs/experiments/nonce-failure), so an attempt gets one landed try.
 *  - order    one or more attempts. More than one = an attempt ladder, allowed ONLY for full-exit
 *             sells (a later attempt can never double-fill: the first fill sells everything and
 *             closes the token account, so later attempts fail harmlessly).
 *  - OCO      orders that share a nonce (e.g. a take-profit and its stop-loss): whichever lands
 *             first burns the other.
 */
import type { Address } from "@solana/kit";
import type { SignedTx } from "./armedTx";

export type ArmedOrderKind =
  | "limit-buy"
  | "limit-sell"
  | "take-profit"
  | "stop-loss"
  | "trailing-stop"
  | "dca-tranche"
  | "migration-snipe"
  | "dev-sell-exit";

export type ArmedSide = "buy" | "sell";
export type ArmedVenue = "pump" | "pumpswap";

export const ARMED_ORDER_SIDE: Record<ArmedOrderKind, ArmedSide> = {
  "limit-buy": "buy",
  "dca-tranche": "buy",
  "migration-snipe": "buy",
  "limit-sell": "sell",
  "take-profit": "sell",
  "stop-loss": "sell",
  "trailing-stop": "sell",
  "dev-sell-exit": "sell",
};

/**
 * armed -> submitted -> filled | failed-consumed, and armed|submitted -> stale | cancelled.
 * A ladder whose attempt failed goes back to armed while it has live attempts.
 */
export type ArmedOrderStatus = "armed" | "submitted" | "filled" | "failed-consumed" | "stale" | "cancelled";

/**
 * live        nonce untouched, variants valid
 * submitted   one variant is in flight
 * cancelling  the cancel was fired; waiting to see which tx consumed the nonce
 * landed-ok   a variant of this attempt filled
 * landed-failed a variant of this attempt landed but failed (nonce consumed, fee paid)
 * burned      the nonce was consumed by the cancel or by another order's tx (OCO sibling)
 */
export type ArmedAttemptStatus = "live" | "submitted" | "cancelling" | "landed-ok" | "landed-failed" | "burned";

export interface ArmedVariant {
  /** `${orderId}/${attempt}/${venue}/${minOutIndex}/${tipLevel}` */
  id: string;
  venue: ArmedVenue;
  /** buy: minimum base tokens out; sell: minimum quote out (lamports for SOL pairs), net of fees. */
  minOut: bigint;
  tipLevel: number;
  tipLamports: bigint;
  /** cu_price x cu_limit, charged even if the tx fails. */
  priorityFeeLamports: bigint;
  tx: SignedTx;
}

export interface ArmedNonceBinding {
  account: Address;
  authority: Address;
  /** Durable nonce value the variants and the cancel were signed against. */
  value: string;
  /** Pre-signed cancel: advance-only. An order does not count as armed without it. */
  cancel: SignedTx;
}

export interface ArmedAttempt {
  index: number;
  nonce: ArmedNonceBinding;
  variants: ArmedVariant[];
  status: ArmedAttemptStatus;
  submittedVariantId?: string;
  submittedAtSlot?: bigint;
  /** Signature that consumed this attempt's nonce, once known. */
  consumedBy?: string;
}

/**
 * Trigger conditions, expressed on the order's own LIVE QUOTE OUT (buy: tokens out for the fixed
 * spend; sell: quote out for the fixed token amount). Quote-out is monotonic in price, so these
 * are price triggers that already include price impact and the fee tier at that price.
 */
export type ArmedTrigger =
  /** Limit buy / take-profit / limit sell: fire once the live quote is at least `threshold`. */
  | { type: "quote-at-least"; threshold: bigint }
  /** Stop-loss: fire once the live quote is at most `threshold`. */
  | { type: "quote-at-most"; threshold: bigint }
  /** Trailing stop: fire when the quote falls `trailBps` below its high-water mark (bounded by the grid). */
  | { type: "trailing"; trailBps: number; activationQuoteOut?: bigint }
  /** DCA tranche: fire after `notBeforeMs` while the live quote is at least `minQuoteOut` (the band edge). */
  | { type: "time"; notBeforeMs: number; minQuoteOut?: bigint }
  /** Migration snipe: fire once the mint migrated AND the canonical pool is live (quote available). */
  | { type: "migration" }
  /** Dev-sell exit: fire when `creator` sells at least `minTokenAmount` of the mint. */
  | { type: "dev-sell"; creator: Address; minTokenAmount?: bigint };

/** Per-venue account facts of the variants. */
export interface FrozenVenueAccounts {
  venue: ArmedVenue;
  /** bonding_curve.creator (pump) / pool.coin_creator (pumpswap) at signing; creator_vault derives from it. */
  creator: Address;
  /** Bonding curve PDA (pump) or pool (pumpswap; the not-yet-existing canonical pool for migration orders). */
  market: Address;
  /** pump fee_recipient / PumpSwap protocol_fee_recipient named by the variants (must stay in the live list). */
  feeRecipient: Address;
  buybackFeeRecipient: Address;
}

/** Account-list facts frozen at signing; any change makes the order stale. */
export interface FrozenAccounts {
  mint: Address;
  baseTokenProgram: Address;
  quoteMint: Address;
  venues: FrozenVenueAccounts[];
  /** Tip accounts paid by the variants. */
  tipAccounts: Address[];
  /** Operator lookup tables the variants load from. */
  lookupTables: Address[];
  /** `currentInterfaceVersion()` of the build that signed (pump IDL snapshot hashes). */
  interfaceVersion: string;
}

/**
 * Default cap on signed variants per armed BUY: the signer firewall counts every signed buy
 * variant in full against the daily buy cap (SPEC "Armed buy variants each count against the daily cap").
 */
export const DEFAULT_MAX_ARMED_BUY_VARIANTS = 3;

/**
 * What arming consumed of the signer's DAILY caps when it was signed (counted whether or not
 * anything lands). Sells never consume the buy cap, but every signed tx consumes the fee budget.
 */
export interface ArmedCapCost {
  /** Sum of SOL-quoted buy variant spends. */
  buyLamports: bigint;
  /** Sum of buy variant spends per non-SOL quote mint. */
  buyQuote: Record<string, bigint>;
  /** Base fee + priority fee + tips over every signed tx of the order (variants and owned cancels). */
  feeLamports: bigint;
}

/** What must stay in the wallet for the order to land (checked before every submit; shown as "reserved"). */
export interface Reservation {
  /** Worst-case lamports that must be available (spend + fees + tips + temporary rent). */
  lamports: bigint;
  mint: Address;
  /** Base tokens that must be available (sells). */
  tokens: bigint;
}

export interface ArmedOrder {
  id: string;
  /** Trading wallet: fee payer, nonce authority and token owner of every tx. */
  wallet: Address;
  kind: ArmedOrderKind;
  side: ArmedSide;
  mint: Address;
  /** buy: quote spend (lamports for SOL pairs); sell: base tokens. Frozen at signing. */
  amount: bigint;
  /** Sells the whole armed balance and closes the token account. Required for ladders. */
  fullExit: boolean;
  trigger: ArmedTrigger;
  attempts: ArmedAttempt[];
  /** Orders sharing a nonce must share this id. */
  ocoGroup?: string;
  /** Live quote out for `amount` when armed (grid-depth cap reference). */
  armingQuoteOut: bigint;
  armedAtMs: number;
  frozen: FrozenAccounts;
  reservation: Reservation;
  /** Daily-cap cost of arming (UI: "uses X of today's buy cap and Y of the fee budget"). */
  capCost: ArmedCapCost;
  status: ArmedOrderStatus;
  statusReason?: string;
  /** Non-fatal warnings (e.g. "interface-upgrade" suspected by the IDL watcher): prompt a re-arm. */
  flags?: string[];
}

export const TERMINAL_STATUSES: readonly ArmedOrderStatus[] = ["filled", "failed-consumed", "stale", "cancelled"];

export function isTerminalStatus(s: ArmedOrderStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}

const OPEN_ATTEMPT: readonly ArmedAttemptStatus[] = ["live", "submitted", "cancelling"];

/** An attempt whose nonce has not been seen consumed yet (its txs may still land). */
export function isAttemptOpen(a: ArmedAttempt): boolean {
  return OPEN_ATTEMPT.includes(a.status);
}

/** Next attempt the trigger engine may submit (lowest live index), if no attempt is in flight. */
export function nextLiveAttempt(order: ArmedOrder): ArmedAttempt | null {
  if (order.attempts.some((a) => a.status === "submitted" || a.status === "cancelling")) return null;
  return order.attempts.find((a) => a.status === "live") ?? null;
}

/** Reservations stay held while any nonce of the order is unconsumed, whatever the order status. */
export function reservationHeld(order: ArmedOrder): boolean {
  return order.attempts.some(isAttemptOpen);
}

/** Every signed transaction of the order, keyed by signature (variants and cancels). */
export function armedSignatures(
  order: ArmedOrder,
): { signature: string; attempt: number; kind: "variant" | "cancel"; variantId?: string }[] {
  const out: { signature: string; attempt: number; kind: "variant" | "cancel"; variantId?: string }[] = [];
  for (const a of order.attempts) {
    for (const v of a.variants) out.push({ signature: v.tx.signature, attempt: a.index, kind: "variant", variantId: v.id });
    out.push({ signature: a.nonce.cancel.signature, attempt: a.index, kind: "cancel" });
  }
  return out;
}

/** Signatures that can consume `nonceAccount`, across orders (to resolve which tx advanced a nonce). */
export function signaturesOnNonce(
  orders: readonly ArmedOrder[],
  nonceAccount: Address,
): { signature: string; orderId: string; attempt: number; kind: "variant" | "cancel"; variantId?: string }[] {
  const out: { signature: string; orderId: string; attempt: number; kind: "variant" | "cancel"; variantId?: string }[] = [];
  const seen = new Set<string>();
  for (const o of orders) {
    for (const a of o.attempts) {
      if (a.nonce.account !== nonceAccount) continue;
      for (const v of a.variants)
        out.push({ signature: v.tx.signature, orderId: o.id, attempt: a.index, kind: "variant", variantId: v.id });
      // OCO orders carry the same cancel bytes; list it once.
      if (!seen.has(a.nonce.cancel.signature)) {
        seen.add(a.nonce.cancel.signature);
        out.push({ signature: a.nonce.cancel.signature, orderId: o.id, attempt: a.index, kind: "cancel" });
      }
    }
  }
  return out;
}

/**
 * Notional for the per-user armed cap: buys count their spend, sells the arming quote of their
 * tokens. Orders sharing a nonce (OCO) are mutually exclusive, so a group counts its maximum.
 */
export function armedNotional(orders: readonly ArmedOrder[]): bigint {
  const groups = new Map<string, bigint>();
  for (const o of orders) {
    if (!reservationHeld(o)) continue;
    const notional = o.side === "buy" ? o.amount : o.armingQuoteOut;
    const key = o.ocoGroup ?? `order:${o.id}`;
    groups.set(key, (groups.get(key) ?? 0n) > notional ? (groups.get(key) as bigint) : notional);
  }
  let total = 0n;
  for (const v of groups.values()) total += v;
  return total;
}

export interface ReservedBalances {
  lamports: bigint;
  tokens: Record<Address, bigint>;
}

/** Aggregate reserved balances for the UI and the pre-submit check (OCO groups count once, at their maximum). */
export function aggregateReservations(orders: readonly ArmedOrder[]): ReservedBalances {
  const groups = new Map<string, Reservation>();
  for (const o of orders) {
    if (!reservationHeld(o)) continue;
    const key = o.ocoGroup ?? `order:${o.id}`;
    const prev = groups.get(key);
    groups.set(
      key,
      prev
        ? {
            lamports: prev.lamports > o.reservation.lamports ? prev.lamports : o.reservation.lamports,
            mint: o.reservation.mint,
            tokens: prev.tokens > o.reservation.tokens ? prev.tokens : o.reservation.tokens,
          }
        : o.reservation,
    );
  }
  const out: ReservedBalances = { lamports: 0n, tokens: {} };
  for (const r of groups.values()) {
    out.lamports += r.lamports;
    if (r.tokens > 0n) out.tokens[r.mint] = (out.tokens[r.mint] ?? 0n) + r.tokens;
  }
  return out;
}

/** Pre-submit balance check: the wallet must still hold what this order reserved. */
export function hasReservedBalance(order: ArmedOrder, balances: { lamports: bigint; tokens: bigint }): { ok: boolean; reason?: string } {
  if (balances.lamports < order.reservation.lamports) {
    return { ok: false, reason: `wallet holds ${balances.lamports} lamports, order needs ${order.reservation.lamports}` };
  }
  if (balances.tokens < order.reservation.tokens) {
    return { ok: false, reason: `wallet holds ${balances.tokens} tokens, order needs ${order.reservation.tokens}` };
  }
  // A full exit sells the WHOLE armed balance and closes the account: extra tokens make it fail.
  if (order.fullExit && balances.tokens !== order.amount) {
    return { ok: false, reason: `full-exit order armed for ${order.amount} tokens but the wallet holds ${balances.tokens}; re-arm` };
  }
  return { ok: true };
}
