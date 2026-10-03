import { Plus, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Hotkey, Kbd, Switch } from "../../components/ui/controls";
import { cn } from "../../lib/cn";
import { compactLabel, HOTKEY_ACTIONS, type HotkeyAction, IS_MAC, parseBinding, TRADE_ACTIONS } from "../../lib/hotkeys";
import { useSettings } from "../../state/settings";
import { useToasts } from "../../state/toasts";
import { startRecording } from "./recorder";
import { Chip, Group, Note, Row, TabHeader } from "./ui";

const GROUPS = ["General", "Trading", "Navigation"] as const;
const LABELS = new Map(HOTKEY_ACTIONS.map((a) => [a.id, a.label] as const));

/** Platform-resolved identity of a binding, so "Mod+K" and "Meta+K" collide on macOS. */
function canonical(text: string): string {
  const binding = parseBinding(text);
  if (!binding) return text.trim().toLowerCase();
  return binding
    .map((c) => {
      const meta = c.meta || (c.mod && IS_MAC);
      const ctrl = c.ctrl || (c.mod && !IS_MAC);
      return [c.space && "space", meta && "meta", ctrl && "ctrl", c.alt && "alt", c.shift && "shift", c.key.toLowerCase()]
        .filter(Boolean)
        .join("+");
    })
    .join(" ");
}

interface Conflict {
  action: HotkeyAction;
  binding: string;
  other: HotkeyAction;
}

/*
 * Hotkey editor. Anatomy follows Zoho CRM's shortcut settings (master toggle beside the title,
 * "Reset shortcuts", grouped keycaps) and Height's per-command rows with an edit control:
 * https://mobbin.com/screens/8291b6de-66e5-495e-91a8-c8a2b6525956
 * https://mobbin.com/screens/227ea05e-2f27-4ad6-8bbf-fa8915d896f3
 */
export function HotkeysTab() {
  const hotkeys = useSettings((s) => s.hotkeys);
  const setHotkey = useSettings((s) => s.setHotkey);
  const resetHotkeys = useSettings((s) => s.resetHotkeys);
  const tradeHotkeys = useSettings((s) => s.tradeHotkeys);
  const setTradeHotkeys = useSettings((s) => s.setTradeHotkeys);
  const [recording, setRecording] = useState<HotkeyAction | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [notice, setNotice] = useState<{ action: HotkeyAction; text: string } | null>(null);
  const rowRefs = useRef<Partial<Record<HotkeyAction, HTMLDivElement | null>>>({});
  const captureRef = useRef<HTMLSpanElement>(null);

  /** Canonical bindings used by more than one action. */
  const duplicates = useMemo(() => {
    const owners = new Map<string, Set<HotkeyAction>>();
    for (const a of HOTKEY_ACTIONS) {
      for (const b of hotkeys[a.id] ?? []) {
        const key = canonical(b);
        const set = owners.get(key) ?? new Set<HotkeyAction>();
        set.add(a.id);
        owners.set(key, set);
      }
    }
    return new Set([...owners].filter(([, set]) => set.size > 1).map(([key]) => key));
  }, [hotkeys]);

  // While a row is recording, the recorder owns the keyboard (capture phase, see recorder.ts).
  useEffect(() => {
    if (!recording) return;
    const action = recording;
    captureRef.current?.focus({ preventScroll: true });
    const end = () => {
      setRecording(null);
      setSpaceHeld(false);
    };
    const stopRecorder = startRecording({
      onSpace: setSpaceHeld,
      onCancel: end,
      keepOpen: () => captureRef.current,
      onChord: (binding) => {
        end();
        const state = useSettings.getState();
        const key = canonical(binding);
        const own = state.hotkeys[action] ?? [];
        if (own.some((b) => canonical(b) === key)) {
          setNotice({ action, text: `${compactLabel(binding)} is already bound to this action.` });
          return;
        }
        const other = HOTKEY_ACTIONS.find((a) => a.id !== action && (state.hotkeys[a.id] ?? []).some((b) => canonical(b) === key));
        if (other) {
          setConflict({ action, binding, other: other.id });
          return;
        }
        state.setHotkey(action, [...own, binding]);
      },
    });
    return () => {
      stopRecorder();
      // Back to the row, not a button: a Space released after a Space combo must not click anything.
      rowRefs.current[action]?.focus({ preventScroll: true });
    };
  }, [recording]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 2500);
    return () => clearTimeout(t);
  }, [notice]);

  const start = (action: HotkeyAction) => {
    setConflict(null);
    setNotice(null);
    setRecording(action);
  };

  const remove = (action: HotkeyAction, binding: string) => {
    setHotkey(
      action,
      (hotkeys[action] ?? []).filter((b) => b !== binding),
    );
  };

  const replace = () => {
    if (!conflict) return;
    const state = useSettings.getState();
    const key = canonical(conflict.binding);
    state.setHotkey(
      conflict.other,
      (state.hotkeys[conflict.other] ?? []).filter((b) => canonical(b) !== key),
    );
    const own = useSettings.getState().hotkeys[conflict.action] ?? [];
    state.setHotkey(conflict.action, [...own, conflict.binding]);
    setConflict(null);
  };

  const resetAll = () => {
    const previous = useSettings.getState().hotkeys;
    resetHotkeys();
    setConflict(null);
    setRecording(null);
    useToasts.getState().push({
      kind: "info",
      title: "Hotkeys reset to defaults",
      action: {
        label: "Undo",
        run: () => {
          const s = useSettings.getState();
          for (const a of HOTKEY_ACTIONS) s.setHotkey(a.id, previous[a.id] ?? []);
        },
      },
    });
  };

  return (
    <>
      <TabHeader
        title="Hotkeys"
        description="Click Record, then press the keys. Hold Space first to record a Space combo; Esc cancels."
        actions={
          <Button size="xs" variant="secondary" icon={<RotateCcw className="icon-sm" />} onClick={resetAll}>
            Reset to defaults
          </Button>
        }
      />

      <Group>
        <Row
          label="Trade hotkeys"
          hint="Hold Space and press a key to buy or sell the hovered Pulse card or the open token. Off disables every buy and sell hotkey; the others keep working."
        >
          <Switch checked={tradeHotkeys} onChange={setTradeHotkeys} label="Trade hotkeys" />
        </Row>
      </Group>

      {duplicates.size > 0 && (
        <Note tone="warn" className="mb-6">
          Some keys are bound to more than one action (outlined below). Only one of them will fire.
        </Note>
      )}

      {GROUPS.map((group) => (
        <Group key={group} title={group}>
          {HOTKEY_ACTIONS.filter((a) => a.group === group).map((a) => {
            const bindings = hotkeys[a.id] ?? [];
            const isRecording = recording === a.id;
            const tradeOff = TRADE_ACTIONS.has(a.id) && !tradeHotkeys;
            return (
              <div key={a.id}>
                <div
                  ref={(el) => {
                    rowRefs.current[a.id] = el;
                  }}
                  tabIndex={-1}
                  className="flex flex-wrap items-center gap-2 px-3 py-2"
                >
                  <div className={cn("min-w-0 flex-1 text-data", tradeOff ? "text-fg-3" : "text-fg-1")}>
                    {a.label}
                    {tradeOff && <Chip className="ml-2">Off</Chip>}
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-1">
                    {bindings.length === 0 && !isRecording && <span className="text-label text-fg-3">Not set</span>}
                    {bindings.map((b) => {
                      const dup = duplicates.has(canonical(b));
                      return (
                        <span
                          key={b}
                          title={dup ? "Also bound to another action" : undefined}
                          className={cn(
                            "inline-flex h-6 items-center gap-1 rounded-sm border px-1",
                            dup ? "border-warn-edge" : "border-hairline",
                          )}
                        >
                          <Hotkey binding={b} />
                          <button
                            type="button"
                            aria-label={`Remove ${compactLabel(b)} from ${a.label}`}
                            onClick={() => remove(a.id, b)}
                            className="flex size-4 items-center justify-center rounded-xs text-fg-3 hover:bg-surface-3 hover:text-fg-1"
                          >
                            <X className="icon-xs" />
                          </button>
                        </span>
                      );
                    })}
                    {isRecording ? (
                      <span
                        ref={captureRef}
                        tabIndex={-1}
                        aria-live="polite"
                        className="inline-flex h-6 items-center gap-1 rounded-sm border border-dashed border-hairline-strong px-2 text-label text-fg-1"
                      >
                        {spaceHeld ? (
                          <>
                            <Kbd>␣</Kbd> + key
                          </>
                        ) : (
                          "Press keys"
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setRecording(null);
                            setSpaceHeld(false);
                          }}
                          className="ml-1 text-fg-3 hover:text-fg-1"
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <Button
                        size="xs"
                        variant="ghost"
                        icon={<Plus className="icon-sm" />}
                        aria-label={`Record a hotkey for ${a.label}`}
                        onClick={() => start(a.id)}
                      >
                        Record
                      </Button>
                    )}
                  </div>
                </div>
                {notice?.action === a.id && <div className="px-3 pb-2 text-label text-fg-3">{notice.text}</div>}
                {conflict?.action === a.id && (
                  <div className="px-3 pb-2">
                    <Note tone="warn">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          <Hotkey binding={conflict.binding} className="align-middle" /> is already used by “{LABELS.get(conflict.other)}”.
                          Replace moves it here.
                        </span>
                        <span className="flex gap-1">
                          <Button size="xs" variant="secondary" onClick={replace}>
                            Replace
                          </Button>
                          <Button size="xs" variant="ghost" onClick={() => setConflict(null)}>
                            Cancel
                          </Button>
                        </span>
                      </div>
                    </Note>
                  </div>
                )}
              </div>
            );
          })}
        </Group>
      ))}
    </>
  );
}
