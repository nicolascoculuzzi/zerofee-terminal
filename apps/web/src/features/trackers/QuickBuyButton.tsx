import { LoaderCircle, Star, Zap } from "lucide-react";
import { memo } from "react";
import { cn } from "../../lib/cn";
import { fmtSolShort } from "../../lib/format";
import { buy } from "../../lib/tradeActions";
import type { TradeSource } from "../../services/tradeService";
import { useSettings } from "../../state/settings";
import { useTrades } from "../../state/trades";

/**
 * Quick-buy pill using the global quick-buy amount: buy-tinted, spinner while a buy on this mint
 * is in flight (same as the Pulse cards). Anatomy: the inline "Trade" action on Binance Wallet's
 * Meme Rush rows (https://mobbin.com/screens/f9b4eff0-8083-4e54-913c-51177e462d1d).
 * Positioned (`relative`) so it sits above a row's stretched link.
 */
export const QuickBuyButton = memo(function QuickBuyButton({
  mint,
  symbol,
  source,
  className,
}: {
  mint: string;
  symbol: string;
  source: TradeSource;
  className?: string;
}) {
  const sol = useSettings((s) => s.quickBuySol);
  const pending = useTrades((s) => s.items.some((t) => t.mint === mint && t.status === "pending"));
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void buy({ mint, sol, source });
      }}
      onKeyDown={(e) => e.stopPropagation()}
      title={`Buy ${fmtSolShort(sol)} SOL of ${symbol}`}
      aria-label={`Quick buy ${fmtSolShort(sol)} SOL of ${symbol}`}
      className={cn(
        "relative inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-buy/10 px-2 text-xs font-semibold text-buy transition-colors hover:bg-buy/20",
        className,
      )}
    >
      {pending ? <LoaderCircle className="icon-xs animate-spin" /> : <Zap className="icon-xs" />}
      {fmtSolShort(sol)}
    </button>
  );
});

/** Watchlist star (neutral: filled when watched). */
export const WatchStar = memo(function WatchStar({ mint, symbol, className }: { mint: string; symbol: string; className?: string }) {
  const watched = useSettings((s) => s.watchlist.includes(mint));
  const toggle = useSettings((s) => s.toggleWatch);
  const label = watched ? `Remove ${symbol} from watchlist` : `Add ${symbol} to watchlist`;
  return (
    <button
      type="button"
      aria-pressed={watched}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle(mint);
      }}
      onKeyDown={(e) => e.stopPropagation()}
      className={cn(
        "relative flex size-5 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-hover",
        watched ? "text-fg" : "text-dim hover:text-fg",
        className,
      )}
    >
      <Star className={cn("icon-sm", watched && "fill-current")} />
    </button>
  );
});
