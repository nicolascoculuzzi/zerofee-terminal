import { DASH, fmtCompact, fmtSolShort, fmtUsd, plainDecimal } from "../../lib/format";
import { LANDING_INFO } from "../../lib/landing";
import type { LandingPreset, Order, OrderKind, OrderStatus } from "../../protocol";
import { isOpenOrder } from "../../state/orders";
import type { QuoteCurrency } from "../../state/settings";

/** Status presentation (DESIGN.md 4.20): the dot colour, the label, and how loud the row is. */
export type StatusTone = "info" | "warn" | "sell" | "filled" | "muted";

export const STATUS_INFO: Record<OrderStatus, { label: string; tone: StatusTone }> = {
  armed: { label: "Armed", tone: "info" },
  submitted: { label: "Sending", tone: "warn" },
  filled: { label: "Filled", tone: "filled" },
  // A failed attempt consumes the durable nonce (SPEC): the order needs re-arming.
  failed: { label: "Consumed · re-arm", tone: "sell" },
  stale: { label: "Needs re-arm", tone: "warn" },
  cancelled: { label: "Cancelled", tone: "muted" },
};

/** Short type names for the 12ch Type column; TP and SL legs get numbers (typeLabels). */
export const KIND_LABEL: Record<OrderKind, string> = {
  limit_buy: "Limit buy",
  limit_sell: "Limit sell",
  take_profit: "TP",
  stop_loss: "SL",
  migration_buy: "Migration buy",
  migration_sell: "Migration sell",
  copy_buy: "Copy buy",
  dev_snipe: "Dev snipe",
  trailing_stop: "Trailing",
  dca_tranche: "DCA",
  dev_sell_exit: "Dev-sell exit",
};

/** Full names for the drawer and dialogs. */
export const KIND_NAME: Record<OrderKind, string> = {
  limit_buy: "Limit buy",
  limit_sell: "Limit sell",
  take_profit: "Take profit",
  stop_loss: "Stop loss",
  migration_buy: "Migration buy",
  migration_sell: "Migration sell",
  copy_buy: "Copy buy",
  dev_snipe: "Dev snipe",
  trailing_stop: "Trailing stop",
  dca_tranche: "DCA tranche",
  dev_sell_exit: "Dev-sell exit",
};

/** Lane column (8ch): where the pre-signed transaction is sent (SPEC "Landing presets"). */
export const LANE_LABEL: Record<LandingPreset, string> = { reduced: "Sender", secure: "Jito", fast: "All lanes" };

export function laneTitle(landing: LandingPreset): string {
  const info = LANDING_INFO[landing];
  return `${info.label}: ${info.route}`;
}

/**
 * "TP1", "TP2"… by trigger price within each token (lowest first), "SL" (numbered when a token
 * has several), everything else its kind label.
 */
export function typeLabels(orders: readonly Order[]): Map<string, string> {
  const out = new Map<string, string>();
  const legs = new Map<string, Order[]>();
  for (const o of orders) {
    if (o.kind === "take_profit" || o.kind === "stop_loss") {
      const key = `${o.mint ?? o.symbol}:${o.kind}`;
      const list = legs.get(key) ?? [];
      list.push(o);
      legs.set(key, list);
    } else {
      out.set(o.id, KIND_LABEL[o.kind]);
    }
  }
  for (const list of legs.values()) {
    list.sort((a, b) => (a.trigger.value ?? 0) - (b.trigger.value ?? 0) || a.createdAt - b.createdAt);
    list.forEach((o, i) => {
      const base = KIND_LABEL[o.kind];
      out.set(o.id, o.kind === "stop_loss" && list.length === 1 ? base : `${base}${i + 1}`);
    });
  }
  return out;
}

export interface TriggerContext {
  quote: QuoteCurrency;
  solUsd: number;
  /** Token supply when the token is in the live set (turns price triggers into market caps). */
  supply: number | null;
}

function mcText(mcSol: number, ctx: TriggerContext): string {
  return ctx.quote === "USD" ? fmtUsd(mcSol * ctx.solUsd) : `${fmtCompact(mcSol)} SOL`;
}

/**
 * A trigger in words (DESIGN.md 4.20, 2.2: "MC above 120K", never comparison symbols). Price
 * triggers read as the market cap they imply when the supply is known, so every row reads in MC;
 * otherwise the price itself, which the UI renders with the subscript-zero <Num>.
 */
export type TriggerParts = { kind: "text"; text: string } | { kind: "price"; words: string; priceSol: number };

export function triggerParts(order: Order, ctx: TriggerContext): TriggerParts {
  const t = order.trigger;
  const word = t.direction === "above" ? "above" : t.direction === "below" ? "below" : "at";
  switch (t.metric) {
    case "mc":
      if (t.value === null) return { kind: "text", text: "Market cap" };
      return { kind: "text", text: `MC ${word} ${mcText(ctx.solUsd > 0 ? t.value / ctx.solUsd : 0, ctx)}` };
    case "price":
      if (t.value === null) return { kind: "text", text: "Price" };
      if (ctx.supply !== null && ctx.supply > 0) return { kind: "text", text: `MC ${word} ${mcText(t.value * ctx.supply, ctx)}` };
      return { kind: "price", words: `Price ${word}`, priceSol: t.value };
    case "migration":
      return { kind: "text", text: "On migration" };
    case "leader_buy":
      return { kind: "text", text: "When the leader buys" };
    case "dev_launch":
      return { kind: "text", text: "When the dev launches" };
    case "trailing":
      return { kind: "text", text: t.value === null ? "Trailing stop" : `Trails ${plainDecimal(t.value)}% below the high` };
    case "time":
      return { kind: "text", text: t.value === null ? "On a schedule" : `After ${new Date(t.value).toLocaleString()}` };
    case "dev_sell":
      return { kind: "text", text: "When the dev sells" };
  }
}

/** Plain-text trigger for titles, aria labels and confirm dialogs (prices as the full decimal). */
export function triggerText(order: Order, ctx: TriggerContext): string {
  const p = triggerParts(order, ctx);
  return p.kind === "text" ? p.text : `${p.words} ${plainDecimal(p.priceSol)} SOL`;
}

export interface Distance {
  /** Signed % move from the live value to the trigger. */
  pct: number;
  /** The live value is already past the trigger (the order is firing or about to). */
  crossed: boolean;
}

/** Distance from the live market cap (or price) to the trigger; null when it doesn't apply. */
export function triggerDistance(order: Order, live: { mcUsd: number | null; priceSol: number | null }): Distance | null {
  const { metric, value, direction } = order.trigger;
  if (!isOpenOrder(order) || value === null) return null;
  const current = metric === "mc" ? live.mcUsd : metric === "price" ? live.priceSol : null;
  if (current === null || !(current > 0)) return null;
  const crossed = (direction === "above" && current >= value) || (direction === "below" && current <= value);
  return { pct: ((value - current) / current) * 100, crossed };
}

/** "Sell 25%", "Buy 0.5 SOL", "Sell 1.2M tokens" (user-entered amounts as entered, DESIGN.md 3.4). */
export function sizeText(order: Order): string {
  const verb = order.side === "buy" ? "Buy" : "Sell";
  const s = order.size;
  if (s.kind === "sol") return `${verb} ${fmtSolShort(s.sol)} SOL`;
  if (s.kind === "pct") return `${verb} ${fmtSolShort(s.pct)}%`;
  return `${verb} ${fmtCompact(s.tokens)} tokens`;
}

/**
 * Nonce column (DESIGN.md 4.20): the slot number of the durable-nonce account ("#4"), with a link
 * icon when an OCO pair shares it, or "None" for orders signed live.
 */
export function nonceInfo(order: Order): { text: string; shared: boolean; title: string } {
  const slot = order.nonceIndex !== null ? `#${order.nonceIndex}` : null;
  if (order.ocoGroupId && (slot || order.nonceSlots === 0)) {
    return {
      text: slot ?? "Shared",
      shared: true,
      title: "One durable nonce shared with its OCO sibling: once either leg lands, the other can't.",
    };
  }
  if (slot) return { text: slot, shared: false, title: "Holds its own durable-nonce slot." };
  if (order.nonceSlots > 0) return { text: DASH, shared: false, title: "Holds a durable-nonce slot." };
  return { text: "None", shared: false, title: "Nothing is pre-signed: this browser signs it live when it fires." };
}

/** Variants column: "6 · 3 tips" (min-out grid size and tip levels), or "Live" for orders signed when they fire. */
export function variantsText(order: Order): { text: string; title: string } {
  if (order.variants > 0) {
    const tips = new Set(order.grid.map((v) => v.tipSol)).size;
    return {
      text: tips > 1 ? `${order.variants} · ${tips} tips` : String(order.variants),
      title: `${order.variants} pre-signed variants on a min-out grid${tips > 1 ? ` with ${tips} tip levels` : ""}`,
    };
  }
  return { text: "Live", title: "Signed in this browser when it fires" };
}

export type OrderTab = "all" | "armed" | "rearm" | "filled" | "consumed" | "cancelled";

export const ORDER_TABS: { id: OrderTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "armed", label: "Armed" },
  { id: "rearm", label: "Needs re-arm" },
  { id: "filled", label: "Filled" },
  { id: "consumed", label: "Consumed" },
  { id: "cancelled", label: "Cancelled" },
];

export const TAB_TEST: Record<OrderTab, (o: Order) => boolean> = {
  all: () => true,
  armed: (o) => o.status === "armed" || o.status === "submitted",
  rearm: (o) => o.status === "stale",
  filled: (o) => o.status === "filled",
  consumed: (o) => o.status === "failed",
  cancelled: (o) => o.status === "cancelled",
};

export function tabCounts(orders: readonly Order[]): Record<OrderTab, number> {
  const c: Record<OrderTab, number> = { all: 0, armed: 0, rearm: 0, filled: 0, consumed: 0, cancelled: 0 };
  for (const o of orders) {
    c.all++;
    for (const t of ORDER_TABS) if (t.id !== "all" && TAB_TEST[t.id](o)) c[t.id]++;
  }
  return c;
}

const STATUS_RANK: Record<OrderStatus, number> = { submitted: 0, armed: 1, stale: 2, failed: 3, filled: 4, cancelled: 5 };

export interface OrderGroup {
  /** Mint, or "kind:<kind>" for orders whose token isn't known yet (copy buys, dev snipes). */
  key: string;
  mint: string | null;
  symbol: string;
  orders: Order[];
  openCount: number;
}

/**
 * Groups orders by token (DESIGN.md 4.20). Groups with open orders come first (most recently
 * armed first); inside a group open orders lead, then the ladder in arming order, so OCO legs
 * sit next to each other.
 */
export function groupByToken(orders: readonly Order[]): OrderGroup[] {
  const map = new Map<string, OrderGroup>();
  for (const o of orders) {
    const key = o.mint ?? `kind:${o.kind}`;
    const g = map.get(key) ?? { key, mint: o.mint, symbol: o.mint ? o.symbol : KIND_NAME[o.kind], orders: [], openCount: 0 };
    g.orders.push(o);
    if (isOpenOrder(o)) g.openCount++;
    map.set(key, g);
  }
  const groups = [...map.values()];
  for (const g of groups) {
    g.orders.sort((a, b) => {
      const ao = isOpenOrder(a);
      const bo = isOpenOrder(b);
      if (ao !== bo) return ao ? -1 : 1;
      if (!ao) return (b.filledAt ?? b.updatedAt) - (a.filledAt ?? a.updatedAt);
      return (
        STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.createdAt - b.createdAt || a.id.localeCompare(b.id, "en", { numeric: true })
      );
    });
  }
  const latest = (g: OrderGroup) => Math.max(...g.orders.map((o) => (isOpenOrder(o) ? o.createdAt : (o.filledAt ?? o.updatedAt))));
  groups.sort((a, b) => {
    if (a.openCount > 0 !== b.openCount > 0) return a.openCount > 0 ? -1 : 1;
    return latest(b) - latest(a);
  });
  return groups;
}

/** Orders to cancel so each durable nonce is advanced once (cancelling one OCO leg cancels both). */
export function cancelTargets(orders: readonly Order[]): Order[] {
  const seen = new Set<string>();
  const out: Order[] = [];
  for (const o of orders) {
    if (!isOpenOrder(o)) continue;
    if (o.ocoGroupId) {
      if (seen.has(o.ocoGroupId)) continue;
      seen.add(o.ocoGroupId);
    }
    out.push(o);
  }
  return out;
}

/** Every open order the cancels will kill: the targets plus the OCO legs that share their nonces. */
export function affectedOrders(targets: readonly Order[], all: readonly Order[]): Order[] {
  const ids = new Set(targets.map((o) => o.id));
  const groups = new Set(targets.map((o) => o.ocoGroupId).filter((g): g is string => g !== null));
  const out = [...targets];
  for (const o of all) {
    if (ids.has(o.id) || !isOpenOrder(o) || !o.ocoGroupId || !groups.has(o.ocoGroupId)) continue;
    out.push(o);
  }
  return out;
}

export function canCancel(o: Order): boolean {
  return o.status === "armed" || o.status === "stale" || o.status === "submitted";
}

export function canRearm(o: Order): boolean {
  return o.status === "stale" || o.status === "failed";
}

/** Rent held by durable-nonce accounts: 80-byte accounts at the rent-exempt minimum (1,447,680 lamports each). */
export const NONCE_RENT_SOL = 0.00144768;

/** "–" when a value is unknown (DESIGN.md 3.1). */
export const UNKNOWN = DASH;
