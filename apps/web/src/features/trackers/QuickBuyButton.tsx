import { Lock, Star, Zap } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { Hotkey } from "../../components/ui/controls";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import { fmtSolShort } from "../../lib/format";
import { buy } from "../../lib/tradeActions";
import type { TradeSource } from "../../services/tradeService";
import { useSettings } from "../../state/settings";
import { useWallet } from "../../state/wallet";
import { useRowTargets } from "./hooks";

/**
 * Pill height follows the row it sits in (row minus 4 px), so dense tapes keep their rhythm:
 * tape 16 / 20 px, table rows 20 / 24 px, 28 / 32 px grids 24 / 28 px (the 4.6 reference).
 * The transparent ::before stretches the hit area to 24 px; on phones the pill is 32 px with a
 * 44 px hit area (DESIGN.md 4.6, 7.3).
 */
const SIZE = {
  tape: "h-[calc(var(--zf-row-dense)-4px)] min-w-14 px-1.5 before:-inset-y-1",
  row: "h-[calc(var(--zf-row)-4px)] min-w-14 px-1.5 before:-inset-y-1",
  grid: "h-row min-w-14 px-1.5 before:-inset-y-0.5",
  touch: "h-8 min-w-16 px-3 before:-inset-y-1.5",
} as const;

export type QuickBuySize = keyof typeof SIZE;

/**
 * Quick-buy pill (DESIGN.md 4.6): neutral at rest (surface-3, hairline-strong, Zap 12 px in
 * text-3, the amount at 12/600). Hover: buy tint, buy edge, buy text and icon. Press, and for
 * 300 ms after a click: buy fill with ink text. No spinner: the toast carries progress. Clicks
 * in its first 250 ms on screen are ignored (mis-click guard); a locked keystore shows Lock and
 * the click opens unlock. The tooltip ends with the Space+B keycaps where that hotkey is live.
 * Uses the global quick-buy amount. Outlined quick-buy pills after Axiom's Instant Trade
 * (docs.axiom.trade/axiom/swap/instant-trade).
 */
export const QuickBuyPill = memo(function QuickBuyPill({
  mint,
  symbol,
  source,
  size = "row",
  tabIndex,
  hotkey = "page",
  className,
}: {
  mint: string;
  symbol: string;
  source: TradeSource;
  size?: QuickBuySize;
  tabIndex?: number;
  /** "page": keycaps when the page registered Space+B; "off": never (docks on other pages). */
  hotkey?: "page" | "off";
  className?: string;
}) {
  const sol = useSettings((s) => s.quickBuySol);
  const binding = useSettings((s) => s.hotkeys["buy.quick"]?.[0]);
  const tradeHotkeys = useSettings((s) => s.tradeHotkeys);
  const pageHotkey = useRowTargets((s) => s.pageHotkey);
  const locked = useWallet((s) => s.mode === "instant" && s.service.locked);
  const mountedAt = useRef(0);
  const [pressed, setPressed] = useState(false);

  useEffect(() => {
    mountedAt.current = performance.now();
  }, []);
  useEffect(() => {
    if (!pressed) return;
    const t = setTimeout(() => setPressed(false), 300);
    return () => clearTimeout(t);
  }, [pressed]);

  const amount = fmtSolShort(sol);
  const verb = locked ? `Unlock to buy ${amount} SOL` : `Buy ${amount} SOL`;
  const showKeys = hotkey === "page" && pageHotkey && tradeHotkeys && !locked;
  return (
    <Tooltip
      content={
        <span className="flex items-center gap-2">
          {verb}
          {showKeys && <Hotkey binding={binding} />}
        </span>
      }
    >
      <button
        type="button"
        tabIndex={tabIndex}
        aria-label={`${verb} of ${symbol}`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (performance.now() - mountedAt.current < 250) return;
          setPressed(true);
          void buy({ mint, sol, source });
        }}
        className={cn(
          "group focus-inset relative inline-flex shrink-0 items-center justify-center gap-1 rounded-full border text-data font-semibold whitespace-nowrap transition-colors before:absolute before:inset-x-0 before:content-['']",
          pressed
            ? "border-buy bg-buy text-ink"
            : "border-hairline-strong bg-surface-3 text-fg-1 hover:border-buy-edge hover:bg-buy-tint hover:text-buy active:border-buy active:bg-buy active:text-ink",
          SIZE[size],
          className,
        )}
      >
        {locked ? (
          <Lock className={cn("icon-xs", pressed ? "text-ink" : "text-fg-3 group-hover:text-buy group-active:text-ink")} />
        ) : (
          <Zap className={cn("icon-xs", pressed ? "text-ink" : "text-fg-3 group-hover:text-buy group-active:text-ink")} />
        )}
        <span className="zf-num">{amount}</span>
      </button>
    </Tooltip>
  );
});

/** Watchlist star: neutral, filled in text-1 when watched (no yellow). 20 px with a 24 px hit area. */
export const WatchStar = memo(function WatchStar({
  mint,
  symbol,
  tabIndex,
  touch,
  className,
}: {
  mint: string;
  symbol: string;
  tabIndex?: number;
  /** 44 px target on phones. */
  touch?: boolean;
  className?: string;
}) {
  const watched = useSettings((s) => s.watchlist.includes(mint));
  const toggle = useSettings((s) => s.toggleWatch);
  const label = watched ? `Remove ${symbol} from watchlist` : `Add ${symbol} to watchlist`;
  return (
    <button
      type="button"
      tabIndex={tabIndex}
      aria-pressed={watched}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle(mint);
      }}
      className={cn(
        "focus-inset relative flex shrink-0 items-center justify-center rounded-sm transition-colors before:absolute before:-inset-0.5 before:content-['']",
        touch ? "size-11" : "size-5",
        watched ? "text-fg-1" : "text-fg-3 hover:text-fg-1",
        className,
      )}
    >
      <Star className={cn("icon-sm", watched && "fill-current")} />
    </button>
  );
});
