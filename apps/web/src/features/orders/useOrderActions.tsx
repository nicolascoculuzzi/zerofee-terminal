import { Loader2 } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { fmtCount, fmtSol } from "../../lib/format";
import { cancelOrder, rearmOrder } from "../../lib/tradeActions";
import type { Order } from "../../protocol";
import { useOrders } from "../../state/orders";
import { affectedOrders, canCancel, cancelTargets, canRearm, KIND_NAME } from "./orderText";

/**
 * Cancel confirm (DESIGN.md 4.17): the title names the action, the body states the consequence
 * in one sentence, and the buttons name both outcomes ("Keep orders" / "Cancel orders"), the
 * safe one focused. Delete and the row's Cancel both land here (4.20).
 */
function CancelDialog({
  orders,
  group,
  labels,
  onClose,
}: {
  orders: Order[];
  group: boolean;
  labels: Map<string, string>;
  onClose: () => void;
}) {
  const byId = useOrders((s) => s.byId);
  const [busy, setBusy] = useState(false);
  const all = useMemo(() => Object.values(byId), [byId]);
  const affected = useMemo(() => affectedOrders(orders, all), [orders, all]);
  const targets = useMemo(() => cancelTargets(orders), [orders]);
  const symbol = orders[0]?.symbol ?? "this token";
  const n = affected.length;
  const one = n === 1;
  const reserved = affected.reduce((sum, o) => sum + o.reservedSol, 0);
  const names = affected.map((o) => labels.get(o.id) ?? KIND_NAME[o.kind]);
  const shared = !group && affected.length === 2 && affected.every((o) => o.ocoGroupId && o.ocoGroupId === affected[0]?.ocoGroupId);

  const title = group || n > 2 ? `Cancel ${fmtCount(n)} armed orders for ${symbol}?` : `Cancel ${names.join(" and ")} for ${symbol}?`;
  const release = reserved > 0 ? `, and ${fmtSol(reserved)} SOL in reserve is released` : "";
  const body = shared
    ? `${names.join(" and ")} share one durable nonce, so its pre-signed cancel stops both legs from ever landing${release}.`
    : one
      ? `Its stored pre-signed cancel advances the durable nonce, so the order can never land${release}.`
      : `Each stored pre-signed cancel advances its durable nonce, so none of these orders can land${release}.`;

  const confirm = async () => {
    setBusy(true);
    try {
      // One cancel per nonce: cancelling an OCO leg already kills its sibling.
      for (const o of targets) await cancelOrder(o.id);
    } finally {
      setBusy(false);
      onClose();
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      width={400}
      title={title}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="md" onClick={onClose} data-autofocus>
            {one ? "Keep order" : "Keep orders"}
          </Button>
          <Button
            variant="sell"
            size="md"
            disabled={busy}
            icon={busy ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : undefined}
            onClick={() => void confirm()}
          >
            {one ? "Cancel order" : "Cancel orders"}
          </Button>
        </div>
      }
    >
      <p className="text-body text-fg-1">{body}</p>
    </Modal>
  );
}

export interface OrderActions {
  /** Opens the confirm for these orders (`group`: "Cancel all for WIF"). Non-cancellable ones are skipped. */
  requestCancel: (orders: Order[], group?: boolean) => void;
  rearm: (order: Order) => void;
  rearming: ReadonlySet<string>;
  /** Render once; it is the confirm dialog while one is open. */
  dialog: ReactNode;
}

export function useOrderActions(labels: Map<string, string>): OrderActions {
  const [confirm, setConfirm] = useState<{ orders: Order[]; group: boolean } | null>(null);
  const [rearming, setRearming] = useState<ReadonlySet<string>>(new Set());

  const requestCancel = useCallback((orders: Order[], group = false) => {
    const open = orders.filter(canCancel);
    if (open.length > 0) setConfirm({ orders: open, group });
  }, []);

  const rearm = useCallback((order: Order) => {
    if (!canRearm(order)) return;
    setRearming((s) => (s.has(order.id) ? s : new Set(s).add(order.id)));
    void rearmOrder(order.id).finally(() =>
      setRearming((s) => {
        const next = new Set(s);
        next.delete(order.id);
        return next;
      }),
    );
  }, []);

  const dialog = confirm ? (
    <CancelDialog orders={confirm.orders} group={confirm.group} labels={labels} onClose={() => setConfirm(null)} />
  ) : null;
  return { requestCancel, rearm, rearming, dialog };
}
