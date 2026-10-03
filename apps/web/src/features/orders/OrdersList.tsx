import { Check, Link2, Monitor, RotateCw, ShieldCheck, X } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { Link } from "react-router";
import { Age } from "../../components/ui/Age";
import { Button } from "../../components/ui/Button";
import { EmptyState, ExplorerLink } from "../../components/ui/bits";
import { Segmented } from "../../components/ui/controls";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import { fmtCount, fmtSol } from "../../lib/format";
import { cancelOrder, rearmOrder } from "../../lib/tradeActions";
import type { Order, OrderStatus } from "../../protocol";
import { useMarket } from "../../state/market";
import { isOpenOrder } from "../../state/orders";
import { useLongList } from "../portfolio/helpers";
import {
  compareOrders,
  currentText,
  distanceText,
  FILTER_TEST,
  fillText,
  groupOrders,
  KIND_LABEL,
  LANDING_LABEL,
  nonceText,
  type OrderFilter,
  type OrderGroup,
  STATUS_LABEL,
  sizeText,
  triggerText,
  variantsText,
} from "./orderText";

export interface OrdersListProps {
  orders: Order[];
  /** Token-page variant: tighter rows, no column header, execution details folded away. */
  compact?: boolean;
}

const BADGE = "inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border px-1 text-2xs font-medium";
const BADGE_NEUTRAL = "border-line text-dim";

/** State colours only: info = armed/pending, warn = needs attention, sell = failed. */
const STATUS_STYLE: Record<OrderStatus, string> = {
  armed: "border-info/30 bg-info/10 text-info",
  submitted: "border-info/30 bg-info/10 text-info",
  filled: "border-line-strong bg-elev text-fg",
  stale: "border-warn/30 bg-warn/10 text-warn",
  failed: "border-sell/30 bg-sell/10 text-sell",
  cancelled: BADGE_NEUTRAL,
};

function StatusBadge({ status }: { status: OrderStatus }) {
  return (
    <span className={cn(BADGE, STATUS_STYLE[status])}>
      {status === "submitted" && <span className="zf-live-dot size-1 rounded-full bg-info" />}
      {status === "filled" && <Check className="icon-xs" />}
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Low risk (runs unattended) in buy green, needs-attention (browser must stay open) in warn. */
function SafetyBadge({ order, muted }: { order: Order; muted: boolean }) {
  if (order.runsWithTabClosed) {
    return (
      <span className={cn(BADGE, muted ? BADGE_NEUTRAL : "border-buy/30 bg-buy/10 text-buy")}>
        <ShieldCheck className="icon-xs" />
        Safe to close tab
      </span>
    );
  }
  return (
    <Tooltip content={order.needsBrowserReason ?? "This browser builds and signs the transaction when the order fires."}>
      <button type="button" className={cn(BADGE, "cursor-help", muted ? BADGE_NEUTRAL : "border-warn/30 bg-warn/10 text-warn")}>
        <Monitor className="icon-xs" />
        Needs browser open
      </button>
    </Tooltip>
  );
}

/** Live value of the metric an open order watches, while its token is in the live set. */
function useWatchedValue(order: Order): number | null {
  const { mint } = order;
  const metric = order.trigger.metric;
  const watch = mint !== null && isOpenOrder(order) && (metric === "mc" || metric === "price" || metric === "migration");
  return useMarket((s) => {
    if (!watch || mint === null) return null;
    const t = s.tokens[mint];
    if (!t) return null;
    if (metric === "mc") return t.marketCapUsd;
    if (metric === "price") return t.priceSol;
    return t.migratedAt !== null ? 1 : t.bondingProgress;
  });
}

const OrderRow = memo(function OrderRow({ order, compact }: { order: Order; compact: boolean }) {
  const open = isOpenOrder(order);
  const current = useWatchedValue(order);
  const [busy, setBusy] = useState<"rearm" | "cancel" | null>(null);
  const canRearm = order.status === "stale" || order.status === "failed";
  const canCancel = order.status === "armed" || order.status === "stale" || order.status === "submitted";
  const distance = current === null ? null : distanceText(order, current);
  const fill = fillText(order);

  const run = (kind: "rearm" | "cancel") => {
    setBusy(kind);
    void (kind === "rearm" ? rearmOrder(order.id) : cancelOrder(order.id)).finally(() => setBusy(null));
  };

  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2">
      <div className={cn("flex min-w-0 flex-col", compact ? "w-28" : "w-32 xl:w-36")}>
        {order.mint ? (
          <Link to={`/t/${order.mint}`} className="truncate text-sm font-medium text-fg hover:underline">
            {order.symbol}
          </Link>
        ) : (
          <span className="truncate text-sm font-medium text-fg">{order.symbol}</span>
        )}
        <span className={cn("text-xs", order.side === "buy" ? "text-buy" : "text-sell")}>{KIND_LABEL[order.kind]}</span>
      </div>

      <div className={cn("flex min-w-0 flex-col", compact ? "w-40" : "w-44")}>
        <span className="truncate text-sm">{triggerText(order.trigger)}</span>
        {current !== null && (
          <span className="truncate text-xs text-dim" title={distance ? `Now ${currentText(order, current)}, ${distance}` : undefined}>
            {currentText(order, current)}
            {distance && ` · ${distance}`}
          </span>
        )}
      </div>

      <div className="flex w-16 flex-col xl:items-end">
        <span className="text-sm">{sizeText(order.size)}</span>
        <span className="text-xs text-dim">{order.size.kind === "pct" ? "of holding" : order.side === "buy" ? "to spend" : "to sell"}</span>
      </div>

      <div className="flex min-w-48 flex-1 flex-col items-start gap-1">
        <div className="flex flex-wrap items-center gap-1">
          <StatusBadge status={order.status} />
          {compact && <SafetyBadge order={order} muted={!open} />}
        </div>
        {order.statusReason && (
          <p className={cn("text-xs text-muted", compact && "max-w-full truncate")} title={order.statusReason}>
            {order.statusReason}
          </p>
        )}
        {fill && (
          <p className="flex flex-wrap items-center gap-1 text-xs">
            <span>{fill}</span>
            {order.filledAt !== null && (
              <span className="text-dim">
                <Age ts={order.filledAt} /> ago
              </span>
            )}
            {order.signature && <ExplorerLink signature={order.signature} />}
          </p>
        )}
      </div>

      {!compact && (
        <>
          <div className="flex w-44 flex-col items-start gap-1">
            <SafetyBadge order={order} muted={!open} />
            <span className="text-xs text-dim">
              <span className={order.landing === "fast" ? "text-warn" : undefined}>{LANDING_LABEL[order.landing]}</span> ·{" "}
              {variantsText(order)}
            </span>
          </div>
          <div className="flex w-28 flex-col xl:items-end">
            <span className={cn("text-sm", !open && "text-dim")} title={open ? "Held back from your available balance" : undefined}>
              {open ? `${fmtSol(order.reservedSol)} SOL` : "released"}
            </span>
            <span className="text-xs text-dim">{nonceText(order)}</span>
          </div>
          <div className="flex w-20 flex-col text-xs text-dim xl:items-end">
            <span title={`Created ${new Date(order.createdAt).toLocaleString()}`}>
              created <Age ts={order.createdAt} />
            </span>
            {order.updatedAt > order.createdAt + 1000 && (
              <span title={`Updated ${new Date(order.updatedAt).toLocaleString()}`}>
                updated <Age ts={order.updatedAt} />
              </span>
            )}
          </div>
        </>
      )}

      <div className={cn("ml-auto flex items-center justify-end gap-1", !compact && "w-36")}>
        {canRearm && (
          <Button size="sm" variant="outline" icon={<RotateCw className="icon-sm" />} disabled={busy !== null} onClick={() => run("rearm")}>
            {busy === "rearm" ? "Re-arming…" : "Re-arm"}
          </Button>
        )}
        {canCancel && (
          <Button size="sm" variant="ghost" icon={<X className="icon-sm" />} disabled={busy !== null} onClick={() => run("cancel")}>
            {busy === "cancel" ? "Cancelling…" : "Cancel"}
          </Button>
        )}
      </div>
    </div>
  );
});

type ListItem = { kind: "section"; key: string; label: string; count: number } | { kind: "group"; key: string; group: OrderGroup };

const ListRow = memo(function ListRow({
  item,
  index,
  measure,
  compact,
}: {
  item: ListItem;
  index: number;
  measure: (el: Element | null) => void;
  compact: boolean;
}) {
  if (item.kind === "section") {
    return (
      <div data-index={index} ref={measure} className="zf-label flex h-row items-center gap-2 border-b border-line bg-panel-2 px-3">
        {item.label}
        <span>{fmtCount(item.count)}</span>
      </div>
    );
  }
  const { group } = item;
  if (!group.oco) {
    const order = group.orders[0];
    return (
      <div data-index={index} ref={measure} className="border-b border-line last:border-b-0">
        {order && <OrderRow order={order} compact={compact} />}
      </div>
    );
  }
  return (
    <div data-index={index} ref={measure} className="border-b border-line bg-panel-2 last:border-b-0">
      <div className="flex h-6 items-center gap-2 px-3 text-2xs text-dim">
        <Link2 className="icon-xs" />
        <span className="font-medium uppercase tracking-wide text-muted">OCO pair</span>
        <span className="truncate">one shared durable nonce: once either leg lands, the other can't</span>
      </div>
      <div className="divide-y divide-line">
        {group.orders.map((o) => (
          <OrderRow key={o.id} order={o} compact={compact} />
        ))}
      </div>
    </div>
  );
});

const FILTERS: { value: OrderFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "rearm", label: "Needs re-arm" },
  { value: "history", label: "History" },
];

const EMPTY_TEXT: Record<OrderFilter, string> = {
  all: "No armed orders yet. Arm a limit, TP/SL or migration order from a token page.",
  open: "No open orders.",
  rearm: "Nothing needs re-arming.",
  history: "No filled, failed or cancelled orders yet.",
};

function buildItems(orders: Order[], filter: OrderFilter): ListItem[] {
  const groups = groupOrders(orders.filter(FILTER_TEST[filter]).sort(compareOrders));
  const asItems = (list: OrderGroup[]): ListItem[] => list.map((group) => ({ kind: "group", key: group.key, group }));
  if (filter !== "all") return asItems(groups);
  const items: ListItem[] = [];
  const open = groups.filter((g) => g.open);
  const done = groups.filter((g) => !g.open);
  const count = (list: OrderGroup[]) => list.reduce((n, g) => n + g.orders.length, 0);
  if (open.length > 0) items.push({ kind: "section", key: "section:open", label: "Open", count: count(open) }, ...asItems(open));
  if (done.length > 0) items.push({ kind: "section", key: "section:history", label: "History", count: count(done) }, ...asItems(done));
  return items;
}

/** Column labels for the one-line row layout at xl widths (rows wrap into cards below that). */
function ColumnHeader() {
  return (
    <div
      aria-hidden="true"
      className="hidden h-row items-center gap-x-3 border-b border-line px-3 text-2xs uppercase tracking-wide text-dim xl:flex"
    >
      <span className="w-36">Order</span>
      <span className="w-44">Trigger</span>
      <span className="w-16 text-right">Size</span>
      <span className="min-w-48 flex-1">Status</span>
      <span className="w-44">Execution</span>
      <span className="w-28 text-right">Reserved</span>
      <span className="w-20 text-right">Age</span>
      <span className="ml-auto w-36" />
    </div>
  );
}

/*
 * Armed orders list. Anatomy follows Coinbase Advanced's order management (status filters,
 * dense uppercase columns, muted finished states) https://mobbin.com/screens/e8bc99dd-2b98-4b12-95b3-5ca277255b09
 * and Binance's order history with its "Trigger Conditions" column
 * https://mobbin.com/screens/ea42228b-3ad4-479d-90b1-0e8cfc9a75bf ; distance to trigger after
 * Airwallex's "% from current rate" https://mobbin.com/screens/c8f4246b-e31c-4ad1-98a3-db3ff20ac970
 *
 * Open orders first (armed, submitted, stale), then history (filled, failed, cancelled), newest
 * first; OCO legs that share a nonce are grouped. Reused by the token page for one token.
 */
export function OrdersList({ orders, compact = false }: OrdersListProps) {
  const [filter, setFilter] = useState<OrderFilter>("all");
  const counts = useMemo(() => {
    const c: Record<OrderFilter, number> = { all: 0, open: 0, rearm: 0, history: 0 };
    for (const o of orders) {
      c.all++;
      if (isOpenOrder(o)) c.open++;
      else c.history++;
      if (o.status === "stale") c.rearm++;
    }
    return c;
  }, [orders]);
  const items = useMemo(() => buildItems(orders, filter), [orders, filter]);
  const list = useLongList(items, (item) => item.key, compact ? 56 : 72);

  return (
    <div className="min-w-0">
      <div className="flex min-h-8 flex-wrap items-center gap-2 border-b border-line px-3 py-1">
        <Segmented<OrderFilter>
          value={filter}
          onChange={setFilter}
          size={compact ? "xs" : "sm"}
          label="Filter orders"
          options={FILTERS.map((f) => ({
            value: f.value,
            label: (
              <span className={cn(f.value === "rearm" && counts.rearm > 0 && filter !== "rearm" && "text-warn")}>
                {f.label} <span className="text-dim">{fmtCount(counts[f.value])}</span>
              </span>
            ),
          }))}
        />
      </div>
      {items.length === 0 ? (
        <EmptyState title={EMPTY_TEXT[filter]} />
      ) : (
        <>
          {!compact && <ColumnHeader />}
          <div ref={list.scrollRef} className={cn(list.virtual && "max-h-160 overflow-y-auto")}>
            <div style={list.virtual ? { paddingTop: list.padTop, paddingBottom: list.padBottom } : undefined}>
              {list.rows.map(({ item, index }) => (
                <ListRow key={item.key} item={item} index={index} measure={list.measure} compact={compact} />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
