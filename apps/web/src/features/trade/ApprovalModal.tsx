import { ShieldCheck } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { WalletIcon } from "../../components/ui/WalletIcon";
import { cn } from "../../lib/cn";
import { shortAddr } from "../../lib/format";
import { useUi } from "../../state/ui";
import { useWallet } from "../../state/wallet";

/**
 * Stand-in for the external wallet's own approval popup in direct mode, sign-in and funding (Phantom,
 * Solflare, Backpack). In production the extension renders this; here it keeps those flows demonstrable
 * without a wallet installed. A 400 px confirm dialog (DESIGN.md 4.17) anchored top-right, where an
 * extension popup opens, so it never covers the dialog that asked for it. On phones, where the wallet
 * app answers in a sheet, it docks to the bottom edge full width with the two answers as equal
 * full-width buttons under the thumb, after Phantom's sheets
 * (https://mobbin.com/screens/fc1b3524-fe72-41d0-bcb6-c13b93b85436) and its review summary
 * (https://mobbin.com/screens/d1e9b056-98fc-4a66-a090-60e46c10304a).
 *
 * Anatomy after wallet request sheets: the requesting wallet's logo and account in the header and
 * "Request from <site>" (Base: https://mobbin.com/screens/ce45b0fe-6063-4083-84e5-5a6aa18750c7), the
 * request as label/value rows (Family's review: https://mobbin.com/screens/80e93094-bb2c-4b26-b433-5f90c9b84754),
 * and two buttons that name both outcomes.
 */
function SimulatedBadge({ className }: { className?: string }) {
  return (
    <span
      title="zerofee is drawing this popup because no wallet extension is installed"
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded-xs border border-warn-edge bg-warn-tint px-1 text-micro font-semibold text-warn",
        className,
      )}
    >
      Simulated
    </span>
  );
}

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
      sheetOnPhone
      label={approval ? `${provider}: ${approval.request.title}` : undefined}
      icon={<WalletIcon icon={connected?.icon} name={provider} provider={connected?.provider} size="md" />}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{approval?.request.title ?? ""}</span>
          {approval && <SimulatedBadge className="sm:hidden" />}
        </span>
      }
      description={
        <>
          {provider}
          {connected && <span className="zf-num text-fg-3"> · {shortAddr(connected.address)}</span>}
        </>
      }
      footer={
        approval && (
          <div className="flex items-center gap-2 max-sm:grid max-sm:grid-cols-2">
            <SimulatedBadge className="mr-auto max-sm:hidden" />
            <Button size="md" variant="secondary" className="max-sm:h-11 max-sm:text-body" onClick={() => approval.resolve(false)}>
              Reject
            </Button>
            <Button
              size="md"
              variant="primary"
              className="max-sm:h-11 max-sm:text-body"
              data-autofocus
              onClick={() => approval.resolve(true)}
            >
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
