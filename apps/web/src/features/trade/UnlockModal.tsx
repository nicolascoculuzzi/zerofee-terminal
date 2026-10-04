import { CircleAlert, KeyRound, Lock } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { shortAddr } from "../../lib/format";
import { getServices } from "../../services";
import { useSettings } from "../../state/settings";
import { useUi } from "../../state/ui";
import { useWallet } from "../../state/wallet";

/*
 * Unlock the trading keystore (DESIGN.md 4.17): a 400 px dialog whose title names what the unlock is for
 * ("Unlock to trade $WIF"), the wallet being unlocked as the description, one passphrase field with its
 * error inline, and a 52 px footer with the primary action last. The key is decrypted in this browser
 * only. The simulated keystore accepts any passphrase; the passkey path needs none.
 */
export function UnlockModal() {
  const unlock = useUi((s) => s.unlock);
  const close = useUi((s) => s.closeUnlock);
  const autoLock = useSettings((s) => s.autoLockMinutes);
  const wallets = useWallet((s) => s.service.tradingWallets);
  const activeAddress = useWallet((s) => s.activeAddress);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"password" | "passkey" | null>(null);
  const hasPasskey = wallets.some((w) => w.unlockMethod === "passkey");
  const simulated = getServices().simulated;
  const passkeys = getServices().features.passkey;
  const active = wallets.find((w) => w.address === activeAddress) ?? wallets.find((w) => !w.archived) ?? null;
  const others = wallets.filter((w) => !w.archived).length - 1;
  const title = unlock.reason ? unlock.reason.replace(/\.$/, "") : "Unlock trading wallet";

  const done = () => {
    const next = unlock.onUnlocked;
    setPassword("");
    setError(null);
    close();
    next?.();
  };

  const run = async (kind: "password" | "passkey") => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "password") await getServices().wallet.unlock(password);
      else await getServices().wallet.unlockWithPasskey();
      done();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      open={unlock.open}
      onClose={close}
      title={title}
      description={
        active ? (
          <>
            {active.label} · <span className="zf-num">{shortAddr(active.address)}</span>
            {others > 0 && ` · ${others === 1 ? "1 more wallet" : `${others} more wallets`} in this keystore`}
          </>
        ) : (
          "The keystore is locked"
        )
      }
      width={400}
      footer={
        <div className="flex items-center justify-end gap-2">
          {passkeys && (
            <Button size="md" variant="secondary" onClick={() => void run("passkey")} disabled={busy !== null} icon={<KeyRound />}>
              {busy === "passkey" ? "Waiting for passkey…" : hasPasskey ? "Use passkey" : "Use passkey (simulated)"}
            </Button>
          )}
          <Button type="submit" form="unlock-form" variant="primary" size="md" disabled={busy !== null || !password}>
            {busy === "password" ? "Unlocking…" : "Unlock"}
          </Button>
        </div>
      }
    >
      <form
        id="unlock-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (password) void run("password");
        }}
      >
        <label htmlFor="unlock-passphrase" className="zf-label mb-1.5 block">
          Passphrase
        </label>
        <input
          id="unlock-passphrase"
          data-autofocus
          type="password"
          autoComplete="current-password"
          className="zf-input"
          value={password}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "unlock-error" : "unlock-note"}
          onChange={(e) => {
            setPassword(e.target.value);
            if (error) setError(null);
          }}
          placeholder={simulated ? "Simulated keystore: any passphrase" : "Keystore passphrase"}
        />
        {error ? (
          <p id="unlock-error" role="alert" className="mt-2 flex items-start gap-1.5 text-label text-sell">
            <CircleAlert className="icon-xs mt-0.5" />
            {error}
          </p>
        ) : (
          <p id="unlock-note" className="mt-2 flex items-start gap-1.5 text-label text-fg-3">
            <Lock className="icon-xs mt-0.5" />
            Decrypted in this browser only. {autoLock > 0 ? `Locks after ${autoLock} min idle.` : "Stays open until you lock it."}
          </p>
        )}
      </form>
    </Modal>
  );
}
