import { KeyRound, Lock } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { getServices } from "../../services";
import { useSettings } from "../../state/settings";
import { useUi } from "../../state/ui";
import { useWallet } from "../../state/wallet";

export function UnlockModal() {
  const unlock = useUi((s) => s.unlock);
  const close = useUi((s) => s.closeUnlock);
  const autoLock = useSettings((s) => s.autoLockMinutes);
  const wallets = useWallet((s) => s.service.tradingWallets);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hasPasskey = wallets.some((w) => w.unlockMethod === "passkey");
  const demo = getServices().simulated;

  const done = () => {
    const next = unlock.onUnlocked;
    setPassword("");
    setError(null);
    close();
    next?.();
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await getServices().wallet.unlock(password);
      done();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const passkey = async () => {
    setBusy(true);
    try {
      await getServices().wallet.unlockWithPasskey();
      done();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={unlock.open} onClose={close} title="Unlock trading wallet" width={380}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex items-start gap-2 rounded-md bg-panel-2 p-3 text-sm text-muted">
          <Lock className="icon-md mt-1 shrink-0 text-warn" />
          <span>
            {unlock.reason || "Your keystore is locked."} The key is decrypted in this browser only and locks again after{" "}
            {autoLock > 0 ? `${autoLock} min idle` : "you lock it"}.
          </span>
        </div>
        <label className="block space-y-1">
          <span className="zf-label">Password</span>
          <input
            data-autofocus
            type="password"
            autoComplete="current-password"
            className="zf-input h-8"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={demo ? "Demo wallet: any password" : "Keystore password"}
          />
        </label>
        {error && <div className="text-xs text-sell">{error}</div>}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" size="md" className="flex-1" disabled={busy || !password}>
            {busy ? "Unlocking…" : "Unlock"}
          </Button>
          <Button size="md" variant="outline" onClick={() => void passkey()} disabled={busy} icon={<KeyRound className="icon-md" />}>
            {hasPasskey ? "Passkey" : "Passkey (demo)"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
