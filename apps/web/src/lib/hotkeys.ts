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
  | "nav.orders"
  | "nav.settings"
  | "buy.quick"
  | "quote.toggle"
  | "density.toggle"
  | "wallet.lock"
  | "panic"
  | "pulse.col1"
  | "pulse.col2"
  | "pulse.col3"
  | "pulse.prevCol"
  | "pulse.nextCol"
  | "pulse.down"
  | "pulse.up"
  | "pulse.first"
  | "pulse.last"
  | "pulse.open"
  | "pulse.openNew"
  | "pulse.copy"
  | "pulse.hide"
  | "pulse.blacklistDev"
  | "pulse.filters"
  | "pulse.pause"
  | "pulse.pauseAll"
  | "token.sideBuy"
  | "token.sideSell"
  | "token.market"
  | "token.limit"
  | "token.advanced"
  | "token.prevTf"
  | "token.nextTf"
  | "token.toggleMc"
  | "token.alert"
  | "token.tab1"
  | "token.tab2"
  | "token.tab3"
  | "token.tab4"
  | "token.tab5"
  | "token.tab6"
  | "token.unlock"
  | "orders.cancel"
  | "orders.rearm";

export type HotkeyGroup = "General" | "Trading" | "Pulse" | "Token page" | "Navigation";

/** Where a binding is live: the same key may mean different things on different pages. */
export type HotkeyScope = "global" | "pulse" | "token" | "orders";

export interface HotkeyActionInfo {
  id: HotkeyAction;
  label: string;
  group: HotkeyGroup;
  scope?: HotkeyScope;
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
  { id: "nav.settings", label: "Go to Settings", group: "Navigation" },
  { id: "buy.quick", label: "Quick-buy the cursor, hovered or open token", group: "Trading" },
  { id: "quote.toggle", label: "Toggle USD / SOL", group: "General" },
  { id: "density.toggle", label: "Toggle density", group: "General" },
  { id: "wallet.lock", label: "Lock keystore", group: "General" },
  { id: "panic", label: "Panic (cancel all orders and lock)", group: "General" },
  { id: "pulse.col1", label: "Focus New Pairs", group: "Pulse", scope: "pulse" },
  { id: "pulse.col2", label: "Focus Final Stretch", group: "Pulse", scope: "pulse" },
  { id: "pulse.col3", label: "Focus Migrated", group: "Pulse", scope: "pulse" },
  { id: "pulse.prevCol", label: "Previous column", group: "Pulse", scope: "pulse" },
  { id: "pulse.nextCol", label: "Next column", group: "Pulse", scope: "pulse" },
  { id: "pulse.down", label: "Next card", group: "Pulse", scope: "pulse" },
  { id: "pulse.up", label: "Previous card", group: "Pulse", scope: "pulse" },
  { id: "pulse.first", label: "First card", group: "Pulse", scope: "pulse" },
  { id: "pulse.last", label: "Last card", group: "Pulse", scope: "pulse" },
  { id: "pulse.open", label: "Open token", group: "Pulse", scope: "pulse" },
  { id: "pulse.openNew", label: "Open token in a new tab", group: "Pulse", scope: "pulse" },
  { id: "pulse.copy", label: "Copy contract address", group: "Pulse", scope: "pulse" },
  { id: "pulse.hide", label: "Hide token (blacklist)", group: "Pulse", scope: "pulse" },
  { id: "pulse.blacklistDev", label: "Blacklist dev", group: "Pulse", scope: "pulse" },
  { id: "pulse.filters", label: "Filters for the focused column", group: "Pulse", scope: "pulse" },
  { id: "pulse.pause", label: "Pause or resume column", group: "Pulse", scope: "pulse" },
  { id: "pulse.pauseAll", label: "Pause or resume all columns", group: "Pulse", scope: "pulse" },
  { id: "token.sideBuy", label: "Trade side: Buy", group: "Token page", scope: "token" },
  { id: "token.sideSell", label: "Trade side: Sell", group: "Token page", scope: "token" },
  { id: "token.market", label: "Order type: Market", group: "Token page", scope: "token" },
  { id: "token.limit", label: "Order type: Limit", group: "Token page", scope: "token" },
  { id: "token.advanced", label: "Order type: Advanced", group: "Token page", scope: "token" },
  { id: "token.prevTf", label: "Previous timeframe", group: "Token page", scope: "token" },
  { id: "token.nextTf", label: "Next timeframe", group: "Token page", scope: "token" },
  { id: "token.toggleMc", label: "Toggle MC / Price", group: "Token page", scope: "token" },
  { id: "token.alert", label: "New alert at the crosshair", group: "Token page", scope: "token" },
  { id: "token.tab1", label: "Bottom tab 1", group: "Token page", scope: "token" },
  { id: "token.tab2", label: "Bottom tab 2", group: "Token page", scope: "token" },
  { id: "token.tab3", label: "Bottom tab 3", group: "Token page", scope: "token" },
  { id: "token.tab4", label: "Bottom tab 4", group: "Token page", scope: "token" },
  { id: "token.tab5", label: "Bottom tab 5", group: "Token page", scope: "token" },
  { id: "token.tab6", label: "Bottom tab 6", group: "Token page", scope: "token" },
  { id: "token.unlock", label: "Unlock to trade", group: "Token page", scope: "token" },
  { id: "orders.cancel", label: "Cancel the selected order", group: "Navigation", scope: "orders" },
  { id: "orders.rearm", label: "Re-arm the selected order", group: "Navigation", scope: "orders" },
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
  "nav.settings": ["G S"],
  "buy.quick": ["Space+B"],
  "quote.toggle": ["T C"],
  "density.toggle": ["T D"],
  "wallet.lock": ["Mod+Shift+L"],
  panic: ["Mod+Shift+Backspace"],
  "pulse.col1": ["1"],
  "pulse.col2": ["2"],
  "pulse.col3": ["3"],
  "pulse.prevCol": ["H", "ArrowLeft"],
  "pulse.nextCol": ["L", "ArrowRight"],
  "pulse.down": ["J", "ArrowDown"],
  "pulse.up": ["K", "ArrowUp"],
  "pulse.first": ["Home"],
  "pulse.last": ["End"],
  "pulse.open": ["Enter"],
  "pulse.openNew": ["Mod+Enter"],
  "pulse.copy": ["C"],
  "pulse.hide": ["X"],
  "pulse.blacklistDev": ["Shift+X"],
  "pulse.filters": ["F"],
  "pulse.pause": ["P"],
  "pulse.pauseAll": ["Shift+P"],
  "token.sideBuy": ["B"],
  "token.sideSell": ["S"],
  "token.market": ["M"],
  "token.limit": ["L"],
  "token.advanced": ["A"],
  "token.prevTf": ["["],
  "token.nextTf": ["]"],
  "token.toggleMc": ["Shift+M"],
  "token.alert": ["Alt+A"],
  "token.tab1": ["Shift+1"],
  "token.tab2": ["Shift+2"],
  "token.tab3": ["Shift+3"],
  "token.tab4": ["Shift+4"],
  "token.tab5": ["Shift+5"],
  "token.tab6": ["Shift+6"],
  "token.unlock": ["U"],
  "orders.cancel": ["Delete"],
  "orders.rearm": ["R"],
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
  "buy.quick",
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
    // Words, never ⌘ ⇧ ⌥ glyphs (missing from our fonts, DESIGN.md 2.2). <Hotkey> draws the
    // macOS modifiers as icons.
    if (c.space) keys.push("Space");
    if (c.mod) keys.push(IS_MAC ? "Cmd" : "Ctrl");
    if (c.ctrl) keys.push("Ctrl");
    if (c.meta) keys.push(IS_MAC ? "Cmd" : "Win");
    if (c.alt) keys.push(IS_MAC ? "Option" : "Alt");
    if (c.shift) keys.push(c.key === "/" ? "" : "Shift");
    keys.push(c.shift && c.key === "/" ? "?" : c.key === "Escape" ? "Esc" : c.key);
    return keys.filter(Boolean);
  });
}

export function compactLabel(text: string | undefined): string {
  if (!text) return "";
  return bindingLabel(text)
    .map((k) => k.join("+"))
    .join(" then ");
}

// ---------------------------------------------------------------------------
// Runtime registry: components register handlers; the shell owns the listener.
// ---------------------------------------------------------------------------

/**
 * A hotkey handler. Return `false` to decline (nothing to act on here): the next handler down
 * the stack gets the key, and if none takes it the key event is left alone (no preventDefault),
 * so the browser or a focused control still sees it.
 */
type Handler = () => unknown;
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

/** Runs the newest handler that accepts the key; returns whether one did. */
export function dispatchHotkey(action: HotkeyAction): boolean {
  const list = handlers.get(action);
  if (!list) return false;
  for (let i = list.length - 1; i >= 0; i--) {
    const handler = list[i];
    if (handler && handler() !== false) return true;
  }
  return false;
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
