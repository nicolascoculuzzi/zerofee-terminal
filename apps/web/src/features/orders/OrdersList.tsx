import { type KeyboardEvent, memo, useCallback, useEffect, useMemo, useState } from "react";
import { Age } from "../../components/ui/Age";
import { EmptyState } from "../../components/ui/bits";
import { cn } from "../../lib/cn";
import { eventKey } from "../../lib/hotkeys";
import type { Order } from "../../protocol";
import { isOpenOrder, useOrders } from "../../state/orders";
import { useSettings } from "../../state/settings";
import { CursorBar, colW, rowClass, TABLE, TD, Th } from "../portfolio/table";
import { useRowCursor } from "../portfolio/useRowCursor";
import { DistanceCell, OrderActions, StatusCell, useTriggerText } from "./OrderCells";
import { OrderDrawer } from "./OrderDrawer";
import { startOrderLog } from "./orderLog";
import { canCancel, canRearm, groupByToken, sizeText, typeLabels } from "./orderText";
import { useOrderActions } from "./useOrderActions";

export interface OrdersListProps {
  orders: Order[];
  /** Token-page variant (DESIGN.md 4.9 "Orders"): 24/28 px rows, the short column set. */
  compact?: boolean;
}

/** Does this keydown match the user's binding for the action? Single-key bindings only ("Delete", "R"). */
function matches(e: KeyboardEvent, binding: string | undefined): boolean {
  if (!binding || binding.includes(" ") || binding.includes("+")) return false;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  return eventKey(e.nativeEvent).toLowerCase() === binding.toLowerCase();
}

const Row = memo(function Row({
  order,
  label,
  index,
  rowRef,
  cursor,
  focusWithin,
  compact,
  rearming,
  onOpen,
  onPick,
  onCancel,
  onRearm,
}: {
  order: Order;
  label: string;
  index: number;
  rowRef: (el: HTMLElement | null) => void;
  cursor: boolean;
  focusWithin: boolean;
  compact: boolean;
  rearming: boolean;
  onOpen: (order: Order) => void;
  onPick: (index: number) => void;
  onCancel: (orders: Order[]) => void;
  onRearm: (order: Order) => void;
}) {
  const trigger = useTriggerText(order);
  const muted = order.status === "cancelled";
  return (
    <tr
      ref={rowRef}
      data-row-index={index}
      tabIndex={cursor ? 0 : -1}
      onClick={(e) => {
        if (!e.currentTarget.contains(e.target as Node)) return;
        onPick(index);
        onOpen(order);
      }}
      className={cn(rowClass({ cursor: cursor && focusWithin, interactive: true }), compact ? "h-row" : "h-[calc(var(--zf-row)+4px)]")}
    >
      <td className={cn(TD, "relative")}>
        <CursorBar on={cursor && focusWithin} />
        <StatusCell order={order} />
      </td>
      <td className={cn(TD, "truncate", muted ? "text-fg-3" : "text-fg-1")}>{label}</td>
      <td className={cn(TD, "truncate", muted ? "text-fg-3" : isOpenOrder(order) ? "text-fg-1" : "text-fg-2")} title={trigger}>
        {trigger}
      </td>
      <td className={cn(TD, "text-right")}>
        <DistanceCell order={order} />
      </td>
      <td className={cn(TD, "truncate", muted ? "text-fg-3" : "text-fg-1")}>{sizeText(order)}</td>
      <td className={cn(TD, "text-right")}>
        <Age ts={order.status === "armed" ? order.updatedAt : order.createdAt} />
      </td>
      <td className={cn(TD, "text-right")}>
        <OrderActions
          order={order}
          tabbable={cursor}
          rearming={rearming}
          onCancel={() => onCancel([order])}
          onRearm={() => onRearm(order)}
          onDetails={() => onOpen(order)}
        />
      </td>
    </tr>
  );
});

/*
 * Orders for one token (DESIGN.md 4.9 "Orders", token page tab): Status (dot + label) · Type ·
 * Trigger · Distance · Size · Armed · Actions (Cancel, Re-arm). Open orders first. Clicking a row
 * opens the same 560 px drawer as the Armed orders page; with the list focused, Up/Down move,
 * Enter opens, Delete cancels (with the confirm) and R re-arms. The full grouped list lives on
 * the Armed orders page (OrdersTable).
 */
export function OrdersList({ orders, compact = false }: OrdersListProps) {
  useEffect(() => {
    startOrderLog();
  }, []);
  const byId = useOrders((s) => s.byId);
  const sorted = useMemo(() => groupByToken(orders).flatMap((g) => g.orders), [orders]);
  const labels = useMemo(() => typeLabels(Object.values(byId)), [byId]);
  const actions = useOrderActions(labels);
  const [openId, setOpenId] = useState<string | null>(null);
  const [focusWithin, setFocusWithin] = useState(false);
  const cancelKey = useSettings((s) => s.hotkeys["orders.cancel"]?.[0]);
  const rearmKey = useSettings((s) => s.hotkeys["orders.rearm"]?.[0]);
  const openOrder = useCallback((o: Order) => setOpenId(o.id), []);
  const cursor = useRowCursor(sorted.length, {
    onOpen: (i) => {
      const o = sorted[i];
      if (o) setOpenId(o.id);
    },
  });
  const drawerOrder = openId ? (byId[openId] ?? null) : null;

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    if (target.matches("[data-row-index]")) {
      const o = sorted[Number(target.dataset.rowIndex)];
      if (o && matches(e, cancelKey) && canCancel(o)) {
        e.preventDefault();
        e.stopPropagation();
        actions.requestCancel([o]);
        return;
      }
      if (o && matches(e, rearmKey) && canRearm(o)) {
        e.preventDefault();
        e.stopPropagation();
        actions.rearm(o);
        return;
      }
    }
    cursor.onKeyDown(e);
  };

  if (sorted.length === 0) {
    return <EmptyState title="No orders on this token" body="Arm a limit, take-profit or stop-loss from the trade panel." />;
  }

  const widths = [16, 12, 8, 12, 5, 19];
  return (
    <div className="min-w-0 overflow-x-auto">
      <table className={TABLE} style={{ minWidth: `calc(${widths.reduce((a, b) => a + b, 0) + 16}ch + ${7 * 16}px)` }} aria-label="Orders">
        <colgroup>
          <col style={colW(16)} />
          <col style={colW(12)} />
          <col />
          <col style={colW(8)} />
          <col style={colW(12)} />
          <col style={colW(5)} />
          <col style={colW(19)} />
        </colgroup>
        <thead>
          <tr>
            <Th>Status</Th>
            <Th>Type</Th>
            <Th>Trigger</Th>
            <Th align="right">Distance</Th>
            <Th>Size</Th>
            <Th align="right">Armed</Th>
            <Th align="right">
              <span className="sr-only">Actions</span>
            </Th>
          </tr>
        </thead>
        <tbody
          onKeyDown={onKeyDown}
          onFocus={() => setFocusWithin(true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false);
          }}
        >
          {sorted.map((o, i) => (
            <Row
              key={o.id}
              order={o}
              label={labels.get(o.id) ?? o.kind}
              index={i}
              rowRef={cursor.rowRef(i)}
              cursor={i === cursor.cursor}
              focusWithin={focusWithin}
              compact={compact}
              rearming={actions.rearming.has(o.id)}
              onOpen={openOrder}
              onPick={cursor.setCursor}
              onCancel={actions.requestCancel}
              onRearm={actions.rearm}
            />
          ))}
        </tbody>
      </table>
      <OrderDrawer
        order={drawerOrder}
        label={drawerOrder ? (labels.get(drawerOrder.id) ?? drawerOrder.kind) : ""}
        rearming={drawerOrder ? actions.rearming.has(drawerOrder.id) : false}
        onClose={() => setOpenId(null)}
        onCancel={(o) => actions.requestCancel([o])}
        onRearm={actions.rearm}
      />
      {actions.dialog}
    </div>
  );
}
