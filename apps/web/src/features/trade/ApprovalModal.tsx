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
            <span className="text-xs font-semibold capitalize">{provider}</span>
            <span className="rounded bg-warn/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-warn">Simulated popup</span>
          </div>
          <div className="mb-1 text-sm font-semibold">{approval.request.title}</div>
          <div className="mb-3 text-[11px] text-dim">
            {window.location.host} · {connected ? shortAddr(connected.address, 4, 4) : "no wallet"}
          </div>
          <div className="space-y-1 rounded-md border border-line bg-panel-2 p-2.5">
            {approval.request.lines.map((l) => (
              <div key={l.label} className="flex justify-between gap-3 text-xs">
                <span className="text-muted">{l.label}</span>
                <span className="text-right font-medium">{l.value}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-start gap-1.5 text-[10px] text-dim">
            <ShieldAlert size={12} className="mt-px shrink-0" />
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
