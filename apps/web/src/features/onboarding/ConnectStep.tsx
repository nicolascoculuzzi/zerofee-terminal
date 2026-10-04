import { ArrowRight, Check } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { CopyButton } from "../../components/ui/controls";
import { WalletBadge, WalletIcon } from "../../components/ui/WalletIcon";
import { cn } from "../../lib/cn";
import { getServices } from "../../services";
import type { ConnectedWallet, ProviderInfo, WalletProvider } from "../../services/walletService";
import { Tag } from "../settings/ui";
import { InlineError, PROVIDER_NAME, Spinner, StepActions, type StepFrame, StepHeader, useAction } from "./parts";

const PROVIDERS: WalletProvider[] = ["phantom", "solflare", "backpack"];

/*
 * Connect wallet (DESIGN.md 4.19 step 1): 44 px rows with the wallet's icon, its name at 13/500
 * and a "Detected" tag; the row being connected shows a spinner on its right.
 * Wallet rows with a spinner after Uniswap; badges after Tally:
 * https://mobbin.com/flows/9aaa402b-0d7a-4960-8261-57602073bb6c
 * https://mobbin.com/flows/7791b9e6-611e-4cb0-ae5c-b767bd662931
 * Real wallets supply their official icon through Wallet Standard (`wallet.icon`, a data: URI), shown
 * with the name the wallet registered; installed wallets are listed first. The simulation has no
 * extensions, so each row shows a neutral 24 px letter square instead of a brand logo.
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
  const simulated = getServices().simulated;
  // Extensions register through Wallet Standard as they load (or get installed meanwhile): keep looking.
  const [providers, setProviders] = useState(() => getServices().wallet.providers());
  useEffect(() => {
    const t = setInterval(() => {
      const next = getServices().wallet.providers();
      setProviders((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    }, 1_000);
    return () => clearInterval(t);
  }, []);
  const known = new Set(providers.map((p) => p.provider));
  const rows: ProviderInfo[] = [
    ...providers,
    ...PROVIDERS.filter((id) => !known.has(id)).map((id) => ({ provider: id, name: PROVIDER_NAME[id], icon: null, installed: false })),
  ];
  // Installed first, otherwise in the service's order.
  rows.sort((a, b) => Number(b.installed) - Number(a.installed));

  const connect = async (provider: WalletProvider) => {
    setPending(provider);
    const res = await run(() => getServices().wallet.connect(provider));
    setPending(null);
    if (res.ok) onConnected(res.value);
  };

  return (
    <>
      <StepHeader frame={frame} />
      <ul className="divide-y divide-hairline border-y border-hairline">
        {rows.map((p) => {
          const id = p.provider;
          const name = p.name;
          const installed = p.installed;
          const isConnected = connected?.provider === id;
          return (
            <li key={id}>
              <button
                type="button"
                disabled={busy || !installed}
                onClick={() => void connect(id)}
                className={cn(
                  "focus-inset flex h-11 w-full items-center gap-3 px-2 text-left transition-colors enabled:hover:bg-surface-2 disabled:cursor-not-allowed",
                  busy && "disabled:cursor-wait",
                  isConnected && "bg-surface-2",
                )}
              >
                <WalletIcon icon={p.icon} name={name} className={cn(!installed && "opacity-60")} />
                <span className={cn("min-w-0 flex-1 truncate text-body font-medium", installed ? "text-fg-1" : "text-fg-3")}>{name}</span>
                {pending === id ? (
                  <span className="flex items-center gap-1 text-label text-fg-2">
                    <Spinner /> Connecting
                  </span>
                ) : isConnected ? (
                  <span className="flex items-center gap-1 text-label text-fg-1">
                    <Check className="icon-xs" /> Connected
                  </span>
                ) : installed ? (
                  <Tag>Detected</Tag>
                ) : (
                  <span className="text-label text-fg-3">Not installed</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {error && <InlineError>{error}</InlineError>}

      {connected && (
        <div className="mt-4">
          <div className="zf-label flex items-center gap-1">
            Connected address · <WalletBadge wallet={connected} className="normal-case" />
          </div>
          <div className="mt-1 flex items-start gap-1 font-mono text-data break-all text-fg-2">
            {connected.address}
            <CopyButton text={connected.address} label="Copy connected address" />
          </div>
        </div>
      )}

      <p className="mt-4 text-label text-fg-3">
        zerofee finds installed wallets through Wallet Standard and only ever sees the public address.
        {simulated && " Simulated: no extension is needed, and connecting creates a demo address."}
      </p>

      {connected && (
        <StepActions>
          <Button size="xl" variant="primary" disabled={busy} onClick={onNext}>
            Continue to sign in <ArrowRight />
          </Button>
        </StepActions>
      )}
    </>
  );
}
