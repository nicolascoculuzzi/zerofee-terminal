import { type FormEvent, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Switch } from "../../components/ui/controls";
import { Modal } from "../../components/ui/Modal";
import { isBase58Address } from "../../lib/address";
import { shortAddr } from "../../lib/format";
import { useToasts } from "../../state/toasts";
import { MAX_TRACKED_WALLETS, type TrackedWallet, useTrackers } from "../../state/trackers";
import { firstGlyph } from "./TradeRow";

const TAG_MAX = 2;
const NAME_MAX = 32;

/*
 * Add / edit wallet. Anatomy follows Copilot Money's "Add Bitcoin address" dialog (one address
 * field, Cancel + primary action bottom-right) with Shopify's labelled form fields:
 * https://mobbin.com/screens/c85be62b-d221-457f-8e57-ef54a4ad2d22
 * https://mobbin.com/screens/9190869b-4dd3-4d42-8da4-33ada99b5def
 */
function WalletForm({ editing, onClose }: { editing: TrackedWallet | null; onClose: () => void }) {
  const [emoji, setEmoji] = useState(editing?.emoji ?? "");
  const [name, setName] = useState(editing?.name ?? "");
  const [address, setAddress] = useState(editing?.address ?? "");
  const [alerts, setAlerts] = useState(editing?.alerts ?? true);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const addr = address.trim();
    if (!isBase58Address(addr)) {
      setError("Enter a valid Solana address (base58, 32–44 characters).");
      return;
    }
    const { wallets, addWallet, updateWallet } = useTrackers.getState();
    const clash = wallets.find((w) => w.address === addr && w.address !== editing?.address);
    if (clash) {
      setError(`Already tracked as “${clash.name}”.`);
      return;
    }
    const label = name.trim() || shortAddr(addr);
    const push = useToasts.getState().push;
    if (editing) {
      updateWallet(editing.address, { address: addr, name: label, emoji, alerts });
      push({ kind: "success", title: "Wallet updated", body: label, ttl: 2000 });
    } else {
      if (wallets.length >= MAX_TRACKED_WALLETS) {
        setError(`The tracker is full (${MAX_TRACKED_WALLETS.toLocaleString("en-US")} wallets). Remove some first.`);
        return;
      }
      if (!addWallet({ address: addr, name: label, emoji, alerts })) {
        setError("Couldn't add this wallet.");
        return;
      }
      push({ kind: "success", title: "Wallet added", body: label, ttl: 2000 });
    }
    onClose();
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span className="zf-label">Tag (optional)</span>
        <input
          className="zf-input w-16 text-center"
          value={emoji}
          placeholder={firstGlyph(name || address || "?")}
          onChange={(e) => setEmoji(Array.from(e.target.value.trim()).slice(0, TAG_MAX).join(""))}
          aria-describedby="wallet-tag-hint"
        />
        <span id="wallet-tag-hint" className="text-xs text-dim">
          Up to {TAG_MAX} characters shown before the name. Defaults to its first letter.
        </span>
      </label>
      <label className="flex flex-col gap-1">
        <span className="zf-label">Wallet name</span>
        <input
          className="zf-input"
          value={name}
          maxLength={NAME_MAX}
          placeholder="Optional; defaults to the short address"
          onChange={(e) => setName(e.target.value)}
          data-autofocus={editing ? true : undefined}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="zf-label">Wallet address</span>
        <input
          className="zf-input font-mono"
          value={address}
          spellCheck={false}
          autoComplete="off"
          placeholder="Solana address"
          onChange={(e) => {
            setAddress(e.target.value);
            setError(null);
          }}
          data-autofocus={editing ? undefined : true}
          aria-invalid={error ? true : undefined}
        />
      </label>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm">
          <span className="block text-fg">Alerts</span>
          <span className="block text-xs text-dim">Toast and sound when this wallet trades.</span>
        </span>
        <Switch checked={alerts} onChange={setAlerts} label="Alerts for this wallet" />
      </div>
      {error && (
        <p role="alert" className="text-xs text-sell">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2 border-t border-line pt-3">
        <Button variant="ghost" size="md" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="md">
          {editing ? "Save" : "Add wallet"}
        </Button>
      </div>
    </form>
  );
}

export function WalletModal({ open, editing, onClose }: { open: boolean; editing: TrackedWallet | null; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title={editing ? "Edit wallet" : "Add wallet"} width={420}>
      <WalletForm key={editing?.address ?? "new"} editing={editing} onClose={onClose} />
    </Modal>
  );
}
