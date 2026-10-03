import { fmtClock, fmtDate } from "../../lib/format";

/** SOL fee amounts as plain decimals (no subscript notation), to lamport precision. */
export function fmtFee(sol: number): string {
  if (!Number.isFinite(sol)) return "—";
  return sol.toFixed(9).replace(/\.?0+$/, "");
}

/** Small USD estimates: "<$0.01", "$0.14". */
export function fmtUsdSmall(usd: number): string {
  if (!Number.isFinite(usd)) return "—";
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** Time left: "23h 59m", "14m 05s", "42s". */
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
