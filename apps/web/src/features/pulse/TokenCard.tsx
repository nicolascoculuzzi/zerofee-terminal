import { memo } from "react";
import { Age } from "../../components/ui/Age";
import { SolGlyph } from "../../components/ui/bits";
import { TokenAvatar } from "../../components/ui/TokenAvatar";
import { cn } from "../../lib/cn";
import { DASH } from "../../lib/format";
import { navigateTo } from "../../lib/nav";
import { useYoungerThan } from "../../lib/useNow";
import type { PulseColumnId, TokenRisk } from "../../protocol";
import { type PresetId, useSettings } from "../../state/settings";
import { Cell, CopyCa, Counters, FeesCell, Flags, LABEL, MetricsCell, MoreButton, Socials } from "./CardParts";
import { AVATAR_TRACK, type CardVariant, type CardView, sameCardView } from "./cardView";
import { HIGHLIGHT_MS } from "./liveList";
import { MiniChart } from "./MiniChart";
import { QuickBuyPill } from "./QuickBuyPill";
import { RiskChips } from "./RiskChips";
import { usePulseUi } from "./store";

/** New Pairs cards with no trade for 30 s render their metrics in text-3 (DESIGN.md 4.4). */
const STALE_MS = 30_000;

export function openToken(mint: string, newTab: boolean): void {
  if (newTab) {
    window.open(`/t/${mint}`, "_blank", "noopener");
    return;
  }
  useSettings.getState().addRecentToken(mint);
  navigateTo(`/t/${mint}`);
}

export interface TokenCardProps {
  view: CardView;
  /** Risk values for the chips; `view.risk` is their memo key. */
  risk: TokenRisk;
  column: PulseColumnId;
  variant: CardVariant;
  /** Position in the column (aria-rowindex − 1) and the row's offset in px. */
  index: number;
  start: number;
  rowId: string;
  quickBuySol: number;
  preset: PresetId;
  socials: boolean;
  counters: boolean;
  miniChart: boolean;
  feesNetBuy: boolean;
  colored: boolean;
  /** Keyboard cursor row. */
  cursor: boolean;
  /** The token last opened in the token page (Instant Trade target). */
  open: boolean;
  /** When the card entered the column (0 for the initial snapshot): drives the highlight fade. */
  insertedAt: number;
}

/** Grid tracks (DESIGN.md 4.4): avatar | main | [chart 64] | metrics 72 | [F/NB 72] | pill, 8 px gaps. */
function gridFor(variant: CardVariant, chart: boolean, fees: boolean): string {
  if (variant === "narrow") return "grid-cols-[var(--zf-card-avatar)_minmax(0,1fr)_auto]";
  if (variant === "wide" || (!chart && !fees)) return "grid-cols-[var(--zf-card-avatar)_minmax(0,1fr)_72px_auto]";
  if (chart && fees) return "grid-cols-[var(--zf-card-avatar)_minmax(0,1fr)_64px_72px_72px_auto]";
  if (chart) return "grid-cols-[var(--zf-card-avatar)_minmax(0,1fr)_64px_72px_auto]";
  return "grid-cols-[var(--zf-card-avatar)_minmax(0,1fr)_72px_72px_auto]";
}

const AVATAR_TRACK_NARROW = "[--zf-card-avatar:44px] in-data-[density=comfortable]:[--zf-card-avatar:52px]";

/**
 * Pulse token card (DESIGN.md 4.4): 68 px compact / 80 px comfortable including the 1 px
 * divider. Three lines (identity; age, socials, counters; risk chips and flags), metrics on the
 * right, then the quick-buy pill. Narrow columns move MC and V into lines 1 and 2 and drop the
 * chip letters; wide+ adds a mini chart and fees / net buy. Hover and the keyboard cursor use
 * surface-2 (the cursor adds a 2 px accent bar), the last-opened token surface-3, new cards the
 * highlight fade. Values never flash. Anatomy after Axiom's card and Binance Meme Rush (square
 * avatar with a status ring and launchpad badge): https://mobbin.com/screens/2aa0b210-3bdf-44dd-b04a-8fa2556db2f5
 * with the bought/sold split bar after Coinbase Wallet: https://mobbin.com/screens/5420b26c-19a1-4d3b-bb6e-7b68d373d175
 */
export const TokenCard = memo(function TokenCard(props: TokenCardProps) {
  const { view, risk, column, variant, index, start, rowId, cursor, open } = props;
  const narrow = variant === "narrow";
  const wideplus = variant === "wideplus";
  const fresh = useYoungerThan(props.insertedAt, HIGHLIGHT_MS);
  const live = useYoungerThan(view.lastTradeAt, STALE_MS);
  const stale = column === "new" && !live;
  const ticker = view.symbol.length > 10 ? `${view.symbol.slice(0, 9)}…` : view.symbol;
  const chart = wideplus && props.miniChart;
  // Backfilled tokens can arrive without a creation time: leave the age out rather than show "–".
  const aged = Number.isFinite(view.createdAt) && view.createdAt > 0;
  const hasSocial = props.socials && (view.x !== "" || view.web !== "" || view.tg !== "");
  const fees = wideplus && props.feesNetBuy;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users open the cursor row with Enter on the grid (pulse.open hotkey)
    // biome-ignore lint/a11y/useSemanticElements: virtualised rows can't be table rows; this is the ARIA grid pattern
    // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid; rows are reached through its aria-activedescendant cursor
    <div
      id={rowId}
      role="row"
      aria-rowindex={index + 1}
      data-mint={view.mint}
      data-col={column}
      style={{ transform: `translateY(${start}px)` }}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        openToken(view.mint, e.metaKey || e.ctrlKey);
      }}
      onMouseDown={(e) => {
        // Middle-click opens a tab; don't start the browser's autoscroll.
        if (e.button === 1) e.preventDefault();
      }}
      onAuxClick={(e) => {
        if (e.button !== 1 || (e.target as HTMLElement).closest("button")) return;
        e.preventDefault();
        openToken(view.mint, true);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        usePulseUi.getState().openMenu({ mint: view.mint, column, x: e.clientX, y: e.clientY });
      }}
      onPointerEnter={(e) => {
        if (e.pointerType !== "touch") usePulseUi.getState().setHover({ mint: view.mint, column });
      }}
      onPointerLeave={() => {
        const s = usePulseUi.getState();
        if (s.hover?.mint === view.mint) s.setHover(null);
      }}
      className={cn(
        "group/card absolute top-0 left-0 grid h-card w-full cursor-pointer items-center gap-x-2 border-b border-hairline px-2 transition-colors in-data-[density=comfortable]:px-2.5",
        gridFor(variant, chart, fees),
        narrow ? AVATAR_TRACK_NARROW : AVATAR_TRACK,
        // --zf-avatar-bg: the launchpad badge's 2 px cut-out matches the card's background.
        open
          ? "bg-surface-3 [--zf-avatar-bg:var(--zf-surface-3)]"
          : cursor
            ? "bg-surface-2 [--zf-avatar-bg:var(--zf-surface-2)]"
            : "[--zf-avatar-bg:var(--zf-surface-1)] hover:bg-surface-2 hover:[--zf-avatar-bg:var(--zf-surface-2)]",
        cursor &&
          "group-focus-visible/grid:outline-2 group-focus-visible/grid:-outline-offset-2 group-focus-visible/grid:outline-focus after:pointer-events-none after:absolute after:inset-y-0 after:left-0 after:w-0.5 after:bg-accent after:content-['']",
        fresh && "zf-enter",
      )}
    >
      <div data-tip="ring" aria-hidden="true" className="flex">
        <TokenAvatar
          mint={view.mint}
          symbol={view.symbol}
          imageUri={view.imageUri}
          launchpad={view.launchpad}
          size="card"
          progress={view.ring >= 0 ? view.ring / 100 : null}
          migrated={view.migrated}
        />
      </div>

      <Cell className="flex min-w-0 flex-col justify-center in-data-[density=comfortable]:gap-0.5">
        <div className="flex h-[18px] min-w-0 items-center gap-1 overflow-x-clip in-data-[density=comfortable]:h-5">
          <span className="shrink-0 text-body font-semibold text-fg-1">{ticker}</span>
          <span className="min-w-0 truncate text-data text-fg-3">{view.name}</span>
          <CopyCa mint={view.mint} />
          {/* Flags sit on line 1, where the name truncates to make room; line 3 is the five
              chips, which fill a wide column on their own. */}
          <Flags view={view} />
          <MoreButton mint={view.mint} symbol={view.symbol} column={column} shown={cursor} />
          {narrow && (
            <span
              data-tip="mc"
              className={cn(
                "zf-num num-dense ml-auto flex min-w-[7ch] shrink-0 items-center justify-end pl-1 text-data font-semibold",
                view.mc === DASH ? "text-fg-4" : stale ? "text-fg-3" : "text-fg-1",
              )}
            >
              {view.sol && view.mc !== DASH && <SolGlyph className="mr-px" />}
              {view.mc}
            </span>
          )}
        </div>
        <div className="flex h-4 min-w-0 items-center gap-1 overflow-x-clip overflow-y-visible in-data-[density=comfortable]:h-[18px]">
          {aged && <Age ts={view.createdAt} className="w-[4ch] shrink-0 text-label font-medium" />}
          {props.socials && <Socials view={view} gap={aged} />}
          {props.counters && <Counters view={view} gap={aged || hasSocial} />}
          {narrow && (
            <span
              data-tip="v"
              className={cn(
                "zf-num num-dense ml-auto flex min-w-[8ch] shrink-0 items-center justify-end pl-1 text-data before:content-['V']",
                LABEL,
                view.v === DASH ? "text-fg-4" : stale ? "text-fg-3" : "text-fg-2",
              )}
            >
              {view.sol && view.v !== DASH && <SolGlyph className="mr-px" />}
              {view.v}
            </span>
          )}
        </div>
        <RiskChips
          risk={risk}
          colored={props.colored}
          letters={narrow ? "never" : "always"}
          tips="delegate"
          pending="quiet"
          className="h-[18px] overflow-x-clip in-data-[density=comfortable]:h-5"
        />
      </Cell>

      {chart && <MiniChart mint={view.mint} />}
      {!narrow && <MetricsCell view={view} stale={stale} />}
      {fees && <FeesCell view={view} stale={stale} />}

      <Cell className="flex items-center justify-end">
        <QuickBuyPill mint={view.mint} symbol={view.symbol} sol={props.quickBuySol} preset={props.preset} />
      </Cell>
    </div>
  );
}, sameCardProps);

function sameCardProps(a: TokenCardProps, b: TokenCardProps): boolean {
  for (const k of Object.keys(a) as (keyof TokenCardProps)[]) {
    if (k === "view" || k === "risk") continue;
    if (a[k] !== b[k]) return false;
  }
  return sameCardView(a.view, b.view);
}
