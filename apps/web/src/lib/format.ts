/**
 * The one formatter module (docs/design/DESIGN.md section 3). Components never call toFixed or
 * toLocaleString directly. Locale is fixed to en-US. Negatives use U+2212; unknown values are
 * an en dash. Tiny prices come back as parts and render through <Num> (no Unicode subscripts:
 * our fonts don't have them).
 */

/** U+2212 minus. */
export const MINUS = "−";
/** Unknown or missing value (render it in text-4). */
export const DASH = "–";

const finite = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

function group(n: number, decimals: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Trims trailing zeros but keeps at least `min` decimals: trim("1.2500", 2) → "1.25". */
function trimTo(s: string, min: number): string {
  if (!s.includes(".")) return min > 0 ? `${s}.${"0".repeat(min)}` : s;
  const [int, dec = ""] = s.split(".");
  let d = dec.replace(/0+$/, "");
  if (d.length < min) d = d.padEnd(min, "0");
  return d ? `${int}.${d}` : (int ?? s);
}

const UNITS: [number, string][] = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
];

/**
 * Compact form: 3 significant digits with a K/M/B/T suffix, trailing zeros kept ("4.20K").
 * The suffix is chosen from the rounded value, so 999,950 reads "1.00M", never "1000K".
 * Values below 1,000 go through `small`.
 */
export function fmtCompact(n: number, small: (abs: number) => string = (a) => trimTo(a.toPrecision(3), 0)): string {
  if (!finite(n)) return DASH;
  const abs = Math.abs(n);
  const sign = n < 0 ? MINUS : "";
  for (const [value, suffix] of UNITS) {
    const scaled = Number((abs / value).toPrecision(3));
    if (scaled >= 1) return `${sign}${scaled.toPrecision(3)}${suffix}`;
  }
  return sign + small(abs);
}

// ---------------------------------------------------------------------------
// USD (3.2)
// ---------------------------------------------------------------------------

/** Compact USD for market cap, liquidity, volume, fees: "$12.3K", "$842", "$8.42", "<$0.01". */
export function fmtUsd(n: number): string {
  if (!finite(n)) return DASH;
  if (n === 0) return "$0";
  const abs = Math.abs(n);
  const sign = n < 0 ? MINUS : "";
  if (abs < 0.01) return `${sign}<$0.01`;
  if (abs < 999.5) {
    // 3 significant digits with at most 2 decimals.
    const p = Number(abs.toPrecision(3));
    const decimals = p >= 100 ? 0 : p >= 10 ? 1 : 2;
    return `${sign}$${p.toFixed(decimals)}`;
  }
  return `${sign}$${fmtCompact(abs)}`;
}

/** Exact USD for balances, PnL and totals: 2 decimals with separators, compact from $100K. */
export function fmtUsdExact(n: number): string {
  if (!finite(n)) return DASH;
  const abs = Math.abs(n);
  const sign = n < 0 && abs >= 0.005 ? MINUS : "";
  if (abs >= 100_000) return `${sign}$${fmtCompact(abs)}`;
  return `${sign}$${group(abs, 2)}`;
}

/** Signed exact USD for changes and PnL: "+$12.08", "−$3.10", "$0.00". */
export function fmtSignedUsd(n: number): string {
  if (!finite(n)) return DASH;
  if (Math.abs(n) < 0.005) return "$0.00";
  return `${n > 0 ? "+" : MINUS}${fmtUsdExact(Math.abs(n))}`;
}

// ---------------------------------------------------------------------------
// Prices per token (3.3)
// ---------------------------------------------------------------------------

export type PriceParts =
  | { kind: "plain"; sign: string; text: string }
  /** "0.0" + zeros (rendered as a .zf-zc span) + digits, e.g. 0.000004123 → 0.0₅4123. */
  | { kind: "sub"; sign: string; zeros: number; digits: string };

/** Price parts: subscript-zero notation from 4 zeros after the decimal point (p < 0.0001). */
export function priceParts(n: number): PriceParts {
  if (!finite(n)) return { kind: "plain", sign: "", text: DASH };
  if (n === 0) return { kind: "plain", sign: "", text: "0" };
  const sign = n < 0 ? MINUS : "";
  const raw = Math.abs(n);
  if (raw >= 999.995) return { kind: "plain", sign, text: group(raw, 2) };
  // Branch on the rounded value (4 significant digits), so 0.000099996 prints as 0.0001000.
  const abs = Number(raw.toPrecision(4));
  if (abs >= 1) {
    const s = abs.toPrecision(4);
    const decimals = s.includes(".") ? (s.split(".")[1]?.length ?? 0) : 0;
    return { kind: "plain", sign, text: decimals >= 2 ? s : abs.toFixed(2) };
  }
  if (abs >= 0.0001) return { kind: "plain", sign, text: abs.toPrecision(4) };
  const [mantissa = "0", exponent = "0"] = abs.toExponential(3).split("e");
  return { kind: "sub", sign, zeros: -Number(exponent) - 1, digits: mantissa.replace(".", "") };
}

/** Full-precision decimal for aria-label, title and the clipboard: no suffix, no subscript. */
export function plainDecimal(n: number): string {
  if (!finite(n)) return DASH;
  if (n === 0) return "0";
  const abs = Math.abs(n);
  // About 10 significant digits, as a plain decimal (never exponent notation).
  const s = abs.toFixed(Math.min(20, Math.max(0, 9 - Math.floor(Math.log10(abs)))));
  return (n < 0 ? "-" : "") + (s.includes(".") ? s.replace(/\.?0+$/, "") : s);
}

const CANVAS_SUB = "₀₁₂₃₄₅₆₇₈₉";

/**
 * Text form of a price for places that can't render spans. Canvas axis labels in price mode
 * may use Unicode subscript digits (DESIGN.md 4.10 exception); everything else passes
 * `canvas = false` and gets the full decimal.
 */
export function fmtPriceText(n: number, canvas = false): string {
  const p = priceParts(n);
  if (p.kind === "plain") return p.sign + p.text;
  if (!canvas) return p.sign + plainDecimal(Math.abs(n));
  const sub = String(p.zeros)
    .split("")
    .map((d) => CANVAS_SUB[Number(d)] ?? d)
    .join("");
  return `${p.sign}0.0${sub}${p.digits}`;
}

/** USD price as plain text (titles, aria). Visible prices render with <Num kind="price">. */
export function fmtUsdPrice(n: number): string {
  if (!finite(n)) return DASH;
  return `$${fmtPriceText(n)}`;
}

/** SOL price as plain text (titles, aria). */
export function fmtSolPrice(n: number): string {
  return fmtPriceText(n);
}

// ---------------------------------------------------------------------------
// SOL amounts (3.4)
// ---------------------------------------------------------------------------

/** SOL amount by magnitude: 12.3K · 1,234.5 · 123.45 · 12.346 · 0.50 · 0.000312 · <0.0001. */
export function fmtSol(n: number): string {
  if (!finite(n)) return DASH;
  if (n === 0) return "0";
  const abs = Math.abs(n);
  const sign = n < 0 ? MINUS : "";
  if (abs >= 9999.95) return sign + fmtCompact(abs);
  if (abs >= 999.995) return sign + group(abs, 1);
  if (abs >= 99.9995) return sign + abs.toFixed(2);
  if (abs >= 0.99995) return sign + trimTo(abs.toFixed(3), 2);
  if (abs >= 0.0099995) return sign + trimTo(abs.toFixed(4), 2);
  if (abs >= 0.0001) return sign + trimTo(abs.toFixed(6), 0);
  return `${sign}<0.0001`;
}

/** Signed SOL change or PnL: "+0.12", "−1.25". */
export function fmtSignedSol(n: number): string {
  if (!finite(n)) return DASH;
  if (n === 0) return "0";
  return `${n > 0 ? "+" : MINUS}${fmtSol(Math.abs(n))}`;
}

/** Tape cells: exactly 3 decimals, trailing zeros split off for text-3 ("0.5" + "00"). */
export function solTapeParts(n: number): { main: string; dim: string } {
  if (!finite(n)) return { main: DASH, dim: "" };
  const abs = Math.abs(n);
  if (abs > 0 && abs < 0.0005) return { main: "<0.001", dim: "" };
  const s = abs >= 9999.95 ? fmtCompact(abs) : abs.toFixed(3);
  if (!s.includes(".") || /[KMBT]$/.test(s)) return { main: s, dim: "" };
  const m = /^(.*?)(\.?0*)$/.exec(s);
  const main = m?.[1] ?? s;
  return { main: main || "0", dim: m?.[2] ?? "" };
}

/** Fees, tips and rent: up to 9 decimals, trimmed, never compact: "0.000005", "0.00106". */
export function fmtFee(n: number): string {
  if (!finite(n)) return DASH;
  if (n === 0) return "0";
  return trimTo(Math.abs(n).toFixed(9), 0);
}

/** Lamports for fee tooltips: "5,000 lamports". */
export function fmtLamports(sol: number): string {
  if (!finite(sol)) return DASH;
  return `${Math.round(sol * 1e9).toLocaleString("en-US")} lamports`;
}

/** User-entered amounts (presets, quick-buy): exactly as entered, normalised ("0.25", "1"). */
export function fmtSolShort(n: number): string {
  if (!finite(n)) return DASH;
  return String(Number(n.toPrecision(6)));
}

// ---------------------------------------------------------------------------
// Percentages (3.5), counts (3.6)
// ---------------------------------------------------------------------------

function pctBody(abs: number): string {
  const r2 = Number(abs.toFixed(2));
  if (r2 < 1) return `${r2.toFixed(2)}%`;
  const r1 = Number(abs.toFixed(1));
  if (r1 < 100) return `${r1.toFixed(1)}%`;
  if (abs < 9999.5) return `${group(Math.round(abs), 0)}%`;
  return `${fmtCompact(abs)}%`;
}

/** Percent: 0.42% · 12.3% · 248% · 1,234% · 12.3K%. Signed for changes and PnL; zero is "0.00%". */
export function fmtPct(n: number, opts: { signed?: boolean } = {}): string {
  if (!finite(n)) return DASH;
  const abs = Math.abs(n);
  if (abs < 0.005) return "0.00%";
  const body = pctBody(abs);
  if (opts.signed) return `${n > 0 ? "+" : MINUS}${body}`;
  return n < 0 ? `${MINUS}${body}` : body;
}

/** Risk chip values: integers from 10, 1 decimal below, "<0.1%" for tiny, "0%" for zero. */
export function fmtRiskPct(n: number): string {
  if (!finite(n)) return DASH;
  const abs = Math.abs(n);
  if (abs === 0) return "0%";
  if (abs < 0.05) return "<0.1%";
  if (abs >= 9.95) return `${Math.round(abs)}%`;
  return `${abs.toFixed(1)}%`;
}

/** Bonding progress (0..1): an integer percent; "Migrating" at 100% until the pool exists. */
export function fmtProgress(p: number): string {
  if (!finite(p)) return DASH;
  if (p >= 1) return "Migrating";
  return `${Math.min(99, Math.floor(p * 100))}%`;
}

/** PnL % that never shows "+Infinity%" (zero or unknown cost basis, e.g. airdrops). */
export function fmtPnlPct(pnl: number, cost: number): string {
  if (!(cost > 0) || !finite(pnl)) return DASH;
  return fmtPct((pnl / cost) * 100, { signed: true });
}

/** Counts: "1,234", then "12.3K" from 10,000. */
export function fmtCount(n: number): string {
  if (!finite(n)) return DASH;
  if (Math.abs(n) >= 10_000) return fmtCompact(n);
  return group(Math.round(n), 0);
}

/** Integers with separators, never compact (slots, lamports): "312,456,789". */
export function fmtInt(n: number | null | undefined): string {
  if (!finite(n)) return DASH;
  return group(Math.round(n), 0);
}

/** Token amounts: compact with 3 significant digits ("1.24M", "620K", "842"). */
export function fmtTokens(n: number): string {
  if (!finite(n)) return DASH;
  return fmtCompact(n, (a) => (a >= 1 ? group(Math.round(a), 0) : trimTo(a.toPrecision(3), 0)));
}

// ---------------------------------------------------------------------------
// Ages and times (3.7), addresses (3.8)
// ---------------------------------------------------------------------------

/** Relative age: "12s", "4m", "3h", "2d", "5mo", "1y". */
export function fmtAge(fromMs: number, nowMs = Date.now()): string {
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${Math.floor(d / 365)}y`;
}

/** 24-hour clock for tooltips and expanded rows: "14:32:05". */
export function fmtClock(ms: number, seconds = true): string {
  const d = new Date(ms);
  const pad = (v: number) => String(v).padStart(2, "0");
  return seconds ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "Oct 3", or "Oct 3, 2025" outside the current year. */
export function fmtDate(ms: number): string {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** Latency: "412 ms", "1.24 s". */
export function fmtMs(ms: number | null | undefined): string {
  if (!finite(ms)) return DASH;
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

/**
 * Short address: head 4 … tail 4 ("7xKX…sAsU"). Pump vanity mints show head 6 and the literal
 * tail ("9Hd4cZ…pump"), because "pump" identifies nothing.
 */
export function shortAddr(address: string, head = 4, tail = 4): string {
  if (head === 4 && tail === 4 && address.length > 12 && address.endsWith("pump")) {
    return `${address.slice(0, 6)}…pump`;
  }
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

/** Sign tone for changes and PnL (3.10): positive buy, negative sell, zero text-3. */
export function signTone(n: number | null | undefined): "buy" | "sell" | "zero" | "unknown" {
  if (!finite(n)) return "unknown";
  if (n > 0) return "buy";
  if (n < 0) return "sell";
  return "zero";
}

/** Tailwind text class for a signed value. */
export function signClass(n: number | null | undefined): string {
  const t = signTone(n);
  return t === "buy" ? "text-buy" : t === "sell" ? "text-sell" : t === "zero" ? "text-fg-3" : "text-fg-4";
}
