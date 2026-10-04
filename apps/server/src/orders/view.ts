/**
 * ArmedOrder (+ trigger state) -> the protocol `Order` view. Pure. Views never carry signed bytes: an
 * armed transaction is a bearer instrument until its nonce advances.
 */
import { type ArmedOrder, type ArmedTrigger, reservationHeld, type TriggerState } from "@zerofee/core";
import type { Order, OrderAttempt, OrderTrigger, OrderVenue } from "@zerofee/protocol";

export function triggerView(t: ArmedTrigger): OrderTrigger {
  switch (t.type) {
    case "quote-at-least":
    case "quote-at-most":
      return { type: t.type, threshold: t.threshold.toString() };
    case "trailing":
      return { type: "trailing", trailBps: t.trailBps, activationQuoteOut: t.activationQuoteOut?.toString() ?? null };
    case "time":
      return { type: "time", notBeforeMs: t.notBeforeMs, minQuoteOut: t.minQuoteOut?.toString() ?? null };
    case "migration":
      return { type: "migration" };
    case "dev-sell":
      return { type: "dev-sell", creator: t.creator, minTokenAmount: t.minTokenAmount?.toString() ?? null };
  }
}

function attemptView(a: ArmedOrder["attempts"][number]): OrderAttempt {
  let low: bigint | null = null;
  let high: bigint | null = null;
  for (const v of a.variants) {
    if (low === null || v.minOut < low) low = v.minOut;
    if (high === null || v.minOut > high) high = v.minOut;
  }
  return {
    index: a.index,
    nonceAccount: a.nonce.account,
    status: a.status,
    variants: a.variants.length,
    minOutLow: (low ?? 0n).toString(),
    minOutHigh: (high ?? 0n).toString(),
    submittedVariantId: a.submittedVariantId ?? null,
    submittedAtSlot: a.submittedAtSlot === undefined ? null : Number(a.submittedAtSlot),
    consumedBy: a.consumedBy ?? null,
  };
}

export interface ViewMeta {
  createdAt: number;
  updatedAt: number;
  dryRun: boolean;
}

export function orderView(o: ArmedOrder, state: TriggerState, meta: ViewMeta): Order {
  return {
    id: o.id,
    wallet: o.wallet,
    kind: o.kind,
    side: o.side,
    mint: o.mint,
    amount: o.amount.toString(),
    fullExit: o.fullExit,
    trigger: triggerView(o.trigger),
    ocoGroup: o.ocoGroup ?? null,
    status: o.status,
    statusReason: o.statusReason ?? null,
    flags: [...(o.flags ?? [])],
    attempts: o.attempts.map(attemptView),
    venues: [...new Set(o.frozen.venues.map((v) => v.venue as OrderVenue))],
    armingQuoteOut: o.armingQuoteOut.toString(),
    armedAt: o.armedAtMs,
    reservation: { lamports: o.reservation.lamports.toString(), tokens: o.reservation.tokens.toString() },
    capCost: { buyLamports: o.capCost.buyLamports.toString(), feeLamports: o.capCost.feeLamports.toString() },
    signature: o.attempts.find((a) => a.status === "landed-ok")?.consumedBy ?? null,
    highWater: o.trigger.type === "trailing" && state.highWater !== undefined ? state.highWater.toString() : null,
    open: reservationHeld(o),
    dryRun: meta.dryRun,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
}
