import { ClipboardPaste, Download, FileUp, Trash2 } from "lucide-react";
import { type ChangeEvent, type FormEvent, useRef, useState } from "react";
import { Button, IconButton } from "../../components/ui/Button";
import { CopyButton, Segmented } from "../../components/ui/controls";
import { isBase58Address } from "../../lib/address";
import { downloadText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { type BlacklistEntry, normalizeHandle } from "../../lib/filters";
import { fmtCount, fmtDate, shortAddr } from "../../lib/format";
import { type BlacklistKind, useSettings } from "../../state/settings";
import { errorMessage } from "./format";
import { Block, InlineStatus, Rows, SectionHeader, SubHeader, type Tone, useTransient } from "./ui";

interface KindInfo {
  id: BlacklistKind;
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
  info: "text-fg-2",
  warn: "text-warn",
  buy: "text-fg-1",
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
 * Blacklists, applied to every Pulse feed on top of each column's filters. Inline add row and a
 * value list with remove, after PlanetScale's IP restrictions:
 * https://mobbin.com/screens/4f361c07-36fd-42c4-8404-db2481db77f4
 */
export function BlacklistsSection() {
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
  const [removed, setRemoved] = useTransient<{ kind: BlacklistKind; entry: BlacklistEntry; shown: string }>(6000);
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

  const remove = (entry: BlacklistEntry, shown: string) => {
    removeBlacklist(kind.id, entry.value);
    setRemoved({ kind: kind.id, entry, shown });
  };

  const undoRemove = () => {
    if (!removed) return;
    addBlacklist(removed.kind, removed.entry.value, removed.entry.note);
    setRemoved(null);
  };

  const exportJson = () => {
    const payload = { app: "zerofee", kind: "blacklists", v: 1, exportedAt: new Date().toISOString(), blacklists };
    downloadText(`zerofee-blacklists-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2));
    setResult({ tone: "neutral", text: `Exported ${fmtCount(total)} ${total === 1 ? "entry" : "entries"}.` });
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
      const parts = [`Added ${fmtCount(added)} ${added === 1 ? "entry" : "entries"}`];
      if (duplicates > 0) parts.push(`${fmtCount(duplicates)} already listed`);
      if (invalid > 0) parts.push(`${fmtCount(invalid)} invalid skipped`);
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
      <SectionHeader
        title="Blacklists"
        description={`Hidden from every Pulse feed (New Pairs, Final Stretch, Migrated) on top of each column's filters. ${fmtCount(total)} ${total === 1 ? "entry" : "entries"} in total. Press X on a Pulse card to hide its token.`}
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
              {k.short} <span className="zf-num text-fg-3">{fmtCount(blacklists[k.id].length)}</span>
            </span>
          ),
          title: k.title,
        }))}
        label="Blacklist"
        className="w-full max-md:h-11"
      />

      <SubHeader
        actions={removed && removed.kind === kind.id ? <InlineStatus onUndo={undoRemove}>Removed {removed.shown}</InlineStatus> : null}
      >
        {kind.title} · {kind.hint}
      </SubHeader>
      <Rows>
        <Block>
          <form className="flex flex-col gap-2 sm:flex-row sm:items-start" onSubmit={add}>
            <div className="min-w-0 flex-1">
              <label htmlFor="zf-bl-value" className="sr-only">
                {kind.field}
              </label>
              <input
                id="zf-bl-value"
                className={cn("zf-input", !kind.handle && "font-mono")}
                value={value}
                spellCheck={false}
                autoComplete="off"
                placeholder={kind.placeholder}
                aria-invalid={error !== null}
                aria-describedby={error ? "zf-bl-error" : undefined}
                onChange={(e) => {
                  setValue(e.target.value);
                  setError(null);
                }}
              />
              {error && (
                <div id="zf-bl-error" className="mt-1 text-label text-sell">
                  {error}
                </div>
              )}
            </div>
            <label htmlFor="zf-bl-note" className="sr-only">
              Note
            </label>
            <input
              id="zf-bl-note"
              className="zf-input sm:w-40"
              value={note}
              maxLength={NOTE_MAX}
              placeholder="Note (optional)"
              onChange={(e) => setNote(e.target.value)}
            />
            <Button type="submit" size="sm" variant="secondary" disabled={!value.trim()} className="max-md:h-11">
              Add to {kind.short.toLowerCase()}
            </Button>
          </form>
        </Block>
        {list.length === 0 ? (
          <Block className="flex items-center text-label text-fg-3">Nothing on this list yet.</Block>
        ) : (
          <Block className="py-0">
            <ul className="max-h-80 divide-y divide-hairline overflow-y-auto">
              {list.map((entry) => {
                const shown = kind.handle ? `@${entry.value}` : shortAddr(entry.value, 6, 6);
                return (
                  <li key={entry.value} className="flex min-h-8 items-center gap-2 py-1">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1 text-data text-fg-1">
                        <span className={cn("truncate", !kind.handle && "font-mono text-fg-2")}>{shown}</span>
                        <CopyButton text={entry.value} label={`Copy ${shown}`} />
                      </div>
                      {entry.note && <div className="truncate text-label text-fg-3">{entry.note}</div>}
                    </div>
                    <span className="shrink-0 text-label text-fg-3">{fmtDate(entry.addedAt)}</span>
                    <IconButton label={`Remove ${shown}`} onClick={() => remove(entry, shown)}>
                      <Trash2 />
                    </IconButton>
                  </li>
                );
              })}
            </ul>
          </Block>
        )}
      </Rows>

      <SubHeader>Import and export</SubHeader>
      <Rows>
        <Block>
          <p className="mb-2 text-label text-fg-3">
            One JSON file holds all four lists. Imports merge into what you have; duplicates are skipped.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" icon={<Download />} onClick={exportJson}>
              Export JSON
            </Button>
            <Button size="sm" variant="secondary" icon={<FileUp />} onClick={() => fileRef.current?.click()}>
              Import file
            </Button>
            <Button size="sm" variant="ghost" icon={<ClipboardPaste />} aria-expanded={pasteOpen} onClick={() => setPasteOpen((o) => !o)}>
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
            <div className="mt-2 space-y-2">
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
                  Import entries
                </Button>
              </div>
            </div>
          )}
          {result && (
            <div role="status" className={cn("mt-2 text-label", RESULT_TONE[result.tone])}>
              {result.text}
            </div>
          )}
        </Block>
      </Rows>
    </>
  );
}
