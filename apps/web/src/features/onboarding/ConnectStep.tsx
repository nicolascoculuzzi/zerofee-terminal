import { ArrowRight, ArrowUpRight, Check, ChevronRight, Lock } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { CopyButton } from "../../components/ui/controls";
import { WalletBadge, WalletIcon } from "../../components/ui/WalletIcon";
import { walletBrand } from "../../components/ui/walletLogos";
import { cn } from "../../lib/cn";
import { shortAddr } from "../../lib/format";
import { getServices } from "../../services";
import type { ConnectedWallet, ProviderInfo, WalletProvider } from "../../services/walletService";
import { Tag } from "../settings/ui";
import { InlineError, Panel, PanelRow, Spinner, StepActions, type StepFrame, StepHeader, useAction } from "./parts";

/*
 * Connect wallet (DESIGN.md 4.19 step 1). A grouped list like OpenSea's and Axiom's connect modals
 * (https://mobbin.com/screens/642f1d7c-e592-45ef-9dc9-85a0dcc2cbdc): 56 px rows with the wallet's real
 * logo at 32 px, its name at 13/500 and one status line; installed wallets first with a "Detected" tag,
 * the row being connected shows a spinner. A wallet that is not installed links to its official site in
 * a new tab instead. Installed wallets supply their logo through Wallet Standard (`wallet.icon`); the
 * rest use the official logos bundled in public/wallets/ (components/ui/walletLogos.ts).
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
  // Installed first, otherwise in the service's order. A wallet that isn't installed is listed only when we
  // can link to it (the known wallets).
  const rows: ProviderInfo[] = providers.filter((p) => p.installed || walletBrand(p.provider));
  rows.sort((a, b) => Number(b.installed) - Number(a.installed));
  const firstMissing = rows.findIndex((r) => !r.installed);

  const connect = async (provider: WalletProvider) => {
    setPending(provider);
    const res = await run(() => getServices().wallet.connect(provider));
    setPending(null);
    if (res.ok) onConnected(res.value);
  };

  return (
    <>
      <StepHeader frame={frame} />
      <Panel>
        <ul className="divide-y divide-hairline">
          {rows.map((p, i) => {
            const id = p.provider;
            const brand = walletBrand(id);
            const isConnected = connected?.provider === id;
            const logo = <WalletIcon icon={p.icon} name={p.name} provider={id} size="lg" />;
            if (!p.installed) {
              if (!brand) return null;
              const row = (
                <li key={id} className="flex h-14 items-center gap-3 px-3">
                  {logo}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body font-medium text-fg-2">{p.name}</span>
                    <span className="block truncate text-label text-fg-3">Not installed</span>
                  </span>
                  <a
                    href={brand.site}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Install ${p.name} from ${brand.host} (opens in a new tab)`}
                    className="inline-flex h-7 items-center gap-1 rounded-sm border border-hairline-strong px-2.5 text-data font-medium text-fg-1 transition-colors hover:bg-surface-3"
                  >
                    Install <ArrowUpRight className="icon-xs text-fg-3" />
                  </a>
                </li>
              );
              if (i !== firstMissing || i === 0) return row;
              return (
                <Fragment key={id}>
                  <li className="flex h-8 items-center bg-surface-2 px-3 text-label font-medium text-fg-3">More wallets</li>
                  {row}
                </Fragment>
              );
            }
            return (
              <li key={id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void connect(id)}
                  className={cn(
                    "group focus-inset flex h-14 w-full items-center gap-3 px-3 text-left transition-colors enabled:hover:bg-surface-2 disabled:cursor-wait",
                    isConnected && "bg-surface-2",
                  )}
                >
                  {logo}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body font-medium text-fg-1">{p.name}</span>
                    <span className="block truncate text-label text-fg-3">
                      {isConnected && connected ? shortAddr(connected.address) : "Browser extension"}
                    </span>
                  </span>
                  {pending === id ? (
                    <span className="flex items-center gap-1.5 text-label text-fg-2">
                      <Spinner /> Approve in {p.name}
                    </span>
                  ) : isConnected ? (
                    <span className="flex items-center gap-1 text-label text-fg-1">
                      <Check className="icon-xs text-buy" /> Connected
                    </span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <Tag>Detected</Tag>
                      <ChevronRight className="icon-sm text-fg-4 transition-colors group-hover:text-fg-2" />
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </Panel>
      {error && <InlineError>{error}</InlineError>}

      {connected && (
        <Panel className="mt-4">
          <PanelRow label="Connected with">
            <WalletBadge wallet={connected} className="justify-end" />
          </PanelRow>
          <PanelRow label="Address">
            <span className="inline-flex items-center gap-1 font-mono text-fg-2">
              {shortAddr(connected.address)}
              <CopyButton text={connected.address} label="Copy connected address" />
            </span>
          </PanelRow>
        </Panel>
      )}

      <p className="mt-4 flex gap-2 text-label text-fg-3">
        <Lock className="icon-xs mt-px shrink-0" />
        <span>
          zerofee only sees your public address. Connecting never moves funds.
          {!simulated && !rows.some((r) => r.installed) && " After you install a wallet, it appears here on its own."}
          {simulated && " Simulated: no extension is needed; connecting creates a demo address."}
        </span>
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
