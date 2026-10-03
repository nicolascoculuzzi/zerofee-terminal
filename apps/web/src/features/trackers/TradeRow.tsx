import { memo } from "react";
import { Link } from "react-router";
import { Age } from "../../components/ui/Age";
import { TokenAvatar } from "../../components/ui/TokenAvatar";
import { cn } from "../../lib/cn";
import { fmtSol, fmtUsd, shortAddr } from "../../lib/format";
import type { TrackedTrade } from "../../protocol";
import type { TrackedWallet } from "../../state/trackers";
import { QuickBuyButton } from "./QuickBuyButton";

export function firstGlyph(s: string): string {
  const ch = Array.from(s.trim())[0];
  return ch ? ch.toUpperCase() : "?";
}

/** Wallet label: a neutral monogram with the user's tag (1–2 characters) or the name's first letter. */
export function WalletGlyph({ emoji, name }: { emoji: string | undefined; name: string }) {
  const tag = emoji?.trim() || firstGlyph(name);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex h-4 shrink-0 items-center justify-center rounded-full bg-elev text-2xs font-semibold text-muted",
        Array.from(tag).length > 1 ? "min-w-4 px-1" : "w-4",
      )}
    >
      {tag}
    </span>
  );
}

export const tradeId = (t: TrackedTrade): string => t.trade.id;

/*
 * Live Trades row. Anatomy follows Base's Activity list (asset avatar + label, signed amount right,
 * time) at Copilot Money's dark row density:
 * https://mobbin.com/screens/2aee414b-0e57-4bf4-8c80-d877122978dc
 * https://mobbin.com/screens/fd8c7d1d-72cb-4c60-90a5-cd4fd1e5c58c
 * Columns collapse with the container (needs an `@container` ancestor): the dock shows
 * age · wallet · B/S · token · SOL · quick-buy; wider panels add Buy/Sell, token age and MC.
 */
export const TradeRow = memo(function TradeRow({
  item,
  wallet,
  fresh,
}: {
  item: TrackedTrade;
  wallet: TrackedWallet | undefined;
  fresh: boolean;
}) {
  const { trade, token } = item;
  const isBuy = trade.side === "buy";
  const name = wallet?.name || shortAddr(trade.maker);
  const tone = isBuy ? "text-buy" : "text-sell";
  return (
    <div className={cn("relative flex h-7 items-center gap-1 px-2 text-xs hover:bg-hover @sm:gap-2 @sm:px-3", fresh && "zf-enter")}>
      <Link to={`/t/${token.mint}`} className="absolute inset-0">
        <span className="sr-only">
          Open {token.symbol}: {name} {isBuy ? "bought" : "sold"} {fmtSol(trade.solAmount)} SOL
        </span>
      </Link>
      <Age ts={trade.ts} className="w-7 shrink-0 text-dim" />
      <span className="flex min-w-0 flex-1 items-center gap-1">
        <WalletGlyph emoji={wallet?.emoji} name={name} />
        <span className="truncate font-medium text-fg">{name}</span>
      </span>
      <span className={cn("w-3 shrink-0 font-semibold @md:w-7", tone)}>
        <span className="@md:hidden">{isBuy ? "B" : "S"}</span>
        <span className="hidden @md:inline">{isBuy ? "Buy" : "Sell"}</span>
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1">
        <TokenAvatar mint={token.mint} symbol={token.symbol} imageUri={token.imageUri} size="xs" />
        <span className="truncate font-medium text-fg">{token.symbol}</span>
        <Age ts={token.createdAt} className="hidden shrink-0 text-dim @sm:inline" />
      </span>
      <span className={cn("w-12 shrink-0 text-right font-medium @sm:w-14", tone)}>{fmtSol(trade.solAmount)}</span>
      <span className="hidden w-14 shrink-0 text-right text-muted @md:block">{fmtUsd(trade.marketCapUsd)}</span>
      <span className="flex w-14 shrink-0 justify-end">
        <QuickBuyButton mint={token.mint} symbol={token.symbol} source="tracker" />
      </span>
    </div>
  );
});

/** Column labels matching TradeRow's cells. */
export function TradeHeader() {
  return (
    <div className="zf-label flex h-6 shrink-0 items-center gap-1 border-b border-line px-2 @sm:gap-2 @sm:px-3">
      <span className="w-7 shrink-0">Age</span>
      <span className="min-w-0 flex-1">Wallet</span>
      <span className="w-3 shrink-0 @md:w-7">
        <span className="hidden @md:inline">Side</span>
      </span>
      <span className="min-w-0 flex-1">Token</span>
      <span className="w-12 shrink-0 text-right @sm:w-14">SOL</span>
      <span className="hidden w-14 shrink-0 text-right @md:block">MC</span>
      <span className="w-14 shrink-0" />
    </div>
  );
}
