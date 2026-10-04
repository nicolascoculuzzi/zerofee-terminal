import { FileUp } from "lucide-react";
import { type DragEvent, useDeferredValue, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { WalletAvatar } from "../../components/ui/TokenAvatar";
import { cn } from "../../lib/cn";
import { fmtInt, shortAddr } from "../../lib/format";
import { MAX_TRACKED_WALLETS, useTrackers } from "../../state/trackers";
import { useWalletDialogs } from "./WalletModal";
import { parseWalletImport } from "./walletImport";

const PREVIEW_ROWS = 6;
const SKIPPED_ROWS = 8;
const MAX_FILE_BYTES = 5_000_000;

const PLACEHOLDER = `One wallet per line:
<address> Smart money
Fresh whale:<address>
<address>,Dev wallet

or a JSON export from zerofee, BullX or GMGN`;

function plural(n: number, noun: string): string {
  return `${fmtInt(n)} ${noun}${n === 1 ? "" : "s"}`;
}

/*
 * Import wallets (DESIGN.md 4.17: 560 px form modal; 2.5 allows a dashed border on the import
 * drop zone). Paste or drop a list, read what will happen, then import in one store write. No
 * success toast: the count in the Wallets tab and the highlighted rows confirm it (4.13).
 * Paste box plus accepted formats, after Gemini Notebook's paste dialog; skipped rows reported
 * before you commit, after Klaviyo's import summary:
 * https://mobbin.com/screens/7b363f63-caa2-4688-93ed-d72e19d9ae30
 * https://mobbin.com/screens/0bcc5375-69fe-4eda-91f6-8b28ca3a5e8b
 */
function ImportDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
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
    if (file.size > MAX_FILE_BYTES) {
      setFileError("Lists over 5 MB aren't supported.");
      return;
    }
    setFileError(null);
    setText(await file.text());
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    void loadFile(e.dataTransfer.files?.[0]);
  };

  const error = fileError ?? parsed.error;

  return (
    <Modal
      open
      onClose={onClose}
      title="Import wallets"
      description="Paste or drop a list. Nothing changes until you import."
      width={560}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            disabled={importable === 0}
            onClick={() => {
              useTrackers.getState().importWallets(fresh);
              onClose();
            }}
          >
            {importable > 0 ? `Import ${plural(importable, "wallet")}` : "Import wallets"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: drop target around the textarea; "Load file" is the keyboard path */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn("rounded-sm border border-dashed transition-colors", dragging ? "border-fg-2" : "border-hairline-strong")}
        >
          <textarea
            data-autofocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            placeholder={PLACEHOLDER}
            aria-label="Wallet list"
            aria-invalid={error ? true : undefined}
            className={cn(
              "block h-40 w-full resize-y rounded-sm p-2 font-mono text-label text-fg-1 placeholder:text-fg-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
              dragging ? "bg-surface-3" : "bg-surface-2",
            )}
          />
        </div>
        <div className="flex items-start justify-between gap-3">
          <ul className="space-y-1 text-label text-fg-3">
            <li>zerofee JSON export</li>
            <li>GMGN text: address name, name:address or address,name</li>
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
          <Button size="sm" variant="secondary" icon={<FileUp className="icon-sm" />} onClick={() => fileRef.current?.click()}>
            Load file
          </Button>
        </div>

        {error && (
          <p role="alert" className="text-label text-sell">
            {error}
          </p>
        )}

        {parsed.format !== "empty" && !error && (
          <div className="rounded-sm border border-hairline">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-hairline px-3 py-2 text-label">
              <span className="font-semibold text-fg-1">{plural(parsed.wallets.length, "wallet")} found</span>
              <span className="text-fg-2">{fmtInt(fresh.length)} new</span>
              {already > 0 && <span className="text-fg-2">{fmtInt(already)} already tracked</span>}
              {parsed.duplicates > 0 && <span className="text-fg-2">{plural(parsed.duplicates, "duplicate")}</span>}
              {parsed.skipped.length > 0 && <span className="text-warn">{fmtInt(parsed.skipped.length)} skipped</span>}
            </div>
            {fresh.length > 0 && (
              <ul className="py-1">
                {fresh.slice(0, PREVIEW_ROWS).map((w) => (
                  <li key={w.address} className="flex h-row items-center gap-2 px-3 text-data">
                    <WalletAvatar seed={w.address} label={w.name} tag={w.emoji} size={16} />
                    <span className="min-w-0 flex-1 truncate text-fg-1">{w.name}</span>
                    <span className="font-mono text-fg-3">{shortAddr(w.address)}</span>
                    {w.alerts && <span className="text-micro text-fg-2">Alerts on</span>}
                  </li>
                ))}
                {fresh.length > PREVIEW_ROWS && (
                  <li className="px-3 py-1 text-label text-fg-3">and {plural(fresh.length - PREVIEW_ROWS, "more wallet")}</li>
                )}
              </ul>
            )}
            {parsed.skipped.length > 0 && (
              <div className="border-t border-hairline px-3 py-2">
                <div className="zf-label mb-1">Skipped</div>
                <ul className="space-y-1 text-label">
                  {parsed.skipped.slice(0, SKIPPED_ROWS).map((s) => (
                    <li key={s.where} className="flex gap-2">
                      <span className="w-16 shrink-0 text-fg-3">{s.where}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-fg-2" title={s.text}>
                        {s.text}
                      </span>
                      <span className="shrink-0 text-warn">{s.reason}</span>
                    </li>
                  ))}
                  {parsed.skipped.length > SKIPPED_ROWS && (
                    <li className="text-fg-3">and {plural(parsed.skipped.length - SKIPPED_ROWS, "more line")}</li>
                  )}
                </ul>
              </div>
            )}
          </div>
        )}

        {fresh.length > room && (
          <p className="text-label text-warn">
            The tracker holds {fmtInt(MAX_TRACKED_WALLETS)} wallets: only the first {plural(room, "wallet")} will be imported.
          </p>
        )}
      </div>
    </Modal>
  );
}

export function ImportWalletsModal() {
  const open = useWalletDialogs((s) => s.kind === "import");
  const close = useWalletDialogs((s) => s.close);
  return open ? <ImportDialog onClose={close} /> : null;
}
