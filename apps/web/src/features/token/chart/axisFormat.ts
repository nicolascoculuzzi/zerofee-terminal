import { DASH, MINUS } from "../../../lib/format";

/*
 * Price-axis text for the token chart (DESIGN.md 3.2, 3.3, 4.10). The series always plots market cap
 * in the active quote; MC mode prints it compact ("$42.71K"), Price mode divides by supply and prints
 * the per-token price with subscript-zero notation for tiny prices ("$0.0₄4271").
 *
 * Precision adapts to the visible range: the tick formatter sees every tick at once, derives the tick
 * step, and prints just enough decimals for neighbouring ticks to differ (a 42.70K..42.74K range reads
 * 42.70K / 42.71K / ..., never five "42.7K"). Single labels (last value, crosshair, order chips,
 * legend) reuse the current step, so they line up with the ticks.
 */

export type AxisMode = "mc" | "price";
export type AxisQuote = "USD" | "SOL";

const UNITS: readonly [number, string][] = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
];

/** Unicode subscript digits (canvas text only: DESIGN.md 4.10 exception), built from code points. */
const SUB_DIGITS = String.fromCharCode(...Array.from({ length: 10 }, (_, i) => 0x2080 + i));
const MAX_DECIMALS = 12;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Fewest decimals that print every multiple of `step` exactly: 10 -> 0, 0.5 -> 1, 0.25 -> 2, 0.02 -> 2.
 * Non-positive or non-finite steps need none.
 */
export function stepDecimals(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return 0;
  const start = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  for (let d = start; d <= start + 3 && d <= MAX_DECIMALS; d++) {
    const scaled = step * 10 ** d;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-6 * Math.max(1, scaled)) return d;
  }
  return Math.min(start + 1, MAX_DECIMALS);
}

/** Smallest positive gap between consecutive distinct values (the tick step); NaN for fewer than 2. */
export function tickStep(values: readonly number[]): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  let step = Number.POSITIVE_INFINITY;
  for (let i = 1; i < sorted.length; i++) {
    const d = (sorted[i] as number) - (sorted[i - 1] as number);
    if (d > 0 && d < step) step = d;
  }
  return Number.isFinite(step) ? step : Number.NaN;
}

function intDigits(abs: number): number {
  return abs >= 1 ? Math.floor(Math.log10(abs) + 1e-12) + 1 : 1;
}

/**
 * Compact number with a K/M/B/T suffix and enough decimals for `step` (NaN: 3 significant digits).
 * At least `minSig` significant digits: 42709 with step 100 is "42.7K", with step 10 "42.71K".
 */
export function compactAt(v: number, step: number, minSig = 3): string {
  if (!Number.isFinite(v)) return DASH;
  if (v === 0) return "0";
  const abs = Math.abs(v);
  let unitIndex = UNITS.findIndex(([u]) => abs >= u);
  const text = (i: number): { s: string; scaled: number } => {
    const unit = i >= 0 ? (UNITS[i] as [number, string])[0] : 1;
    const scaled = abs / unit;
    const fromStep = Number.isFinite(step) && step > 0 ? stepDecimals(step / unit) : 0;
    const d = clamp(Math.max(fromStep, minSig - intDigits(scaled)), 0, MAX_DECIMALS);
    return { s: scaled.toFixed(d), scaled: Number(scaled.toFixed(d)) };
  };
  let out = text(unitIndex);
  // Rounding up into the next unit: 999.96K prints as 1.00M, never 1000.0K.
  if (out.scaled >= 1000 && unitIndex !== 0) {
    unitIndex = unitIndex < 0 ? UNITS.length - 1 : unitIndex - 1;
    out = text(unitIndex);
  }
  const suffix = unitIndex >= 0 ? (UNITS[unitIndex] as [number, string])[1] : "";
  const zero = Number(out.s) === 0;
  return `${v < 0 && !zero ? MINUS : ""}${out.s}${suffix}`;
}

/** A per-token price as parts: plain text, or "0.0" + a zero count + significant digits. */
export type AxisPriceParts = { kind: "plain"; text: string } | { kind: "sub"; zeros: number; digits: string };

function group(n: number, decimals: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/**
 * Price with enough decimals for `step` and at least 4 significant digits (DESIGN.md 3.3): 1,234.50 ·
 * 12.35 · 0.01235 · 0.0₅4123 (4 or more zeros after the point use subscript-zero notation).
 */
export function priceAtParts(p: number, step: number): AxisPriceParts {
  if (!Number.isFinite(p)) return { kind: "plain", text: DASH };
  if (p === 0) return { kind: "plain", text: "0" };
  const abs = Math.abs(p);
  const fromStep = Number.isFinite(step) && step > 0 ? stepDecimals(step) : 0;
  if (abs >= 1) {
    const minDecimals = abs >= 1000 ? 2 : Math.max(2, 4 - intDigits(abs));
    const d = clamp(Math.max(fromStep, minDecimals), 0, 8);
    return { kind: "plain", text: abs >= 1000 ? group(abs, d) : abs.toFixed(d) };
  }
  let zeros = -Math.floor(Math.log10(abs) + 1e-12) - 1;
  let d = clamp(Math.max(fromStep, zeros + 4), zeros + 4, zeros + 8);
  // Round first: 0.00009999996 is 0.0001000, which has one zero fewer.
  const rounded = Number(abs.toFixed(Math.min(d, 20)));
  if (rounded >= 1) return priceAtParts(rounded, step);
  const z2 = -Math.floor(Math.log10(rounded) + 1e-12) - 1;
  if (z2 !== zeros) {
    zeros = z2;
    d = clamp(Math.max(fromStep, zeros + 4), zeros + 4, zeros + 8);
  }
  if (zeros < 4) return { kind: "plain", text: rounded.toFixed(Math.min(d, 20)) };
  const digits = Math.round(rounded * 10 ** d)
    .toString()
    .padStart(d - zeros, "0");
  return { kind: "sub", zeros, digits };
}

/** Canvas text for price parts (Unicode subscript digits for the zero count). */
export function priceAtText(p: number, step: number): string {
  const parts = priceAtParts(p, step);
  if (parts.kind === "plain") return parts.text;
  const sub = String(parts.zeros)
    .split("")
    .map((d) => SUB_DIGITS[Number(d)] ?? d)
    .join("");
  return `0.0${sub}${parts.digits}`;
}

/** Legend parts: a prefix ("$"), then plain text or subscript-zero parts. */
export interface LegendParts {
  prefix: string;
  parts: AxisPriceParts;
}

/**
 * One chart's axis format. `tickmarks` (the series' tickmarksFormatter) records the tick step; `format`
 * (the series' formatter) prints single values with the same precision. `minMove` follows the plotted
 * magnitude so tick generation never runs into float limits.
 */
export class AxisFormat {
  private step = Number.NaN;

  constructor(
    readonly mode: AxisMode,
    readonly quote: AxisQuote,
    readonly supply: number,
  ) {}

  private get prefix(): string {
    return this.quote === "USD" ? "$" : "";
  }

  /**
   * Text for plot value `v` (market cap in the quote) at tick step `step` (plot units). Ticks need only
   * 2 significant digits ("60K", "65K"); single labels keep 3 ("5.05K").
   */
  text(v: number, step: number, minSig = 3): string {
    if (!Number.isFinite(v)) return DASH;
    if (this.mode === "mc") {
      const s = compactAt(v, step, minSig);
      return s.startsWith(MINUS) ? `${MINUS}${this.prefix}${s.slice(1)}` : `${this.prefix}${s}`;
    }
    const supply = this.supply > 0 ? this.supply : 1;
    return `${this.prefix}${priceAtText(v / supply, step / supply)}`;
  }

  /**
   * Series formatter (last value, crosshair label, order chips). Market cap and price are never
   * negative: the pane's bottom margin can reach below zero, and the crosshair there reads 0.
   */
  readonly format = (v: number): string => this.text(Math.max(0, v), this.step);

  /** Series tickmarks formatter: all ticks at once. Ticks below zero stay blank. */
  readonly tickmarks = (values: number[]): string[] => {
    const step = tickStep(values);
    if (Number.isFinite(step)) this.step = step;
    return values.map((v) => (v < 0 ? "" : this.text(v, Number.isFinite(step) ? step : this.step, 2)));
  };

  /** DOM parts for the legend (subscripts render as spans there, never as Unicode glyphs). */
  legend(v: number): LegendParts {
    if (this.mode === "mc") return { prefix: "", parts: { kind: "plain", text: this.format(v) } };
    const supply = this.supply > 0 ? this.supply : 1;
    return { prefix: this.prefix, parts: priceAtParts(v / supply, this.step / supply) };
  }

  /** Forgets the tick step (after a unit or data change the next paint sets a fresh one). */
  reset(): void {
    this.step = Number.NaN;
  }
}

/** minMove for a series whose values reach `maxAbs`: about 7 significant digits of headroom. */
export function minMoveFor(maxAbs: number): number {
  if (!(maxAbs > 0) || !Number.isFinite(maxAbs)) return 0.0001;
  const exp = Math.floor(Math.log10(maxAbs)) - 7;
  return 10 ** clamp(exp, -12, 6);
}
