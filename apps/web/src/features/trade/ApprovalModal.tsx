import { ShieldAlert } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { shortAddr } from "../../lib/format";
import { useUi } from "../../state/ui";
import { useWallet } from "../../state/wallet";

/**
 * Stand-in for the external wallet's approval popup (Phantom / Solflare / Backpack). In
 * production the extension renders this itself; here it keeps direct mode and the sign-in
 * flow demonstrable without any wallet installed.
 */
export function ApprovalModal() {
  const approval = useUi((s) => s.approval);
  const connected = useWallet((s) => s.service.connected);
  const provider = connected?.provider ?? "phantom";
  return (
    <Modal
      open={approval !== null}
      onClose={() => approval?.resolve(false)}
      bare
      width={340}
      label="Wallet approval"
      className="border-info/30"
    >
      {approval && (
        <div className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-semibold capitalize">{provider}</span>
            <span className="rounded-sm border border-warn/40 px-1 text-2xs font-semibold uppercase text-warn">Simulated popup</span>
          </div>
          <div className="mb-1 text-md font-semibold">{approval.request.title}</div>
          <div className="mb-3 text-xs text-dim">
            {window.location.host} · {connected ? shortAddr(connected.address, 4, 4) : "no wallet"}
          </div>
          <div className="space-y-1 rounded-md border border-line bg-panel-2 p-3">
            {approval.request.lines.map((l) => (
              <div key={l.label} className="flex justify-between gap-3 text-sm">
                <span className="text-muted">{l.label}</span>
                <span className="text-right font-medium">{l.value}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-start gap-1 text-2xs text-dim">
            <ShieldAlert className="icon-sm mt-px shrink-0" />
            Only approve requests you started on the canonical zerofee domain.
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Button size="md" variant="outline" onClick={() => approval.resolve(false)}>
              Reject
            </Button>
            <Button size="md" variant="primary" data-autofocus onClick={() => approval.resolve(true)}>
              Approve
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
