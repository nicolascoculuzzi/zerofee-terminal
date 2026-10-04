import { type FormEvent, type ReactNode, useId, useState } from "react";
import { create } from "zustand";
import { Button } from "../../components/ui/Button";
import { Switch } from "../../components/ui/controls";
import { Modal } from "../../components/ui/Modal";
import { WalletAvatar } from "../../components/ui/TokenAvatar";
import { isBase58Address } from "../../lib/address";
import { fmtInt, shortAddr } from "../../lib/format";
import { MAX_TRACKED_WALLETS, type TrackedWallet, useTrackers } from "../../state/trackers";

/** Which wallet dialog is open; panes, menus and empty states open them, the page renders them. */
export const useWalletDialogs = create<{
  kind: "add" | "edit" | "import" | null;
  wallet: TrackedWallet | null;
  openAdd(): void;
  openEdit(wallet: TrackedWallet): void;
  openImport(): void;
  close(): void;
}>()((set) => ({
  kind: null,
  wallet: null,
  openAdd: () => set({ kind: "add", wallet: null }),
  openEdit: (wallet) => set({ kind: "edit", wallet }),
  openImport: () => set({ kind: "import", wallet: null }),
  close: () => set({ kind: null, wallet: null }),
}));

const TAG_MAX = 2;
const NAME_MAX = 32;

/** One or two characters, no spaces (the user's own tag; it only shows inside the avatar). */
function cleanTag(raw: string): string {
  return Array.from(raw.replace(/\s+/g, "")).slice(0, TAG_MAX).join("");
}

function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="zf-label">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${htmlFor}-msg`} role="alert" className="text-label text-sell">
          {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-msg`} className="text-label text-fg-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/*
 * Add / edit wallet (DESIGN.md 5.4: 400 px; tag optional with no default, name, address checked
 * as base58, alerts switch). Header, body padding and a footer with the primary action last per
 * 4.17, after Linear's dialogs: https://mobbin.com/screens/eddaff7c-37b8-4382-b53c-e4e09c1003d0
 * No success toast: the new row highlights in the list (DESIGN.md 4.13 "never toast").
 */
function WalletForm({ editing, formId, onDone }: { editing: TrackedWallet | null; formId: string; onDone: () => void }) {
  const id = useId();
  const [tag, setTag] = useState(editing?.emoji ?? "");
  const [name, setName] = useState(editing?.name ?? "");
  const [address, setAddress] = useState(editing?.address ?? "");
  const [alerts, setAlerts] = useState(editing?.alerts ?? true);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const addr = address.trim();
  const shapeError = addr && !isBase58Address(addr) ? "Not a Solana address: base58, 32 to 44 characters." : null;
  const shownError = error ?? (touched ? shapeError : null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!addr) {
      setError("Enter the wallet's address.");
      return;
    }
    if (shapeError) {
      setError(shapeError);
      return;
    }
    const { wallets, addWallet, updateWallet } = useTrackers.getState();
    const clash = wallets.find((w) => w.address === addr && w.address !== editing?.address);
    if (clash) {
      setError(`Already tracked as “${clash.name}”.`);
      return;
    }
    const label = name.trim() || shortAddr(addr);
    if (editing) {
      updateWallet(editing.address, { address: addr, name: label, emoji: tag, alerts });
    } else {
      if (wallets.length >= MAX_TRACKED_WALLETS) {
        setError(`The tracker holds ${fmtInt(MAX_TRACKED_WALLETS)} wallets. Remove some first.`);
        return;
      }
      if (!addWallet({ address: addr, name: label, emoji: tag, alerts })) {
        setError("Couldn't add this wallet.");
        return;
      }
    }
    onDone();
  };

  const preview = name.trim() || (addr ? shortAddr(addr) : "Wallet");
  return (
    <form id={formId} onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-end gap-3">
        <Field label="Tag" htmlFor={`${id}-tag`}>
          <div className="flex items-center gap-2">
            <WalletAvatar seed={addr || preview} label={preview} tag={tag} size={24} />
            <input
              id={`${id}-tag`}
              className="zf-input w-12 text-center"
              value={tag}
              placeholder="–"
              maxLength={8}
              onChange={(e) => setTag(cleanTag(e.target.value))}
              aria-describedby={`${id}-tag-hint`}
            />
          </div>
        </Field>
        <Field label="Name" htmlFor={`${id}-name`}>
          <input
            id={`${id}-name`}
            className="zf-input"
            value={name}
            maxLength={NAME_MAX}
            placeholder={addr ? shortAddr(addr) : "Optional"}
            onChange={(e) => setName(e.target.value)}
            data-autofocus={editing ? true : undefined}
          />
        </Field>
      </div>
      <p id={`${id}-tag-hint`} className="-mt-2 text-label text-fg-3">
        The tag is optional: up to {TAG_MAX} characters inside the avatar. Without one, the avatar shows the name's first letter.
      </p>
      <Field label="Address" htmlFor={`${id}-addr`} error={shownError}>
        <input
          id={`${id}-addr`}
          className="zf-input font-mono"
          value={address}
          spellCheck={false}
          autoComplete="off"
          placeholder="Solana address"
          onChange={(e) => {
            setAddress(e.target.value);
            setError(null);
          }}
          onBlur={() => setTouched(true)}
          data-autofocus={editing ? undefined : true}
          aria-invalid={shownError ? true : undefined}
          aria-describedby={shownError ? `${id}-addr-msg` : undefined}
        />
      </Field>
      <div className="flex items-center justify-between gap-3">
        <span>
          <span className="block text-data text-fg-1">Alerts</span>
          <span className="block text-label text-fg-3">Sound and a toast when this wallet trades.</span>
        </span>
        <Switch checked={alerts} onChange={setAlerts} label="Alerts for this wallet" />
      </div>
    </form>
  );
}

export function WalletModal() {
  const kind = useWalletDialogs((s) => s.kind);
  const wallet = useWalletDialogs((s) => s.wallet);
  const close = useWalletDialogs((s) => s.close);
  const formId = useId();
  const open = kind === "add" || kind === "edit";
  const editing = kind === "edit" ? wallet : null;
  return (
    <Modal
      open={open}
      onClose={close}
      title={editing ? "Edit wallet" : "Add wallet"}
      width={400}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="md" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" size="md">
            {editing ? "Save wallet" : "Add wallet"}
          </Button>
        </div>
      }
    >
      {open && <WalletForm key={editing?.address ?? "new"} editing={editing} formId={formId} onDone={close} />}
    </Modal>
  );
}
