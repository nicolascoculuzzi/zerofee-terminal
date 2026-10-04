import { describe, expect, test } from "bun:test";

// The recorder checks `instanceof Node` for pointer targets; bun has no DOM, so stand one in
// before loading it.
(globalThis as Record<string, unknown>).Node ??= EventTarget;
const { startRecording } = await import("./recorder");

type Mods = Partial<Record<"shiftKey" | "altKey" | "ctrlKey" | "metaKey" | "repeat", boolean>>;

function key(type: "keydown" | "keyup", code: string, k: string, mods: Mods = {}): Event {
  const e = new Event(type, { cancelable: true });
  Object.defineProperties(e, {
    code: { value: code },
    key: { value: k },
    shiftKey: { value: !!mods.shiftKey },
    altKey: { value: !!mods.altKey },
    ctrlKey: { value: !!mods.ctrlKey },
    metaKey: { value: !!mods.metaKey },
    repeat: { value: !!mods.repeat },
  });
  return e;
}

function setup(keepOpenContains = false, sequenceMs = 0) {
  const win = new EventTarget();
  const log: string[] = [];
  const stop = startRecording(
    {
      onSpace: (held: boolean) => log.push(`space:${held}`),
      onChord: (b: string) => log.push(`chord:${b}`),
      onCancel: () => log.push("cancel"),
      onPending: (first: string) => log.push(`pending:${first}`),
      keepOpen: () => ({ contains: () => keepOpenContains }) as unknown as Element,
    },
    win as unknown as Window,
    { sequenceMs },
  );
  // Stands in for the global hotkey handler: registered after the recorder, non-capture.
  const seen: string[] = [];
  win.addEventListener("keydown", (e) => seen.push(`down:${(e as KeyboardEvent).code}`));
  win.addEventListener("keyup", (e) => seen.push(`up:${(e as KeyboardEvent).code}`));
  return { win, log, seen, stop };
}

describe("hotkey recorder", () => {
  test("records a modified chord and keeps it from the global handler", () => {
    const { win, log, seen } = setup();
    const ev = key("keydown", "KeyI", "I", { shiftKey: true });
    win.dispatchEvent(ev);
    expect(log).toEqual(["chord:Shift+I"]);
    expect(ev.defaultPrevented).toBe(true);
    expect(seen).toEqual([]);
  });

  test("Space combos: Space is tracked, the chord includes it, releases pass through", () => {
    const { win, log, seen, stop } = setup();
    win.dispatchEvent(key("keydown", "Space", " "));
    win.dispatchEvent(key("keydown", "Space", " ", { repeat: true }));
    win.dispatchEvent(key("keydown", "KeyQ", "q"));
    expect(log).toEqual(["space:true", "chord:Space+Q"]);
    stop();
    // Still held after stop: auto-repeat is swallowed, releases pass through.
    win.dispatchEvent(key("keydown", "Space", " ", { repeat: true }));
    win.dispatchEvent(key("keydown", "KeyQ", "q", { repeat: true }));
    win.dispatchEvent(key("keyup", "KeyQ", "q"));
    win.dispatchEvent(key("keyup", "Space", " "));
    expect(seen).toEqual(["up:KeyQ", "up:Space"]);
    // Everything released: the global handler gets keys again.
    win.dispatchEvent(key("keydown", "Digit1", "1"));
    expect(seen).toEqual(["up:KeyQ", "up:Space", "down:Digit1"]);
  });

  test("Escape alone cancels; Shift+Escape can be recorded", () => {
    const a = setup();
    a.win.dispatchEvent(key("keydown", "Escape", "Escape"));
    expect(a.log).toEqual(["cancel"]);
    expect(a.seen).toEqual([]);
    const b = setup();
    b.win.dispatchEvent(key("keydown", "Escape", "Escape", { shiftKey: true }));
    expect(b.log).toEqual(["chord:Shift+Escape"]);
  });

  test("modifier-only and repeated keydowns don't record", () => {
    const { win, log } = setup();
    win.dispatchEvent(key("keydown", "ShiftLeft", "Shift", { shiftKey: true }));
    win.dispatchEvent(key("keydown", "KeyA", "a", { repeat: true }));
    expect(log).toEqual([]);
    win.dispatchEvent(key("keydown", "KeyA", "a"));
    expect(log).toEqual(["chord:A"]);
  });

  test("only the first chord counts until torn down", () => {
    const { win, log, seen } = setup();
    win.dispatchEvent(key("keydown", "KeyA", "a"));
    win.dispatchEvent(key("keydown", "KeyB", "b"));
    expect(log).toEqual(["chord:A"]);
    expect(seen).toEqual([]);
  });

  test("a pointer-down outside cancels; inside the recorder it doesn't", () => {
    const outside = setup(false);
    outside.win.dispatchEvent(new Event("pointerdown"));
    expect(outside.log).toEqual(["cancel"]);
    const inside = setup(true);
    inside.win.dispatchEvent(new Event("pointerdown"));
    expect(inside.log).toEqual([]);
  });

  test("after stop with nothing held, keys reach the global handler", () => {
    const { win, seen, stop } = setup();
    stop();
    win.dispatchEvent(key("keydown", "KeyK", "k", { metaKey: true }));
    expect(seen).toEqual(["down:KeyK"]);
  });
});

describe("hotkey recorder, sequence mode", () => {
  test("two plain keys inside the window record a sequence", () => {
    const { win, log, seen } = setup(false, 50);
    win.dispatchEvent(key("keydown", "KeyG", "g"));
    win.dispatchEvent(key("keydown", "KeyP", "p"));
    expect(log).toEqual(["pending:G", "chord:G P"]);
    expect(seen).toEqual([]);
  });

  test("a plain key alone records itself when the window closes", async () => {
    const { win, log } = setup(false, 20);
    win.dispatchEvent(key("keydown", "KeyB", "b"));
    expect(log).toEqual(["pending:B"]);
    await Bun.sleep(60);
    expect(log).toEqual(["pending:B", "chord:B"]);
  });

  test("modified chords and Space combos record at once", () => {
    const a = setup(false, 50);
    a.win.dispatchEvent(key("keydown", "KeyI", "I", { shiftKey: true }));
    expect(a.log).toEqual(["chord:Shift+I"]);
    const b = setup(false, 50);
    b.win.dispatchEvent(key("keydown", "Space", " "));
    b.win.dispatchEvent(key("keydown", "Digit1", "1"));
    expect(b.log).toEqual(["space:true", "chord:Space+1"]);
  });

  test("Escape while a first key waits cancels the whole recording", async () => {
    const { win, log } = setup(false, 20);
    win.dispatchEvent(key("keydown", "KeyG", "g"));
    win.dispatchEvent(key("keydown", "Escape", "Escape"));
    await Bun.sleep(40);
    expect(log).toEqual(["pending:G", "cancel"]);
  });

  test("stop clears a waiting first key", async () => {
    const { win, log, stop } = setup(false, 20);
    win.dispatchEvent(key("keydown", "KeyT", "t"));
    stop();
    await Bun.sleep(40);
    expect(log).toEqual(["pending:T"]);
  });
});
