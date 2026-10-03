import { ClipboardPaste, Download, FileUp, Trash2 } from "lucide-react";
import { type ChangeEvent, type FormEvent, useRef, useState } from "react";
import { Button, IconButton } from "../../components/ui/Button";
import { CopyButton, Segmented } from "../../components/ui/controls";
import { isBase58Address } from "../../lib/address";
import { downloadText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { normalizeHandle } from "../../lib/filters";
import { fmtDate, shortAddr } from "../../lib/format";
import { type BlacklistKind, useSettings } from "../../state/settings";
import { errorMessage } from "./format";
import { Field, Group, TabHeader, type Tone } from "./ui";

interface KindInfo {
  id: BlacklistKind;
  /** Segment label. */
  short: string;
  title: string;
  field: string;
  placeholder: string;
  hint: string;
  handle: boolean;
}

const KINDS: KindInfo[] = [
  {
    id: "tokens",
    short: "Tokens",
    title: "Tokens",
    field: "Token mint",
    placeholder: "Mint address",
    hint: "Hides the token itself.",
    handle: false,
  },
  {
    id: "devs",
    short: "Devs",
    title: "Devs",
    field: "Dev wallet",
    placeholder: "Creator wallet address",
    hint: "Hides every token this wallet creates.",
    handle: false,
  },
  {
    id: "fundingWallets",
    short: "Funders",
    title: "Funding wallets",
    field: "Funding wallet",
    placeholder: "Funder wallet address",
    hint: "Hides tokens whose creator was funded by this wallet.",
    handle: false,
  },
  {
    id: "xHandles",
    short: "X handles",
    title: "X handles",
    field: "X handle",
    placeholder: "@handle or x.com/handle",
    hint: "Hides tokens that link this X account.",
    handle: true,
  },
];

const HANDLE_RE = /^[a-z0-9_]{1,15}$/;
const NOTE_MAX = 80;
const IMPORT_MAX_ENTRIES = 5000;
const IMPORT_MAX_BYTES = 1_000_000;

const RESULT_TONE: Record<Tone, string> = {
  neutral: "text-fg-2",
  info: "text-info",
  warn: "text-warn",
  buy: "text-buy",
  sell: "text-sell",
};

function normalizeValue(kind: KindInfo, raw: string): string {
  return kind.handle ? normalizeHandle(raw) : raw.trim();
}

function validate(kind: KindInfo, value: string): string | null {
  if (kind.handle) return HANDLE_RE.test(value) ? null : "X handles are 1 to 15 letters, digits or underscores.";
  return isBase58Address(value) ? null : "Not a Solana address (base58, 32 to 44 characters).";
}

interface ImportEntry {
  kind: BlacklistKind;
  value: string;
  note: string;
}

/** Accepts our export ({ kind: "blacklists", blacklists }) or a bare { tokens, devs, fundingWallets, xHandles } object. */
function parseImport(text: string): { entries: ImportEntry[]; invalid: number } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Not valid JSON.");
  }
  if (!data || typeof data !== "object") throw new Error("Expected a JSON object.");
  const root = data as Record<string, unknown>;
  const lists = root.kind === "blacklists" ? root.blacklists : root;
  if (!lists || typeof lists !== "object") throw new Error("No blacklists found in the file.");
  const source = lists as Record<string, unknown>;
  const entries: ImportEntry[] = [];
  let invalid = 0;
  let found = false;
  for (const kind of KINDS) {
    const raw = source[kind.id];
    if (!Array.isArray(raw)) continue;
    found = true;
    for (const item of raw) {
      const obj = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
      const rawValue = typeof item === "string" ? item : typeof obj?.value === "string" ? obj.value : null;
      const value = rawValue === null ? "" : normalizeValue(kind, rawValue);
      if (!value || validate(kind, value)) {
        invalid++;
        continue;
      }
      const note = typeof obj?.note === "string" ? obj.note.trim().slice(0, NOTE_MAX) : "";
      entries.push({ kind: kind.id, value, note });
    }
  }
  if (!found) throw new Error("No lists found. Expected tokens, devs, fundingWallets or xHandles arrays.");
  if (entries.length > IMPORT_MAX_ENTRIES)
    throw new Error(`Too many entries (${entries.length}); the limit is ${IMPORT_MAX_ENTRIES} per import.`);
  return { entries, invalid };
}

/*
 * Blacklists. Add row + list anatomy follows Salesforce's excluded-addresses list and
 * PlanetScale's IP restrictions (inline add field, value, remove):
 * https://mobbin.com/screens/5356a12c-cc81-4211-aaf9-f1e542c21023
 * https://mobbin.com/screens/4f361c07-36fd-42c4-8404-db2481db77f4
 */
export function BlacklistsTab() {
  const blacklists = useSettings((s) => s.blacklists);
  const addBlacklist = useSettings((s) => s.addBlacklist);
  const removeBlacklist = useSettings((s) => s.removeBlacklist);
  const [kindId, setKindId] = useState<BlacklistKind>("tokens");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [result, setResult] = useState<{ tone: Tone; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const kind = KINDS.find((k) => k.id === kindId) ?? KINDS[0]!;
  const list = blacklists[kind.id];
  const total = KINDS.reduce((n, k) => n + blacklists[k.id].length, 0);

  const add = (e: FormEvent) => {
    e.preventDefault();
    const v = normalizeValue(kind, value);
    if (!v) return;
    const invalid = validate(kind, v);
    if (invalid) {
      setError(invalid);
      return;
    }
    if (list.some((entry) => entry.value === v)) {
      setError("Already on this list.");
      return;
    }
    addBlacklist(kind.id, v, note.trim().slice(0, NOTE_MAX));
    setValue("");
    setNote("");
    setError(null);
  };

  const exportJson = () => {
    const payload = { app: "zerofee", kind: "blacklists", v: 1, exportedAt: new Date().toISOString(), blacklists };
    downloadText(`zerofee-blacklists-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2));
    setResult({ tone: "neutral", text: `Exported ${total} ${total === 1 ? "entry" : "entries"}.` });
  };

  const applyImport = (text: string) => {
    try {
      const { entries, invalid } = parseImport(text);
      let added = 0;
      let duplicates = 0;
      for (const entry of entries) {
        if (useSettings.getState().blacklists[entry.kind].some((x) => x.value === entry.value)) {
          duplicates++;
          continue;
        }
        addBlacklist(entry.kind, entry.value, entry.note);
        added++;
      }
      const parts = [`Added ${added} ${added === 1 ? "entry" : "entries"}`];
      if (duplicates > 0) parts.push(`${duplicates} already listed`);
      if (invalid > 0) parts.push(`${invalid} invalid skipped`);
      setResult({ tone: added > 0 ? "buy" : "neutral", text: `${parts.join(" · ")}.` });
      setPasteText("");
      setPasteOpen(false);
    } catch (err) {
      setResult({ tone: "sell", text: errorMessage(err) });
    }
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > IMPORT_MAX_BYTES) {
      setResult({ tone: "sell", text: "That file is larger than 1 MB." });
      return;
    }
    applyImport(await file.text());
  };

  return (
    <>
      <TabHeader
        title="Blacklists"
        description={`Applied to every Pulse feed (New Pairs, Final Stretch, Migrated) on top of each column's filters. ${total} ${total === 1 ? "entry" : "entries"} in total.`}
      />

      <Segmented<BlacklistKind>
        value={kindId}
        onChange={(k) => {
          setKindId(k);
          setError(null);
          setValue("");
        }}
        options={KINDS.map((k) => ({
          value: k.id,
          label: (
            <span>
              {k.short} <span className="font-mono text-fg-3">{blacklists[k.id].length}</span>
            </span>
          ),
          title: k.title,
        }))}
        label="Blacklist"
        className="mb-4 w-full"
      />

      <Group title={kind.title} description={kind.hint} extra={<span className="text-label text-fg-3">{list.length} listed</span>}>
        <form className="space-y-2 p-3" onSubmit={add}>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Field label={kind.field} htmlFor="zf-bl-value" className="flex-1">
              <input
                id="zf-bl-value"
                className={cn("zf-input", !kind.handle && "font-mono")}
                value={value}
                spellCheck={false}
                autoComplete="off"
                placeholder={kind.placeholder}
                aria-invalid={error !== null}
                onChange={(e) => {
                  setValue(e.target.value);
                  setError(null);
                }}
              />
            </Field>
            <Field label="Note (optional)" htmlFor="zf-bl-note" className="sm:w-40">
              <input
                id="zf-bl-note"
                className="zf-input"
                value={note}
                maxLength={NOTE_MAX}
                placeholder="Why"
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
            <Button type="submit" size="md" variant="secondary" disabled={!value.trim()}>
              Add
            </Button>
          </div>
          {error && <div className="text-label text-sell">{error}</div>}
        </form>
        {list.length === 0 ? (
          <div className="px-3 py-2 text-label text-fg-3">Nothing on this list yet.</div>
        ) : (
          <ul className="max-h-80 divide-y divide-hairline overflow-y-auto">
            {list.map((entry) => {
              const shown = kind.handle ? `@${entry.value}` : shortAddr(entry.value, 6, 6);
              return (
                <li key={entry.value} className="flex items-center gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1 text-data text-fg-1">
                      <span className={cn("truncate", !kind.handle && "font-mono")}>{shown}</span>
                      <CopyButton text={entry.value} label={`Copy ${shown}`} />
                    </div>
                    {entry.note && <div className="truncate text-label text-fg-2">{entry.note}</div>}
                  </div>
                  <span className="shrink-0 text-right text-label text-fg-3">{fmtDate(entry.addedAt)}</span>
                  <IconButton label={`Remove ${shown}`} onClick={() => removeBlacklist(kind.id, entry.value)}>
                    <Trash2 className="icon-sm" />
                  </IconButton>
                </li>
              );
            })}
          </ul>
        )}
      </Group>

      <Group
        title="Import and export"
        description="One JSON file holds all four lists. Imports merge into what you have; duplicates are skipped."
      >
        <div className="flex flex-wrap items-center gap-2 p-3">
          <Button size="sm" variant="secondary" icon={<Download className="icon-sm" />} onClick={exportJson}>
            Export JSON
          </Button>
          <Button size="sm" variant="secondary" icon={<FileUp className="icon-sm" />} onClick={() => fileRef.current?.click()}>
            Import file
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<ClipboardPaste className="icon-sm" />}
            aria-expanded={pasteOpen}
            onClick={() => setPasteOpen((open) => !open)}
          >
            Paste JSON
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            aria-label="Blacklists JSON file"
            onChange={(e) => void onFile(e)}
          />
        </div>
        {pasteOpen && (
          <div className="space-y-2 p-3">
            <textarea
              aria-label="Blacklists JSON"
              className="zf-input h-32 resize-y py-2 font-mono"
              spellCheck={false}
              value={pasteText}
              placeholder='{ "tokens": [], "devs": [], "fundingWallets": [], "xHandles": [] }'
              onChange={(e) => setPasteText(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setPasteOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" disabled={!pasteText.trim()} onClick={() => applyImport(pasteText)}>
                Import
              </Button>
            </div>
          </div>
        )}
        {result && (
          <div aria-live="polite" className={cn("px-3 py-2 text-label", RESULT_TONE[result.tone])}>
            {result.text}
          </div>
        )}
      </Group>
    </>
  );
}
