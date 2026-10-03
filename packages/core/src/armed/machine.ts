/**
 * Armed-order status machine: a pure reducer `(order, event) -> { order, effects }`.
 *
 * The server order engine feeds it what it observes and executes the effects it returns. The one
 * fact that settles everything is WHICH SIGNATURE CONSUMED A NONCE (`nonce-consumed`): a variant
 * of this order (filled, or landed-and-failed), the pre-signed cancel, or something else (an OCO
 * sibling or a foreign transaction). Dispatch every `nonce-consumed` to all orders bound to that
 * nonce (`signaturesOnNonce` helps resolve the signature). Events carry the nonce VALUE that was
 * consumed, so a slot re-armed at a new value is never touched by events about an older generation.
 *
 *   armed --submitted--> submitted --nonce-consumed(own variant, ok)-----> filled
 *                                  --nonce-consumed(own variant, failed)-> failed-consumed
 *                                                                          (or armed: ladder continues)
 *                                  --submit-missed--> fire cancel; resolves on nonce-consumed
 *   armed|submitted --stale--> stale (fire cancels)    --cancel-requested--> cancelled (fire cancels)
 *
 * Truth wins: if a variant lands after a cancel was requested, the order still becomes filled.
 */
import type { Address } from "@solana/kit";
import type { SignedTx } from "./armedTx";
import { type ArmedAttempt, type ArmedOrder, isAttemptOpen, isTerminalStatus } from "./model";

export type ArmedOrderEvent =
  /** The engine submitted `variantId` of attempt `attempt`. */
  | { type: "submitted"; attempt: number; variantId: string; slot?: bigint }
  /**
   * `nonce` advanced away from `nonceValue` (the consuming tx's lifetime token); `signature` is the
   * transaction that advanced it (`success` = executed without error).
   */
  | {
      type: "nonce-consumed";
      nonce: Address;
      nonceValue: string;
      signature: string;
      success: boolean;
      slot?: bigint;
      bySiblingOrderId?: string;
    }
  /** The submitted attempt did not land within the engine's window: burn the nonce. */
  | { type: "submit-missed"; attempt: number }
  /** User cancel, Panic, admin halt or expiry: fire every open cancel. */
  | { type: "cancel-requested"; reason: string }
  /** A DEFINITIVE staleness finding (the variants can no longer succeed). */
  | { type: "stale"; reason: string }
  /** A non-definitive finding (e.g. an IDL change that may not affect these instructions). */
  | { type: "flag"; reason: string };

export type ArmedOrderEffect =
  | { type: "fire-cancel"; orderId: string; nonce: Address; cancel: SignedTx }
  | {
      type: "notify";
      orderId: string;
      kind: "filled" | "consumed" | "ladder-continues" | "missed" | "stale" | "cancelled" | "flagged";
      message: string;
    };

export class ArmedTransitionError extends Error {}

interface Draft {
  order: ArmedOrder;
  effects: ArmedOrderEffect[];
  fired: Set<Address>;
}

function setAttempt(d: Draft, index: number, patch: Partial<ArmedAttempt>): void {
  d.order = { ...d.order, attempts: d.order.attempts.map((a) => (a.index === index ? { ...a, ...patch } : a)) };
}

function notify(d: Draft, kind: Extract<ArmedOrderEffect, { type: "notify" }>["kind"], message: string): void {
  d.effects.push({ type: "notify", orderId: d.order.id, kind, message });
}

/** Moves open attempts (except `except`) to cancelling and fires their cancels (once per nonce). */
function cancelOpenAttempts(d: Draft, except?: number): void {
  for (const a of d.order.attempts) {
    if (a.index === except || (a.status !== "live" && a.status !== "submitted")) continue;
    setAttempt(d, a.index, { status: "cancelling" });
    if (!d.fired.has(a.nonce.account)) {
      d.fired.add(a.nonce.account);
      d.effects.push({ type: "fire-cancel", orderId: d.order.id, nonce: a.nonce.account, cancel: a.nonce.cancel });
    }
  }
}

function setStatus(d: Draft, status: ArmedOrder["status"], reason: string): void {
  d.order = { ...d.order, status, statusReason: reason };
}

const hasLive = (o: ArmedOrder) => o.attempts.some((a) => a.status === "live");
const hasInFlight = (o: ArmedOrder) => o.attempts.some((a) => a.status === "submitted" || a.status === "cancelling");

function onNonceConsumed(d: Draft, e: Extract<ArmedOrderEvent, { type: "nonce-consumed" }>): void {
  const hit = d.order.attempts.filter((a) => a.nonce.account === e.nonce && a.nonce.value === e.nonceValue && isAttemptOpen(a));
  for (const attempt of hit) {
    const variant = attempt.variants.find((v) => v.tx.signature === e.signature);
    if (variant) {
      setAttempt(d, attempt.index, { status: e.success ? "landed-ok" : "landed-failed", consumedBy: e.signature });
      if (e.success) {
        setStatus(d, "filled", `filled by ${variant.id}`);
        // A full-exit ladder's other nonces must die now: a re-buy of the same amount could revive them.
        cancelOpenAttempts(d, attempt.index);
        notify(d, "filled", `filled by ${variant.id} (${e.signature})`);
      } else if (!isTerminalStatus(d.order.status)) {
        if (hasLive(d.order)) {
          setStatus(d, "armed", `attempt ${attempt.index} landed but failed; ladder continues`);
          notify(d, "ladder-continues", `attempt ${attempt.index} landed but failed (${e.signature}); next attempt stays armed`);
        } else {
          setStatus(d, "failed-consumed", "landed but failed: nonce consumed, re-arm");
          notify(d, "consumed", `landed but failed (${e.signature}); the nonce is consumed - re-arm`);
        }
      }
      continue;
    }
    setAttempt(d, attempt.index, { status: "burned", consumedBy: e.signature });
    const isOwnCancel = e.signature === attempt.nonce.cancel.signature;
    if (!isOwnCancel && e.success) {
      // Another transaction executed on this nonce: the OCO sibling filled, or something foreign
      // used the nonce. Either way the order's premise is gone; burn its other nonces too.
      cancelOpenAttempts(d);
      if (!isTerminalStatus(d.order.status)) {
        const why = e.bySiblingOrderId
          ? `OCO sibling ${e.bySiblingOrderId} filled`
          : `nonce consumed by another transaction (${e.signature})`;
        setStatus(d, "cancelled", why);
        notify(d, "cancelled", `cancelled: ${why}`);
      }
      continue;
    }
    if (isTerminalStatus(d.order.status)) continue;
    if (hasLive(d.order)) {
      if (d.order.status === "submitted" && !hasInFlight(d.order))
        setStatus(d, "armed", `attempt ${attempt.index} burned; ladder continues`);
      continue;
    }
    if (hasInFlight(d.order)) continue;
    if (isOwnCancel) {
      setStatus(d, "failed-consumed", "attempt missed and its nonce was burned by the cancel: re-arm");
      notify(d, "consumed", "the attempt missed; the cancel burned its nonce - re-arm");
    } else {
      setStatus(d, "failed-consumed", `nonce consumed by a failed transaction (${e.signature}): re-arm`);
      notify(d, "consumed", `nonce consumed by a failed transaction (${e.signature}) - re-arm`);
    }
  }
}

/** Applies one event. Throws ArmedTransitionError only for engine bugs (e.g. submitting a non-armed order). */
export function applyArmedOrderEvent(order: ArmedOrder, event: ArmedOrderEvent): { order: ArmedOrder; effects: ArmedOrderEffect[] } {
  const d: Draft = { order, effects: [], fired: new Set() };
  switch (event.type) {
    case "submitted": {
      if (order.status !== "armed") throw new ArmedTransitionError(`order ${order.id} is ${order.status}, not armed`);
      const attempt = order.attempts[event.attempt];
      if (attempt?.status !== "live") throw new ArmedTransitionError(`attempt ${event.attempt} of ${order.id} is not live`);
      if (hasInFlight(order)) throw new ArmedTransitionError(`order ${order.id} already has an attempt in flight`);
      if (!attempt.variants.some((v) => v.id === event.variantId)) {
        throw new ArmedTransitionError(`variant ${event.variantId} is not in attempt ${event.attempt} of ${order.id}`);
      }
      setAttempt(d, attempt.index, {
        status: "submitted",
        submittedVariantId: event.variantId,
        ...(event.slot !== undefined ? { submittedAtSlot: event.slot } : {}),
      });
      setStatus(d, "submitted", `submitted ${event.variantId}`);
      break;
    }
    case "nonce-consumed":
      onNonceConsumed(d, event);
      break;
    case "submit-missed": {
      const attempt = order.attempts[event.attempt];
      if (attempt?.status !== "submitted") break;
      setAttempt(d, attempt.index, { status: "cancelling" });
      d.effects.push({ type: "fire-cancel", orderId: order.id, nonce: attempt.nonce.account, cancel: attempt.nonce.cancel });
      notify(d, "missed", `attempt ${attempt.index} did not land in time; firing its cancel`);
      break;
    }
    case "cancel-requested":
      cancelOpenAttempts(d);
      if (!isTerminalStatus(order.status)) {
        setStatus(d, "cancelled", event.reason);
        notify(d, "cancelled", `cancelled: ${event.reason}`);
      }
      break;
    case "stale":
      if (isTerminalStatus(order.status)) break;
      cancelOpenAttempts(d);
      setStatus(d, "stale", event.reason);
      notify(d, "stale", `stale (${event.reason}): re-arm from the browser`);
      break;
    case "flag":
      if ((order.flags ?? []).includes(event.reason)) break;
      d.order = { ...order, flags: [...(order.flags ?? []), event.reason] };
      notify(d, "flagged", `check and re-arm: ${event.reason}`);
      break;
  }
  return { order: d.order, effects: d.effects };
}
