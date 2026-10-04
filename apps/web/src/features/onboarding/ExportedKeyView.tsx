import type { TradingWallet } from "../../services/walletService";
import { KeyReveal } from "./KeyReveal";
import { PassphraseGate } from "./PassphraseGate";
import { useExportedKey } from "./useExportedKey";

/** The key from the wallet service in the reveal view (the simulation's is labelled as such by KeyReveal). */
export function ExportedKeyView({ wallet, simulated }: { wallet: TradingWallet; simulated: boolean }) {
  const exported = useExportedKey(wallet.id);
  const { secret, error } = exported;
  if (exported.needsPassword) return <PassphraseGate exported={exported} />;
  if (error) return <p className="text-label text-sell">{error}</p>;
  if (!secret) return <p className="text-label text-fg-3">Asking the signer for the key…</p>;
  return <KeyReveal secret={secret} wallet={wallet} simulated={simulated} />;
}
