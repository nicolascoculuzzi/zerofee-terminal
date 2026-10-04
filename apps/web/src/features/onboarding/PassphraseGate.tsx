import { KeyRound } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/Button";
import type { ExportedKey } from "./useExportedKey";

/**
 * The signer hands a key out only with the keystore passphrase again (packages/signer: export re-checks
 * it). A compact form in place of the key view (DESIGN.md 4.19, 4.23): one field, one secondary action,
 * the error inline.
 */
export function PassphraseGate({ exported, label = "Show key" }: { exported: ExportedKey; label?: string }) {
  const [pw, setPw] = useState("");
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (pw) exported.submitPassword(pw);
        setPw("");
      }}
    >
      <label className="block space-y-1">
        <span className="zf-label">Keystore passphrase</span>
        <input
          type="password"
          autoComplete="current-password"
          className="zf-input max-md:h-11"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          aria-invalid={exported.error ? true : undefined}
        />
      </label>
      <p className="text-label text-fg-3">The signer asks for it again before it shows a key. It stays in this browser.</p>
      {exported.error && <p className="text-label text-sell">{exported.error}</p>}
      <Button type="submit" size="md" variant="secondary" icon={<KeyRound />} disabled={!pw || exported.busy}>
        {exported.busy ? "Checking" : label}
      </Button>
    </form>
  );
}
