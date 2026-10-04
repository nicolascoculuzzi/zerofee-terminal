import { memo } from "react";
import { cn } from "../../lib/cn";
import { DASH, fmtSignedSol, fmtSignedUsd, fmtSol, fmtUsd, fmtUsdExact, plainDecimal, signClass } from "../../lib/format";
import { useMarket } from "../../state/market";
import { type QuoteCurrency, useSettings } from "../../state/settings";

/*
 * Values in the one global quote (DESIGN.md 3.9): market caps, liquidity, volume, values and PnL
 * follow display.quote (status bar toggle, T then C). Amounts the user enters stay in SOL.
 */

export function useQuote(): { quote: QuoteCurrency; solUsd: number } {
  const quote = useSettings((s) => s.display.quote);
  const solUsd = useMarket((s) => s.solUsd);
  return { quote, solUsd };
}

export type MoneyKind = "compact" | "exact" | "signed";

/** Converts to the quote; `usd` wins when both are given in USD mode, `sol` in SOL mode. */
export function toQuote(quote: QuoteCurrency, solUsd: number, v: { usd?: number | null; sol?: number | null }): number | null {
  if (quote === "USD") {
    if (typeof v.usd === "number") return v.usd;
    if (typeof v.sol === "number") return v.sol * solUsd;
    return null;
  }
  if (typeof v.sol === "number") return v.sol;
  if (typeof v.usd === "number" && solUsd > 0) return v.usd / solUsd;
  return null;
}

/** Plain-text money in the quote: "$12.3K" / "102.5", "+$12.08" / "+0.12". */
export function fmtMoney(quote: QuoteCurrency, value: number | null, kind: MoneyKind = "compact"): string {
  if (value === null || !Number.isFinite(value)) return DASH;
  if (quote === "USD") return kind === "signed" ? fmtSignedUsd(value) : kind === "exact" ? fmtUsdExact(value) : fmtUsd(value);
  return kind === "signed" ? fmtSignedSol(value) : fmtSol(value);
}

/** Header label for a money column: "Value $" / "Value SOL". */
export function quoteUnit(quote: QuoteCurrency): string {
  return quote === "USD" ? "USD" : "SOL";
}

/**
 * One money value in the global quote. `unit` adds the " SOL" suffix (text-3, label size) in SOL
 * mode; tight cells leave it to the column header (DESIGN.md 3.4).
 */
export const Money = memo(function Money({
  usd,
  sol,
  kind = "compact",
  unit = false,
  dense = false,
  colorBySign = false,
  className,
}: {
  usd?: number | null;
  sol?: number | null;
  kind?: MoneyKind;
  unit?: boolean;
  dense?: boolean;
  colorBySign?: boolean;
  className?: string;
}) {
  const { quote, solUsd } = useQuote();
  const v = toQuote(quote, solUsd, { usd, sol });
  if (v === null || !Number.isFinite(v)) {
    return (
      <span role="img" aria-label="unknown" className={cn("zf-num text-fg-4", className)}>
        {DASH}
      </span>
    );
  }
  const tone = kind === "signed" || colorBySign ? signClass(v) : undefined;
  return (
    <span
      role="img"
      aria-label={`${quote === "USD" ? "$" : ""}${plainDecimal(v)}${quote === "SOL" ? " SOL" : ""}`}
      className={cn("zf-num whitespace-nowrap", dense && "num-dense", tone, className)}
    >
      {fmtMoney(quote, v, kind)}
      {unit && quote === "SOL" && <span className="zf-unit">{" SOL"}</span>}
    </span>
  );
});
