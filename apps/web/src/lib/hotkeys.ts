/**
 * Configurable hotkeys. Bindings are strings such as "Space+1" (hold Space, press 1),
 * "Mod+K" (Cmd on macOS, Ctrl elsewhere), "Shift+I", "Escape", "/" or a two-step sequence
 * "G P". Keys are matched on `KeyboardEvent.code`, so they work on any keyboard layout.
 */
export type HotkeyAction =
  | "search.open"
  | "ui.close"
  | "settings.open"
  | "instant.toggle"
  | "hotkeys.help"
  | "buy.1"
  | "buy.2"
  | "buy.3"
  | "buy.4"
  | "sell.1"
  | "sell.2"
  | "sell.3"
  | "sell.4"
  | "sell.initials"
  | "preset.1"
  | "preset.2"
  | "preset.3"
  | "nav.discover"
  | "nav.pulse"
  | "nav.trackers"
  | "nav.portfolio"
  | "nav.orders";

export interface HotkeyActionInfo {
  id: HotkeyAction;
  label: string;
  group: "General" | "Trading" | "Navigation";
}

export const HOTKEY_ACTIONS: HotkeyActionInfo[] = [
  { id: "search.open", label: "Open search", group: "General" },
  { id: "ui.close", label: "Close dialog / window", group: "General" },
  { id: "settings.open", label: "Open settings", group: "General" },
  { id: "instant.toggle", label: "Toggle Instant Trade window", group: "General" },
  { id: "hotkeys.help", label: "Show hotkeys", group: "General" },
  { id: "buy.1", label: "Buy preset 1 (hovered or open token)", group: "Trading" },
  { id: "buy.2", label: "Buy preset 2", group: "Trading" },
  { id: "buy.3", label: "Buy preset 3", group: "Trading" },
  { id: "buy.4", label: "Buy preset 4", group: "Trading" },
  { id: "sell.1", label: "Sell preset 1", group: "Trading" },
  { id: "sell.2", label: "Sell preset 2", group: "Trading" },
  { id: "sell.3", label: "Sell preset 3", group: "Trading" },
  { id: "sell.4", label: "Sell preset 4", group: "Trading" },
  { id: "sell.initials", label: "Sell initials", group: "Trading" },
  { id: "preset.1", label: "Switch to P1", group: "Trading" },
  { id: "preset.2", label: "Switch to P2", group: "Trading" },
  { id: "preset.3", label: "Switch to P3", group: "Trading" },
  { id: "nav.discover", label: "Go to Discover", group: "Navigation" },
  { id: "nav.pulse", label: "Go to Pulse", group: "Navigation" },
  { id: "nav.trackers", label: "Go to Trackers", group: "Navigation" },
  { id: "nav.portfolio", label: "Go to Portfolio", group: "Navigation" },
  { id: "nav.orders", label: "Go to Armed orders", group: "Navigation" },
];

export const DEFAULT_HOTKEYS: Record<HotkeyAction, string[]> = {
  "search.open": ["/", "Mod+K"],
  "ui.close": ["Escape"],
  "settings.open": ["Mod+,"],
  "instant.toggle": ["Shift+I"],
  "hotkeys.help": ["Shift+/"],
  "buy.1": ["Space+1"],
  "buy.2": ["Space+2"],
  "buy.3": ["Space+3"],
  "buy.4": ["Space+4"],
  "sell.1": ["Space+Q"],
  "sell.2": ["Space+W"],
  "sell.3": ["Space+E"],
  "sell.4": ["Space+R"],
  "sell.initials": ["Space+T"],
  "preset.1": ["Alt+1"],
  "preset.2": ["Alt+2"],
  "preset.3": ["Alt+3"],
  "nav.discover": ["G D"],
  "nav.pulse": ["G P"],
  "nav.trackers": ["G T"],
  "nav.portfolio": ["G W"],
  "nav.orders": ["G O"],
};

export const TRADE_ACTIONS: ReadonlySet<HotkeyAction> = new Set<HotkeyAction>([
  "buy.1",
  "buy.2",
  "buy.3",
  "buy.4",
  "sell.1",
  "sell.2",
  "sell.3",
  "sell.4",
  "sell.initials",
]);

export interface Chord {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  space: boolean;
  key: string;
}

export type Binding = Chord[];

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

function normalizeKeyName(raw: string): string {
  if (raw.length === 1) return raw.toUpperCase();
  const k = raw.toLowerCase();
  if (k === "esc") return "Escape";
  if (k === "space") return "Space";
  if (k === "enter" || k === "return") return "Enter";
  return raw[0]?.toUpperCase() + raw.slice(1);
}

export function parseChord(text: string): Chord | null {
  const parts = text.split("+").map((p) => p.trim());
  // "Mod++" would mean the plus key; not supported, keep it simple.
  if (parts.some((p) => p === "")) return null;
  const chord: Chord = { mod: false, ctrl: false, alt: false, shift: false, meta: false, space: false, key: "" };
  parts.forEach((part, i) => {
    const p = part.toLowerCase();
    const last = i === parts.length - 1;
    if (!last && p === "mod") chord.mod = true;
    else if (!last && p === "ctrl") chord.ctrl = true;
    else if (!last && (p === "alt" || p === "option")) chord.alt = true;
    else if (!last && p === "shift") chord.shift = true;
    else if (!last && (p === "meta" || p === "cmd")) chord.meta = true;
    else if (!last && p === "space") chord.space = true;
    else chord.key = normalizeKeyName(part);
  });
  return chord.key ? chord : null;
}

export function parseBinding(text: string): Binding | null {
  const steps = text.trim().split(/\s+/);
  if (steps.length === 0 || steps.length > 2) return null;
  const chords: Chord[] = [];
  for (const s of steps) {
    const c = parseChord(s);
    if (!c) return null;
    chords.push(c);
  }
  return chords;
}

const CODE_MAP: Record<string, string> = {
  Slash: "/",
  Comma: ",",
  Period: ".",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  Backslash: "\\",
  Space: "Space",
};

export function eventKey(e: KeyboardEvent): string {
  const code = e.code;
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad") && /\d$/.test(code)) return code.slice(6);
  const mapped = CODE_MAP[code];
  if (mapped) return mapped;
  return normalizeKeyName(e.key);
}

export function chordMatches(c: Chord, e: KeyboardEvent, spaceHeld: boolean): boolean {
  if (c.key !== eventKey(e)) return false;
  const wantMeta = c.meta || (c.mod && IS_MAC);
  const wantCtrl = c.ctrl || (c.mod && !IS_MAC);
  if (wantMeta !== e.metaKey) return false;
  if (wantCtrl !== e.ctrlKey) return false;
  if (c.alt !== e.altKey) return false;
  if (c.shift !== e.shiftKey) return false;
  if (c.space !== spaceHeld) return false;
  return true;
}

/** Turns a keydown into a binding string, for the hotkey recorder. */
export function chordFromEvent(e: KeyboardEvent, spaceHeld: boolean): string | null {
  const key = eventKey(e);
  if (["Shift", "Control", "Alt", "Meta", "Space"].includes(key)) return null;
  const parts: string[] = [];
  if (spaceHeld) parts.push("Space");
  if (IS_MAC ? e.metaKey : e.ctrlKey) parts.push("Mod");
  if (IS_MAC && e.ctrlKey) parts.push("Ctrl");
  if (!IS_MAC && e.metaKey) parts.push("Meta");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

/** Human label: "Space+Q" → ["␣", "Q"], "Mod+K" → ["⌘", "K"]. */
export function bindingLabel(text: string): string[][] {
  const binding = parseBinding(text);
  if (!binding) return [[text]];
  return binding.map((c) => {
    const keys: string[] = [];
    if (c.space) keys.push("␣");
    if (c.mod) keys.push(IS_MAC ? "⌘" : "Ctrl");
    if (c.ctrl) keys.push("Ctrl");
    if (c.meta) keys.push(IS_MAC ? "⌘" : "Win");
    if (c.alt) keys.push(IS_MAC ? "⌥" : "Alt");
    if (c.shift) keys.push(c.key === "/" ? "" : "⇧");
    keys.push(c.shift && c.key === "/" ? "?" : c.key === "Escape" ? "Esc" : c.key);
    return keys.filter(Boolean);
  });
}

export function compactLabel(text: string | undefined): string {
  if (!text) return "";
  return bindingLabel(text)
    .map((k) => k.join(""))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Runtime registry: components register handlers; the shell owns the listener.
// ---------------------------------------------------------------------------

type Handler = () => void;
const handlers = new Map<HotkeyAction, Handler[]>();

/** Last registration wins (a stack), so a focused panel can override a page. */
export function registerHotkey(action: HotkeyAction, handler: Handler): () => void {
  const list = handlers.get(action) ?? [];
  list.push(handler);
  handlers.set(action, list);
  return () => {
    const current = handlers.get(action);
    if (!current) return;
    const idx = current.lastIndexOf(handler);
    if (idx >= 0) current.splice(idx, 1);
  };
}

export function hasHandler(action: HotkeyAction): boolean {
  return (handlers.get(action)?.length ?? 0) > 0;
}

export function dispatchHotkey(action: HotkeyAction): boolean {
  const list = handlers.get(action);
  const handler = list?.[list.length - 1];
  if (!handler) return false;
  handler();
  return true;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "range", "color"].includes(type);
  }
  return false;
}
