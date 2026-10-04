import { KeyRound } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { getServices } from "../../services";
import { useSettings } from "../../state/settings";
import { useUi } from "../../state/ui";
import { useWallet } from "../../state/wallet";

/*
 * Unlock the trading keystore (DESIGN.md 4.17): a 400 px dialog, 44 px header, 16 px body, a
 * 52 px footer with the primary action last. The key is decrypted in this browser only. The
 * simulated keystore accepts any passphrase; the passkey path needs none.
 */
export function UnlockModal() {
  const unlock = useUi((s) => s.unlock);
  const close = useUi((s) => s.closeUnlock);
  const autoLock = useSettings((s) => s.autoLockMinutes);
  const wallets = useWallet((s) => s.service.tradingWallets);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"password" | "passkey" | null>(null);
  const hasPasskey = wallets.some((w) => w.unlockMethod === "passkey");
  const simulated = getServices().simulated;
  const passkeys = getServices().features.passkey;

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
      title="Unlock trading wallet"
      description={unlock.reason || "The keystore is locked"}
      width={400}
      footer={
        <div className="flex items-center justify-end gap-2">
          {passkeys && (
            <Button size="md" variant="secondary" onClick={() => void run("passkey")} disabled={busy !== null} icon={<KeyRound />}>
              {hasPasskey ? "Use passkey" : "Use passkey (simulated)"}
            </Button>
          )}
          <Button type="submit" form="unlock-form" variant="primary" size="md" disabled={busy !== null || !password}>
            Unlock
          </Button>
        </div>
      }
    >
      <form
        id="unlock-form"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (password) void run("password");
        }}
      >
        <p className="text-body text-fg-2">
          The key is decrypted in this browser only and locks again after{" "}
          {autoLock > 0 ? `${autoLock} minutes without activity` : "you lock it"}.
        </p>
        <label className="block space-y-1">
          <span className="zf-label">Passphrase</span>
          <input
            data-autofocus
            type="password"
            autoComplete="current-password"
            className="zf-input"
            value={password}
            aria-invalid={error ? true : undefined}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={simulated ? "Simulated keystore: any passphrase" : "Keystore passphrase"}
          />
        </label>
        {error && <p className="text-label text-sell">{error}</p>}
      </form>
    </Modal>
  );
}
