import { HOTKEY_ACTIONS, type HotkeyAction, type HotkeyScope, IS_MAC, parseBinding } from "../../lib/hotkeys";

/** Platform-resolved identity of a binding, so "Mod+K" and "Meta+K" collide on macOS. */
export function canonical(text: string, mac: boolean = IS_MAC): string {
  const binding = parseBinding(text);
  if (!binding) return text.trim().toLowerCase();
  return binding
    .map((c) => {
      const meta = c.meta || (c.mod && mac);
      const ctrl = c.ctrl || (c.mod && !mac);
      return [c.space && "space", meta && "meta", ctrl && "ctrl", c.alt && "alt", c.shift && "shift", c.key.toLowerCase()]
        .filter(Boolean)
        .join("+");
    })
    .join(" ");
}

const SCOPE = new Map<HotkeyAction, HotkeyScope>(HOTKEY_ACTIONS.map((a) => [a.id, a.scope ?? "global"]));

export function scopeOf(action: HotkeyAction): HotkeyScope {
  return SCOPE.get(action) ?? "global";
}

/** Two actions can collide only when they are live at the same time: same scope, or either is global. */
export function scopesOverlap(a: HotkeyScope, b: HotkeyScope): boolean {
  return a === b || a === "global" || b === "global";
}

/**
 * True when one binding shadows the other: the same keys, or a single key that is the first
 * step of the other's sequence (a bound "G" would swallow "G then P").
 */
export function bindingsClash(a: string, b: string, mac: boolean = IS_MAC): boolean {
  const ca = canonical(a, mac);
  const cb = canonical(b, mac);
  if (ca === cb) return true;
  const [a1, a2] = ca.split(" ");
  const [b1, b2] = cb.split(" ");
  return a1 === b1 && (a2 === undefined) !== (b2 === undefined);
}

export interface Clash {
  action: HotkeyAction;
  binding: string;
}

/** Bindings of other actions that clash with `binding` for `action` in an overlapping scope. */
export function findClashes(
  action: HotkeyAction,
  binding: string,
  hotkeys: Record<HotkeyAction, string[]>,
  mac: boolean = IS_MAC,
): Clash[] {
  const scope = scopeOf(action);
  const out: Clash[] = [];
  for (const a of HOTKEY_ACTIONS) {
    if (a.id === action || !scopesOverlap(scope, a.scope ?? "global")) continue;
    for (const b of hotkeys[a.id] ?? []) if (bindingsClash(binding, b, mac)) out.push({ action: a.id, binding: b });
  }
  return out;
}

/** Every binding that already clashes with another action's binding, keyed `${action} ${binding}`. */
export function allClashes(hotkeys: Record<HotkeyAction, string[]>, mac: boolean = IS_MAC): Map<string, Clash[]> {
  const out = new Map<string, Clash[]>();
  for (const a of HOTKEY_ACTIONS) {
    for (const b of hotkeys[a.id] ?? []) {
      const found = findClashes(a.id, b, hotkeys, mac);
      if (found.length > 0) out.set(`${a.id} ${b}`, found);
    }
  }
  return out;
}
