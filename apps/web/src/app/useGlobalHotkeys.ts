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
        if (tradeTargetAvailable()) {
          e.preventDefault();
          spaceHeld = true;
        }
        return;
      }
      const now = performance.now();
      let matched: HotkeyAction | null = null;
      if (last && now - last.at < SEQUENCE_WINDOW_MS && !typing) {
        const prev = last.e;
        for (const s of sequences) {
          const [first, second] = s.binding;
          if (first && second && chordMatches(first, prev, false) && chordMatches(second, e, false)) {
            matched = s.action;
            break;
          }
        }
      }
      if (!matched) {
        for (const s of single) {
          const [chord] = s.binding;
          if (chord && chordMatches(chord, e, spaceHeld)) {
            matched = s.action;
            break;
          }
        }
      }
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !spaceHeld && eventKey(e).length === 1;
      last = plain && !typing ? { e, at: now } : null;
      if (!matched) return;
      if (typing && !TYPING_ALLOWED.has(matched)) return;
      if (TRADE_ACTIONS.has(matched)) {
        if (!tradeHotkeys || e.repeat) return;
      }
      if (dispatchHotkey(matched)) {
        e.preventDefault();
        e.stopPropagation();
        last = null;
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
