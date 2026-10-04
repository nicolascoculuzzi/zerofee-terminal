import { chordFromEvent } from "../../lib/hotkeys";

export interface RecorderHandlers {
  /** Space went down or up while recording (for the "Space + key" hint). */
  onSpace: (held: boolean) => void;
  /** A complete binding, e.g. "Space+Q", "Mod+K" or "G P". Recording is over. */
  onChord: (binding: string) => void;
  /** Escape, or a pointer-down outside `keepOpen`. Recording is over. */
  onCancel: () => void;
  /** Pointer-downs inside this element (the recorder's own controls) don't cancel. */
  keepOpen?: () => Element | null;
  /** Sequence mode: a plain first key is waiting for a possible second key ("G then …"). */
  onPending?: (first: string) => void;
}

export interface RecorderOptions {
  /**
   * Window for the second key of a sequence ("G then P"), in ms. A plain single key (no
   * modifiers, no Space) waits this long for a second key; 0 records single chords only.
   */
  sequenceMs?: number;
}

/** Unmodified single-character keys can start a sequence (the same rule as the global handler). */
function canStartSequence(chord: string): boolean {
  return !chord.includes("+") && chord.length === 1;
}

/**
 * Records the next binding. Listens on `target` (the window) in the CAPTURE phase and stops
 * every keydown there with preventDefault + stopImmediatePropagation, so the global hotkey
 * handler never fires while a key is being recorded. Space is tracked as a held modifier for
 * Space combos; Escape on its own cancels.
 *
 * Returns a stop function. Keys still down when it's called (the chord itself, Space, a
 * modifier) keep having their auto-repeat swallowed until released, so a just-recorded hotkey
 * can't fire and Space can't scroll the page. Keyups always pass through: hotkeys fire on
 * keydown only, and the global handler needs Space's keyup to keep its own state right.
 */
export function startRecording(handlers: RecorderHandlers, target: Window = window, options: RecorderOptions = {}): () => void {
  let space = false;
  let active = true;
  let first: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const held = new Set<string>();
  const sequenceMs = options.sequenceMs ?? 0;

  const finish = (binding: string) => {
    if (timer) clearTimeout(timer);
    timer = null;
    first = null;
    active = false;
    handlers.onChord(binding);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    held.add(e.code);
    if (!active) return;
    if (e.code === "Space") {
      if (!space) {
        space = true;
        handlers.onSpace(true);
      }
      return;
    }
    if (e.key === "Escape" && !space && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      if (timer) clearTimeout(timer);
      timer = null;
      first = null;
      active = false;
      handlers.onCancel();
      return;
    }
    if (e.repeat) return;
    if (first !== null) {
      // Second step of a sequence: Space combos can't follow a first key, so Space is ignored here.
      const second = chordFromEvent(e, false);
      if (second) finish(`${first} ${second}`);
      return;
    }
    const chord = chordFromEvent(e, space);
    if (!chord) return;
    if (sequenceMs > 0 && canStartSequence(chord)) {
      first = chord;
      handlers.onPending?.(chord);
      timer = setTimeout(() => {
        if (active && first !== null) finish(first);
      }, sequenceMs);
      return;
    }
    finish(chord);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    held.delete(e.code);
    if (e.code !== "Space") return;
    e.preventDefault();
    space = false;
    if (active) handlers.onSpace(false);
  };
  const onPointerDown = (e: Event) => {
    if (!active) return;
    const inside = handlers.keepOpen?.();
    if (inside && e.target instanceof Node && inside.contains(e.target)) return;
    if (timer) clearTimeout(timer);
    timer = null;
    first = null;
    active = false;
    handlers.onCancel();
  };
  const onBlur = () => {
    space = false;
    held.clear();
    if (active) handlers.onSpace(false);
  };

  target.addEventListener("keydown", onKeyDown, true);
  target.addEventListener("keyup", onKeyUp, true);
  target.addEventListener("pointerdown", onPointerDown, true);
  target.addEventListener("blur", onBlur);
  return () => {
    active = false;
    if (timer) clearTimeout(timer);
    timer = null;
    target.removeEventListener("keydown", onKeyDown, true);
    target.removeEventListener("keyup", onKeyUp, true);
    target.removeEventListener("pointerdown", onPointerDown, true);
    target.removeEventListener("blur", onBlur);
    if (held.size > 0) swallowUntilReleased(held, target);
  };
}

/** Swallows keydowns of `codes` (auto-repeat) until each is released; gives up on blur or after 3 s. */
function swallowUntilReleased(codes: Set<string>, target: Window): void {
  function done() {
    clearTimeout(timer);
    target.removeEventListener("keydown", onKeyDown, true);
    target.removeEventListener("keyup", onKeyUp, true);
    target.removeEventListener("blur", done);
  }
  function onKeyDown(e: KeyboardEvent) {
    if (!codes.has(e.code)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  function onKeyUp(e: KeyboardEvent) {
    if (!codes.has(e.code)) return;
    codes.delete(e.code);
    if (codes.size === 0) done();
  }
  const timer = setTimeout(done, 3000);
  target.addEventListener("keydown", onKeyDown, true);
  target.addEventListener("keyup", onKeyUp, true);
  target.addEventListener("blur", done);
}
