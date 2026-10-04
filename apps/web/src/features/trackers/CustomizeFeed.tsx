import { AtSign, Plus, Upload } from "lucide-react";
import { type FormEvent, memo, type ReactNode, useCallback, useDeferredValue, useMemo, useState } from "react";
import { Age } from "../../components/ui/Age";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/bits";
import { Switch } from "../../components/ui/controls";
import { Modal } from "../../components/ui/Modal";
import { WalletAvatar } from "../../components/ui/TokenAvatar";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { useCssPx } from "../../lib/cssVar";
import { normalizeHandle } from "../../lib/filters";
import { fmtInt } from "../../lib/format";
import { useSettings } from "../../state/settings";
import { type TrackedHandle, useTrackers } from "../../state/trackers";
import { MetaCount, PaneToolbar } from "./bits";
import { ExportMenu, jsonExportActions } from "./ExportMenu";
import { blockedHandles, normalizeQuery } from "./feedFilters";
import { HANDLE_RE, handlesToJson, parseHandleImport } from "./handleImport";
import { MOBILE_ROW_PX, useIsMobile } from "./hooks";
import { removeHandle } from "./socialActions";
import { Cell, CursorBar, HeaderCell, HeaderRow, rowTone } from "./table";
import { VirtualGrid } from "./VirtualList";

const handleKey = (h: TrackedHandle): string => h.handle;

function plural(n: number, noun: string): string {
  return `${fmtInt(n)} ${noun}${n === 1 ? "" : "s"}`;
}

const COL = {
  handle: "min-w-0 flex-1",
  sw: "w-[8ch] justify-center",
  added: "w-[5ch] justify-end @max-[480px]:hidden",
  remove: "w-[9ch] justify-end",
} as const;

const ROW = "flex items-center gap-2 px-2";

const HandleRow = memo(function HandleRow({
  h,
  blacklisted,
  active,
  mobile,
}: {
  h: TrackedHandle;
  blacklisted: boolean;
  active: boolean;
  mobile: boolean;
}) {
  const update = (patch: Partial<TrackedHandle>) => useTrackers.getState().updateHandle(h.handle, patch);
  const tab = mobile || active ? 0 : -1;
  return (
    <div className={cn(ROW, "relative h-full text-data max-md:px-3", active ? "bg-surface-2" : rowTone({}))}>
      <CursorBar show={active} />
      <Cell className={cn("items-center gap-1", COL.handle)}>
        <WalletAvatar seed={h.handle} label={h.handle} size={16} />
        <span className="truncate font-medium text-fg-1">@{h.handle}</span>
        {blacklisted && (
          <span className="shrink-0 text-micro font-medium text-warn" title="Blacklisted in Settings, so its posts stay hidden">
            Blacklisted
          </span>
        )}
      </Cell>
      <Cell className={cn("shrink-0", COL.sw)}>
        <SwitchCell>
          <Switch
            checked={h.tweets}
            onChange={(tweets) => update({ tweets })}
            label={`Tweets, replies, quotes and reposts from @${h.handle}`}
          />
        </SwitchCell>
      </Cell>
      <Cell className={cn("shrink-0", COL.sw)}>
        <SwitchCell>
          <Switch checked={h.profile} onChange={(profile) => update({ profile })} label={`Profile updates from @${h.handle}`} />
        </SwitchCell>
      </Cell>
      <Cell className={cn("shrink-0", COL.sw)}>
        <SwitchCell>
          <Switch checked={h.follows} onChange={(follows) => update({ follows })} label={`Accounts @${h.handle} follows`} />
        </SwitchCell>
      </Cell>
      <Cell className={cn("shrink-0", COL.added)}>
        <Age ts={h.addedAt} />
      </Cell>
      <Cell className={cn("shrink-0", COL.remove)}>
        <Button size="xs" variant="ghost" tabIndex={tab} onClick={() => removeHandle(h)} className="max-md:h-11">
          Remove
        </Button>
      </Cell>
    </div>
  );
});

/** Switches keep their 28 × 16 track; on phones the cell pads them to a 44 px target. */
function SwitchCell({ children }: { children: ReactNode }) {
  return <span className="flex items-center justify-center max-md:size-11">{children}</span>;
}

/* Paste-a-list import for handles; same anatomy as the wallet import. */
function ImportHandlesDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const deferred = useDeferredValue(text);
  const handles = useTrackers((s) => s.handles);
  const parsed = useMemo(() => parseHandleImport(deferred), [deferred]);
  const fresh = useMemo(() => {
    const have = new Set(handles.map((h) => h.handle));
    return parsed.handles.filter((h) => !have.has(h.handle));
  }, [parsed, handles]);
  return (
    <Modal
      open
      onClose={onClose}
      title="Import X handles"
      description="Paste handles, x.com links or a zerofee export."
      width={560}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            disabled={fresh.length === 0}
            onClick={() => {
              useTrackers.getState().importHandles(fresh);
              onClose();
            }}
          >
            {fresh.length > 0 ? `Import ${plural(fresh.length, "handle")}` : "Import handles"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <textarea
          data-autofocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          aria-label="Handle list"
          placeholder={"@handle, one per line or comma-separated\nx.com links work too\nor a zerofee JSON export"}
          className="h-32 w-full resize-y rounded-sm border border-dashed border-hairline-strong bg-surface-2 p-2 font-mono text-label text-fg-1 placeholder:text-fg-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
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
                <span className="text-fg-2">{fmtInt(fresh.length)} new</span>
                {parsed.duplicates > 0 && <span className="text-fg-2">{plural(parsed.duplicates, "duplicate")}</span>}
                {parsed.invalid.length > 0 && <span className="text-warn">{fmtInt(parsed.invalid.length)} invalid</span>}
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
      </div>
    </Modal>
  );
}

/**
 * Handles: the X list with per-handle switches (tweets, profile updates, follows). Data grid with
 * a header row and inline switches, after Twenty's table and Coinbase's "Customize table":
 * https://mobbin.com/screens/36b0d5c8-9550-44ee-b7a0-30f8d10f2eed
 * https://mobbin.com/screens/fee6499f-1bb8-47b4-a971-607d22e0f20a
 */
export function CustomizeFeed({ query, toolbarStart }: { query: string; toolbarStart?: ReactNode }) {
  const handles = useTrackers((s) => s.handles);
  const xBlacklist = useSettings((s) => s.blacklists.xHandles);
  const blocked = useMemo(() => blockedHandles(xBlacklist), [xBlacklist]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const mobile = useIsMobile();
  const rowPx = useCssPx("--zf-row", 24) + 4;
  const q = normalizeQuery(query);
  const rows = useMemo(() => (q ? handles.filter((h) => h.handle.includes(q)) : handles), [handles, q]);

  const add = (e: FormEvent) => {
    e.preventDefault();
    const h = normalizeHandle(input);
    if (!h) return;
    if (!HANDLE_RE.test(h)) {
      setError("Handles are 1 to 15 letters, digits or underscores.");
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
    setError(blocked.has(h) ? `@${h} is blacklisted in Settings, so its posts stay hidden.` : null);
  };

  const exportActions = jsonExportActions({
    filename: "zerofee-x-handles.json",
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
  const copy = useCallback((h: TrackedHandle) => void copyText(`@${h.handle}`), []);

  return (
    <div className="@container flex min-h-0 min-w-0 flex-1 flex-col">
      <PaneToolbar>
        {toolbarStart}
        <form onSubmit={add} className="flex items-center gap-1">
          <label className="flex h-control w-48 items-center gap-1 rounded-sm border border-hairline-strong bg-surface-2 px-2 text-data focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus max-md:h-11 max-md:w-40">
            <AtSign className="icon-xs shrink-0 text-fg-3" />
            <input
              className="min-w-0 flex-1 bg-transparent placeholder:text-fg-4 focus-visible:outline-none max-md:text-title"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setError(null);
              }}
              placeholder="handle or x.com link"
              aria-label="X handle to track"
              aria-invalid={error ? true : undefined}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <Button type="submit" size="xs" variant="secondary" icon={<Plus />} className="max-md:h-11">
            Add handle
          </Button>
        </form>
        {error && (
          <span role="alert" className={cn("truncate text-label", error.includes("blacklisted") ? "text-warn" : "text-sell")}>
            {error}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2 pl-2">
          <MetaCount>{plural(handles.length, "handle")}</MetaCount>
          <Button size="xs" variant="ghost" icon={<Upload />} onClick={() => setImportOpen(true)} className="max-md:h-11">
            Import
          </Button>
          <ExportMenu actions={exportActions} disabled={handles.length === 0} size="xs" />
        </span>
      </PaneToolbar>
      <VirtualGrid
        items={rows}
        getKey={handleKey}
        rowHeight={mobile ? MOBILE_ROW_PX : rowPx}
        label="Tracked X handles"
        header={
          <HeaderRow className={cn(ROW, "max-md:px-3")}>
            <HeaderCell className={COL.handle}>Handle</HeaderCell>
            <HeaderCell className={COL.sw} align="center" title="Tweets, replies, quotes and reposts">
              Tweets
            </HeaderCell>
            <HeaderCell className={COL.sw} align="center">
              Profile
            </HeaderCell>
            <HeaderCell className={COL.sw} align="center">
              Follows
            </HeaderCell>
            <HeaderCell className={COL.added} align="right">
              Added
            </HeaderCell>
            <HeaderCell className={COL.remove} />
          </HeaderRow>
        }
        empty={
          handles.length === 0 ? (
            <EmptyState
              className="text-balance"
              icon={<AtSign />}
              title="No handles yet"
              body="Add a handle above or import a list. Untracked accounts still show under All posts."
            />
          ) : (
            <EmptyState className="text-balance" title={`No handles match “${query.trim()}”`} body="Search by handle." />
          )
        }
        onCopy={copy}
        renderRow={(h, { active }) => <HandleRow h={h} blacklisted={blocked.has(h.handle)} active={active} mobile={mobile} />}
      />
      {importOpen && <ImportHandlesDialog onClose={() => setImportOpen(false)} />}
    </div>
  );
}
