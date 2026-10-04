import { ArrowRight, Check, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/Button";
import { Hotkey } from "../../components/ui/controls";
import { WalletBadge } from "../../components/ui/WalletIcon";
import { cn } from "../../lib/cn";
import { fmtSol, shortAddr } from "../../lib/format";
import type { ConnectedWallet, TradingWallet } from "../../services/walletService";
import { useSettings } from "../../state/settings";
import type { FundResult } from "./FundStep";
import { Panel, StepActions, type StepFrame, StepHeader } from "./parts";

function Item({ ok, label, children }: { ok: boolean; label: string; children: ReactNode }) {
  return (
    <li className="flex min-h-11 items-center gap-3 px-3 py-2 text-data">
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full",
          ok ? "bg-buy-tint text-buy" : "bg-warn-tint text-warn",
        )}
      >
        {ok ? <Check className="icon-xs" /> : <TriangleAlert className="icon-xs" />}
      </span>
      <span className="w-28 shrink-0 text-fg-3">{label}</span>
      <span className={cn("min-w-0 flex-1 text-right", ok ? "text-fg-1" : "text-warn")}>{children}</span>
    </li>
  );
}

/*
 * Done (DESIGN.md 4.19 step 7): a status checklist and one primary action, "Open Pulse".
 * Recovery status checklist after Proton: https://mobbin.com/flows/62f54e4d-a558-4be2-98e2-6dcb560ca29f
 */
export function DoneStep({
  frame,
  connected,
  wallet,
  backedUp,
  funded,
  onOpen,
}: {
  frame: StepFrame;
  connected: ConnectedWallet;
  wallet: TradingWallet;
  backedUp: boolean;
  funded: FundResult | null;
  onOpen: () => void;
}) {
  const helpKey = useSettings((s) => s.hotkeys["hotkeys.help"]?.[0]);
  return (
    <>
      <StepHeader frame={frame} />
      <Panel>
        <ul className="divide-y divide-hairline">
          <Item ok label="Signed in">
            <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
              <WalletBadge wallet={connected} />
              <span className="font-mono text-fg-2">{shortAddr(connected.address)}</span>
            </span>
          </Item>
          <Item ok label="Trading wallet">
            {wallet.label} · {wallet.unlockMethod === "passkey" ? "passkey" : "passphrase"}
          </Item>
          <Item ok={backedUp} label="Backup">
            {backedUp ? "Verified" : "Not verified"}
          </Item>
          <Item ok={funded !== null} label="Balance">
            {funded ? `Funded ${fmtSol(funded.sol)} SOL` : "Not funded · fund any time from the top bar"}
          </Item>
        </ul>
      </Panel>
      <StepActions>
        <Button size="xl" variant="primary" onClick={onOpen}>
          Open Pulse <ArrowRight />
        </Button>
      </StepActions>
      {helpKey && (
        <p className="mt-4 flex items-center justify-center gap-1 text-label text-fg-3">
          Press <Hotkey binding={helpKey} /> any time for shortcuts.
        </p>
      )}
    </>
  );
}
