import { memo } from "react";
import { Age } from "../../components/ui/Age";
import { SolGlyph } from "../../components/ui/bits";
import { TokenAvatar } from "../../components/ui/TokenAvatar";
import { cn } from "../../lib/cn";
import { useYoungerThan } from "../../lib/useNow";
import type { PulseColumnId, TokenRisk } from "../../protocol";
import type { PresetId } from "../../state/settings";
import { Cell } from "./CardParts";
import { type CardView, sameCardView } from "./cardView";
import { HIGHLIGHT_MS } from "./liveList";
import { QuickBuyPill } from "./QuickBuyPill";
import { RiskChips } from "./RiskChips";
import { openToken } from "./TokenCard";

export interface MobileRowProps {
  view: CardView;
  risk: TokenRisk;
  column: PulseColumnId;
  index: number;
  start: number;
  quickBuySol: number;
  preset: PresetId;
  colored: boolean;
  insertedAt: number;
  review: boolean;
}

/**
 * Phone Pulse row (DESIGN.md 5.8): 64 px, 10 px top and bottom, 12 px sides. Line 1 (20 px):
 * ticker 14/600, age 12 text-2, volume 12 text-3, MC 13/600 on the right. Line 2 (24 px): the
 * five risk chips with letters, and the quick-buy pill (24 px visual, 44 px hit area). A tap on
 * the row opens the token; a tap on the pill buys (or opens the review sheet). Two-line rows
 * with MC and volume on the right after Binance Meme Rush: https://mobbin.com/screens/972c602f-95aa-44ba-9cd3-1f869d9a58c3
 */
export const MobileRow = memo(function MobileRow(props: MobileRowProps) {
  const { view, column } = props;
  const fresh = useYoungerThan(props.insertedAt, HIGHLIGHT_MS);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the row is a touch target; keyboard users use the desktop grid's Enter
    // biome-ignore lint/a11y/useSemanticElements: virtualised rows can't be table rows; this is the ARIA grid pattern
    // biome-ignore lint/a11y/useFocusableInteractive: a touch list; rows are tapped, never tab stops
    <div
      role="row"
      aria-rowindex={props.index + 1}
      data-mint={view.mint}
      data-col={column}
      style={{ transform: `translateY(${props.start}px)` }}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        openToken(view.mint, false);
      }}
      className={cn(
        "absolute top-0 left-0 grid h-16 w-full grid-cols-[36px_minmax(0,1fr)] grid-rows-[20px_24px] content-center items-center gap-x-2 border-b border-hairline px-3 active:bg-surface-2",
        fresh && "zf-enter",
      )}
    >
      <div aria-hidden="true" className="row-span-2 flex [&>div]:size-9">
        <TokenAvatar
          mint={view.mint}
          symbol={view.symbol}
          imageUri={view.imageUri}
          launchpad={view.launchpad}
          size="md"
          progress={view.ring >= 0 ? view.ring / 100 : null}
          migrated={view.migrated}
        />
      </div>
      <Cell className="flex min-w-0 items-center gap-2 overflow-x-clip">
        <span className="shrink-0 text-amount font-semibold text-fg-1">
          {view.symbol.length > 10 ? `${view.symbol.slice(0, 9)}…` : view.symbol}
        </span>
        <Age ts={view.createdAt} className="shrink-0 text-data" />
        <span className="zf-num flex min-w-0 items-center truncate text-data text-fg-3">
          V&nbsp;{view.sol && <SolGlyph className="mr-px" />}
          {view.v}
        </span>
        <span className="zf-num ml-auto flex shrink-0 items-center pl-1 text-body font-semibold text-fg-1 before:mr-1 before:text-micro before:font-medium before:text-fg-3 before:content-['MC']">
          {view.sol && <SolGlyph className="mr-px" />}
          {view.mc}
        </span>
      </Cell>
      <Cell className="flex min-w-0 items-center gap-2">
        <RiskChips risk={props.risk} colored={props.colored} tips="delegate" className="min-w-0 overflow-x-clip" />
        <span className="ml-auto flex shrink-0">
          <QuickBuyPill
            mint={view.mint}
            symbol={view.symbol}
            column={column}
            sol={props.quickBuySol}
            preset={props.preset}
            review={props.review}
            touch
          />
        </span>
      </Cell>
    </div>
  );
}, sameRowProps);

function sameRowProps(a: MobileRowProps, b: MobileRowProps): boolean {
  for (const k of Object.keys(a) as (keyof MobileRowProps)[]) {
    if (k === "view" || k === "risk") continue;
    if (a[k] !== b[k]) return false;
  }
  return sameCardView(a.view, b.view);
}
