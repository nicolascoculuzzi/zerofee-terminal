import { ShieldCheck } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { WalletIcon } from "../../components/ui/WalletIcon";
import { shortAddr } from "../../lib/format";
import { useUi } from "../../state/ui";
import { useWallet } from "../../state/wallet";

/**
 * Stand-in for the external wallet's own approval popup in direct mode, sign-in and funding (Phantom,
 * Solflare, Backpack). In production the extension renders this; here it keeps those flows demonstrable
 * without a wallet installed. A 400 px confirm dialog (DESIGN.md 4.17) anchored top-right, where an
 * extension popup opens, so it never covers the dialog that asked for it.
 *
 * Anatomy after wallet request sheets: the requesting wallet's logo and account in the header and
 * "Request from <site>" (Base: https://mobbin.com/screens/ce45b0fe-6063-4083-84e5-5a6aa18750c7), the
 * request as label/value rows (Family's review: https://mobbin.com/screens/80e93094-bb2c-4b26-b433-5f90c9b84754),
 * and two buttons that name both outcomes.
 */
export function ApprovalModal() {
  const approval = useUi((s) => s.approval);
  const connected = useWallet((s) => s.service.connected);
  const provider = connected?.name ?? "Wallet";
  const host = window.location.host;
  return (
    <Modal
      open={approval !== null}
      onClose={() => approval?.resolve(false)}
      width={400}
      placement="top-end"
      label={approval ? `${provider}: ${approval.request.title}` : undefined}
      icon={<WalletIcon icon={connected?.icon} name={provider} provider={connected?.provider} size="md" />}
      title={approval?.request.title ?? ""}
      description={
        <>
          {provider}
          {connected && <span className="zf-num text-fg-3"> · {shortAddr(connected.address)}</span>}
        </>
      }
      footer={
        approval && (
          <div className="flex items-center gap-2">
            <span
              title="zerofee is drawing this popup because no wallet extension is installed"
              className="mr-auto inline-flex h-4 items-center rounded-xs border border-warn-edge bg-warn-tint px-1 text-micro font-semibold text-warn"
            >
              Simulated
            </span>
            <Button size="md" variant="secondary" onClick={() => approval.resolve(false)}>
              Reject
            </Button>
            <Button size="md" variant="primary" data-autofocus onClick={() => approval.resolve(true)}>
              Approve
            </Button>
          </div>
        )
      }
    >
      {approval && (
        <div className="space-y-3">
          <div className="overflow-hidden rounded-md border border-hairline bg-surface-1">
            <div className="flex h-8 items-center justify-between gap-3 border-b border-hairline px-3">
              <span className="text-data font-medium text-fg-2">Request from</span>
              <span className="truncate font-mono text-label text-fg-1">{host}</span>
            </div>
            <dl>
              {approval.request.lines.map((l) => (
                <div
                  key={l.label}
                  className="flex min-h-8 items-center justify-between gap-4 border-hairline px-3 py-1.5 not-first:border-t"
                >
                  <dt className="shrink-0 text-data text-fg-3">{l.label}</dt>
                  <dd className="zf-num min-w-0 text-right text-data text-fg-1">{l.value}</dd>
                </div>
              ))}
            </dl>
          </div>
          <p className="flex items-start gap-1.5 text-label text-fg-3">
            <ShieldCheck className="icon-xs mt-0.5 shrink-0" />
            Approve only requests you started on {host}.
          </p>
        </div>
      )}
    </Modal>
  );
}
