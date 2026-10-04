import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "../components/ui/Button";
import { Hotkey, KeyCap } from "../components/ui/controls";
import { Modal } from "../components/ui/Modal";
import { cn } from "../lib/cn";
import { compactLabel, HOTKEY_ACTIONS, type HotkeyActionInfo, type HotkeyGroup, hasHandler, IS_MAC, TRADE_ACTIONS } from "../lib/hotkeys";
import { useSettings } from "../state/settings";
import { useUi } from "../state/ui";

type SheetGroup = HotkeyGroup | "Tables";
const GROUPS: SheetGroup[] = ["General", "Trading", "Pulse", "Token page", "Tables", "Navigation"];
const GROUP_NOTE: Partial<Record<SheetGroup, string>> = {
  Pulse: "On Pulse",
  "Token page": "On token pages",
  Trading: "Hold Space",
  Tables: "In a focused table",
};

/** Fixed keys that aren't rebindable: each entry lists alternatives, each a chord of keycaps. */
interface FixedShortcut {
  id: string;
  label: string;
  keys: string[][];
  /** Live only where this handler exists (e.g. a Pulse column key). */
  liveWith?: HotkeyActionInfo["id"];
}

const MOD = IS_MAC ? "Cmd" : "Ctrl";

const FIXED: Partial<Record<SheetGroup, FixedShortcut[]>> = {
  Pulse: [{ id: "pulse-search", label: "Search the focused column", keys: [["/"]], liveWith: "pulse.col1" }],
  Tables: [
    { id: "t-move", label: "Move the cursor", keys: [["↑"], ["↓"], ["Home"], ["End"], ["PgUp"], ["PgDn"]] },
    { id: "t-open", label: "Open the row", keys: [["Enter"]] },
    { id: "t-open-new", label: "Open the row in a new tab", keys: [[MOD, "Enter"]] },
    { id: "t-details", label: "Row details", keys: [["Shift", "Enter"]] },
    { id: "t-copy", label: "Copy the address", keys: [["C"]] },
  ],
};

/*
 * Shortcut sheet (DESIGN.md 1.5, 6.4): searchable, three columns, grouped by area. Shortcuts
 * that can't fire here (another page's keys, trade keys while they're off or without a target)
 * are greyed out, and a modifier legend explains the keycaps. Searchable multi-column sheet after
 * Obvious; greyed-out shortcuts and a modifier legend after Perplexity:
 * https://mobbin.com/screens/d1f418bb-9d1a-40b6-a7b5-7b294ef64703
 * https://mobbin.com/screens/b0a63cb0-ff2e-49a9-90ab-b4dff7f8084d
 */
export function HotkeysHelp() {
  const open = useUi((s) => s.hotkeysHelpOpen);
  const setOpen = useUi((s) => s.setHotkeysHelp);
  const openSettings = useUi((s) => s.openSettings);
  const hotkeys = useSettings((s) => s.hotkeys);
  const tradeHotkeys = useSettings((s) => s.tradeHotkeys);
  const [query, setQuery] = useState("");

  // Handlers register per page, so "applies here" is a live handler for the action (computed when
  // the sheet opens; pages don't change underneath an open modal).
  const live = useMemo(() => {
    const set = new Set<string>();
    if (!open) return set;
    for (const a of HOTKEY_ACTIONS) {
      if (hasHandler(a.id) && (!TRADE_ACTIONS.has(a.id) || tradeHotkeys)) set.add(a.id);
    }
    return set;
  }, [open, tradeHotkeys]);

  const q = query.trim().toLowerCase();
  const matches = (a: HotkeyActionInfo) =>
    !q || a.label.toLowerCase().includes(q) || (hotkeys[a.id] ?? []).some((b) => compactLabel(b).toLowerCase().includes(q));
  const matchesFixed = (f: FixedShortcut) =>
    !q || f.label.toLowerCase().includes(q) || f.keys.some((k) => k.join("+").toLowerCase().includes(q));
  const groups = GROUPS.map((g) => ({
    group: g,
    actions: HOTKEY_ACTIONS.filter((a) => a.group === g && matches(a)),
    fixed: (FIXED[g] ?? []).filter(matchesFixed),
  })).filter((g) => g.actions.length > 0 || g.fixed.length > 0);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const mods = IS_MAC
    ? [
        { k: "Cmd", label: "Command" },
        { k: "Shift", label: "Shift" },
        { k: "Option", label: "Option" },
      ]
    : [
        { k: "Ctrl", label: "Control" },
        { k: "Shift", label: "Shift" },
        { k: "Alt", label: "Alt" },
      ];

  return (
    <Modal
      open={open}
      onClose={close}
      title="Keyboard shortcuts"
      description="Greyed-out keys don't apply on this page right now."
      width={880}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-label text-fg-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {mods.map((m) => (
              <span key={m.k} className="inline-flex items-center gap-1">
                <KeyCap k={m.k} /> {m.label}
              </span>
            ))}
            <span className="inline-flex items-center gap-1">
              <KeyCap k="Space" /> + key: hold Space, then press the key
            </span>
            <span className="inline-flex items-center gap-1">
              <KeyCap k="G" /> <span className="text-micro">then</span> <KeyCap k="P" />: one after the other
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span>Trade hotkeys {tradeHotkeys ? "on" : "off"}</span>
            <Button
              size="xs"
              variant="secondary"
              onClick={() => {
                close();
                openSettings("hotkeys");
              }}
            >
              Edit shortcuts
            </Button>
          </div>
        </div>
      }
    >
      <label className="relative mb-3 block w-full sm:w-60">
        <span className="sr-only">Search shortcuts</span>
        <Search className="icon-sm pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-fg-3" />
        <input
          data-autofocus
          type="search"
          className="zf-input pl-7 max-md:h-11"
          placeholder="Search actions or keys"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.preventDefault();
              e.stopPropagation();
              setQuery("");
            }
          }}
        />
      </label>
      {groups.length === 0 ? (
        <p className="text-data text-fg-3">No shortcuts match “{query.trim()}”.</p>
      ) : (
        <div className="gap-x-6 sm:columns-2 lg:columns-3">
          {groups.map(({ group, actions, fixed }) => (
            <section key={group} className="mb-4 break-inside-avoid">
              <div className="flex h-6 items-center justify-between gap-2">
                <h3 className="zf-group-label">{group}</h3>
                {GROUP_NOTE[group] && <span className="text-micro text-fg-3">{GROUP_NOTE[group]}</span>}
              </div>
              <ul>
                {actions.map((a) => {
                  const bindings = hotkeys[a.id] ?? [];
                  const dim = !live.has(a.id);
                  return (
                    <li key={a.id} className="flex min-h-6 items-center justify-between gap-2 py-0.5 text-data">
                      <span className={cn("min-w-0", dim ? "text-fg-4" : "text-fg-2")}>
                        {a.label}
                        {dim && <span className="sr-only"> (not available here)</span>}
                      </span>
                      <span className={cn("flex shrink-0 items-center gap-1", dim && "opacity-50")}>
                        {bindings.length === 0 ? (
                          <span className="text-label text-fg-4">Not set</span>
                        ) : (
                          bindings.map((b, i) => (
                            <span key={b} className="inline-flex items-center gap-1">
                              {i > 0 && <span className="text-micro text-fg-3">or</span>}
                              <Hotkey binding={b} />
                            </span>
                          ))
                        )}
                      </span>
                    </li>
                  );
                })}
                {fixed.map((f) => {
                  const dim = f.liveWith ? !live.has(f.liveWith) : false;
                  return (
                    <li key={f.id} className="flex min-h-6 items-center justify-between gap-2 py-0.5 text-data">
                      <span className={cn("min-w-0", dim ? "text-fg-4" : "text-fg-2")}>
                        {f.label}
                        {dim && <span className="sr-only"> (not available here)</span>}
                      </span>
                      <span className={cn("flex shrink-0 flex-wrap items-center justify-end gap-1", dim && "opacity-50")}>
                        {f.keys.map((chord, i) => (
                          <span key={chord.join("+")} className="inline-flex items-center gap-0.5">
                            {i > 0 && <span className="pr-0.5 text-micro text-fg-3">·</span>}
                            {chord.map((k) => (
                              <KeyCap key={k} k={k} />
                            ))}
                          </span>
                        ))}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Modal>
  );
}
