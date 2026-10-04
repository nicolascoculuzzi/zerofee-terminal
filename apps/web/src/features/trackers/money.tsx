import { memo } from "react";
import { SolGlyph } from "../../components/ui/bits";
import { Num } from "../../components/ui/Num";
import { cn } from "../../lib/cn";
import { useMarket } from "../../state/market";
import { useSettings } from "../../state/settings";

/**
 * A market cap, liquidity or volume in the one global quote (DESIGN.md 3.9): compact USD
 * ("$12.3K"), or SOL by 3.4 with the 12 px SolGlyph prefix, since table cells have no room for
 * a " SOL" suffix. Pass `sol` when the exact SOL figure is known (e.g. the MC a trade printed);
 * otherwise USD converts at the live SOL/USD from the status bar.
 */
export const QuoteValue = memo(function QuoteValue({
  usd,
  sol,
  dense,
  className,
}: {
  usd: number | null | undefined;
  sol?: number | null;
  /** Condensed digits for tape cells (DESIGN.md 2.2). */
  dense?: boolean;
  className?: string;
}) {
  const quote = useSettings((s) => s.display.quote);
  const solUsd = useMarket((s) => s.solUsd);
  if (quote === "USD") return <Num kind="usd" value={usd} dense={dense} className={className} />;
  const value = sol ?? (typeof usd === "number" && solUsd > 0 ? usd / solUsd : null);
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <SolGlyph className="text-fg-3" />
      <Num kind="sol" value={value} dense={dense} />
    </span>
  );
});

/** Column header suffix for quote-aware columns: "MC" stays "MC", the unit shows in the cells. */
export function useQuote(): "USD" | "SOL" {
  return useSettings((s) => s.display.quote);
}
