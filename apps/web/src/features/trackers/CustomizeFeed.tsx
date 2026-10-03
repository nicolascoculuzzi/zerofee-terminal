import { AtSign, Info, Plus, Trash2, Upload } from "lucide-react";
import { type FormEvent, memo, useDeferredValue, useMemo, useState } from "react";
import { Age } from "../../components/ui/Age";
import { Button, IconButton } from "../../components/ui/Button";
import { Switch } from "../../components/ui/controls";
import { Modal } from "../../components/ui/Modal";
import { normalizeHandle } from "../../lib/filters";
import { useSettings } from "../../state/settings";
import { useToasts } from "../../state/toasts";
import { type TrackedHandle, useTrackers } from "../../state/trackers";
import { SearchField } from "./bits";
import { ExportMenu, jsonExportActions } from "./ExportMenu";
import { blockedHandles } from "./feedFilters";
import { HANDLE_RE, handlesToJson, parseHandleImport } from "./handleImport";
import { useRowHeight } from "./hooks";
import { VirtualList } from "./VirtualList";

function plural(n: number, noun: string): string {
  return `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;
}

function removeWithUndo(h: TrackedHandle): void {
  useTrackers.getState().removeHandle(h.handle);
  useToasts.getState().push({
    kind: "info",
    title: `Removed @${h.handle}`,
    action: {
      label: "Undo",
      run: () => {
        const s = useTrackers.getState();
        if (s.addHandle(h.handle))
          s.updateHandle(h.handle, { tweets: h.tweets, profile: h.profile, follows: h.follows, addedAt: h.addedAt });
      },
    },
  });
}

const HandleRow = memo(function HandleRow({ h, blacklisted }: { h: TrackedHandle; blacklisted: boolean }) {
  const update = (patch: Partial<TrackedHandle>) => useTrackers.getState().updateHandle(h.handle, patch);
  return (
    <div className="flex h-7 items-center gap-2 px-3 text-label hover:bg-surface-3">
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate font-medium text-fg-1">@{h.handle}</span>
        {blacklisted && (
          <span className="shrink-0 text-micro text-warn" title="Blacklisted in Settings: its posts stay hidden">
            Blacklisted
          </span>
        )}
        <Age ts={h.addedAt} className="hidden shrink-0 text-fg-3 @sm:inline" />
      </span>
      <span className="flex w-14 shrink-0 justify-center">
        <Switch
          checked={h.tweets}
          onChange={(tweets) => update({ tweets })}
          label={`Tweets, replies, quotes and retweets from @${h.handle}`}
        />
      </span>
      <span className="flex w-14 shrink-0 justify-center">
        <Switch checked={h.profile} onChange={(profile) => update({ profile })} label={`Profile updates from @${h.handle}`} />
      </span>
      <span className="flex w-14 shrink-0 justify-center">
        <Switch checked={h.follows} onChange={(follows) => update({ follows })} label={`Accounts @${h.handle} follows`} />
      </span>
      <span className="flex w-6 shrink-0 justify-end">
        <IconButton size="xs" label={`Remove @${h.handle}`} onClick={() => removeWithUndo(h)}>
          <Trash2 className="icon-sm" />
        </IconButton>
      </span>
    </div>
  );
});

/* Paste-a-list import, same anatomy as the wallet import (Gemini Notebook paste dialog). */
function ImportHandlesForm({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const deferred = useDeferredValue(text);
  const handles = useTrackers((s) => s.handles);
  const parsed = useMemo(() => parseHandleImport(deferred), [deferred]);
  const fresh = useMemo(() => {
    const have = new Set(handles.map((h) => h.handle));
    return parsed.handles.filter((h) => !have.has(h.handle));
  }, [parsed, handles]);

  const commit = () => {
    // One store write and one feed sync for the whole paste.
    const added = useTrackers.getState().importHandles(fresh);
    useToasts
      .getState()
      .push({ kind: added > 0 ? "success" : "info", title: added > 0 ? `Imported ${plural(added, "handle")}` : "Nothing new to import" });
    onClose();
  };

  return (
    <div className="flex flex-col gap-3">
      <textarea
        data-autofocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        aria-label="Handle list"
        placeholder={"@handle, one per line or comma-separated\nx.com links work too\nor a zerofee JSON export"}
        className="h-32 w-full resize-y rounded-sm border border-hairline-strong bg-bg p-2 font-mono text-label outline-none placeholder:text-fg-3 focus:border-accent"
      />
      {parsed.error ? (
        <p role="alert" className="text-label text-sell">
          {parsed.error}
        </p>
      ) : (
        deferred.trim() && (
          <div className="flex flex-col gap-1 text-label">
            <div className="flex flex-wrap gap-x-3">
              <span className="font-semibold text-fg-1">{plural(parsed.handles.length, "handle")} found</span>
              <span className="text-fg-2">{fresh.length.toLocaleString("en-US")} new</span>
              {parsed.duplicates > 0 && <span className="text-fg-2">{plural(parsed.duplicates, "duplicate")}</span>}
              {parsed.invalid.length > 0 && <span className="text-warn">{parsed.invalid.length.toLocaleString("en-US")} invalid</span>}
            </div>
            {parsed.invalid.length > 0 && (
              <p className="truncate font-mono text-fg-3" title={parsed.invalid.join(", ")}>
                Skipped: {parsed.invalid.slice(0, 8).join(", ")}
                {parsed.invalid.length > 8 ? "…" : ""}
              </p>
            )}
          </div>
        )
      )}
      <div className="flex justify-end gap-2 border-t border-hairline pt-3">
        <Button variant="ghost" size="md" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" size="md" disabled={fresh.length === 0} onClick={commit}>
          {fresh.length > 0 ? `Import ${plural(fresh.length, "handle")}` : "Import"}
        </Button>
      </div>
    </div>
  );
}

/*
 * Customize Feed: the handle list with per-handle toggles. Anatomy follows Twenty's dense table
 * (toolbar with count and actions, compact header, inline row actions) with on/off controls like
 * Coinbase's "Customize table" menu:
 * https://mobbin.com/screens/f8bd66b5-e935-465b-93d6-cf2f74b3c078
 * https://mobbin.com/screens/fee6499f-1bb8-47b4-a971-607d22e0f20a
 */
export function CustomizeFeed() {
  const handles = useTrackers((s) => s.handles);
  const xBlacklist = useSettings((s) => s.blacklists.xHandles);
  const blocked = useMemo(() => blockedHandles(xBlacklist), [xBlacklist]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const rowHeight = useRowHeight();

  const rows = useMemo(() => {
    const q = normalizeHandle(query);
    return q ? handles.filter((h) => h.handle.includes(q)) : handles;
  }, [handles, query]);

  const add = (e: FormEvent) => {
    e.preventDefault();
    const h = normalizeHandle(input);
    if (!h) return;
    if (!HANDLE_RE.test(h)) {
      setError("Handles are 1–15 letters, numbers or underscores.");
      return;
    }
    if (useTrackers.getState().handles.some((x) => x.handle === h)) {
      setError(`@${h} is already in your list.`);
      return;
    }
    if (!useTrackers.getState().addHandle(h)) {
      setError("Couldn't add that handle.");
      return;
    }
    setInput("");
    setError(null);
    if (blocked.has(h)) {
      useToasts
        .getState()
        .push({ kind: "warn", title: `@${h} is blacklisted`, body: "Its posts stay hidden until you remove it in Settings → Blacklists." });
    }
  };

  const exportActions = jsonExportActions({
    filename: "zerofee-x-handles.json",
    noun: "handle",
    count: handles.length,
    json: () => handlesToJson(useTrackers.getState().handles),
    lines: {
      label: "Copy as @handles",
      text: () =>
        useTrackers
          .getState()
          .handles.map((h) => `@${h.handle}`)
          .join("\n"),
    },
  });

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <form onSubmit={add} className="flex flex-col gap-1 border-b border-hairline p-2">
        <div className="flex items-center gap-2">
          <label className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-sm border border-hairline-strong bg-bg px-2 text-data focus-within:border-accent">
            <AtSign className="icon-sm shrink-0 text-fg-3" />
            <input
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-fg-3"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setError(null);
              }}
              placeholder="handle or x.com/handle"
              aria-label="X handle to track"
              aria-invalid={error ? true : undefined}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <Button type="submit" size="md" variant="primary" icon={<Plus className="icon-sm" />}>
            Add handle
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-label text-sell">
            {error}
          </p>
        )}
      </form>

      <div className="flex flex-wrap items-center gap-2 border-b border-hairline p-2">
        <SearchField
          className="flex-1 basis-32"
          value={query}
          onChange={setQuery}
          placeholder="Search handle"
          label="Search tracked handles"
        />
        <span className="text-label whitespace-nowrap text-fg-3">{plural(handles.length, "handle")}</span>
        <div className="flex items-center gap-2">
          <Button size="md" variant="secondary" title="Import" icon={<Upload className="icon-sm" />} onClick={() => setImportOpen(true)}>
            <span className="hidden @lg:inline">Import</span>
          </Button>
          <ExportMenu actions={exportActions} disabled={handles.length === 0} compactLabel />
        </div>
      </div>

      <div className="zf-label flex h-6 shrink-0 items-center gap-2 border-b border-hairline px-3">
        <span className="min-w-0 flex-1">Handle</span>
        <span className="w-14 shrink-0 text-center" title="Tweets, replies, quotes and retweets">
          Tweets
        </span>
        <span className="w-14 shrink-0 text-center">Profile</span>
        <span className="w-14 shrink-0 text-center">Follows</span>
        <span className="w-6 shrink-0" />
      </div>

      {handles.length === 0 ? (
        <p className="px-3 py-4 text-data text-fg-3">No handles yet. Add one above or import a list.</p>
      ) : rows.length === 0 ? (
        <p className="px-3 py-4 text-data text-fg-3">No handles match “{query.trim()}”.</p>
      ) : (
        <VirtualList
          label="Tracked X handles"
          count={rows.length}
          rowHeight={rowHeight}
          getKey={(i) => rows[i]?.handle ?? i}
          renderRow={(i) => {
            const h = rows[i];
            return h ? <HandleRow h={h} blacklisted={blocked.has(h.handle)} /> : null;
          }}
        />
      )}

      <p className="flex items-center gap-2 border-t border-hairline px-3 py-2 text-label text-fg-3">
        <Info className="icon-sm" />
        Keyword and trend alerts are planned. Untracked handles show everything in “All posts”.
      </p>

      <Modal open={importOpen} onClose={() => setImportOpen(false)} title="Import X handles" width={480}>
        <ImportHandlesForm onClose={() => setImportOpen(false)} />
      </Modal>
    </div>
  );
}
