import { useCallback, useEffect, useState } from "react";
import { getServices } from "../../services";

export interface ExportedKey {
  /** The base58 key once the signer returns it. Lives in this component's state only. */
  secret: string | null;
  error: string | null;
  /** Asks again (e.g. after an unlock). */
  retry: () => void;
  /** The signer re-asks for the keystore passphrase before it hands the key out (live signer). */
  needsPassword: boolean;
  /** Sends the passphrase; the key (or an error) follows. */
  submitPassword: (password: string) => void;
  busy: boolean;
}

/** Fetches a trading wallet's key from the wallet service for the backup and export views. */
export function useExportedKey(walletId: string): ExportedKey {
  const needsPassword = getServices().features.exportNeedsPassword;
  const [attempt, setAttempt] = useState(0);
  const [password, setPassword] = useState<string | null>(null);
  const [state, setState] = useState<{ secret: string | null; error: string | null; busy: boolean }>({
    secret: null,
    error: null,
    busy: false,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the request on retry
  useEffect(() => {
    if (needsPassword && password === null) return;
    let live = true;
    setState({ secret: null, error: null, busy: true });
    getServices()
      .wallet.exportKey(walletId, password ?? undefined)
      .then(
        (secret) => live && setState({ secret, error: null, busy: false }),
        (e: unknown) => {
          if (!live) return;
          setState({ secret: null, error: e instanceof Error ? e.message : String(e), busy: false });
          // A wrong passphrase goes back to the form.
          setPassword(null);
        },
      );
    return () => {
      live = false;
    };
  }, [walletId, attempt, password, needsPassword]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const submitPassword = useCallback((pw: string) => setPassword(pw), []);
  return { ...state, retry, needsPassword: needsPassword && state.secret === null, submitPassword };
}
