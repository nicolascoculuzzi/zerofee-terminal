import { ArrowRight, CircleCheck, PenLine } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { shortAddr } from "../../lib/format";
import { getServices } from "../../services";
import type { ConnectedWallet, SiwsSession } from "../../services/walletService";
import { fmtDateTime } from "../settings/format";
import { Note } from "../settings/ui";
import { InlineError, StepFooter, type StepFrame, StepPanel, useAction } from "./parts";

const STATEMENT = "Sign in to zerofee. This request will not trigger a transaction or cost any fees.";
/** Preview only; the signed session carries the real expiry. */
const PREVIEW_SESSION_MS = 8 * 3_600_000;

interface PreviewLine {
  id: string;
  text: string;
  placeholder?: string;
}

/*
 * Sign-In With Solana. The message block follows Base's sign-in review (monospace message,
 * "Signing with" address, one primary action):
 * https://mobbin.com/screens/ce45b0fe-6063-4083-84e5-5a6aa18750c7
 */
export function SignInStep({
  frame,
  connected,
  session,
  onBusyChange,
  onSigned,
  onBack,
  onNext,
}: {
  frame: StepFrame;
  connected: ConnectedWallet;
  session: SiwsSession | null;
  onBusyChange: (busy: boolean) => void;
  onSigned: (session: SiwsSession) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const { busy, error, run } = useAction(onBusyChange);
  const [previewAt] = useState(() => Date.now());
  const signed = session !== null && session.address === connected.address ? session : null;
  const domain = window.location.host;

  const lines: PreviewLine[] = [
    { id: "head", text: `${domain} wants you to sign in with your Solana account:` },
    { id: "address", text: connected.address },
    { id: "gap1", text: "" },
    { id: "statement", text: STATEMENT },
    { id: "gap2", text: "" },
    { id: "uri", text: `URI: ${window.location.origin}` },
    { id: "version", text: "Version: 1" },
    { id: "chain", text: "Chain ID: mainnet" },
    { id: "nonce", text: "Nonce: ", placeholder: "<one-time nonce from the server>" },
    { id: "issued", text: `Issued At: ${new Date(previewAt).toISOString()}` },
    { id: "expires", text: `Expiration Time: ${new Date(previewAt + PREVIEW_SESSION_MS).toISOString()}` },
  ];

  const sign = async () => {
    const res = await run(() => getServices().wallet.signIn());
    if (res.ok) onSigned(res.value);
  };

  return (
    <StepPanel
      {...frame}
      footer={
        <StepFooter onBack={onBack} backDisabled={busy}>
          {signed ? (
            <Button size="lg" variant="primary" onClick={onNext}>
              Continue <ArrowRight className="icon-md" />
            </Button>
          ) : (
            <Button size="lg" variant="primary" icon={<PenLine className="icon-md" />} disabled={busy} onClick={() => void sign()}>
              {busy ? "Waiting for wallet…" : error ? "Try again" : "Sign message"}
            </Button>
          )}
        </StepFooter>
      }
    >
      <div>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <span className="zf-label">{signed ? "Signed message" : "Message preview"}</span>
          <span className="text-label text-fg-3">Signing with {shortAddr(connected.address, 4, 4)}</span>
        </div>
        <pre className="overflow-x-auto rounded-sm border border-hairline bg-bg p-3 font-mono text-label whitespace-pre-wrap break-all text-fg-1">
          {signed
            ? signed.message
            : lines.map((line) => (
                <span key={line.id} className="block">
                  {line.text || " "}
                  {line.placeholder && <span className="text-fg-3">{line.placeholder}</span>}
                </span>
              ))}
        </pre>
      </div>

      {signed ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-data">
          <CircleCheck className="icon-sm text-buy" />
          <span className="text-fg-1">Signed in</span>
          <span className="text-fg-2">· session expires {fmtDateTime(signed.expiresAt)}</span>
          <span className="font-mono text-label text-fg-3">signature {shortAddr(signed.signature, 6, 6)}</span>
        </div>
      ) : (
        <Note tone="info">
          <ul className="space-y-1">
            <li>No password or email: the signature proves you control this wallet.</li>
            <li>The message binds this domain ({domain}), so a look-alike site can't reuse it.</li>
            <li>A one-time server nonce stops replays, and the expiry keeps the session short.</li>
            <li>It's a message, not a transaction: nothing moves and it costs nothing.</li>
          </ul>
        </Note>
      )}

      {error && <InlineError>{error.replace(/\.$/, "")}. Nothing was signed.</InlineError>}
    </StepPanel>
  );
}
