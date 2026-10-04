import { Clock, Trash2 } from "lucide-react";
import { useState } from "react";
import { IconButton } from "../../components/ui/Button";
import { CopyButton } from "../../components/ui/controls";
import { HoldButton } from "../../components/ui/HoldButton";
import { isBase58Address } from "../../lib/address";
import { fmtDate, shortAddr } from "../../lib/format";
import { useNow } from "../../lib/useNow";
import { getServices } from "../../services";
import { useSettings, type WithdrawalDestination } from "../../state/settings";
import { useWallet } from "../../state/wallet";
import { errorMessage, fmtCountdown } from "./format";
import { Block, InlineStatus, Row, Rows, SubHeader, Tag, useTransient } from "./ui";

const PROVIDER_NAME = { phantom: "Phantom", solflare: "Solflare", backpack: "Backpack" } as const;
const LABEL_MAX = 24;

/*
 * Withdrawal destinations (DESIGN.md 5.5): the connected wallet is the default and usable at
 * once; any other address needs a 1 s hold, a connected-wallet signature and a 24 h delay, shown
 * as an "Active in 23h 12m" badge. No toasts: the list itself confirms, removals offer Undo.
 * Address-book allowlist anatomy after Coinbase:
 * https://mobbin.com/screens/456f615c-3e60-47cc-8c97-0b44151d46ca
 */
export function WithdrawalDestinations() {
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
  const [saved, setSaved] = useTransient<string>(6000);
  const [removed, setRemoved] = useTransient<WithdrawalDestination>(6000);

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
  const canAdd = connected !== null && trimmed !== "" && addressError === null && !busy;

  const add = async () => {
    if (!canAdd) return;
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
      setSaved(name);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = (d: WithdrawalDestination) => {
    removeDestination(d.id);
    setRemoved(d);
  };

  // Undo puts back exactly what was removed, including its original activation time.
  const undoRemove = () => {
    if (!removed) return;
    const entry = removed;
    useSettings.setState((s) => ({ withdrawalDestinations: [...s.withdrawalDestinations, entry] }));
    setRemoved(null);
  };

  return (
    <>
      <SubHeader
        anchor="withdrawals"
        actions={
          removed ? (
            <InlineStatus onUndo={undoRemove}>Removed {removed.label}</InlineStatus>
          ) : saved ? (
            <InlineStatus>Saved {saved} · usable in 24 h</InlineStatus>
          ) : null
        }
      >
        Withdrawal destinations
      </SubHeader>
      <Rows>
        <Row
          label={
            <span className="inline-flex items-center gap-2">
              Connected wallet <Tag>Default</Tag>
            </span>
          }
          help={
            connected ? (
              <span className="inline-flex items-center gap-1">
                {PROVIDER_NAME[connected.provider]} <span className="font-mono text-fg-2">{shortAddr(connected.address)}</span>
                <CopyButton text={connected.address} label="Copy connected wallet address" />
              </span>
            ) : (
              "No wallet connected."
            )
          }
        >
          <Tag>{connected ? "Active" : "Not connected"}</Tag>
        </Row>
        {destinations.map((d) => {
          const pending = d.activeAt > now;
          return (
            <Row
              key={d.id}
              label={d.label}
              help={
                <span className="inline-flex items-center gap-1">
                  <span className="font-mono text-fg-2">{shortAddr(d.address)}</span>
                  <CopyButton text={d.address} label={`Copy ${d.label} address`} />
                  <span>· added {fmtDate(d.addedAt)}</span>
                </span>
              }
            >
              {pending ? (
                <Tag tone="warn">
                  <Clock />
                  Active in {fmtCountdown(d.activeAt - now)}
                </Tag>
              ) : (
                <Tag>Active</Tag>
              )}
              <IconButton label={`Remove ${d.label}`} onClick={() => remove(d)}>
                <Trash2 />
              </IconButton>
            </Row>
          );
        })}
        <Block>
          <div className="grid gap-2 sm:grid-cols-[160px_minmax(0,1fr)]">
            <label className="block">
              <span className="sr-only">Label</span>
              <input
                className="zf-input max-md:h-11"
                value={label}
                maxLength={LABEL_MAX}
                placeholder="Label, e.g. Cold wallet"
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="sr-only">Address</span>
              <input
                className="zf-input font-mono max-md:h-11"
                value={address}
                spellCheck={false}
                autoComplete="off"
                placeholder="Solana address"
                aria-invalid={addressError !== null}
                aria-describedby={addressError ? "zf-wd-error" : undefined}
                onChange={(e) => {
                  setAddress(e.target.value);
                  setError(null);
                }}
              />
            </label>
          </div>
          {addressError && (
            <div id="zf-wd-error" className="mt-1 text-label text-sell">
              {addressError}
            </div>
          )}
          {error && <div className="mt-1 text-label text-sell">{error}</div>}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <span className="max-w-[44ch] text-label text-fg-3">
              {connected
                ? "Hold to confirm, then sign in your wallet (not a transaction). New addresses wait 24 hours, so an intruder can't add one and drain the wallet before you notice."
                : "Connect a wallet first: it signs new destinations."}
            </span>
            <HoldButton tone="primary" disabled={!canAdd} onConfirm={add} className="max-md:h-11">
              {busy ? "Waiting for wallet…" : "Hold to add destination"}
            </HoldButton>
          </div>
        </Block>
      </Rows>
    </>
  );
}
