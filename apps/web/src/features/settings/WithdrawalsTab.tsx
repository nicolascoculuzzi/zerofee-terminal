import { Clock, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button, IconButton } from "../../components/ui/Button";
import { CopyButton } from "../../components/ui/controls";
import { isBase58Address } from "../../lib/address";
import { fmtDate, shortAddr } from "../../lib/format";
import { useNow } from "../../lib/useNow";
import { getServices } from "../../services";
import { useSettings } from "../../state/settings";
import { useToasts } from "../../state/toasts";
import { useWallet } from "../../state/wallet";
import { errorMessage, fmtCountdown } from "./format";
import { Chip, Field, Group, Note, TabHeader } from "./ui";

const PROVIDER_NAME = { phantom: "Phantom", solflare: "Solflare", backpack: "Backpack" } as const;
const LABEL_MAX = 24;

/*
 * Withdrawal destinations. Anatomy follows Coinbase's address-book allowlist (nickname,
 * address, date added, row actions, "Add address") with the pending/active states of an
 * exchange withdrawal whitelist:
 * https://mobbin.com/screens/456f615c-3e60-47cc-8c97-0b44151d46ca
 */
export function WithdrawalsTab() {
  const connected = useWallet((s) => s.service.connected);
  const tradingWallets = useWallet((s) => s.service.tradingWallets);
  const destinations = useSettings((s) => s.withdrawalDestinations);
  const addDestination = useSettings((s) => s.addWithdrawalDestination);
  const removeDestination = useSettings((s) => s.removeWithdrawalDestination);
  const now = useNow();
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = address.trim();
  const addressError = !trimmed
    ? null
    : !isBase58Address(trimmed)
      ? "Not a Solana address (base58, 32 to 44 characters)."
      : connected?.address === trimmed
        ? "That's your connected wallet. It's already the default destination."
        : tradingWallets.some((w) => w.address === trimmed)
          ? "That's one of your trading wallets."
          : destinations.some((d) => d.address === trimmed)
            ? "Already in your list."
            : null;
  const canSubmit = connected !== null && trimmed !== "" && addressError === null && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    const name = label.trim() || "Destination";
    setBusy(true);
    setError(null);
    try {
      const approved = await getServices().wallet.approveWithConnected({
        title: "Add withdrawal destination",
        lines: [
          { label: "Label", value: name },
          { label: "Address", value: shortAddr(trimmed, 6, 6) },
          { label: "Usable", value: "After a 24 h delay" },
          { label: "Cost", value: "Signature only, no transaction" },
        ],
      });
      if (!approved) {
        setError("Signature rejected in the wallet. The destination was not added.");
        return;
      }
      addDestination(trimmed, name);
      setLabel("");
      setAddress("");
      useToasts.getState().push({ kind: "success", title: `Added ${name}`, body: "Usable for withdrawals in 24 h." });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = (id: string, name: string) => {
    removeDestination(id);
    useToasts.getState().push({ kind: "info", title: `Removed ${name}` });
  };

  return (
    <>
      <TabHeader
        title="Withdrawals"
        description="Where the trading wallet can send SOL. Your connected wallet is always one click away; anything else waits 24 hours."
      />

      <Group title="Destinations">
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="zf-label flex-1">Destination</span>
          <span className="zf-label w-32 text-right">Status</span>
          <span className="w-6" />
        </div>
        <div className="flex items-center gap-2 px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-sm text-fg">
              Connected wallet
              <Chip>Default</Chip>
            </div>
            {connected ? (
              <div className="flex items-center gap-1 font-mono text-xs text-muted">
                {PROVIDER_NAME[connected.provider]} {shortAddr(connected.address, 6, 6)}
                <CopyButton text={connected.address} label="Copy connected wallet address" />
              </div>
            ) : (
              <div className="text-xs text-dim">No wallet connected</div>
            )}
          </div>
          <span className="w-32 text-right text-sm text-buy">{connected ? "Instant" : "—"}</span>
          <span className="w-6" />
        </div>
        {destinations.map((d) => {
          const pending = d.activeAt > now;
          return (
            <div key={d.id} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-fg">{d.label}</div>
                <div className="flex items-center gap-1 font-mono text-xs text-muted">
                  {shortAddr(d.address, 6, 6)}
                  <CopyButton text={d.address} label={`Copy ${d.label} address`} />
                  <span className="font-sans text-dim">· added {fmtDate(d.addedAt)}</span>
                </div>
              </div>
              {pending ? (
                <span
                  title="Pending: usable after the 24 h delay"
                  className="flex w-32 items-center justify-end gap-1 text-right text-sm text-warn"
                >
                  <Clock className="icon-sm" />
                  <span className="sr-only">Pending, usable</span>
                  in <span className="font-mono">{fmtCountdown(d.activeAt - now)}</span>
                </span>
              ) : (
                <span className="w-32 text-right text-sm text-buy">Active</span>
              )}
              <IconButton label={`Remove ${d.label}`} onClick={() => remove(d.id, d.label)}>
                <Trash2 className="icon-sm" />
              </IconButton>
            </div>
          );
        })}
        {destinations.length === 0 && <div className="px-3 py-2 text-xs text-dim">No other destinations.</div>}
      </Group>

      <Group title="Add a destination" description="Needs a signature from your connected wallet, then a 24-hour delay.">
        <form className="space-y-3 p-3" onSubmit={(e) => void submit(e)}>
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="Label" htmlFor="zf-wd-label">
              <input
                id="zf-wd-label"
                className="zf-input"
                value={label}
                maxLength={LABEL_MAX}
                placeholder="Cold wallet"
                onChange={(e) => setLabel(e.target.value)}
              />
            </Field>
            <Field label="Address" htmlFor="zf-wd-address" className="sm:col-span-2">
              <input
                id="zf-wd-address"
                className="zf-input font-mono"
                value={address}
                spellCheck={false}
                autoComplete="off"
                placeholder="Solana address"
                aria-invalid={addressError !== null}
                aria-describedby={addressError ? "zf-wd-address-error" : undefined}
                onChange={(e) => {
                  setAddress(e.target.value);
                  setError(null);
                }}
              />
            </Field>
          </div>
          {addressError && (
            <div id="zf-wd-address-error" className="text-xs text-sell">
              {addressError}
            </div>
          )}
          {error && <div className="text-xs text-sell">{error}</div>}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-dim">
              {connected ? "Your wallet will ask you to sign. It's not a transaction." : "Connect a wallet first."}
            </span>
            <Button type="submit" size="sm" variant="primary" disabled={!canSubmit}>
              {busy ? "Waiting for wallet…" : "Sign and add"}
            </Button>
          </div>
        </form>
      </Group>

      <Note tone="info">
        Why the delay: if someone gets into this browser, they can't add their own address and drain the trading wallet before you notice. A
        pending address shows here for 24 hours. Remove anything you don't recognise.
      </Note>
    </>
  );
}
