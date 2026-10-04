import { memo } from "react";
import { Link } from "react-router";
import { Age } from "../../components/ui/Age";
import { Num } from "../../components/ui/Num";
import { TokenAvatar, WalletAvatar } from "../../components/ui/TokenAvatar";
import { cn } from "../../lib/cn";
import { fmtSol, shortAddr } from "../../lib/format";
import type { TrackedTrade } from "../../protocol";
import type { TrackedWallet } from "../../state/trackers";
import { mcSol, sizeBarPct } from "./feedFilters";
import { hoverTarget } from "./hooks";
import { QuoteValue } from "./money";
import { QuickBuyPill } from "./QuickBuyButton";
import { Cell, CursorBar, HeaderCell, HeaderRow, rowTone } from "./table";

export const tradeId = (t: TrackedTrade): string => t.trade.id;
export const tradeMint = (t: TrackedTrade): string => t.token.mint;

/*
 * Live trades columns (DESIGN.md 4.9 tape rules, 5.4): fixed `ch` widths, the token column
 * flexes. Narrow containers (the 360 px dock) drop MC and the token age and tighten the gaps.
 * Needs an @container ancestor.
 */
const COL = {
  age: "w-[5ch] justify-end @max-[480px]:w-[4ch]",
  wallet: "w-[18ch] @max-[640px]:w-[14ch] @max-[480px]:w-[11ch]",
  side: "w-[3ch] justify-center @max-[480px]:w-4",
  token: "min-w-0 flex-1",
  tokenAge: "@max-[560px]:hidden",
  sol: "w-[9ch] justify-end",
  mc: "w-[9ch] justify-end @max-[560px]:hidden",
  pill: "w-16 justify-end @max-[480px]:w-14",
} as const;

const ROW = "flex items-center gap-2 px-2 @max-[480px]:gap-1";

/** "B" / "S" in micro 10/600 on a 16 × 16 side-tint square (DESIGN.md 4.9). */
export function SideMark({ side }: { side: "buy" | "sell" }) {
  const buy = side === "buy";
  return (
    <span
      role="img"
      aria-label={buy ? "Buy" : "Sell"}
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-xs text-micro font-semibold",
        buy ? "bg-buy-tint text-buy" : "bg-sell-tint text-sell",
      )}
    >
      {buy ? "B" : "S"}
    </span>
  );
}

/** Wallet label: its avatar (the user's tag, else a monogram) and name, or the short address. */
export function WalletLabel({ address, wallet, className }: { address: string; wallet: TrackedWallet | undefined; className?: string }) {
  const name = wallet?.name;
  return (
    <span className={cn("flex min-w-0 items-center gap-1", className)} title={name ? `${name} · ${address}` : address}>
      <WalletAvatar seed={address} label={name ?? address} tag={wallet?.emoji} size={16} />
      {name ? (
        <span className="truncate font-medium text-fg-1">{name}</span>
      ) : (
        <span className="truncate font-mono text-fg-2">{shortAddr(address)}</span>
      )}
    </span>
  );
}

export interface TradeRowProps {
  item: TrackedTrade;
  wallet: TrackedWallet | undefined;
  /** New tape row: the side-coloured flash (DESIGN.md 6.6). */
  fresh: boolean;
  active: boolean;
  /** Inside a floating dock (surface-2), hover steps to surface-3. */
  floating?: boolean;
  hotkey?: "page" | "off";
}

/**
 * Live trades row, dense (20 / 24 px): age · wallet · side · token (avatar, ticker, token age) ·
 * SOL in the side colour with 3 decimals and dim trailing zeros · MC at trade · quick-buy.
 * A size bar sits behind the row. Side colour on the figure that matters, after Binance's
 * market trades: https://mobbin.com/screens/8d1b7823-6418-44c5-b3d5-ab69b3bfd6e3
 * "Someone bought" rows tied to a token, after Base's social feed:
 * https://mobbin.com/screens/0ee5ef3f-8693-4e21-971f-8975e9157712
 */
export const TradeRow = memo(function TradeRow({ item, wallet, fresh, active, floating, hotkey }: TradeRowProps) {
  const { trade, token } = item;
  const buy = trade.side === "buy";
  const who = wallet?.name ?? shortAddr(trade.maker);
  return (
    <div
      {...hoverTarget(token.mint)}
      className={cn(
        ROW,
        "relative isolate h-full text-data",
        active ? (floating ? "bg-surface-3" : "bg-surface-2") : rowTone({ floating }),
        fresh && (buy ? "zf-flash-buy" : "zf-flash-sell"),
      )}
    >
      <span
        aria-hidden="true"
        className={cn("absolute inset-y-0 right-0 -z-10", buy ? "bg-bar-buy" : "bg-bar-sell")}
        style={{ width: `${sizeBarPct(trade.solAmount)}%` }}
      />
      <CursorBar show={active} />
      <Cell className={cn("shrink-0", COL.age)}>
        <Age ts={trade.ts} className="num-dense" />
      </Cell>
      <Cell className={cn("shrink-0", COL.wallet)}>
        <WalletLabel address={trade.maker} wallet={wallet} />
      </Cell>
      <Cell className={cn("shrink-0", COL.side)}>
        <SideMark side={trade.side} />
      </Cell>
      <Cell className={cn("items-center gap-1", COL.token)}>
        <Link to={`/t/${token.mint}`} tabIndex={-1} className="absolute inset-0">
          <span className="sr-only">
            Open {token.symbol}: {who} {buy ? "bought" : "sold"} {fmtSol(trade.solAmount)} SOL
          </span>
        </Link>
        <TokenAvatar mint={token.mint} symbol={token.symbol} imageUri={token.imageUri} size="2xs" />
        <span className="max-w-[10ch] truncate font-semibold text-fg-1">{token.symbol}</span>
        <Age ts={token.createdAt} className={cn("num-dense text-fg-3", COL.tokenAge)} />
      </Cell>
      <Cell className={cn("shrink-0", COL.sol)}>
        <Num kind="solTape" value={trade.solAmount} dense className={cn("font-medium", buy ? "text-buy" : "text-sell")} />
      </Cell>
      <Cell className={cn("shrink-0 text-fg-2", COL.mc)}>
        <QuoteValue usd={trade.marketCapUsd} sol={mcSol(trade)} dense />
      </Cell>
      <Cell className={cn("shrink-0", COL.pill)}>
        <QuickBuyPill mint={token.mint} symbol={token.symbol} source="tracker" size="tape" tabIndex={active ? 0 : -1} hotkey={hotkey} />
      </Cell>
    </div>
  );
});

/** Column labels matching TradeRow; units in the header (DESIGN.md 4.9). */
export function TradeHeader() {
  return (
    <HeaderRow className={ROW}>
      <HeaderCell className={COL.age} align="right">
        Age
      </HeaderCell>
      <HeaderCell className={COL.wallet}>Wallet</HeaderCell>
      <HeaderCell className={COL.side} align="center" title="Side: B buy, S sell" />
      <HeaderCell className={COL.token}>Token</HeaderCell>
      <HeaderCell className={COL.sol} align="right">
        SOL
      </HeaderCell>
      <HeaderCell className={COL.mc} align="right" metric="marketCap">
        MC
      </HeaderCell>
      <HeaderCell className={COL.pill} />
    </HeaderRow>
  );
}

/**
 * Phone row (64 px, DESIGN.md 2.10 and 5.8): token avatar; line 1 side, ticker, SOL and MC;
 * line 2 the wallet and the age; the 32 px quick-buy pill with a 44 px hit area on the right.
 */
export const MobileTradeRow = memo(function MobileTradeRow({ item, wallet, fresh }: Pick<TradeRowProps, "item" | "wallet" | "fresh">) {
  const { trade, token } = item;
  const buy = trade.side === "buy";
  const who = wallet?.name ?? shortAddr(trade.maker);
  return (
    <div
      {...hoverTarget(token.mint)}
      className={cn("relative flex h-full items-center gap-3 px-3", fresh && (buy ? "zf-flash-buy" : "zf-flash-sell"))}
    >
      <Link to={`/t/${token.mint}`} className="absolute inset-0">
        <span className="sr-only">
          Open {token.symbol}: {who} {buy ? "bought" : "sold"} {fmtSol(trade.solAmount)} SOL
        </span>
      </Link>
      <TokenAvatar mint={token.mint} symbol={token.symbol} imageUri={token.imageUri} size="sm" />
      <Cell className="min-w-0 flex-1 flex-col gap-1">
        <span className="flex h-5 min-w-0 items-center gap-2">
          <SideMark side={trade.side} />
          <span className="truncate text-amount font-semibold text-fg-1">{token.symbol}</span>
          <Num kind="solTape" value={trade.solAmount} unit="SOL" className={cn("text-data font-medium", buy ? "text-buy" : "text-sell")} />
          <span className="ml-auto shrink-0 text-data text-fg-2">
            <QuoteValue usd={trade.marketCapUsd} sol={mcSol(trade)} />
          </span>
        </span>
        <span className="flex h-5 min-w-0 items-center gap-2 text-data">
          <WalletLabel address={trade.maker} wallet={wallet} />
          <Age ts={trade.ts} className="ml-auto shrink-0" />
        </span>
      </Cell>
      <QuickBuyPill mint={token.mint} symbol={token.symbol} source="tracker" size="touch" />
    </div>
  );
});
