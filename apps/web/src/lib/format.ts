const SUBSCRIPT_DIGITS = "₀₁₂₃₄₅₆₇₈₉";

function subscript(n: number): string {
  return String(n)
    .split("")
    .map((d) => SUBSCRIPT_DIGITS[Number(d)] ?? d)
    .join("");
}

/**
 * Tiny numbers with subscript-zero notation, e.g. 0.00000002796 → "0.0₇2796".
 * Numbers ≥ 0.001 use ordinary significant digits.
 */
export function fmtSmall(n: number, sig = 4): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1) return sign + trimZeros(abs.toFixed(abs >= 100 ? 2 : abs >= 10 ? 3 : 4));
  if (abs >= 0.001) return sign + trimZeros(abs.toPrecision(sig));
  // "0.0₅1234" = 0.000001234: the subscript counts the zeros after the decimal point.
  const [mantissa = "0", exponent = "0"] = abs.toExponential(sig - 1).split("e");
  const zeros = -Number(exponent) - 1;
  const digits = mantissa.replace(".", "").replace(/0+$/, "") || "0";
  return `${sign}0.0${subscript(zeros)}${digits}`;
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** 1234 → "1.23K", 12_345_678 → "12.3M". */
export function fmtCompact(n: number, digits = 3): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const units: [number, string][] = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [value, suffix] of units) {
    if (abs >= value) return sign + trimZeros((abs / value).toPrecision(digits)) + suffix;
  }
  if (abs >= 100) return sign + abs.toFixed(0);
  if (abs >= 1) return sign + trimZeros(abs.toFixed(2));
  return sign + fmtSmall(abs, 3);
}

export function fmtUsd(n: number, digits = 3): string {
  if (!Number.isFinite(n)) return "—";
  if (n < 0) return `-$${fmtCompact(-n, digits)}`;
  return `$${fmtCompact(n, digits)}`;
}

/** USD price per token, subscript zeros for memecoin prices. */
export function fmtUsdPrice(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `$${fmtSmall(n, 4)}`;
}

export function fmtSolPrice(n: number): string {
  return fmtSmall(n, 4);
}

/** SOL amounts: 0.0123, 1.25, 12.3, 1.2K. */
export function fmtSol(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1000) return fmtCompact(n, 3);
  if (abs >= 100) return n.toFixed(1);
  if (abs >= 10) return trimZeros(n.toFixed(2));
  if (abs >= 1) return trimZeros(n.toFixed(3));
  if (abs >= 0.001 || abs === 0) return trimZeros(n.toFixed(4));
  return fmtSmall(n, 3);
}

export function fmtSignedSol(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : "-"}${fmtSol(Math.abs(n))}`;
}

export function fmtPct(n: number, opts: { signed?: boolean; digits?: number } = {}): string {
  if (!Number.isFinite(n)) return "—";
  const digits = opts.digits ?? (Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : Math.abs(n) >= 1 ? 1 : 2);
  const body = Math.abs(n) >= 10_000 ? `${fmtCompact(Math.abs(n), 3)}%` : `${Math.abs(n).toFixed(digits)}%`;
  if (opts.signed) return `${n >= 0 ? "+" : "-"}${body}`;
  return n < 0 ? `-${body}` : body;
}

/** PnL % that never shows "+Infinity%" (zero cost basis, e.g. airdrops). */
export function fmtPnlPct(pnl: number, cost: number): string {
  if (!(cost > 0) || !Number.isFinite(pnl)) return "—";
  return fmtPct((pnl / cost) * 100, { signed: true });
}

export function fmtCount(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 10_000) return fmtCompact(n, 3);
  return Math.round(n).toLocaleString("en-US");
}

export function fmtTokens(n: number): string {
  return fmtCompact(n, 3);
}

/** Relative age: "25s", "4m", "3h", "2d", "11mo", "1y". */
export function fmtAge(fromMs: number, nowMs = Date.now()): string {
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(d / 365)}y`;
}

export function fmtClock(ms: number, seconds = true): string {
  const d = new Date(ms);
  const pad = (v: number) => String(v).padStart(2, "0");
  return seconds ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

export function shortAddr(address: string, head = 4, tail = 4): string {
  if (address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

/** Parses a user-typed number ("1.5", "1,5", "2k"); null when empty or invalid. */
export function parseAmount(raw: string): number | null {
  const s = raw.trim().replace(",", ".").toLowerCase();
  if (!s) return null;
  const mult = s.endsWith("k") ? 1e3 : s.endsWith("m") ? 1e6 : s.endsWith("b") ? 1e9 : 1;
  const n = Number.parseFloat(mult === 1 ? s : s.slice(0, -1));
  return Number.isFinite(n) ? n * mult : null;
}
