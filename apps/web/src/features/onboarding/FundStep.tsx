import { ArrowRight, Check, Copy, QrCode as QrCodeIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { NumberInput } from "../../components/ui/controls";
import { WalletIcon } from "../../components/ui/WalletIcon";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { fmtInt, fmtSol, fmtSolShort } from "../../lib/format";
import { getServices } from "../../services";
import type { ConnectedWallet, TradingWallet } from "../../services/walletService";
import { useMarket } from "../../state/market";
import { useWallet } from "../../state/wallet";
import { useTransient } from "../settings/ui";
import { InlineError, Panel, Spinner, StepActions, type StepFrame, StepHeader, useAction } from "./parts";
import { QrCode } from "./QrCode";

const CHIPS = [0.5, 1, 2, 5] as const;
/** Left in the connected wallet for its own network fees. */
const FEE_RESERVE_SOL = 0.001;

export interface FundResult {
  sol: number;
  /** Slot the deposit was seen at (null when only the transfer receipt is known). */
  slot: number | null;
}

type Source = "connected" | "deposit";

/** Watches the trading wallet's balance and reports the first increase (either path). */
function useDepositWatcher(address: string, onReceived: (r: FundResult) => void, active: boolean) {
  const balance = useWallet((s) => s.status[address]?.solBalance ?? null);
  const baseline = useRef<number | null>(null);
  const report = useRef(onReceived);
  report.current = onReceived;
  useEffect(() => {
    if (!active || balance === null) return;
    if (baseline.current === null) {
      baseline.current = balance;
      return;
    }
    const delta = balance - baseline.current;
    if (delta > 1e-9) {
      baseline.current = balance;
      report.current({ sol: delta, slot: useMarket.getState().slot || null });
    }
  }, [balance, active]);
  return balance;
}

/*
 * Fund (DESIGN.md 4.19 step 6): "From Phantom | Deposit address". From the connected wallet: an
 * amount with 0.5 / 1 / 2 / 5 chips and "Transfer 1 SOL" (the wallet approves). Deposit: a 160 px
 * QR on a white plate, the full address in mono, Copy, "Send SOL on Solana only." A watcher row
 * waits for the deposit. The only step that can be skipped.
 * Stepper with QR, address and copy after OKX's deposit flow; amount chips after Coinbase:
 * https://mobbin.com/flows/a6c83dd1-51f7-4e6f-95da-faff776eb1ca
 * https://mobbin.com/screens/f8afc154-e5c8-4587-ab43-93c4799a979a
 */
export function FundStep({
  frame,
  connected,
  wallet,
  funded,
  onBusyChange,
  onFunded,
  onSkip,
  onNext,
}: {
  frame: StepFrame;
  connected: ConnectedWallet;
  wallet: TradingWallet;
  funded: FundResult | null;
  onBusyChange: (busy: boolean) => void;
  onFunded: (result: FundResult) => void;
  onSkip: () => void;
  onNext: () => void;
}) {
  const { busy, error, run } = useAction(onBusyChange);
  const [source, setSource] = useState<Source>("connected");
  const [connectedSol, setConnectedSol] = useState<number | null>(null);
  const [amount, setAmount] = useState<number | null>(1);
  const [copied, setCopied] = useTransient<true>(1200);
  /** The server only simulated the transfer (DRY_RUN): nothing arrives on-chain. */
  const [simulated, setSimulated] = useState(false);
  const name = connected.name;
  const balance = useDepositWatcher(wallet.address, onFunded, funded === null);

  const refresh = useCallback(() => {
    getServices()
      .wallet.balances()
      .then((b) => setConnectedSol(b.connectedSol))
      .catch(() => setConnectedSol(null));
  }, []);
  useEffect(() => refresh(), [refresh]);

  const max = connectedSol === null ? null : Math.max(0, connectedSol - FEE_RESERVE_SOL);
  const over = amount !== null && max !== null && amount > max ? amount - max : 0;
  const canTransfer = amount !== null && amount > 0 && over === 0 && !busy;

  // If the balance stream hasn't shown the transfer 3 s after the wallet confirmed it, the
  // receipt alone marks the step funded (the slot is then unknown).
  const fundedRef = useRef(funded);
  fundedRef.current = funded;
  const fallback = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (fallback.current) clearTimeout(fallback.current);
    },
    [],
  );

  const transfer = async () => {
    if (!canTransfer || amount === null) return;
    const sol = amount;
    const res = await run(() => getServices().wallet.fundFromConnected(wallet.address, sol));
    if (!res.ok) return;
    setSimulated(res.value.simulated === true);
    refresh();
    fallback.current = setTimeout(() => {
      if (!fundedRef.current) onFunded({ sol, slot: null });
    }, 3000);
  };

  return (
    <>
      <StepHeader frame={frame} />
      <SourceTabs
        value={source}
        onChange={setSource}
        options={[
          { value: "connected", label: `From ${name}`, icon: <WalletIcon icon={connected.icon} name={name} size="sm" /> },
          { value: "deposit", label: "Deposit address", icon: <QrCodeIcon className="icon-sm text-fg-3" /> },
        ]}
      />

      {source === "connected" ? (
        <div className="mt-4">
          <div className="flex h-4 items-center justify-between gap-2 text-label">
            <label htmlFor="zf-fund-amount" className="font-medium text-fg-3">
              Amount
            </label>
            <span className="text-fg-3">
              {name} balance <span className="zf-num">{connectedSol === null ? "–" : fmtSol(connectedSol)}</span> SOL ·{" "}
              <button
                type="button"
                disabled={max === null || max <= 0}
                onClick={() => max !== null && setAmount(Math.floor(max * 1e4) / 1e4)}
                className="font-medium text-fg-1 hover:underline disabled:text-fg-4"
              >
                Max
              </button>
            </span>
          </div>
          <NumberInput
            id="zf-fund-amount"
            size="amount"
            value={amount}
            onChange={setAmount}
            min={0}
            step={(v) => (v < 1 ? 0.01 : 0.1)}
            suffix="SOL"
            invalid={over > 0}
            ariaLabel="Amount to transfer, SOL"
            onEnter={() => void transfer()}
            className="mt-1"
          />
          {over > 0 && (
            <p className="mt-1 text-label text-sell">
              Exceeds the {name} balance by {fmtSol(over)} SOL, after a fee reserve.
            </p>
          )}
          <div className="mt-2 grid grid-cols-4 gap-1">
            {CHIPS.map((v) => {
              const on = amount === v;
              return (
                <button
                  key={v}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setAmount(v)}
                  className={cn(
                    "h-8 rounded-sm border bg-surface-2 text-data font-medium transition-colors max-md:h-11",
                    on ? "border-fg-2 text-fg-1" : "border-hairline text-fg-2 hover:text-fg-1",
                  )}
                >
                  {v}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <Panel className="mt-4 flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
          <QrCode value={wallet.address} size={144} label={`QR code for ${wallet.label}'s address`} />
          <div className="min-w-0 flex-1">
            <div className="zf-label">{wallet.label} · trading wallet</div>
            <p className="mt-1 font-mono text-data break-all text-fg-1">{wallet.address}</p>
            <Button
              size="md"
              variant="secondary"
              icon={copied ? <Check /> : <Copy />}
              aria-label={copied ? "Copied" : "Copy address"}
              onClick={() => {
                void copyText(wallet.address).then((ok) => ok && setCopied(true));
              }}
              className="mt-3 max-md:h-11"
            >
              {copied ? "Copied" : "Copy address"}
            </Button>
            <p className="mt-3 text-label text-fg-3">Send SOL on the Solana network only.</p>
          </div>
        </Panel>
      )}

      <div className="mt-4 flex min-h-10 items-center rounded-md border border-hairline px-3 text-data" aria-live="polite">
        {funded && simulated ? (
          <span className="flex flex-wrap items-center gap-x-2 text-warn">
            Dry run: the server simulated a {fmtSol(funded.sol)} SOL transfer and sent nothing.
          </span>
        ) : funded ? (
          <span className="flex flex-wrap items-center gap-x-2">
            <Check className="icon-xs text-buy" />
            <span className="text-buy">Received {fmtSol(funded.sol)} SOL</span>
            {funded.slot !== null && <span className="zf-num text-label text-fg-3">slot {fmtInt(funded.slot)}</span>}
          </span>
        ) : (
          <span className="flex w-full items-center gap-2 text-fg-3">
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-fg-4" />
            Waiting for deposit
            <span className="ml-auto text-fg-2">
              Balance <span className="zf-num text-fg-1">{fmtSol(balance)}</span> SOL
            </span>
          </span>
        )}
      </div>
      {error && <InlineError>{error}</InlineError>}

      <StepActions>
        {funded ? (
          <Button size="xl" variant="primary" onClick={onNext}>
            Continue to the summary <ArrowRight />
          </Button>
        ) : (
          <>
            {source === "connected" && (
              <Button size="xl" variant="primary" disabled={!canTransfer} onClick={() => void transfer()}>
                {busy && <Spinner />}
                {busy ? `Waiting for ${name}` : `Transfer ${amount !== null && amount > 0 ? fmtSolShort(amount) : ""} SOL`}
              </Button>
            )}
            <Button size="xl" variant="ghost" disabled={busy} onClick={onSkip}>
              Skip for now
            </Button>
          </>
        )}
      </StepActions>
    </>
  );
}

/** Two funding sources as a full-width segmented radiogroup with icons (36 px, active on surface-3). */
function SourceTabs({
  value,
  onChange,
  options,
}: {
  value: Source;
  onChange: (s: Source) => void;
  options: { value: Source; label: string; icon: ReactNode }[];
}) {
  return (
    <div role="radiogroup" aria-label="Funding source" className="grid grid-cols-2 gap-1 rounded-md border border-hairline p-1">
      {options.map((o) => {
        const on = o.value === value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: segmented radio with an icon
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cn(
              "focus-inset flex h-8 items-center justify-center gap-2 rounded-sm text-data font-medium transition-colors max-md:h-11",
              on ? "bg-surface-3 text-fg-1" : "text-fg-3 hover:bg-surface-2 hover:text-fg-1",
            )}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
