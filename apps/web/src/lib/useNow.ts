import { create } from "zustand";
import { fmtAge } from "./format";

/**
 * One shared 1 Hz clock (DESIGN.md 3.7, 8). Components subscribe through a selector, so a row
 * re-renders only when its own label changes ("4m" stays put for a minute). No per-row timers.
 */
const useClock = create<{ now: number }>()(() => ({ now: Date.now() }));

let started = false;
function ensureClock(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  setInterval(() => useClock.setState({ now: Date.now() }), 1000);
}

/** The current time, re-rendering every second. Prefer useAgeLabel for ages. */
export function useNow(): number {
  ensureClock();
  return useClock((s) => s.now);
}

/** "12s", "4m", "3h"…: re-renders only when the label changes. */
export function useAgeLabel(ts: number): string {
  ensureClock();
  return useClock((s) => fmtAge(ts, s.now));
}

/** True while `ts` is younger than `ms` (re-renders once when it flips). */
export function useYoungerThan(ts: number, ms: number): boolean {
  ensureClock();
  return useClock((s) => s.now - ts < ms);
}
