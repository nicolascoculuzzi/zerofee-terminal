import { fmtClock, fmtDate } from "../../lib/format";

/** Time left: "23h 12m", "14m 05s", "42s" (the "Active in 23h 12m" badge, session expiry). */
export function fmtCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** "Oct 3, 14:05" in local time. */
export function fmtDateTime(ms: number): string {
  return `${fmtDate(ms)}, ${fmtClock(ms, false)}`;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
