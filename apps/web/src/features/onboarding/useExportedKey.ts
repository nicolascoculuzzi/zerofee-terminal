import { useCallback, useEffect, useState } from "react";
import { getServices } from "../../services";

export interface ExportedKey {
  /** The base58 key once the signer returns it. */
  secret: string | null;
  error: string | null;
  /** Asks again (e.g. after an unlock). */
  retry: () => void;
}

/** Fetches a trading wallet's key from the wallet service for the backup and export views. */
export function useExportedKey(walletId: string): ExportedKey {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ secret: string | null; error: string | null }>({ secret: null, error: null });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the request on retry
  useEffect(() => {
    let live = true;
    setState({ secret: null, error: null });
    getServices()
      .wallet.exportKey(walletId)
      .then(
        (secret) => live && setState({ secret, error: null }),
        (e: unknown) => live && setState({ secret: null, error: e instanceof Error ? e.message : String(e) }),
      );
    return () => {
      live = false;
    };
  }, [walletId, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}
