/**
 * Armed orders: the gateway's Order (packages/protocol orders.ts, the engine's own model) to the UI's
 * order view (src/protocol.ts Order).
 *
 * The engine triggers on QUOTE OUT, not on price: a buy fires when its fixed spend would get at least
 * N tokens, a sell when its fixed token amount would get at least (take-profit) or at most (stop-loss)
 * N lamports. The UI reads triggers as prices and market caps, so a threshold becomes the effective
 * price per token it implies (spend / tokens out, or quote out / tokens sold): price impact and the
 * fee tier at that size are included, which is exactly what the order will fill at.
 */
import type { OrderEventRecord, OrderKind as WireKind, Order as WireOrder } from "@zerofee/protocol";
import type { Order, OrderEvent, OrderKind, OrderStatus, OrderTrigger } from "../../protocol";
import { uiAmount } from "./adapters";

const KIND: Record<WireKind, OrderKind> = {
  "limit-buy": "limit_buy",
  "limit-sell": "limit_sell",
  "take-profit": "take_profit",
  "stop-loss": "stop_loss",
  "trailing-stop": "trailing_stop",
  "dca-tranche": "dca_tranche",
  "migration-snipe": "migration_buy",
  "dev-sell-exit": "dev_sell_exit",
};

const STATUS: Record<WireOrder["status"], OrderStatus> = {
  armed: "armed",
  submitted: "submitted",
  filled: "filled",
  "failed-consumed": "failed",
  stale: "stale",
  cancelled: "cancelled",
};

export interface OrderAdaptContext {
  /** Token decimals (pump.fun mints: 6). */
  decimals: number;
  symbol: string;
  /** Nonce slot index by nonce account (the wallet's derived slots), when known. */
  nonceIndex?: (account: string) => number | null;
  /** Server event history (GET /api/orders/:id), oldest first; without it a minimal timeline is derived. */
  events?: OrderEventRecord[];
}

/** Effective price (SOL per whole token) implied by a quote-out amount for this order. */
export function impliedPriceSol(o: Pick<WireOrder, "side" | "amount">, quoteOut: string, decimals: number): number | null {
  const amount = BigInt(o.amount);
  const out = BigInt(quoteOut);
  if (amount <= 0n || out <= 0n) return null;
  return o.side === "buy" ? uiAmount(amount, 9) / uiAmount(out, decimals) : uiAmount(out, 9) / uiAmount(amount, decimals);
}

export function triggerOf(o: WireOrder, decimals: number): OrderTrigger {
  const t = o.trigger;
  switch (t.type) {
    case "quote-at-least":
      // Buys: more tokens out = a lower price. Sells: more SOL out = a higher price.
      return { metric: "price", direction: o.side === "buy" ? "below" : "above", value: impliedPriceSol(o, t.threshold, decimals) };
    case "quote-at-most":
      return { metric: "price", direction: o.side === "buy" ? "above" : "below", value: impliedPriceSol(o, t.threshold, decimals) };
    case "trailing":
      return { metric: "trailing", direction: "below", value: t.trailBps / 100 };
    case "time":
      return { metric: "time", direction: null, value: t.notBeforeMs };
    case "migration":
      return { metric: "migration", direction: null, value: null };
    case "dev-sell":
      return { metric: "dev_sell", direction: null, value: null };
  }
}

const EVENT_KIND: Partial<Record<OrderEventRecord["type"], string>> = {
  armed: "armed",
  submitted: "triggered",
  sent: "attempt",
  simulated: "attempt",
  "send-failed": "failed",
  "nonce-consumed": "filled",
  "submit-missed": "failed",
  "cancel-requested": "cancelled",
  "cancel-fired": "cancelled",
  stale: "stale",
  flag: "stale",
  held: "attempt",
};

function eventsOf(o: WireOrder, records: OrderEventRecord[] | undefined): OrderEvent[] {
  if (records?.length) {
    return records.map((r) => ({
      at: r.at,
      kind: r.type === "nonce-consumed" ? (r.status === "filled" ? "filled" : "failed") : (EVENT_KIND[r.type] ?? r.type),
      slot: typeof r.detail.slot === "number" ? r.detail.slot : null,
      reason: r.message || null,
    }));
  }
  const out: OrderEvent[] = [
    { at: o.armedAt, kind: "armed", slot: null, reason: o.dryRun ? "Dry run: the server simulates its submission" : null },
  ];
  if (o.status !== "armed") {
    const kind = o.status === "failed-consumed" ? "failed" : o.status === "submitted" ? "triggered" : o.status;
    out.push({ at: o.updatedAt, kind, slot: null, reason: o.statusReason });
  }
  return out;
}

export function adaptOrder(o: WireOrder, ctx: OrderAdaptContext): Order {
  const first = o.attempts[0];
  const variants = o.attempts.reduce((n, a) => n + a.variants, 0);
  const filled = o.status === "filled";
  return {
    id: o.id,
    mint: o.mint,
    symbol: ctx.symbol,
    kind: KIND[o.kind],
    side: o.side,
    trigger: triggerOf(o, ctx.decimals),
    size:
      o.side === "buy"
        ? { kind: "sol", sol: uiAmount(o.amount, 9) }
        : o.fullExit
          ? { kind: "pct", pct: 100 }
          : { kind: "tokens", tokens: uiAmount(o.amount, ctx.decimals) },
    status: STATUS[o.status],
    statusReason: o.statusReason ?? (o.flags.length ? `Flagged: ${o.flags.join(", ")}` : null),
    runsWithTabClosed: true,
    needsBrowserReason: null,
    reservedSol: o.open ? uiAmount(o.reservation.lamports, 9) : 0,
    nonceSlots: o.attempts.length,
    nonceAccount: first?.nonceAccount ?? null,
    nonceIndex: first ? (ctx.nonceIndex?.(first.nonceAccount) ?? null) : null,
    ocoGroupId: o.ocoGroup,
    // Armed orders only travel Jito bundle-only with the jitodontfront marker (SPEC "Armed orders").
    landing: "secure",
    variants,
    grid: [],
    events: eventsOf(o, ctx.events),
    armedPriceSol: impliedPriceSol(o, o.armingQuoteOut, ctx.decimals),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    filledAt: filled ? o.updatedAt : null,
    fillLatencyMs: null,
    signature: o.signature,
    fill: null,
  };
}
