import { memo } from "react";
import { cn } from "../../lib/cn";
import {
  DASH,
  fmtCount,
  fmtPct,
  fmtSignedSol,
  fmtSignedUsd,
  fmtSol,
  fmtTokens,
  fmtUsd,
  fmtUsdExact,
  plainDecimal,
  priceParts,
  signClass,
  solTapeParts,
} from "../../lib/format";

export type NumKind = "price" | "usd" | "usdExact" | "sol" | "solTape" | "pct" | "count" | "tokens";

export interface NumProps {
  value: number | null | undefined;
  kind: NumKind;
  /** Prices only: "$" prefix (USD) or none (SOL). */
  usd?: boolean;
  /** Changes and PnL: explicit +/− and the buy/sell/text-3 colour (DESIGN.md 3.10). */
  signed?: boolean;
  /** Colour by sign without forcing a "+" (e.g. a negative balance). */
  colorBySign?: boolean;
  /** Unit suffix in text-3 at label size, after a thin space: "SOL", "MC". */
  unit?: string;
  /** Condensed digits for tape cells and compact Pulse metrics. */
  dense?: boolean;
  className?: string;
  title?: string;
}

/**
 * The one number renderer (DESIGN.md 3.1): tabular digits, the plain decimal in aria-label,
 * subscript zeros as a styled span (never Unicode subscripts), unknown values as an en dash
 * in text-4, units in text-3.
 */
export const Num = memo(function Num({ value, kind, usd, signed, colorBySign, unit, dense, className, title }: NumProps) {
  const known = typeof value === "number" && Number.isFinite(value);
  if (!known) {
    return (
      <span role="img" className={cn("zf-num text-fg-4", className)} aria-label="unknown">
        {DASH}
      </span>
    );
  }
  const v = value as number;
  const tone = signed || colorBySign ? signClass(v) : undefined;
  const aria = plainDecimal(v);
  const base = cn("zf-num", dense && "num-dense", tone, className);
  // A thin space (U+2009) separates value and unit (DESIGN.md 2.2).
  const suffix = unit ? <span className="zf-unit">{` ${unit.trim()}`}</span> : null;

  if (kind === "price") {
    const p = priceParts(v);
    return (
      <span role="img" className={base} aria-label={`${usd ? "$" : ""}${aria}`} title={title}>
        {p.sign}
        {usd && "$"}
        {p.kind === "plain" ? (
          p.text
        ) : (
          <>
            0.0
            <span className="zf-zc" aria-hidden="true">
              {p.zeros}
            </span>
            {p.digits}
          </>
        )}
        {suffix}
      </span>
    );
  }

  if (kind === "solTape") {
    const { main, dim } = solTapeParts(v);
    return (
      <span role="img" className={base} aria-label={aria} title={title}>
        {main}
        {dim && <span className="zf-dim">{dim}</span>}
        {suffix}
      </span>
    );
  }

  let text: string;
  switch (kind) {
    case "usd":
      text = signed ? `${v > 0 ? "+" : ""}${fmtUsd(v)}` : fmtUsd(v);
      break;
    case "usdExact":
      text = signed ? fmtSignedUsd(v) : fmtUsdExact(v);
      break;
    case "sol":
      text = signed ? fmtSignedSol(v) : fmtSol(v);
      break;
    case "pct":
      text = fmtPct(v, { signed });
      break;
    case "count":
      text = fmtCount(v);
      break;
    case "tokens":
      text = fmtTokens(v);
      break;
  }
  return (
    <span role="img" className={base} aria-label={aria} title={title}>
      {text}
      {suffix}
    </span>
  );
});
