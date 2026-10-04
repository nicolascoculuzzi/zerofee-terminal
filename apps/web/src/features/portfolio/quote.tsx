import { Num } from "../../components/ui/Num";
import { cn } from "../../lib/cn";
import { DASH, fmtCompact, fmtSignedUsd, fmtUsd, fmtUsdExact, plainDecimal } from "../../lib/format";
import { useYoungerThan } from "../../lib/useNow";
import { useMarket } from "../../state/market";
import { type QuoteCurrency, useSettings } from "../../state/settings";

export interface Quote {
  /** The one global quote (status bar chip, T then C). */
  quote: QuoteCurrency;
  solUsd: number;
  /** SOL/USD older than 60 s: USD values render in text-3 (DESIGN.md 3.9). */
  staleUsd: boolean;
}

export function useQuote(): Quote {
  const quote = useSettings((s) => s.display.quote);
  const solUsd = useMarket((s) => s.solUsd);
  const at = useMarket((s) => s.solUsdAt);
  const fresh = useYoungerThan(at, 60_000);
  return { quote, solUsd, staleUsd: !fresh };
}

const finite = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

/** Plain formatted text with the full decimal for screen readers (DESIGN.md 3.1). */
function NumText({ text, value, className }: { text: string; value: number; className?: string }) {
  return (
    <span role="img" aria-label={plainDecimal(value)} className={cn("zf-num", className)}>
      {text}
    </span>
  );
}

/**
 * A SOL amount shown in the global quote: exact USD ("$3,812.40", signed for PnL) or SOL with
 * a text-3 unit. Balances, values and PnL all go through here so the toggle flips the page.
 */
export function Money({
  sol,
  signed,
  unit = true,
  className,
  quote: forced,
}: {
  sol: number | null | undefined;
  signed?: boolean;
  /** "SOL" suffix in SOL mode (off when the column header carries it). */
  unit?: boolean;
  className?: string;
  /** Pin a currency regardless of the toggle (e.g. "Available" is always SOL). */
  quote?: QuoteCurrency;
}) {
  const q = useQuote();
  const quote = forced ?? q.quote;
  if (!finite(sol)) return <Num value={null} kind="sol" className={className} />;
  if (quote === "USD") {
    const usd = sol * q.solUsd;
    if (q.staleUsd)
      return <NumText value={usd} text={signed ? fmtSignedUsd(usd) : fmtUsdExact(usd)} className={cn("text-fg-3", className)} />;
    return <Num value={usd} kind="usdExact" signed={signed} className={className} />;
  }
  return <Num value={sol} kind="sol" signed={signed} unit={unit ? "SOL" : undefined} className={className} />;
}

/**
 * Market cap in the global quote, compact: "$12.4K" or "104 SOL" (3 significant digits). Pass the
 * SOL value when the supply is known; `usd` (the MC recorded with past fills) is the fallback.
 */
export function MarketCap({
  sol,
  usd,
  unit = true,
  className,
}: {
  sol?: number | null;
  usd?: number | null;
  unit?: boolean;
  className?: string;
}) {
  const q = useQuote();
  const valueSol = finite(sol) && sol > 0 ? sol : finite(usd) && usd > 0 && q.solUsd > 0 ? usd / q.solUsd : null;
  if (valueSol === null) return <Num value={null} kind="usd" className={className} />;
  if (q.quote === "USD") {
    const valueUsd = finite(sol) && sol > 0 ? sol * q.solUsd : (usd as number);
    return <NumText value={valueUsd} text={fmtUsd(valueUsd)} className={cn(q.staleUsd && "text-fg-3", className)} />;
  }
  return (
    <span role="img" aria-label={plainDecimal(valueSol)} className={cn("zf-num", className)}>
      {fmtCompact(valueSol)}
      {unit && <span className="zf-unit">{" SOL"}</span>}
    </span>
  );
}

/** Text form of a market cap for trigger sentences ("MC above $120K" / "MC above 412 SOL"). */
export function marketCapText(sol: number, quote: QuoteCurrency, solUsd: number): string {
  if (!Number.isFinite(sol) || sol <= 0) return DASH;
  return quote === "USD" ? fmtUsd(sol * solUsd) : `${fmtCompact(sol)} SOL`;
}
