import { Plus, RotateCcw, Search } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Button, IconButton } from "../../components/ui/Button";
import { Hotkey, KeyCap, Switch } from "../../components/ui/controls";
import { cn } from "../../lib/cn";
import {
  compactLabel,
  DEFAULT_HOTKEYS,
  HOTKEY_ACTIONS,
  type HotkeyAction,
  type HotkeyActionInfo,
  type HotkeyGroup,
  TRADE_ACTIONS,
} from "../../lib/hotkeys";
import { useSettings } from "../../state/settings";
import { allClashes, type Clash, canonical, findClashes } from "./conflicts";
import { startRecording } from "./recorder";
import { anchorId } from "./sections";
import { InlineStatus, Row, Rows, SectionHeader, SubHeader, Tag, useTransient } from "./ui";

const GROUPS: HotkeyGroup[] = ["General", "Trading", "Pulse", "Token page", "Navigation"];
const LABEL = new Map(HOTKEY_ACTIONS.map((a) => [a.id, a.label] as const));
const GROUP_SCOPE_NOTE: Partial<Record<HotkeyGroup, string>> = { Pulse: "On Pulse only", "Token page": "On token pages only" };
/** Matches the global handler's sequence window (useGlobalHotkeys). */
const SEQUENCE_MS = 900;
const MAX_BINDINGS = 2;

/** Which binding is being recorded: `index` null adds a new one. */
interface Recording {
  action: HotkeyAction;
  index: number | null;
}

interface Pending extends Recording {
  binding: string;
  clashes: Clash[];
}

function sameBindings(a: string[] | undefined, b: string[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => canonical(v) === canonical(y[i] ?? ""));
}

function withBinding(list: string[], index: number | null, binding: string): string[] {
  if (index === null) return [...list, binding];
  return list.map((b, i) => (i === index ? binding : b));
}

/*
 * Hotkeys editor (DESIGN.md 5.5): a "Trade hotkeys" master switch, search and "Reset all", then
 * 32 px rows of action · keycaps (click one to record, "+" adds a second) · reset. Conflicts
 * only count inside the same scope or against global keys ("L" on Pulse and on a token page is
 * fine). Keycaps as rebindable buttons, master toggle and reset after Zoho CRM; "Allow keyboard
 * shortcuts" after Toggl:
 * https://mobbin.com/screens/8291b6de-66e5-495e-91a8-c8a2b6525956
 * https://mobbin.com/screens/c6f9271e-5854-4174-bee5-691005237d18
 */
export function HotkeysSection() {
  const hotkeys = useSettings((s) => s.hotkeys);
  const setHotkey = useSettings((s) => s.setHotkey);
  const resetHotkeys = useSettings((s) => s.resetHotkeys);
  const tradeHotkeys = useSettings((s) => s.tradeHotkeys);
  const setTradeHotkeys = useSettings((s) => s.setTradeHotkeys);
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<Recording | null>(null);
  const [first, setFirst] = useState<string | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useTransient<{ action: HotkeyAction; text: string }>(2500);
  const [resetAll, setResetAll] = useTransient<Record<HotkeyAction, string[]>>(6000);
  const rowRefs = useRef<Partial<Record<HotkeyAction, HTMLDivElement | null>>>({});
  const captureRef = useRef<HTMLSpanElement>(null);

  const clashes = useMemo(() => allClashes(hotkeys), [hotkeys]);

  // While a binding records, the recorder owns the keyboard (capture phase, see recorder.ts).
  useEffect(() => {
    if (!recording) return;
    const target = recording;
    captureRef.current?.focus({ preventScroll: true });
    const end = () => {
      setRecording(null);
      setFirst(null);
      setSpaceHeld(false);
    };
    const stop = startRecording(
      {
        onSpace: setSpaceHeld,
        onPending: setFirst,
        onCancel: end,
        keepOpen: () => captureRef.current,
        onChord: (binding) => {
          end();
          const state = useSettings.getState();
          const own = state.hotkeys[target.action] ?? [];
          const key = canonical(binding);
          if (own.some((b, i) => i !== target.index && canonical(b) === key)) {
            setNotice({ action: target.action, text: `${compactLabel(binding)} is already bound to this action.` });
            return;
          }
          const found = findClashes(target.action, binding, state.hotkeys);
          if (found.length > 0) {
            setPending({ ...target, binding, clashes: found });
            return;
          }
          state.setHotkey(target.action, withBinding(own, target.index, binding));
        },
      },
      window,
      { sequenceMs: SEQUENCE_MS },
    );
    return () => {
      stop();
      // Back to the row, not a button: a Space released after a Space combo must not click anything.
      rowRefs.current[target.action]?.focus({ preventScroll: true });
    };
  }, [recording, setNotice]);

  const start = (action: HotkeyAction, index: number | null) => {
    setPending(null);
    setNotice(null);
    setRecording({ action, index });
  };

  const removeBinding = (action: HotkeyAction, index: number) => {
    setRecording(null);
    setHotkey(
      action,
      (useSettings.getState().hotkeys[action] ?? []).filter((_, i) => i !== index),
    );
  };

  const replace = () => {
    if (!pending) return;
    const state = useSettings.getState();
    for (const c of pending.clashes) {
      state.setHotkey(
        c.action,
        (useSettings.getState().hotkeys[c.action] ?? []).filter((b) => b !== c.binding),
      );
    }
    const own = useSettings.getState().hotkeys[pending.action] ?? [];
    state.setHotkey(pending.action, withBinding(own, pending.index, pending.binding));
    setPending(null);
  };

  const doResetAll = () => {
    const previous = useSettings.getState().hotkeys;
    resetHotkeys();
    setPending(null);
    setRecording(null);
    setResetAll(previous);
  };

  const undoResetAll = () => {
    if (!resetAll) return;
    const s = useSettings.getState();
    for (const a of HOTKEY_ACTIONS) s.setHotkey(a.id, resetAll[a.id] ?? []);
    setResetAll(null);
  };

  const q = query.trim().toLowerCase();
  const matches = (a: HotkeyActionInfo) =>
    !q || a.label.toLowerCase().includes(q) || (hotkeys[a.id] ?? []).some((b) => compactLabel(b).toLowerCase().includes(q));

  const renderRow = (a: HotkeyActionInfo) => {
    const bindings = hotkeys[a.id] ?? [];
    const isRecording = recording?.action === a.id;
    const tradeOff = TRADE_ACTIONS.has(a.id) && !tradeHotkeys;
    const modified = !sameBindings(bindings, DEFAULT_HOTKEYS[a.id]);
    const capture = (
      <span
        ref={captureRef}
        tabIndex={-1}
        className="inline-flex h-6 items-center gap-2 rounded-sm bg-surface-2 px-2 text-label text-fg-1 outline-2 outline-offset-2 outline-focus"
      >
        <span aria-live="polite">
          {first ? (
            <span className="inline-flex items-center gap-1">
              <Hotkey binding={first} />
              <span className="text-micro text-fg-3">then …</span>
            </span>
          ) : spaceHeld ? (
            <span className="inline-flex items-center gap-1">
              <KeyCap k="Space" /> + key
            </span>
          ) : (
            "Press keys…"
          )}
        </span>
        {recording?.index !== null && recording?.index !== undefined && (
          <button
            type="button"
            onClick={() => removeBinding(a.id, recording.index as number)}
            className="text-fg-2 underline-offset-2 hover:text-fg-1 hover:underline"
          >
            Remove
          </button>
        )}
        <KeyCap k="Esc" />
      </span>
    );
    return (
      <div key={a.id} id={anchorId(`hk-${a.id}`)} className="scroll-mt-4">
        <div
          ref={(el) => {
            rowRefs.current[a.id] = el;
          }}
          tabIndex={-1}
          className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 py-1 outline-none max-md:min-h-11"
        >
          <div className={cn("flex min-w-0 flex-1 items-center gap-2 text-data", tradeOff ? "text-fg-3" : "text-fg-1")}>
            <span className="truncate">{a.label}</span>
            {tradeOff && <Tag>Off</Tag>}
            {a.scope === "orders" && <Tag>Orders page</Tag>}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1">
            {bindings.length === 0 && !isRecording && <span className="text-label text-fg-3">Not set</span>}
            {bindings.map((b, i) => {
              if (isRecording && recording?.index === i) return <Fragment key={b}>{capture}</Fragment>;
              const clash = clashes.get(`${a.id} ${b}`);
              return (
                <button
                  key={b}
                  type="button"
                  title={clash ? `Also used by ${clash.map((c) => LABEL.get(c.action)).join(", ")}` : `Change ${compactLabel(b)}`}
                  aria-label={`${compactLabel(b)}: change the binding for ${a.label}${clash ? ", conflicts with another action" : ""}`}
                  onClick={() => start(a.id, i)}
                  className={cn(
                    "focus-inset inline-flex h-6 items-center rounded-sm border px-1 transition-colors hover:bg-surface-3",
                    clash ? "border-warn-edge" : "border-transparent",
                  )}
                >
                  <Hotkey binding={b} />
                </button>
              );
            })}
            {isRecording && recording?.index === null && capture}
            {!isRecording && bindings.length < MAX_BINDINGS && (
              <IconButton label={`Add a key for ${a.label}`} size="xs" onClick={() => start(a.id, null)}>
                <Plus />
              </IconButton>
            )}
            <span className="flex w-5 justify-center">
              {modified && !isRecording && (
                <IconButton
                  label={`Reset ${a.label} to ${DEFAULT_HOTKEYS[a.id].map(compactLabel).join(" or ") || "no key"}`}
                  size="xs"
                  onClick={() => setHotkey(a.id, DEFAULT_HOTKEYS[a.id])}
                >
                  <RotateCcw />
                </IconButton>
              )}
            </span>
          </div>
        </div>
        {notice?.action === a.id && <div className="pb-1 text-label text-fg-3">{notice.text}</div>}
        {pending?.action === a.id && (
          <div role="alert" className="flex flex-wrap items-center gap-x-2 gap-y-1 pb-2 text-label text-warn">
            <Hotkey binding={pending.binding} />
            <span>Used by {pending.clashes.map((c) => LABEL.get(c.action)).join(", ")}</span>
            <span className="text-fg-3">·</span>
            <button type="button" onClick={replace} className="font-medium text-fg-1 underline-offset-2 hover:underline">
              Replace
            </button>
            <button type="button" onClick={() => setPending(null)} className="text-fg-2 underline-offset-2 hover:underline">
              Cancel
            </button>
          </div>
        )}
      </div>
    );
  };

  const visibleGroups = GROUPS.map((g) => ({ group: g, actions: HOTKEY_ACTIONS.filter((a) => a.group === g && matches(a)) })).filter(
    (g) => g.actions.length > 0,
  );

  return (
    <>
      <SectionHeader
        title="Hotkeys"
        description="Click a key to record a new one, or + to add a second. Hold Space first for a Space combo; press two keys in a row for a sequence. Esc cancels."
      />
      <Rows>
        <Row
          anchor="master"
          label="Trade hotkeys"
          help="Hold Space and press a key to buy or sell the hovered Pulse card or the open token. Off disables every buy and sell key; the others keep working."
        >
          <Switch checked={tradeHotkeys} onChange={setTradeHotkeys} label="Trade hotkeys" />
        </Row>
      </Rows>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <label className="relative block w-full sm:w-60">
          <span className="sr-only">Search hotkeys</span>
          <Search className="icon-sm pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-fg-3" />
          <input
            type="search"
            className="zf-input pl-7 max-md:h-11"
            placeholder="Search actions or keys"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {resetAll ? (
          <InlineStatus onUndo={undoResetAll}>All hotkeys reset</InlineStatus>
        ) : (
          <Button size="xs" variant="ghost" icon={<RotateCcw />} onClick={doResetAll}>
            Reset all
          </Button>
        )}
      </div>

      {visibleGroups.length === 0 && <p className="mt-4 text-data text-fg-3">No actions or keys match “{query.trim()}”.</p>}
      {visibleGroups.map(({ group, actions }) => (
        <Fragment key={group}>
          <SubHeader actions={GROUP_SCOPE_NOTE[group] ? <span className="text-label text-fg-3">{GROUP_SCOPE_NOTE[group]}</span> : null}>
            {group}
          </SubHeader>
          <div className="divide-y divide-hairline border-y border-hairline">{actions.map(renderRow)}</div>
        </Fragment>
      ))}
    </>
  );
}
