import { ArrowRight, CircleCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { NumberInput } from "../../components/ui/controls";
import { fmtSol, fmtSolShort, shortAddr } from "../../lib/format";
import { getServices } from "../../services";
import type { ConnectedWallet, TradingWallet } from "../../services/walletService";
import { useWallet } from "../../state/wallet";
import { Field, Note } from "../settings/ui";
import { InlineError, PROVIDER_NAME, StepFooter, type StepFrame, StepPanel, useAction } from "./parts";

const CHIPS = [0.5, 1, 2, 5] as const;
/** Left in the connected wallet for its own network fees. */
const FEE_RESERVE_SOL = 0.001;

export interface FundResult {
  sol: number;
  signature: string;
}

/*
 * Transfer from the connected wallet: From/To cards with balances, then the amount with quick
 * chips and one approval, after Binance's internal transfer dialog:
 * https://mobbin.com/screens/1fa8b611-dfd1-4506-a202-35345f54d8de
 */
export function FundStep({
  frame,
  connected,
  wallet,
  funded,
  onBusyChange,
  onFunded,
  onSkip,
  onBack,
  onNext,
}: {
  frame: StepFrame;
  connected: ConnectedWallet;
  wallet: TradingWallet;
  funded: FundResult | null;
  onBusyChange: (busy: boolean) => void;
  onFunded: (result: FundResult) => void;
  onSkip: () => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const { busy, error, run } = useAction(onBusyChange);
  const [connectedSol, setConnectedSol] = useState<number | null>(null);
  const [amount, setAmount] = useState<number | null>(1);
  const tradingSol = useWallet((s) => s.status[wallet.address]?.solBalance ?? null);

  const refresh = useCallback(() => {
    getServices()
      .wallet.balances()
      .then((b) => setConnectedSol(b.connectedSol))
      .catch(() => setConnectedSol(null));
  }, []);
  useEffect(() => refresh(), [refresh]);

  const max = connectedSol === null ? null : Math.max(0, connectedSol - FEE_RESERVE_SOL);
  const tooMuch = amount !== null && max !== null && amount > max;
  const canFund = amount !== null && amount > 0 && !tooMuch && !busy;

  const fund = async () => {
    if (!canFund || amount === null) return;
    const sol = amount;
    const res = await run(() => getServices().wallet.fundFromConnected(wallet.address, sol));
    if (!res.ok) return;
    onFunded({ sol, signature: res.value.signature });
    refresh();
  };

  return (
    <StepPanel
      {...frame}
      footer={
        <StepFooter onBack={onBack} backDisabled={busy}>
          {funded ? (
            <Button size="lg" variant="primary" onClick={onNext}>
              Continue <ArrowRight className="icon-md" />
            </Button>
          ) : (
            <>
              <Button size="lg" variant="ghost" disabled={busy} onClick={onSkip}>
                Skip for now
              </Button>
              <Button size="lg" variant="primary" disabled={!canFund} onClick={() => void fund()}>
                {busy ? "Waiting for wallet…" : `Fund ${amount !== null && amount > 0 ? `${fmtSolShort(amount)} SOL` : ""}`}
              </Button>
            </>
          )}
        </StepFooter>
      }
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-md border border-hairline px-3 py-2">
          <div className="zf-label">From · {PROVIDER_NAME[connected.provider]}</div>
          <div className="mt-1 flex items-baseline justify-between gap-2">
            <span className="font-mono text-label text-fg-2">{shortAddr(connected.address, 4, 4)}</span>
            <span className="font-mono text-body text-fg-1">{connectedSol === null ? "…" : `${fmtSol(connectedSol)} SOL`}</span>
          </div>
        </div>
        <div className="rounded-md border border-hairline px-3 py-2">
          <div className="zf-label">To · {wallet.label} (trading wallet)</div>
          <div className="mt-1 flex items-baseline justify-between gap-2">
            <span className="font-mono text-label text-fg-2">{shortAddr(wallet.address, 4, 4)}</span>
            <span className="font-mono text-body text-fg-1">{tradingSol === null ? "…" : `${fmtSol(tradingSol)} SOL`}</span>
          </div>
        </div>
      </div>

      {funded ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-buy-edge bg-buy-tint px-3 py-2 text-data">
          <CircleCheck className="icon-sm text-buy" />
          <span className="text-fg-1">Funded {fmtSolShort(funded.sol)} SOL</span>
          <span className="font-mono text-label text-fg-3">signature {shortAddr(funded.signature, 6, 6)}</span>
        </div>
      ) : (
        <Field label="Amount">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <NumberInput
              value={amount}
              onChange={setAmount}
              min={0}
              suffix="SOL"
              alignRight
              className="h-8 sm:w-48"
              ariaLabel="Amount to fund, SOL"
              onEnter={() => void fund()}
            />
            <div className="flex gap-1">
              {CHIPS.map((v) => (
                <Button
                  key={v}
                  size="md"
                  variant={amount === v ? "secondary" : "secondary"}
                  aria-pressed={amount === v}
                  onClick={() => setAmount(v)}
                >
                  {v} SOL
                </Button>
              ))}
            </div>
          </div>
        </Field>
      )}

      {!funded && tooMuch && (
        <InlineError>More than the connected wallet holds. Leave about {FEE_RESERVE_SOL} SOL there for fees.</InlineError>
      )}
      {error && <InlineError>{error}</InlineError>}

      <Note tone="info">
        One approval in your connected wallet moves the SOL. Keep only what you're willing to lose in the trading wallet; withdrawing back
        to your connected wallet is one click.
      </Note>
    </StepPanel>
  );
}
