/** Runs `fn` once the browser is idle (or after `timeoutMs` at the latest). */
export function whenIdle(fn: () => void, timeoutMs = 2_000): void {
  const w = globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(fn, { timeout: timeoutMs });
  else setTimeout(fn, Math.min(timeoutMs, 500));
}
