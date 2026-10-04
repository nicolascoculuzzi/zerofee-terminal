import { fmtCompact, fmtPriceText, fmtSolShort } from "../../lib/format";
import type { Order, OrderKind, OrderStatus } from "../../protocol";

/*
 * Order wording for the token page (DESIGN.md 4.20): triggers in words ("MC above 120K", never
 * the comparison glyphs our fonts lack), sizes as verbs ("Sell 25%", "Buy 0.5 SOL"), statuses as a dot
 * plus a label.
 */

export const KIND_TEXT: Record<OrderKind, string> = {
  limit_buy: "Limit buy",
  limit_sell: "Limit sell",
  take_profit: "Take profit",
  stop_loss: "Stop loss",
  migration_buy: "Migration buy",
  migration_sell: "Migration sell",
  copy_buy: "Copy buy",
  dev_snipe: "Dev snipe",
};

export const KIND_SHORT: Record<OrderKind, string> = {
  limit_buy: "Limit buy",
  limit_sell: "Limit sell",
  take_profit: "TP",
  stop_loss: "SL",
  migration_buy: "Migration buy",
  migration_sell: "Migration sell",
  copy_buy: "Copy buy",
  dev_snipe: "Dev snipe",
};

export type StatusTone = "info" | "warn" | "sell" | "done" | "off";

export const STATUS_TEXT: Record<OrderStatus, { label: string; tone: StatusTone }> = {
  armed: { label: "Armed", tone: "info" },
  submitted: { label: "Sending", tone: "warn" },
  filled: { label: "Filled", tone: "done" },
  stale: { label: "Needs re-arm", tone: "warn" },
  failed: { label: "Consumed · re-arm", tone: "sell" },
  cancelled: { label: "Cancelled", tone: "off" },
};

/** "MC above $120K", "Price below 0.000004123 SOL", "On migration". */
export function triggerText(order: Order): string {
  const t = order.trigger;
  const dir = t.direction === "below" ? "below" : t.direction === "above" ? "above" : "at";
  if (t.metric === "mc") return t.value === null ? "Market cap" : `MC ${dir} $${fmtCompact(t.value)}`;
  if (t.metric === "price") return t.value === null ? "Price" : `Price ${dir} ${fmtPriceText(t.value)} SOL`;
  if (t.metric === "migration") return "On migration";
  if (t.metric === "leader_buy") return "When the leader buys";
  return "When the dev launches";
}

/** "Buy 0.5 SOL", "Sell 25%". */
export function sizeText(order: Order): string {
  const verb = order.side === "buy" ? "Buy" : "Sell";
  return order.size.kind === "sol" ? `${verb} ${fmtSolShort(order.size.sol)} SOL` : `${verb} ${fmtSolShort(order.size.pct)}%`;
}

/** Signed % from the live value to the trigger (a distance, not PnL), or null. */
export function distanceToTrigger(order: Order, current: { mcUsd: number; priceSol: number }): number | null {
  const t = order.trigger;
  if (t.value === null) return null;
  if (t.metric === "mc") return current.mcUsd > 0 ? (t.value / current.mcUsd - 1) * 100 : null;
  if (t.metric === "price") return current.priceSol > 0 ? (t.value / current.priceSol - 1) * 100 : null;
  return null;
}

/** Trigger level as SOL per token, for drawing the order on the chart. */
export function triggerPriceSol(order: Order, supply: number, solUsd: number): number | null {
  const t = order.trigger;
  if (t.value === null) return null;
  if (t.metric === "price") return t.value;
  if (t.metric === "mc" && supply > 0 && solUsd > 0) return t.value / (supply * solUsd);
  return null;
}
