import { describe, expect, test } from "bun:test";
import { DEFAULT_HOTKEYS, type HotkeyAction } from "../../lib/hotkeys";
import { allClashes, bindingsClash, canonical, findClashes, scopesOverlap } from "./conflicts";

const withBindings = (patch: Partial<Record<HotkeyAction, string[]>>) => ({ ...DEFAULT_HOTKEYS, ...patch });

describe("hotkey conflicts", () => {
  test("Mod resolves per platform", () => {
    expect(canonical("Mod+K", true)).toBe("meta+k");
    expect(canonical("Mod+K", false)).toBe("ctrl+k");
    expect(bindingsClash("Mod+K", "Meta+K", true)).toBe(true);
    expect(bindingsClash("Mod+K", "Meta+K", false)).toBe(false);
  });

  test("a single key shadows a sequence that starts with it; second steps don't", () => {
    expect(bindingsClash("G", "G P")).toBe(true);
    expect(bindingsClash("G P", "G")).toBe(true);
    expect(bindingsClash("C", "T C")).toBe(false);
    expect(bindingsClash("G P", "G D")).toBe(false);
    expect(bindingsClash("Space+1", "1")).toBe(false);
  });

  test("scopes overlap only when equal or global", () => {
    expect(scopesOverlap("pulse", "token")).toBe(false);
    expect(scopesOverlap("pulse", "pulse")).toBe(true);
    expect(scopesOverlap("global", "orders")).toBe(true);
  });

  test("the defaults have no clashes", () => {
    expect(allClashes(DEFAULT_HOTKEYS, true).size).toBe(0);
    expect(allClashes(DEFAULT_HOTKEYS, false).size).toBe(0);
  });

  test("the same key on different pages is not a conflict", () => {
    // "L": next column on Pulse, Limit on a token page.
    expect(findClashes("token.limit", "L", DEFAULT_HOTKEYS)).toEqual([]);
    expect(findClashes("pulse.nextCol", "L", DEFAULT_HOTKEYS)).toEqual([]);
  });

  test("a page key that matches a global binding conflicts", () => {
    expect(findClashes("pulse.copy", "Shift+I", DEFAULT_HOTKEYS)).toEqual([{ action: "instant.toggle", binding: "Shift+I" }]);
    expect(findClashes("token.alert", "G", DEFAULT_HOTKEYS).map((c) => c.action)).toEqual([
      "nav.discover",
      "nav.pulse",
      "nav.trackers",
      "nav.portfolio",
      "nav.orders",
      "nav.settings",
    ]);
  });

  test("allClashes reports both sides of a duplicate", () => {
    const map = allClashes(withBindings({ "pulse.filters": ["Shift+I"] }), true);
    expect(map.get("pulse.filters Shift+I")).toEqual([{ action: "instant.toggle", binding: "Shift+I" }]);
    expect(map.get("instant.toggle Shift+I")).toEqual([{ action: "pulse.filters", binding: "Shift+I" }]);
  });
});
