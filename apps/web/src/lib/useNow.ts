import { create } from "zustand";

/** One shared 1 Hz clock so relative ages re-render together without per-component timers. */
const useClock = create<{ now: number }>()(() => ({ now: Date.now() }));

let started = false;
function ensureClock(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  setInterval(() => useClock.setState({ now: Date.now() }), 1000);
}

export function useNow(): number {
  ensureClock();
  return useClock((s) => s.now);
}
