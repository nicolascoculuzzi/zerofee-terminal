import { Check } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { Link } from "react-router";
import { Age } from "../../components/ui/Age";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/bits";
import { Num } from "../../components/ui/Num";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import { DASH, fmtClock, fmtMs, fmtPct } from "../../lib/format";
import { rearmOrder } from "../../lib/tradeActions";
import type { Order, TokenSummary } from "../../protocol";
import { isOpenOrder, useOrders } from "../../state/orders";
import { triggerParts, triggerText } from "../orders/orderText";
import { useCancelDialog } from "./CancelOrderDialog";
import { useQuote } from "./money";
import { distanceToTrigger, KIND_TEXT, STATUS_TEXT, type StatusTone, sizeText } from "./orderText";
import { type Col, ch, DataTable, flex } from "./table";

/*
 * Orders tab (DESIGN.md 4.9 "Orders", statuses per 4.20): status dot + label · type · trigger in
 * words · distance (signed, text-2: a distance is not PnL) · size · armed age · Cancel (danger xs,
 * with a confirm) and Re-arm (secondary xs). Status dot plus label after Vercel:
 * https://mobbin.com/screens/e9576405-bcef-419a-922a-8fb84b044a54
 */

type Key = "status" | "type" | "trigger" | "distance" | "size" | "armed" | "actions";

const COLS: Col<Key>[] = [
  { key: "status", label: "Status", width: ch(16) },
  { key: "type", label: "Type", width: ch(12) },
  { key: "trigger", label: "Trigger", width: flex(16) },
  { key: "distance", label: "Distance", width: ch(8), align: "right" },
  { key: "size", label: "Size", width: ch(12), align: "right" },
  { key: "armed", label: "Armed", width: ch(5), align: "right" },
  { key: "actions", label: "", width: ch(16), align: "right" },
];

const DOT: Record<StatusTone, string> = {
  info: "bg-info",
  warn: "bg-warn",
  sell: "bg-sell",
  done: "",
  off: "bg-fg-4",
};

function Status({ order }: { order: Order }) {
  const s = STATUS_TEXT[order.status];
  if (order.status === "filled") {
    return (
      <span className="flex items-center gap-1.5 text-fg-1" title={order.filledAt ? fmtClock(order.filledAt) : undefined}>
        <Check className="icon-xs" />
        Filled
        {order.fillLatencyMs !== null && <span className="zf-num text-fg-2">{fmtMs(order.fillLatencyMs)}</span>}
      </span>
    );
  }
  const label = (
    <span className={cn("flex items-center gap-1.5", order.status === "cancelled" ? "text-fg-4" : "text-fg-1")}>
      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", DOT[s.tone])} />
      {s.label}
      {order.status === "submitted" && <Age ts={order.updatedAt} className="text-fg-3" />}
    </span>
  );
  return order.statusReason ? <Tooltip content={order.statusReason}>{label}</Tooltip> : label;
}

export function TokenOrders({ token }: { token: TokenSummary }) {
  const byId = useOrders((s) => s.byId);
  const ask = useCancelDialog((s) => s.ask);
  const { quote, solUsd } = useQuote();
  const orders = useMemo(() => {
    const list = Object.values(byId).filter((o) => o.mint === token.mint);
    return list.sort((a, b) => {
      const ao = isOpenOrder(a);
      const bo = isOpenOrder(b);
      if (ao !== bo) return ao ? -1 : 1;
      return b.createdAt - a.createdAt;
    });
  }, [byId, token.mint]);

  if (orders.length === 0) {
    return (
      <EmptyState
        title="No orders on this token"
        body="Arm a limit, take-profit or stop-loss from the trade panel. Armed orders run with this tab closed."
      />
    );
  }

  const current = { mcUsd: token.marketCapUsd, priceSol: token.priceSol };
  const ctx = { quote, solUsd, supply: token.supply };
  const content = (o: Order, key: Key): ReactNode => {
    switch (key) {
      case "status":
        return <Status order={o} />;
      case "type":
        return <span className="text-fg-2">{KIND_TEXT[o.kind]}</span>;
      case "trigger": {
        const t = triggerParts(o, ctx);
        return (
          <span className="truncate text-fg-1" title={triggerText(o, ctx)}>
            {t.kind === "text" ? (
              t.text
            ) : (
              <>
                {t.words} <Num value={t.priceSol} kind="price" unit="SOL" />
              </>
            )}
          </span>
        );
      }
      case "distance": {
        const d = isOpenOrder(o) ? distanceToTrigger(o, current) : null;
        return d === null ? (
          <span className="text-fg-4">{DASH}</span>
        ) : (
          <span className="zf-num text-fg-2">{fmtPct(d, { signed: true })}</span>
        );
      }
      case "size":
        return <span className="text-fg-1">{sizeText(o)}</span>;
      case "armed":
        return <Age ts={o.createdAt} />;
      case "actions":
        return (
          <span className="flex items-center gap-1">
            {(o.status === "stale" || o.status === "failed") && (
              <Button variant="secondary" size="xs" onClick={() => void rearmOrder(o.id)}>
                Re-arm
              </Button>
            )}
            {isOpenOrder(o) && (
              <Button variant="danger" size="xs" onClick={() => ask(o)}>
                Cancel
              </Button>
            )}
          </span>
        );
    }
  };

  return (
    <div className="h-full overflow-auto">
      <DataTable label={`Orders for ${token.symbol}`} minWidth={720} cols={COLS} rows={orders} rowKey={(o) => o.id} cell={content} />
      <div className="flex h-row items-center px-2 text-label text-fg-3">
        <Link to="/orders" className="hover:text-fg-1">
          All armed orders
        </Link>
      </div>
    </div>
  );
}

/** Open orders on this token, for the tab count. */
export function useOpenOrderCount(mint: string): number {
  const byId = useOrders((s) => s.byId);
  return useMemo(() => Object.values(byId).filter((o) => o.mint === mint && isOpenOrder(o)).length, [byId, mint]);
}
