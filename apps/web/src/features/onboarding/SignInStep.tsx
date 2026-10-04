import { ArrowRight, Check } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { shortAddr } from "../../lib/format";
import { getServices } from "../../services";
import type { ConnectedWallet, SiwsSession } from "../../services/walletService";
import { fmtDateTime } from "../settings/format";
import { InlineError, PROVIDER_NAME, Spinner, StepActions, type StepFrame, StepHeader, useAction } from "./parts";

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
  const signed = session !== null && session.address === connected.address ? session : null;
  const domain = window.location.host;
  const wallet = PROVIDER_NAME[connected.provider];

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
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <span className="zf-label">{signed ? "Signed message" : "Message to sign"}</span>
        <span className="text-label text-fg-3">
          {wallet} · <span className="font-mono">{shortAddr(connected.address)}</span>
        </span>
      </div>
      <pre className="overflow-x-auto rounded-sm bg-surface-2 p-3 font-mono text-label font-normal whitespace-pre-wrap break-all text-fg-2">
        {signed
          ? signed.message
          : preview.map((line) => (
              <span key={line.id} className="block">
                {line.text || " "}
                {line.pending && <span className="text-fg-3">({line.pending})</span>}
              </span>
            ))}
      </pre>
      <p className="mt-3 text-body text-fg-2">This signature proves you own this wallet. It can't move funds.</p>

      {signed && (
        <p className="mt-3 flex flex-wrap items-center gap-x-2 text-data text-fg-1">
          <Check className="icon-xs" /> Signed in
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
            {busy ? `Waiting for ${wallet}` : `Sign in with ${wallet}`}
          </Button>
        )}
      </StepActions>
    </>
  );
}
