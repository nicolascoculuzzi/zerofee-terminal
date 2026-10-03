import { fmtPct, fmtSol, fmtSolPrice, fmtSolShort, fmtTokens, fmtUsd } from "../../lib/format";
import type { LandingPreset, Order, OrderKind, OrderSize, OrderStatus, OrderTrigger } from "../../protocol";
import { isOpenOrder } from "../../state/orders";

export const KIND_LABEL: Record<OrderKind, string> = {
  limit_buy: "Limit buy",
  limit_sell: "Limit sell",
  take_profit: "Take profit",
  stop_loss: "Stop loss",
  migration_buy: "Migration buy",
  migration_sell: "Migration sell",
  copy_buy: "Copy buy",
  dev_snipe: "Dev snipe",
};

export const STATUS_LABEL: Record<OrderStatus, string> = {
  armed: "armed",
  submitted: "submitted",
  filled: "filled",
  stale: "stale, needs re-arm",
  failed: "failed",
  cancelled: "cancelled",
};

export const LANDING_LABEL: Record<LandingPreset, string> = { reduced: "Reduced", secure: "Secure", fast: "Fast" };

function comparator(direction: OrderTrigger["direction"]): string {
  if (direction === "below") return "≤";
  if (direction === "above") return "≥";
  return "at";
}

/** "MC ≤ $12.4K", "Price ≥ 0.0₇41 SOL", "On migration"… */
export function triggerText(t: OrderTrigger): string {
  switch (t.metric) {
    case "mc":
      return t.value === null ? "Market cap" : `MC ${comparator(t.direction)} ${fmtUsd(t.value)}`;
    case "price":
      return t.value === null ? "Price" : `Price ${comparator(t.direction)} ${fmtSolPrice(t.value)} SOL`;
    case "migration":
      return "On migration";
    case "leader_buy":
      return "When the leader buys";
    case "dev_launch":
      return "When the dev launches";
  }
}

/** "0.5 SOL" or "50%" (of the holding when the order fires). */
export function sizeText(size: OrderSize): string {
  return size.kind === "sol" ? `${fmtSolShort(size.sol)} SOL` : `${fmtSolShort(size.pct)}%`;
}

/** Live value of the metric the trigger watches, formatted like the trigger. */
export function currentText(order: Order, current: number): string {
  if (order.trigger.metric === "mc") return `MC ${fmtUsd(current)}`;
  if (order.trigger.metric === "price") return `${fmtSolPrice(current)} SOL`;
  return `Bonding ${fmtPct(current * 100)}`;
}

/** Signed % move from the live value to the trigger, or "at trigger" once it is crossed. */
export function distanceText(order: Order, current: number): string | null {
  const { metric, value, direction } = order.trigger;
  if ((metric !== "mc" && metric !== "price") || value === null || !(current > 0)) return null;
  if ((direction === "above" && current >= value) || (direction === "below" && current <= value)) return "at trigger";
  return `${fmtPct(((value - current) / current) * 100, { signed: true })} to trigger`;
}

/** "1 nonce slot", or "shared (OCO)" for the leg riding on its sibling's nonce. */
export function nonceText(order: Order): string {
  if (order.nonceSlots === 0) {
    if (order.ocoGroupId) return "shared (OCO)";
    return order.runsWithTabClosed ? "no nonce slot" : "no nonce (signed live)";
  }
  return `${order.nonceSlots} nonce slot${order.nonceSlots === 1 ? "" : "s"}`;
}

export function variantsText(order: Order): string {
  if (order.variants > 0) return `${order.variants} pre-signed variant${order.variants === 1 ? "" : "s"}`;
  return "signed when it fires";
}

export function fillText(order: Order): string | null {
  const f = order.fill;
  if (!f) return null;
  return `${order.side === "buy" ? "Bought" : "Sold"} ${fmtTokens(f.tokenAmount)} for ${fmtSol(f.solAmount)} SOL at ${fmtSolPrice(f.priceSol)}`;
}

export type OrderFilter = "all" | "open" | "rearm" | "history";

export const FILTER_TEST: Record<OrderFilter, (o: Order) => boolean> = {
  all: () => true,
  open: isOpenOrder,
  rearm: (o) => o.status === "stale",
  history: (o) => !isOpenOrder(o),
};

/** Open orders first (newest first), then finished ones (most recently finished first). */
export function compareOrders(a: Order, b: Order): number {
  const ao = isOpenOrder(a);
  const bo = isOpenOrder(b);
  if (ao !== bo) return ao ? -1 : 1;
  if (ao) return b.createdAt - a.createdAt;
  return (b.filledAt ?? b.updatedAt) - (a.filledAt ?? a.updatedAt);
}

export interface OrderGroup {
  key: string;
  /** Legs sharing one durable nonce (take profit + stop loss). */
  oco: boolean;
  open: boolean;
  orders: Order[];
}

/** Groups OCO legs together, keeping each group where its first (highest-sorted) leg falls. */
export function groupOrders(sorted: Order[]): OrderGroup[] {
  const groups: OrderGroup[] = [];
  const byOco = new Map<string, OrderGroup>();
  for (const o of sorted) {
    const open = isOpenOrder(o);
    if (o.ocoGroupId) {
      const g = byOco.get(o.ocoGroupId);
      if (g) {
        g.orders.push(o);
        g.open ||= open;
        continue;
      }
      const group: OrderGroup = { key: `oco:${o.ocoGroupId}`, oco: true, open, orders: [o] };
      byOco.set(o.ocoGroupId, group);
      groups.push(group);
    } else {
      groups.push({ key: o.id, oco: false, open, orders: [o] });
    }
  }
  // Legs in the order they were armed (take profit before its stop loss).
  for (const g of groups) {
    if (g.oco) g.orders.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id, "en", { numeric: true }));
  }
  return groups;
}
