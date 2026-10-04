import { ShieldAlert } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { shortAddr } from "../../lib/format";
import { useUi } from "../../state/ui";
import { useWallet } from "../../state/wallet";

const PROVIDER: Record<string, string> = { phantom: "Phantom", solflare: "Solflare", backpack: "Backpack" };

/**
 * Stand-in for the external wallet's own approval popup in direct mode (Phantom, Solflare,
 * Backpack). In production the extension renders this; here it keeps direct mode and sign-in
 * demonstrable without a wallet installed. A 400 px confirm dialog per DESIGN.md 4.17; the
 * buttons name both outcomes.
 */
export function ApprovalModal() {
  const approval = useUi((s) => s.approval);
  const connected = useWallet((s) => s.service.connected);
  const provider = PROVIDER[connected?.provider ?? "phantom"] ?? "Wallet";
  return (
    <Modal
      open={approval !== null}
      onClose={() => approval?.resolve(false)}
      width={400}
      title={approval?.request.title ?? ""}
      description={`${provider} · ${window.location.host} · ${connected ? shortAddr(connected.address) : "no wallet"}`}
      footer={
        approval && (
          <div className="flex items-center justify-end gap-2">
            <Button size="md" variant="secondary" onClick={() => approval.resolve(false)}>
              Reject request
            </Button>
            <Button size="md" variant="primary" data-autofocus onClick={() => approval.resolve(true)}>
              Approve in {provider}
            </Button>
          </div>
        )
      }
    >
      {approval && (
        <div className="space-y-3">
          <span className="inline-flex h-4 items-center rounded-xs bg-warn-tint px-1 text-micro font-semibold text-warn">
            Simulated wallet popup
          </span>
          <dl className="divide-y divide-hairline rounded-sm border border-hairline">
            {approval.request.lines.map((l) => (
              <div key={l.label} className="flex h-7 items-center justify-between gap-3 px-2 text-data">
                <dt className="text-fg-3">{l.label}</dt>
                <dd className="zf-num text-right text-fg-1">{l.value}</dd>
              </div>
            ))}
          </dl>
          <p className="flex items-start gap-1 text-label text-fg-3">
            <ShieldAlert className="icon-xs mt-px shrink-0" />
            Only approve requests you started on the canonical zerofee domain.
          </p>
        </div>
      )}
    </Modal>
  );
}
