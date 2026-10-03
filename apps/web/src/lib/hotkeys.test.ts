import { describe, expect, test } from "bun:test";
import { bindingLabel, chordMatches, DEFAULT_HOTKEYS, dispatchHotkey, parseBinding, registerHotkey } from "./hotkeys";

function key(code: string, opts: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return { code, key: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...opts } as KeyboardEvent;
}

describe("hotkey bindings", () => {
  test("every default binding parses", () => {
    for (const list of Object.values(DEFAULT_HOTKEYS)) for (const b of list) expect(parseBinding(b)).not.toBeNull();
  });

  test("Space-hold chords only match while Space is held", () => {
    const [chord] = parseBinding("Space+1") ?? [];
    expect(chord).toBeDefined();
    if (!chord) return;
    expect(chordMatches(chord, key("Digit1"), true)).toBe(true);
    expect(chordMatches(chord, key("Digit1"), false)).toBe(false);
    expect(chordMatches(chord, key("Digit2"), true)).toBe(false);
  });

  test("modifiers must match exactly", () => {
    const [chord] = parseBinding("Shift+I") ?? [];
    if (!chord) throw new Error("parse failed");
    expect(chordMatches(chord, key("KeyI", { shiftKey: true }), false)).toBe(true);
    expect(chordMatches(chord, key("KeyI"), false)).toBe(false);
    expect(chordMatches(chord, key("KeyI", { shiftKey: true, altKey: true }), false)).toBe(false);
  });

  test("two-step sequences and labels", () => {
    expect(parseBinding("G P")).toHaveLength(2);
    expect(bindingLabel("Space+Q")).toEqual([["␣", "Q"]]);
    expect(bindingLabel("Shift+/")).toEqual([["?"]]);
  });

  test("the most recent handler wins and unregistering restores the previous one", () => {
    const calls: string[] = [];
    const offA = registerHotkey("buy.1", () => calls.push("pulse"));
    const offB = registerHotkey("buy.1", () => calls.push("token"));
    dispatchHotkey("buy.1");
    offB();
    dispatchHotkey("buy.1");
    offA();
    expect(dispatchHotkey("buy.1")).toBe(false);
    expect(calls).toEqual(["token", "pulse"]);
  });
});
