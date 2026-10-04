import { ArrowRight, Check, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { WalletBadge } from "../../components/ui/WalletIcon";
import { shortAddr } from "../../lib/format";
import { getServices } from "../../services";
import type { ConnectedWallet, SiwsSession } from "../../services/walletService";
import { fmtDateTime } from "../settings/format";
import { InlineError, Panel, Spinner, StepActions, type StepFrame, StepHeader, useAction } from "./parts";

const STATEMENT = "Sign in to zerofee. This request will not trigger a transaction or cost any fees.";
/** Preview only; the signed session carries the real expiry. */
const PREVIEW_SESSION_MS = 8 * 3_600_000;

/*
 * Sign in (DESIGN.md 4.19 step 2): the exact SIWS message in a mono block (surface-2, 4 px
 * radius, 12 px padding, mono 11/400 text-2) and one primary action. Message review with the
 * signing address after Base: https://mobbin.com/screens/ce45b0fe-6063-4083-84e5-5a6aa18750c7
 */
export function SignInStep({
  frame,
  connected,
  session,
  onBusyChange,
  onSigned,
  onNext,
}: {
  frame: StepFrame;
  connected: ConnectedWallet;
  session: SiwsSession | null;
  onBusyChange: (busy: boolean) => void;
  onSigned: (session: SiwsSession) => void;
  onNext: () => void;
}) {
  const { busy, error, run } = useAction(onBusyChange);
  const [previewAt] = useState(() => Date.now());
  const signed = session !== null && session.address === connected.address && session.message ? session : null;
  // The live server issues the nonce: show the exact text the wallet will be asked to sign.
  const [exact, setExact] = useState<string | null>(null);
  useEffect(() => {
    const preview = getServices().wallet.previewSignIn;
    if (!preview || signed) return;
    let live = true;
    preview
      .call(getServices().wallet)
      .then((text) => live && setExact(text))
      .catch(() => live && setExact(null));
    return () => {
      live = false;
    };
  }, [signed]);
  const domain = window.location.host;

  const preview: { id: string; text: string; pending?: string }[] = [
    { id: "head", text: `${domain} wants you to sign in with your Solana account:` },
    { id: "address", text: connected.address },
    { id: "gap1", text: "" },
    { id: "statement", text: STATEMENT },
    { id: "gap2", text: "" },
    { id: "uri", text: `URI: ${window.location.origin}` },
    { id: "version", text: "Version: 1" },
    { id: "chain", text: "Chain ID: mainnet" },
    { id: "nonce", text: "Nonce: ", pending: "issued by the server when you sign" },
    { id: "issued", text: `Issued At: ${new Date(previewAt).toISOString()}` },
    { id: "expires", text: `Expiration Time: ${new Date(previewAt + PREVIEW_SESSION_MS).toISOString()}` },
  ];

  const sign = async () => {
    const res = await run(() => getServices().wallet.signIn());
    if (res.ok) onSigned(res.value);
  };

  return (
    <>
      <StepHeader frame={frame} />
      <Panel>
        <div className="flex h-9 items-center justify-between gap-2 border-b border-hairline bg-surface-2 px-3">
          <span className="text-label font-medium text-fg-2">{signed ? "Signed message" : "Message to sign"}</span>
          <span className="inline-flex min-w-0 items-center gap-1.5 text-label text-fg-3">
            <WalletBadge wallet={connected} className="text-fg-2" />
            <span className="font-mono">{shortAddr(connected.address)}</span>
          </span>
        </div>
        <pre className="max-h-64 overflow-auto p-3 font-mono text-label font-normal whitespace-pre-wrap break-all text-fg-2">
          {signed
            ? signed.message
            : exact !== null
              ? exact
              : preview.map((line) => (
                  <span key={line.id} className="block">
                    {line.text || " "}
                    {line.pending && <span className="text-fg-3">({line.pending})</span>}
                  </span>
                ))}
        </pre>
      </Panel>
      <p className="mt-3 flex gap-2 text-label text-fg-3">
        <ShieldCheck className="icon-xs mt-px shrink-0" />
        This signature proves you own this wallet. It can't move funds or approve a transaction.
      </p>

      {signed && (
        <p className="mt-4 flex flex-wrap items-center gap-x-2 text-data text-fg-1">
          <Check className="icon-xs text-buy" /> Signed in
          <span className="text-fg-3">· session until {fmtDateTime(signed.expiresAt)}</span>
        </p>
      )}
      {error && <InlineError>{error.replace(/\.$/, "")}. Nothing was signed.</InlineError>}

      <StepActions>
        {signed ? (
          <Button size="xl" variant="primary" onClick={onNext}>
            Continue to the trading wallet <ArrowRight />
          </Button>
        ) : (
          <Button size="xl" variant="primary" disabled={busy} onClick={() => void sign()}>
            {busy && <Spinner />}
            {busy ? `Waiting for ${connected.name}` : `Sign in with ${connected.name}`}
          </Button>
        )}
      </StepActions>
    </>
  );
}
