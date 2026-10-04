import { useState } from "react";
import { create } from "zustand";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { fmtSol } from "../../lib/format";
import { cancelOrder } from "../../lib/tradeActions";
import type { Order } from "../../protocol";
import { KIND_TEXT } from "./orderText";

/*
 * Confirm dialog for cancelling an armed order (DESIGN.md 4.17): the title names the action,
 * one sentence states the consequence, and the buttons name both outcomes. Never "Are you sure?".
 * Explicit consequence copy after Mintlify's danger zone:
 * https://mobbin.com/screens/a704b533-fd36-4209-9f6e-30f49be34cde
 */

export const useCancelDialog = create<{ order: Order | null; ask(order: Order): void; close(): void }>()((set) => ({
  order: null,
  ask: (order) => set({ order }),
  close: () => set({ order: null }),
}));

export function CancelOrderDialog() {
  const order = useCancelDialog((s) => s.order);
  const close = useCancelDialog((s) => s.close);
  const [busy, setBusy] = useState(false);
  const kind = order ? KIND_TEXT[order.kind].toLowerCase() : "";
  return (
    <Modal
      open={order !== null}
      onClose={close}
      width={400}
      title={order ? `Cancel ${kind} for ${order.symbol}?` : ""}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="md" data-autofocus onClick={close}>
            Keep order
          </Button>
          <Button
            variant="sell"
            size="md"
            disabled={busy}
            onClick={() => {
              if (!order) return;
              setBusy(true);
              void cancelOrder(order.id).finally(() => {
                setBusy(false);
                close();
              });
            }}
          >
            Cancel order
          </Button>
        </div>
      }
    >
      {order && (
        <p className="text-body text-fg-2">
          The pre-signed cancel fires now and advances the nonce
          {order.reservedSol > 0 ? `, releasing the ${fmtSol(order.reservedSol)} SOL it reserves` : ""}. To trade at this level again, arm a
          new order.
        </p>
      )}
    </Modal>
  );
}
