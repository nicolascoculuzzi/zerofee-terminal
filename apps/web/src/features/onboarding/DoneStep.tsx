import { ArrowRight, Check, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/Button";
import { Hotkey } from "../../components/ui/controls";
import { fmtSol, shortAddr } from "../../lib/format";
import type { ConnectedWallet, TradingWallet } from "../../services/walletService";
import { useSettings } from "../../state/settings";
import type { FundResult } from "./FundStep";
import { StepActions, type StepFrame, StepHeader } from "./parts";

function Item({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className="flex min-h-8 items-center gap-2 py-1 text-data">
      {ok ? <Check className="icon-xs text-buy" /> : <TriangleAlert className="icon-xs text-warn" />}
      <span className={ok ? "text-fg-1" : "text-warn"}>{children}</span>
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
      <ul className="divide-y divide-hairline border-y border-hairline">
        <Item ok>
          Signed in as <span className="font-mono">{shortAddr(connected.address)}</span>
        </Item>
        <Item ok>Trading wallet created ({wallet.unlockMethod === "passkey" ? "passkey" : "passphrase"})</Item>
        <Item ok={backedUp}>{backedUp ? "Backup verified" : "Backup not verified"}</Item>
        <Item ok={funded !== null}>{funded ? `Funded ${fmtSol(funded.sol)} SOL` : "Not funded · Fund later"}</Item>
      </ul>
      <StepActions>
        <Button size="xl" variant="primary" onClick={onOpen}>
          Open Pulse <ArrowRight />
        </Button>
      </StepActions>
      {helpKey && (
        <p className="mt-4 flex items-center gap-1 text-label text-fg-3">
          Press <Hotkey binding={helpKey} /> any time for shortcuts.
        </p>
      )}
    </>
  );
}
