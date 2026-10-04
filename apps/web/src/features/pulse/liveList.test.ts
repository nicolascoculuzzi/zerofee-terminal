import { describe, expect, test } from "bun:test";
import { CALM_MS, emptyList, type ListInput, type ListState, queuedCount, RESORT_MS, stableMerge, stepList } from "./liveList";

const T0 = 1_800_000_000_000;

function input(patch: Partial<ListInput> & { incoming: string[] }): ListInput {
  return { now: T0, frozen: false, calm: false, resortMs: 0, query: "q", nonce: 0, ...patch };
}

function boot(incoming: string[]): ListState {
  return stepList(emptyList(), input({ incoming }));
}

describe("stableMerge", () => {
  test("keeps survivors in their old order and slots new mints after their nearest survivor", () => {
    expect(stableMerge(["a", "b", "c"], ["c", "x", "a", "b"])).toEqual(["a", "b", "c", "x"]);
    expect(stableMerge(["a", "b"], ["n", "a", "b"])).toEqual(["n", "a", "b"]);
    expect(stableMerge(["a", "b", "c"], ["a", "c"])).toEqual(["a", "c"]);
  });
});

describe("stepList", () => {
  test("the first snapshot shows as is, without highlights", () => {
    const s = boot(["a", "b"]);
    expect(s.shown).toEqual(["a", "b"]);
    expect(s.inserted.size).toBe(0);
    expect(s.ready).toBe(true);
  });

  test("live mode inserts at the feed rate and marks new cards", () => {
    const s = stepList(boot(["a", "b"]), input({ incoming: ["n", "a", "b"], now: T0 + 100 }));
    expect(s.shown).toEqual(["n", "a", "b"]);
    expect(s.inserted.get("n")).toBe(T0 + 100);
  });

  test("frozen columns hold order and membership; the queue is counted", () => {
    const base = boot(["a", "b"]);
    const s = stepList(base, input({ incoming: ["n", "b"], now: T0 + 100, frozen: true }));
    expect(s).toBe(base);
    expect(queuedCount(s.shown, ["n", "b"])).toBe(1);
  });

  test("an N-new click applies the queue even while frozen", () => {
    const base = boot(["a", "b"]);
    const s = stepList(base, input({ incoming: ["n", "a", "b"], now: T0 + 100, frozen: true, nonce: 1 }));
    expect(s.shown).toEqual(["n", "a", "b"]);
    expect(s.inserted.has("n")).toBe(true);
    // Still frozen afterwards: later arrivals queue again.
    const later = stepList(s, input({ incoming: ["m", "n", "a", "b"], now: T0 + 200, frozen: true, nonce: 1 }));
    expect(later).toBe(s);
  });

  test("calm mode commits at most once per second", () => {
    const base = boot(["a"]);
    const first = stepList(base, input({ incoming: ["n", "a"], now: T0 + 50, calm: true }));
    expect(first).toBe(base);
    const due = stepList(first, input({ incoming: ["m", "n", "a"], now: T0 + CALM_MS, calm: true }));
    expect(due.shown).toEqual(["m", "n", "a"]);
    const held = stepList(due, input({ incoming: ["k", "m", "n", "a"], now: T0 + CALM_MS + 500, calm: true }));
    expect(held).toBe(due);
  });

  test("value-sorted lists re-sort at most every 2 s; removals still apply", () => {
    const base = boot(["a", "b", "c"]);
    const sorted = stepList(base, input({ incoming: ["b", "a", "c"], now: T0 + 3000, resortMs: RESORT_MS }));
    expect(sorted.shown).toEqual(["b", "a", "c"]);
    const held = stepList(sorted, input({ incoming: ["c", "b"], now: T0 + 3500, resortMs: RESORT_MS }));
    expect(held.shown).toEqual(["b", "c"]);
    const resorted = stepList(held, input({ incoming: ["c", "b"], now: T0 + 3000 + RESORT_MS, resortMs: RESORT_MS }));
    expect(resorted.shown).toEqual(["c", "b"]);
  });

  test("a changed query re-syncs immediately, without highlights, even while frozen", () => {
    const base = boot(["a", "b"]);
    const s = stepList(base, input({ incoming: ["z"], now: T0 + 100, frozen: true, query: "q2" }));
    expect(s.shown).toEqual(["z"]);
    expect(s.inserted.has("z")).toBe(false);
  });

  test("unchanged input returns the same state object", () => {
    const base = boot(["a", "b"]);
    expect(stepList(base, input({ incoming: ["a", "b"], now: T0 + 100 }))).toBe(base);
  });
});
