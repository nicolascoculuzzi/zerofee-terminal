import { ArrowDownToLine, ArrowUpFromLine, Clock, QrCode, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { CopyButton, NumberInput, Segmented } from "../../components/ui/controls";
import { Modal } from "../../components/ui/Modal";
import { cn } from "../../lib/cn";
import { fmtSol, shortAddr } from "../../lib/format";
import { getServices } from "../../services";
import { useSettings } from "../../state/settings";
import { useToasts } from "../../state/toasts";
import { type FundTab, useUi } from "../../state/ui";
import { useWallet } from "../../state/wallet";

function FundFromConnected({ address }: { address: string }) {
  const [connectedSol, setConnectedSol] = useState<number | null>(null);
  const [amount, setAmount] = useState<number | null>(1);
  const [busy, setBusy] = useState(false);
  const connected = useWallet((s) => s.service.connected);
  const close = useUi((s) => s.closeFund);

  useEffect(() => {
    void getServices()
      .wallet.balances()
      .then((b) => setConnectedSol(b.connectedSol));
  }, []);

  const submit = async () => {
    if (!amount) return;
    setBusy(true);
    try {
      await getServices().wallet.fundFromConnected(address, amount);
      useToasts.getState().push({ kind: "success", title: `Funded ${fmtSol(amount)} SOL`, body: "From your connected wallet" });
      close();
    } catch (e) {
      useToasts.getState().push({ kind: "error", title: "Funding failed", body: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-md bg-panel-2 px-3 py-2 text-sm">
        <span className="flex items-center gap-1 text-muted">
          <Wallet className="icon-md" /> <span className="capitalize">{connected?.provider ?? "Wallet"}</span>{" "}
          <span className="font-mono">{connected ? shortAddr(connected.address) : ""}</span>
        </span>
        <span className="font-semibold">◎ {connectedSol === null ? "…" : fmtSol(connectedSol)}</span>
      </div>
      <NumberInput value={amount} onChange={setAmount} suffix="SOL" min={0} className="h-9" ariaLabel="Amount to fund" />
      <div className="flex gap-1">
        {[0.5, 1, 2, 5].map((v) => (
          <Button key={v} size="xs" variant="subtle" className="flex-1" onClick={() => setAmount(v)}>
            {v} SOL
          </Button>
        ))}
        <Button
          size="xs"
          variant="subtle"
          className="flex-1"
          onClick={() => connectedSol !== null && setAmount(Math.max(0, Math.floor((connectedSol - 0.01) * 1000) / 1000))}
        >
          Max
        </Button>
      </div>
      <p className="text-xs text-dim">
        One approval in your connected wallet moves SOL into the trading wallet. Keep only what you're willing to lose in it.
      </p>
      <Button variant="primary" size="lg" className="w-full" disabled={busy || !amount} onClick={() => void submit()}>
        {busy ? "Waiting for wallet…" : `Fund ${amount ? fmtSol(amount) : ""} SOL`}
      </Button>
    </div>
  );
}

function Deposit({ address }: { address: string }) {
  return (
    <div className="space-y-3">
      <div className="flex gap-3">
        <div className="flex h-28 w-28 shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-line-strong text-center text-2xs text-dim">
          <QrCode className="icon-lg" />
          QR code
          <br />
          (with real wallet)
        </div>
        <div className="min-w-0 space-y-2">
          <div className="zf-label">Trading wallet address</div>
          <div className="flex items-start gap-1 break-all rounded-md bg-panel-2 p-2 font-mono text-xs">
            {address}
            <CopyButton text={address} label="Copy address" />
          </div>
        </div>
      </div>
      <ul className="list-disc space-y-1 pl-4 text-xs text-muted">
        <li>Send only SOL on Solana mainnet to this address (for example from an exchange withdrawal).</li>
        <li>The balance updates when the transfer lands; no memo is needed.</li>
      </ul>
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

  const submit = async () => {
    if (!amount) return;
    if (dest !== "connected") {
      useToasts.getState().push({
        kind: "info",
        title: "Queued for the delay window",
        body: "Withdrawals to other destinations go out after the 24 h delay set when you added the address.",
      });
      return;
    }
    if (useWallet.getState().service.locked) {
      requestUnlock("Unlock to sign the withdrawal", () => void submit());
      return;
    }
    setBusy(true);
    try {
      await getServices().wallet.withdrawToConnected(address, amount);
      useToasts.getState().push({ kind: "success", title: `Withdrew ${fmtSol(amount)} SOL`, body: "To your connected wallet" });
      close();
    } catch (e) {
      useToasts.getState().push({ kind: "error", title: "Withdrawal failed", body: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-between text-sm text-muted">
        <span>Available</span>
        <span className="text-fg">
          ◎ {fmtSol(available)} {reserved > 0 && <span className="text-dim">({fmtSol(reserved)} reserved by armed orders)</span>}
        </span>
      </div>
      <NumberInput
        value={amount}
        onChange={setAmount}
        suffix={
          <button type="button" className="font-semibold text-fg" onClick={() => setAmount(Math.floor(available * 10_000) / 10_000)}>
            Max
          </button>
        }
        min={0}
        max={available}
        className="h-9"
        ariaLabel="Amount to withdraw"
      />
      <div className="space-y-1">
        <div className="zf-label">Destination</div>
        <button
          type="button"
          onClick={() => setDest("connected")}
          className={cn(
            "flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm",
            dest === "connected" ? "border-fg/40 bg-hover" : "border-line hover:bg-hover",
          )}
        >
          <span>
            Connected wallet <span className="font-mono text-dim">{connected ? shortAddr(connected.address) : "—"}</span>
          </span>
          <span className="text-buy">Instant</span>
        </button>
        {destinations.map((d) => {
          const pending = d.activeAt > Date.now();
          return (
            <button
              key={d.id}
              type="button"
              disabled={pending}
              onClick={() => setDest(d.id)}
              className={cn(
                "flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm disabled:opacity-60",
                dest === d.id ? "border-fg/40 bg-hover" : "border-line hover:bg-hover",
              )}
            >
              <span>
                {d.label} <span className="font-mono text-dim">{shortAddr(d.address)}</span>
              </span>
              {pending ? (
                <span className="flex items-center gap-1 text-warn">
                  <Clock className="icon-sm" /> active in {Math.ceil((d.activeAt - Date.now()) / 3_600_000)} h
                </span>
              ) : (
                <span className="text-muted">Verified</span>
              )}
            </button>
          );
        })}
        <button
          type="button"
          className="text-xs text-muted underline decoration-line-strong underline-offset-2 hover:text-fg"
          onClick={() => openSettings("withdrawals")}
        >
          Manage destinations (new ones need a wallet signature + 24 h delay)
        </button>
      </div>
      <Button variant="primary" size="lg" className="w-full" disabled={busy || !amount} onClick={() => void submit()}>
        {busy ? "Signing…" : "Withdraw"}
      </Button>
    </div>
  );
}

export function FundModal() {
  const open = useUi((s) => s.fundOpen);
  const tab = useUi((s) => s.fundTab);
  const openFund = useUi((s) => s.openFund);
  const close = useUi((s) => s.closeFund);
  const address = useWallet((s) => s.activeAddress);
  const label = useWallet((s) => s.service.tradingWallets.find((w) => w.address === s.activeAddress)?.label);
  return (
    <Modal open={open} onClose={close} title={`Trading wallet${label ? ` · ${label}` : ""}`} width={440}>
      {!address ? (
        <div className="text-sm text-muted">Create a trading wallet first.</div>
      ) : (
        <div className="space-y-4">
          <Segmented<FundTab>
            value={tab}
            onChange={(t) => openFund(t)}
            className="w-full"
            options={[
              {
                value: "fund",
                label: (
                  <span className="flex items-center justify-center gap-1">
                    <Wallet className="icon-sm" /> From wallet
                  </span>
                ),
              },
              {
                value: "deposit",
                label: (
                  <span className="flex items-center justify-center gap-1">
                    <ArrowDownToLine className="icon-sm" /> Deposit
                  </span>
                ),
              },
              {
                value: "withdraw",
                label: (
                  <span className="flex items-center justify-center gap-1">
                    <ArrowUpFromLine className="icon-sm" /> Withdraw
                  </span>
                ),
              },
            ]}
          />
          {tab === "fund" && <FundFromConnected address={address} />}
          {tab === "deposit" && <Deposit address={address} />}
          {tab === "withdraw" && <Withdraw address={address} />}
        </div>
      )}
    </Modal>
  );
}
