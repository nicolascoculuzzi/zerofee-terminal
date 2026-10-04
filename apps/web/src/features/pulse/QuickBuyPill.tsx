import { memo, useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { fmtSolShort } from "../../lib/format";
import { buy } from "../../lib/tradeActions";
import type { PulseColumnId } from "../../protocol";
import { useMarket } from "../../state/market";
import type { PresetId } from "../../state/settings";
import { useWallet } from "../../state/wallet";
import { ICON, MASK } from "./icons";
import { usePulseUi } from "./store";

/** Mis-click guard: a card's quick-buy ignores clicks for its first 250 ms on screen (DESIGN.md 6.7). */
const GUARD_MS = 250;
/** Trade buttons hold their pressed look for 300 ms after release (DESIGN.md 6.2). */
const HOLD_MS = 300;

/**
 * Quick-buy pill (DESIGN.md 4.6): neutral at rest (surface-3, hairline-strong, Zap 12 + amount
 * 12/600), buy-tint on hover, solid buy on press, no spinner (the toast carries progress). Lock
 * replaces Zap while the keystore is locked in Instant mode; tradeActions opens unlock and
 * retries, shows the countdown confirm for flagged tokens and refuses trades while the feed is
 * down, which disables the pill. With "Confirm trades on touch devices", a tap opens the review
 * sheet instead. Outlined quick-buy pills after Axiom's Instant Trade; one Buy action per card
 * after Binance Meme Rank: https://mobbin.com/screens/55442959-3968-4340-9c27-3efe6dfffeb5
 */
export const QuickBuyPill = memo(function QuickBuyPill({
  mint,
  symbol,
  column,
  sol,
  preset,
  touch,
  review,
}: {
  mint: string;
  symbol: string;
  column: PulseColumnId;
  sol: number;
  preset: PresetId;
  /** Phone layout: a 44 px hit area around the 24 px pill. */
  touch?: boolean;
  /** Open the review sheet instead of buying (confirm on touch). */
  review?: boolean;
}) {
  const locked = useWallet((s) => s.service.locked && s.mode === "instant");
  const feedUp = useMarket((s) => s.connection === "live" || s.connection === "degraded");
  const [mountedAt] = useState(() => performance.now());
  const [pressed, setPressed] = useState(false);
  useEffect(() => {
    if (!pressed) return;
    const t = setTimeout(() => setPressed(false), HOLD_MS);
    return () => clearTimeout(t);
  }, [pressed]);
  const amount = fmtSolShort(sol);
  return (
    <button
      type="button"
      data-tip="pill"
      aria-label={locked ? `Unlock to buy ${symbol}` : `Buy ${amount} SOL of ${symbol}`}
      disabled={!feedUp || !(sol > 0)}
      onClick={(e) => {
        e.stopPropagation();
        if (performance.now() - mountedAt < GUARD_MS) return;
        setPressed(true);
        if (review) {
          usePulseUi.getState().openReview({ mint, column });
          return;
        }
        void buy({ mint, sol, preset, source: "pulse" });
      }}
      className={cn(
        "zf-num relative flex h-6 min-w-14 shrink-0 items-center justify-center gap-1 rounded-full border px-1.5 text-data font-semibold whitespace-nowrap transition-colors",
        ICON,
        locked ? MASK.lock : MASK.zap,
        pressed
          ? "border-buy bg-buy text-ink before:text-ink"
          : "border-hairline-strong bg-surface-3 text-fg-1 before:text-fg-3 hover:border-buy-edge hover:bg-buy-tint hover:text-buy hover:before:text-buy active:border-buy active:bg-buy active:text-ink active:before:text-ink",
        "disabled:border-transparent disabled:bg-surface-2 disabled:text-fg-4 disabled:before:text-fg-4",
        touch && "after:absolute after:inset-x-0 after:-inset-y-2.5 after:content-['']",
      )}
    >
      {amount}
    </button>
  );
});
