import { Clock, LoaderCircle } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { CopyButton, NumberInput, Segmented } from "../../components/ui/controls";
import { HoldButton } from "../../components/ui/HoldButton";
import { Modal } from "../../components/ui/Modal";
import { cn } from "../../lib/cn";
import { fmtSol, fmtSolShort, shortAddr } from "../../lib/format";
import { getServices } from "../../services";
import { useSettings } from "../../state/settings";
import { useToasts } from "../../state/toasts";
import { type FundTab, useUi } from "../../state/ui";
import { useWallet } from "../../state/wallet";
import { QrCode } from "../onboarding/QrCode";
import { PresetChips, solStep } from "./AmountField";

/*
 * Fund, deposit and withdraw for the trading wallet (DESIGN.md 4.17 forms, 560 px): segmented
 * tabs, amounts with preset chips, verb-plus-object buttons, and hold-to-confirm for withdrawals
 * to a non-default destination (1.7). Transfer form with balances after Kraken Pro's simple order
 * form https://mobbin.com/screens/e7e29a51-ac57-4038-8ad5-fe228df11309; "Use max" after Base
 * https://mobbin.com/screens/09a5bbe0-2943-4077-9f53-eddf516df513
 */

const PROVIDER: Record<string, string> = { phantom: "Phantom", solflare: "Solflare", backpack: "Backpack" };
/** Left in the connected wallet for its own network fees. */
const FEE_RESERVE_SOL = 0.001;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex h-7 items-center justify-between gap-3 text-data">
      <span className="text-fg-3">{label}</span>
      <span className="min-w-0 text-right text-fg-1">{children}</span>
    </div>
  );
}

function FundFromConnected({ address }: { address: string }) {
  const [connectedSol, setConnectedSol] = useState<number | null>(null);
  const [amount, setAmount] = useState<number | null>(1);
  const [busy, setBusy] = useState(false);
  const connected = useWallet((s) => s.service.connected);
  const close = useUi((s) => s.closeFund);
  const provider = PROVIDER[connected?.provider ?? "phantom"] ?? "your wallet";

  useEffect(() => {
    void getServices()
      .wallet.balances()
      .then((b) => setConnectedSol(b.connectedSol));
  }, []);

  const max = connectedSol === null ? null : Math.max(0, Math.floor((connectedSol - FEE_RESERVE_SOL) * 1000) / 1000);
  const over = amount !== null && max !== null && amount > max;

  const submit = async () => {
    if (!amount || over) return;
    setBusy(true);
    try {
      await getServices().wallet.fundFromConnected(address, amount);
      useToasts.getState().push({ kind: "success", title: `Funded ${fmtSolShort(amount)} SOL`, body: `From ${provider}` });
      close();
    } catch (e) {
      useToasts.getState().push({ kind: "error", title: "Funding failed", body: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="rounded-sm border border-hairline px-3">
        <Row label={`From ${provider}`}>
          <span className="font-mono text-fg-2">{connected ? shortAddr(connected.address) : "–"}</span>
          <span className="zf-num ml-2">{connectedSol === null ? "–" : `${fmtSol(connectedSol)} SOL`}</span>
        </Row>
        <Row label="To trading wallet">
          <span className="font-mono text-fg-2">{shortAddr(address)}</span>
        </Row>
      </div>
      <div className="space-y-1">
        <div className="flex h-4 items-center justify-between text-label">
          <span className="font-medium text-fg-3">Amount</span>
          {max !== null && (
            <button type="button" className="text-fg-3 hover:text-fg-1" onClick={() => setAmount(max)}>
              Max <span className="zf-num text-fg-1">{fmtSol(max)}</span> SOL
            </button>
          )}
        </div>
        <NumberInput
          size="amount"
          value={amount}
          onChange={setAmount}
          suffix="SOL"
          min={0}
          step={solStep}
          invalid={over}
          ariaLabel="Amount to fund in SOL"
        />
        {over && <p className="text-label text-sell">Exceeds the {provider} balance</p>}
        <PresetChips values={[0.5, 1, 2, 5]} active={amount} label={fmtSolShort} onPick={setAmount} unit="SOL" />
      </div>
      <p className="text-label text-fg-3">
        One approval in {provider} moves SOL into the trading wallet. Keep only what you are willing to lose in it.
      </p>
      <Button
        variant="primary"
        size="lg"
        className="w-full"
        disabled={busy || !amount || over}
        icon={busy ? <LoaderCircle className="animate-spin" /> : undefined}
        onClick={() => void submit()}
      >
        {amount ? `Transfer ${fmtSolShort(amount)} SOL` : "Enter an amount"}
      </Button>
    </div>
  );
}

function Deposit({ address, label }: { address: string; label: string }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
      <QrCode value={address} label={`QR code for ${label}'s address`} />
      <div className="min-w-0 flex-1 space-y-3">
        <div className="space-y-1">
          <div className="zf-label">{label} · trading wallet address</div>
          <div className="flex items-start gap-1 rounded-sm border border-hairline bg-surface-2 p-2 font-mono text-data break-all text-fg-1">
            {address}
            <CopyButton text={address} label="Copy address" />
          </div>
        </div>
        <p className="text-body text-fg-2">Send SOL on Solana only. The balance updates when the transfer lands; no memo is needed.</p>
      </div>
    </div>
  );
}

function Withdraw({ address }: { address: string }) {
  const balance = useWallet((s) => s.status[address]?.solBalance ?? 0);
  const reserved = useWallet((s) => s.status[address]?.reservedSol ?? 0);
  const connected = useWallet((s) => s.service.connected);
  const destinations = useSettings((s) => s.withdrawalDestinations);
  const openSettings = useUi((s) => s.openSettings);
  const requestUnlock = useUi((s) => s.requestUnlock);
  const close = useUi((s) => s.closeFund);
  const [amount, setAmount] = useState<number | null>(null);
  const [dest, setDest] = useState<string>("connected");
  const [busy, setBusy] = useState(false);
  const available = Math.max(0, balance - reserved - 0.00001);
  const provider = PROVIDER[connected?.provider ?? "phantom"] ?? "Connected wallet";
  const over = amount !== null && amount > available;
  const other = destinations.find((d) => d.id === dest) ?? null;

  const submit = async () => {
    if (!amount || over) return;
    if (other) {
      useToasts.getState().push({
        kind: "info",
        title: `Withdrawal of ${fmtSolShort(amount)} SOL queued`,
        body: `${other.label} receives it once the 24 h delay for new destinations has passed.`,
      });
      close();
      return;
    }
    if (useWallet.getState().service.locked) {
      requestUnlock("Unlock to sign the withdrawal", () => void submit());
      return;
    }
    setBusy(true);
    try {
      await getServices().wallet.withdrawToConnected(address, amount);
      useToasts.getState().push({ kind: "success", title: `Withdrew ${fmtSolShort(amount)} SOL`, body: `To ${provider}` });
      close();
    } catch (e) {
      useToasts.getState().push({ kind: "error", title: "Withdrawal failed", body: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <div className="flex h-4 items-center justify-between text-label">
          <span className="font-medium text-fg-3">Amount</span>
          <button type="button" className="text-fg-3 hover:text-fg-1" onClick={() => setAmount(Math.floor(available * 10_000) / 10_000)}>
            Available <span className="zf-num text-fg-1">{fmtSol(available)}</span> SOL · Max
          </button>
        </div>
        <NumberInput
          size="amount"
          value={amount}
          onChange={setAmount}
          suffix="SOL"
          min={0}
          step={solStep}
          invalid={over}
          ariaLabel="Amount to withdraw in SOL"
        />
        {over && <p className="text-label text-sell">Exceeds the available balance by {fmtSol((amount ?? 0) - available)} SOL</p>}
        {reserved > 0 && <p className="text-label text-fg-3">{fmtSol(reserved)} SOL stays reserved by armed orders.</p>}
      </div>
      <div className="space-y-1" role="radiogroup" aria-label="Destination">
        <div className="zf-label">Destination</div>
        {/* biome-ignore lint/a11y/useSemanticElements: radio rows with an address and status */}
        <button
          type="button"
          role="radio"
          aria-checked={dest === "connected"}
          onClick={() => setDest("connected")}
          className={cn(
            "flex h-9 w-full items-center justify-between rounded-sm border px-3 text-left text-data transition-colors",
            dest === "connected" ? "border-hairline-strong bg-surface-3" : "border-hairline hover:bg-surface-3",
          )}
        >
          <span>
            {provider} <span className="font-mono text-fg-3">{connected ? shortAddr(connected.address) : "–"}</span>
          </span>
          <span className="text-fg-2">Instant</span>
        </button>
        {destinations.map((d) => {
          const pending = d.activeAt > Date.now();
          return (
            // biome-ignore lint/a11y/useSemanticElements: radio rows with an address and status
            <button
              key={d.id}
              type="button"
              role="radio"
              aria-checked={dest === d.id}
              disabled={pending}
              onClick={() => setDest(d.id)}
              className={cn(
                "flex h-9 w-full items-center justify-between rounded-sm border px-3 text-left text-data transition-colors disabled:text-fg-4",
                dest === d.id ? "border-hairline-strong bg-surface-3" : "border-hairline hover:bg-surface-3",
              )}
            >
              <span>
                {d.label} <span className="font-mono text-fg-3">{shortAddr(d.address)}</span>
              </span>
              {pending ? (
                <span className="flex items-center gap-1 text-warn">
                  <Clock className="icon-xs" /> Active in {Math.ceil((d.activeAt - Date.now()) / 3_600_000)} h
                </span>
              ) : (
                <span className="text-fg-2">24 h delay passed</span>
              )}
            </button>
          );
        })}
        <Button variant="ghost" size="xs" onClick={() => openSettings("withdrawals")}>
          Manage destinations
        </Button>
      </div>
      {other ? (
        <HoldButton tone="primary" className="w-full" disabled={!amount || over} onConfirm={() => void submit()}>
          Hold to withdraw {amount ? `${fmtSolShort(amount)} SOL` : ""} to {other.label}
        </HoldButton>
      ) : (
        <Button
          variant="primary"
          size="lg"
          className="w-full"
          disabled={busy || !amount || over}
          icon={busy ? <LoaderCircle className="animate-spin" /> : undefined}
          onClick={() => void submit()}
        >
          {amount ? `Withdraw ${fmtSolShort(amount)} SOL` : "Enter an amount"}
        </Button>
      )}
    </div>
  );
}

export function FundModal() {
  const open = useUi((s) => s.fundOpen);
  const tab = useUi((s) => s.fundTab);
  const openFund = useUi((s) => s.openFund);
  const close = useUi((s) => s.closeFund);
  const fundAddress = useUi((s) => s.fundAddress);
  const activeAddress = useWallet((s) => s.activeAddress);
  const address = fundAddress ?? activeAddress;
  const label = useWallet((s) => s.service.tradingWallets.find((w) => w.address === address)?.label);
  return (
    <Modal
      open={open}
      onClose={close}
      title="Trading wallet"
      description={label ? `${label} · ${address ? shortAddr(address) : ""}` : undefined}
      width={560}
    >
      {!address ? (
        <p className="text-body text-fg-2">Create a trading wallet first.</p>
      ) : (
        <div className="space-y-4">
          <Segmented<FundTab>
            value={tab}
            onChange={(t) => openFund(t, fundAddress)}
            className="w-full"
            options={[
              { value: "fund", label: "From wallet" },
              { value: "deposit", label: "Deposit address" },
              { value: "withdraw", label: "Withdraw" },
            ]}
            label="Funding method"
          />
          {tab === "fund" && <FundFromConnected address={address} />}
          {tab === "deposit" && <Deposit address={address} label={label ?? "Trading wallet"} />}
          {tab === "withdraw" && <Withdraw address={address} />}
        </div>
      )}
    </Modal>
  );
}
