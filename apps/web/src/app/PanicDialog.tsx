import { useState } from "react";
import { Button } from "../components/ui/Button";
import { HoldButton } from "../components/ui/HoldButton";
import { Modal } from "../components/ui/Modal";
import { fmtCount, fmtSol } from "../lib/format";
import { panic } from "../lib/tradeActions";
import { isOpenOrder, useOrders } from "../state/orders";
import { useUi } from "../state/ui";
import { useWallet } from "../state/wallet";

/**
 * Panic (DESIGN.md 1.7, 4.17, 4.20): one confirm dialog for the whole app (Orders page,
 * Settings danger zone, Cmd+Shift+Backspace, palette). The action needs a 1 s hold, and both
 * outcomes are named: "Keep orders" or "Hold to cancel all and lock".
 */
export function PanicDialog() {
  const open = useUi((s) => s.panicOpen);
  const close = useUi((s) => s.closePanic);
  const openCount = useOrders((s) => Object.values(s.byId).filter(isOpenOrder).length);
  const reservedSol = useWallet((s) => (s.activeAddress ? (s.status[s.activeAddress]?.reservedSol ?? 0) : 0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await panic();
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      width={400}
      title={`Cancel ${openCount === 1 ? "1 armed order" : `${fmtCount(openCount)} armed orders`} and lock?`}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="md" onClick={close} data-autofocus>
            Keep orders
          </Button>
          <HoldButton onConfirm={() => void confirm()} disabled={busy}>
            {busy ? "Cancelling…" : "Hold to cancel all and lock"}
          </HoldButton>
        </div>
      }
    >
      <p className="text-body text-fg-1">
        Every armed order is cancelled with its stored pre-signed cancel. Their nonces advance, so the signed transactions can never land.
      </p>
      <dl className="mt-3 overflow-hidden rounded-md border border-hairline bg-surface-1">
        {[
          ["Armed orders", `${fmtCount(openCount)} cancelled`],
          ["Reserved", `${fmtSol(reservedSol)} SOL spendable again`],
          ["Keystore", "Locked"],
        ].map(([label, value]) => (
          <div key={label} className="flex h-8 items-center justify-between gap-4 border-hairline px-3 not-first:border-t">
            <dt className="text-data text-fg-3">{label}</dt>
            <dd className="zf-num text-data text-fg-1">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-label text-fg-3">To trade again, unlock and re-arm what you still want.</p>
      {error && (
        <p role="alert" className="mt-3 text-label text-sell">
          {error}
        </p>
      )}
    </Modal>
  );
}
