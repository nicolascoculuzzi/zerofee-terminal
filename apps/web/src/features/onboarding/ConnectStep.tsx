import { ArrowRight, Check, ChevronRight, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { CopyButton } from "../../components/ui/controls";
import { cn } from "../../lib/cn";
import { getServices } from "../../services";
import type { ConnectedWallet, WalletProvider } from "../../services/walletService";
import { InlineError, PROVIDER_NAME, StepFooter, type StepFrame, StepPanel, useAction } from "./parts";

const PROVIDERS: WalletProvider[] = ["phantom", "solflare", "backpack"];

/*
 * Wallet picker rows (monogram, name, chevron) after Coinbase's "Connect wallet" dialog:
 * https://mobbin.com/screens/0028e86d-943f-4bfd-8be6-ce4f873921ce
 * No third-party logos are shipped, so each wallet gets a neutral monogram.
 */
export function ConnectStep({
  frame,
  connected,
  onBusyChange,
  onConnected,
  onNext,
}: {
  frame: StepFrame;
  connected: ConnectedWallet | null;
  onBusyChange: (busy: boolean) => void;
  onConnected: (wallet: ConnectedWallet) => void;
  onNext: () => void;
}) {
  const { busy, error, run } = useAction(onBusyChange);
  const [pending, setPending] = useState<WalletProvider | null>(null);

  const connect = async (provider: WalletProvider) => {
    setPending(provider);
    const res = await run(() => getServices().wallet.connect(provider));
    setPending(null);
    if (res.ok) onConnected(res.value);
  };

  return (
    <StepPanel
      {...frame}
      footer={
        <StepFooter>
          <Button size="lg" variant="primary" disabled={!connected || busy} onClick={onNext}>
            Continue <ArrowRight className="icon-md" />
          </Button>
        </StepFooter>
      }
    >
      <ul className="divide-y divide-hairline rounded-md border border-hairline">
        {PROVIDERS.map((id) => {
          const name = PROVIDER_NAME[id];
          const isConnected = connected?.provider === id;
          return (
            <li key={id}>
              <button
                type="button"
                disabled={busy}
                onClick={() => void connect(id)}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-surface-3 disabled:cursor-wait",
                  isConnected && "bg-surface-3",
                )}
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-sm border border-hairline-strong bg-surface-2 text-data font-semibold text-fg-1">
                  {name.charAt(0)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-data font-semibold text-fg-1">{name}</span>
                  <span className="block text-label text-fg-3">Wallet Standard</span>
                </span>
                {pending === id ? (
                  <span className="flex items-center gap-1 text-label text-fg-2">
                    <LoaderCircle className="icon-sm animate-spin" /> Connecting…
                  </span>
                ) : isConnected ? (
                  <span className="flex items-center gap-1 text-label text-buy">
                    <Check className="icon-sm" /> Connected
                  </span>
                ) : (
                  <ChevronRight className="icon-md text-fg-3" />
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {error && <InlineError>{error}</InlineError>}

      {connected && (
        <div className="rounded-md border border-hairline bg-surface-2 px-3 py-2">
          <div className="zf-label">Connected address · {PROVIDER_NAME[connected.provider]}</div>
          <div className="mt-1 flex items-start gap-2 font-mono text-data break-all text-fg-1">
            {connected.address}
            <CopyButton text={connected.address} label="Copy connected address" className="mt-px" />
          </div>
        </div>
      )}

      <p className="text-label text-fg-3">
        zerofee finds installed wallets through Wallet Standard and sees only your public address. Simulated here: no extension is needed,
        and connecting creates a demo address.
      </p>
    </StepPanel>
  );
}
