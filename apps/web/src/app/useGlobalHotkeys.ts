import { useEffect } from "react";
import {
  type Binding,
  chordMatches,
  dispatchHotkey,
  eventKey,
  type HotkeyAction,
  hasHandler,
  isTypingTarget,
  parseBinding,
  TRADE_ACTIONS,
} from "../lib/hotkeys";
import { overlayOpen } from "../lib/overlayStack";
import { useSettings } from "../state/settings";

const SEQUENCE_WINDOW_MS = 900;
const TYPING_ALLOWED: ReadonlySet<HotkeyAction> = new Set<HotkeyAction>(["ui.close", "search.open", "settings.open"]);

function compile(map: Record<HotkeyAction, string[]>): { action: HotkeyAction; binding: Binding }[] {
  const out: { action: HotkeyAction; binding: Binding }[] = [];
  for (const [action, list] of Object.entries(map) as [HotkeyAction, string[]][]) {
    for (const text of list) {
      const binding = parseBinding(text);
      if (binding) out.push({ action, binding });
    }
  }
  return out;
}

/** Window-level keyboard handling: Space-hold chords, "G P" sequences, typing guard. */
export function useGlobalHotkeys(): void {
  const hotkeys = useSettings((s) => s.hotkeys);
  const tradeHotkeys = useSettings((s) => s.tradeHotkeys);

  useEffect(() => {
    const bindings = compile(hotkeys);
    const single = bindings.filter((b) => b.binding.length === 1);
    const sequences = bindings.filter((b) => b.binding.length === 2);
    let spaceHeld = false;
    let last: { e: KeyboardEvent; at: number } | null = null;

    const tradeTargetAvailable = () => tradeHotkeys && [...TRADE_ACTIONS].some((a) => hasHandler(a));

    const onKeyDown = (e: KeyboardEvent) => {
      const typing = isTypingTarget(e.target);
      if (e.code === "Space" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (tradeTargetAvailable() && !overlayOpen()) {
          e.preventDefault();
          spaceHeld = true;
        }
        return;
      }
      const now = performance.now();
      // The same key can mean different things per page ("L": next column on Pulse, Limit on a
      // token page); only actions with a live handler count, sequences before single keys, and
      // a handler that declines (returns false) passes the key on to the next candidate.
      const candidates: HotkeyAction[] = [];
      if (last && now - last.at < SEQUENCE_WINDOW_MS && !typing) {
        const prev = last.e;
        for (const s of sequences) {
          const [first, second] = s.binding;
          if (first && second && hasHandler(s.action) && chordMatches(first, prev, false) && chordMatches(second, e, false)) {
            candidates.push(s.action);
          }
        }
      }
      for (const s of single) {
        const [chord] = s.binding;
        if (chord && hasHandler(s.action) && chordMatches(chord, e, spaceHeld)) candidates.push(s.action);
      }
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !spaceHeld && eventKey(e).length === 1;
      last = plain && !typing ? { e, at: now } : null;
      for (const action of candidates) {
        if (typing && !TYPING_ALLOWED.has(action)) continue;
        // With a modal, drawer, palette or menu open, only Esc reaches the app (DESIGN.md 6.4).
        if (overlayOpen() && action !== "ui.close") continue;
        if (TRADE_ACTIONS.has(action) && (!tradeHotkeys || e.repeat)) continue;
        if (dispatchHotkey(action)) {
          e.preventDefault();
          e.stopPropagation();
          last = null;
          return;
        }
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceHeld = false;
    };
    const onBlur = () => {
      spaceHeld = false;
      last = null;
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [hotkeys, tradeHotkeys]);
}
