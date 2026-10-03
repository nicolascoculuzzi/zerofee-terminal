import { FileUp } from "lucide-react";
import { useDeferredValue, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { shortAddr } from "../../lib/format";
import { useToasts } from "../../state/toasts";
import { MAX_TRACKED_WALLETS, useTrackers } from "../../state/trackers";
import { WalletGlyph } from "./TradeRow";
import { parseWalletImport } from "./walletImport";

const PREVIEW_ROWS = 6;
const SKIPPED_ROWS = 12;

const PLACEHOLDER = `Paste one wallet per line, for example:
<address> Smart money
Fresh whale:<address>
<address>,Dev wallet

or a JSON export from zerofee, BullX or GMGN.`;

function plural(n: number, noun: string): string {
  return `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;
}

/*
 * Import wallets. Anatomy follows Gemini Notebook's paste dialog (one large paste box, accepted
 * formats listed under it, single confirm action) and Klaviyo's import summary that reports
 * skipped rows before you commit:
 * https://mobbin.com/screens/7b363f63-caa2-4688-93ed-d72e19d9ae30
 * https://mobbin.com/screens/0bcc5375-69fe-4eda-91f6-8b28ca3a5e8b
 */
function ImportForm({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const deferred = useDeferredValue(text);
  const fileRef = useRef<HTMLInputElement>(null);
  const wallets = useTrackers((s) => s.wallets);
  const parsed = useMemo(() => parseWalletImport(deferred), [deferred]);
  const existing = useMemo(() => new Set(wallets.map((w) => w.address)), [wallets]);
  const fresh = useMemo(() => parsed.wallets.filter((w) => !existing.has(w.address)), [parsed, existing]);
  const already = parsed.wallets.length - fresh.length;
  const room = Math.max(0, MAX_TRACKED_WALLETS - wallets.length);
  const importable = Math.min(room, fresh.length);

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 5_000_000) {
      useToasts.getState().push({ kind: "error", title: "File too large", body: "Wallet lists over 5 MB aren't supported." });
      return;
    }
    setText(await file.text());
  };

  const commit = () => {
    const added = useTrackers.getState().importWallets(fresh);
    const skipped = parsed.wallets.length - added;
    useToasts.getState().push({
      kind: added > 0 ? "success" : "info",
      title: added > 0 ? `Imported ${plural(added, "wallet")}` : "Nothing new to import",
      body: skipped > 0 ? `${plural(skipped, "wallet")} already tracked or over the limit.` : undefined,
    });
    onClose();
  };

  return (
    <div className="flex flex-col gap-3">
      <textarea
        data-autofocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        placeholder={PLACEHOLDER}
        aria-label="Wallet list"
        className="h-40 w-full resize-y rounded-md border border-line-strong bg-bg p-2 font-mono text-xs outline-none placeholder:text-dim focus:border-accent"
      />
      <div className="flex items-start justify-between gap-3">
        <ul className="list-disc space-y-1 pl-4 text-xs text-muted">
          <li>zerofee JSON export</li>
          <li>GMGN text: address name · name:address · address,name</li>
          <li>BullX JSON: address or walletAddress with name, label or tag</li>
        </ul>
        <input
          ref={fileRef}
          type="file"
          accept=".json,.txt,.csv,application/json,text/plain,text/csv"
          className="hidden"
          onChange={(e) => {
            void loadFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <Button size="sm" variant="subtle" icon={<FileUp className="icon-sm" />} onClick={() => fileRef.current?.click()}>
          Load file
        </Button>
      </div>

      {parsed.error && (
        <p role="alert" className="text-xs text-sell">
          {parsed.error}
        </p>
      )}

      {parsed.format !== "empty" && !parsed.error && (
        <div className="rounded-md border border-line">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2 text-xs">
            <span className="font-semibold text-fg">{plural(parsed.wallets.length, "wallet")} found</span>
            <span className="text-muted">{fresh.length.toLocaleString("en-US")} new</span>
            {already > 0 && <span className="text-muted">{already.toLocaleString("en-US")} already tracked</span>}
            {parsed.duplicates > 0 && <span className="text-muted">{plural(parsed.duplicates, "duplicate")}</span>}
            {parsed.skipped.length > 0 && <span className="text-warn">{parsed.skipped.length.toLocaleString("en-US")} skipped</span>}
          </div>
          {fresh.length > 0 && (
            <ul className="py-1">
              {fresh.slice(0, PREVIEW_ROWS).map((w) => (
                <li key={w.address} className="flex h-6 items-center gap-2 px-3 text-xs">
                  <WalletGlyph emoji={w.emoji} name={w.name} />
                  <span className="min-w-0 flex-1 truncate text-fg">{w.name}</span>
                  <span className="font-mono text-dim">{shortAddr(w.address, 4, 4)}</span>
                  {w.alerts && <span className="text-2xs text-muted uppercase">Alerts</span>}
                </li>
              ))}
              {fresh.length > PREVIEW_ROWS && (
                <li className="px-3 pb-1 text-xs text-dim">and {plural(fresh.length - PREVIEW_ROWS, "more wallet")}</li>
              )}
            </ul>
          )}
          {parsed.skipped.length > 0 && (
            <div className="border-t border-line px-3 py-2">
              <div className="zf-label mb-1">Skipped</div>
              <ul className="space-y-1 text-xs">
                {parsed.skipped.slice(0, SKIPPED_ROWS).map((s) => (
                  <li key={s.where} className="flex gap-2">
                    <span className="w-16 shrink-0 text-dim">{s.where}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-muted" title={s.text}>
                      {s.text}
                    </span>
                    <span className="shrink-0 text-warn">{s.reason}</span>
                  </li>
                ))}
                {parsed.skipped.length > SKIPPED_ROWS && (
                  <li className="text-dim">and {plural(parsed.skipped.length - SKIPPED_ROWS, "more line")}</li>
                )}
              </ul>
            </div>
          )}
        </div>
      )}

      {fresh.length > room && (
        <p className="text-xs text-warn">
          The tracker holds {MAX_TRACKED_WALLETS.toLocaleString("en-US")} wallets: only the first {plural(room, "wallet")} will be imported.
        </p>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
        <Button variant="ghost" size="md" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" size="md" disabled={importable === 0} onClick={commit}>
          {importable > 0 ? `Import ${plural(importable, "wallet")}` : "Import"}
        </Button>
      </div>
    </div>
  );
}

export function ImportWalletsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Import wallets" width={560}>
      <ImportForm onClose={onClose} />
    </Modal>
  );
}
