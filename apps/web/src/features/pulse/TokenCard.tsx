import { LoaderCircle, Sparkles, TriangleAlert, Users, Zap } from "lucide-react";
import { memo } from "react";
import { Age } from "../../components/ui/Age";
import { SocialLinks } from "../../components/ui/bits";
import { CopyButton } from "../../components/ui/controls";
import { TokenAvatar } from "../../components/ui/TokenAvatar";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import { fmtCount, fmtPct, fmtSolShort, fmtUsd } from "../../lib/format";
import { METRICS, token2022Danger } from "../../lib/metrics";
import { navigateTo } from "../../lib/nav";
import { buy } from "../../lib/tradeActions";
import type { PulseColumnId, TokenSummary } from "../../protocol";
import type { PresetId } from "../../state/settings";
import { useSettings } from "../../state/settings";
import { useTrades } from "../../state/trades";
import { useUi } from "../../state/ui";
import { RiskChips } from "./RiskChips";
import { TokenMenu } from "./TokenMenu";

export interface TokenCardProps {
  token: TokenSummary;
  column: PulseColumnId;
  quickBuySol: number;
  preset: PresetId;
  compact: boolean;
  metricColors: boolean;
  showRing: boolean;
  largeQuickBuy: boolean;
  /** Recently entered: briefly highlighted. */
  fresh: boolean;
}

function QuickBuyPill({ token, sol, preset, large }: { token: TokenSummary; sol: number; preset: PresetId; large: boolean }) {
  const pending = useTrades((s) => s.items.some((t) => t.mint === token.mint && t.status === "pending"));
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void buy({ mint: token.mint, sol, preset, source: "pulse" });
      }}
      aria-label={`Quick buy ${fmtSolShort(sol)} SOL of ${token.symbol}`}
      className={cn(
        "flex shrink-0 items-center justify-center gap-1 rounded-full bg-buy/10 font-semibold text-buy hover:bg-buy/20",
        large ? "h-6 min-w-20 px-3 text-sm" : "h-5 min-w-16 px-2 text-xs",
      )}
    >
      {pending ? <LoaderCircle className="icon-xs animate-spin" /> : <Zap className="icon-xs" />}
      {fmtSolShort(sol)} SOL
    </button>
  );
}

/**
 * Pulse card: a 3-row grid, identity and stats on the left, numbers and the buy action
 * right-aligned on the right.
 * Anatomy: Binance Meme Rank card (identity, chip row, one buy action per row)
 * https://mobbin.com/screens/5fb08bd4-fd7c-4a78-8ca9-77bf63a3a1a8 and OKX market rows (numbers right-aligned)
 * https://mobbin.com/screens/afd911c1-6455-47f4-afee-ef2843bd423f. Field set follows Axiom's Pulse card.
 */
export const TokenCard = memo(function TokenCard({
  token: t,
  column,
  quickBuySol,
  preset,
  compact,
  metricColors,
  showRing,
  largeQuickBuy,
  fresh,
}: TokenCardProps) {
  const setHoverMint = useUi((s) => s.setHoverMint);
  const addRecent = useSettings((s) => s.addRecentToken);
  const danger = token2022Danger(t.token2022);
  const buyShare = t.txns > 0 ? t.buys / t.txns : 0.5;
  const up = t.change5mPct >= 0;
  const onCurve = column !== "migrated";
  const open = () => {
    addRecent(t.mint);
    navigateTo(`/t/${t.mint}`);
  };
  const pill = <QuickBuyPill token={t} sol={quickBuySol} preset={preset} large={largeQuickBuy} />;

  return (
    // biome-ignore lint/a11y/useSemanticElements: the card contains buttons, so it can't be an <a>
    <div
      role="link"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter") open();
      }}
      onPointerEnter={() => setHoverMint(t.mint)}
      onPointerLeave={() => {
        if (useUi.getState().hoverMint === t.mint) setHoverMint(null);
      }}
      className={cn(
        "group relative flex cursor-pointer items-center gap-3 border-b border-line px-3 hover:bg-panel-2 focus-visible:bg-panel-2",
        compact ? "h-card-compact" : "h-card",
        fresh && "zf-enter",
      )}
    >
      <TokenAvatar
        mint={t.mint}
        symbol={t.symbol}
        imageUri={t.imageUri}
        launchpad={t.launchpad}
        size={compact ? "md" : "lg"}
        progress={showRing ? t.bondingProgress : null}
        migrated={!onCurve}
      />

      <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1">
        {/* Row 1: identity | market cap */}
        <div className="flex min-w-0 items-center gap-1">
          <span className="shrink-0 text-base font-semibold">{t.symbol}</span>
          <span className="min-w-0 truncate text-sm text-muted">{t.name}</span>
          <CopyButton text={t.mint} label="Copy contract address" />
          <span className="opacity-0 group-hover:opacity-100 focus-within:opacity-100">
            <TokenMenu token={t} />
          </span>
        </div>
        <Tooltip wrapperClassName="justify-end" content={`${METRICS.marketCap.definition} 5m: ${fmtPct(t.change5mPct, { signed: true })}`}>
          <span className="text-right text-2xs text-dim">
            MC{" "}
            <span className={cn("text-sm font-semibold", !metricColors ? "text-fg" : up ? "text-buy" : "text-sell")}>
              {fmtUsd(t.marketCapUsd)}
            </span>
          </span>
        </Tooltip>

        {/* Row 2: age, socials, holder stats | volume and txns (compact: buy action) */}
        <div className="flex min-w-0 items-center gap-2 overflow-hidden text-xs text-muted">
          <Tooltip content={METRICS.age.definition}>
            <Age ts={t.createdAt} className="font-medium text-fg" />
          </Tooltip>
          <SocialLinks socials={t.socials} />
          <Tooltip content={`${METRICS.holders.label}: ${METRICS.holders.definition}`}>
            <span className="flex items-center gap-1">
              <Users className="icon-xs" />
              {fmtCount(t.holders)}
            </span>
          </Tooltip>
          <Tooltip content={`${METRICS.proTraders.label}: ${METRICS.proTraders.definition}`}>
            <span className="flex items-center gap-1">
              <Sparkles className="icon-xs" />
              {t.proTraders}
            </span>
          </Tooltip>
          {column === "final" && (
            <Tooltip content={METRICS.progress.definition}>
              <span className="text-fg">{fmtPct(t.bondingProgress * 100)}</span>
            </Tooltip>
          )}
          {t.dexPaid && (
            <Tooltip content={METRICS.dexPaid.definition}>
              <span className="rounded-sm border border-line-strong px-1 text-2xs font-semibold text-fg">DEX</span>
            </Tooltip>
          )}
          {danger.length > 0 && (
            <Tooltip content={`Token-2022 danger: ${danger.join(", ")}. ${METRICS.token2022.definition}`}>
              <span className="flex items-center gap-px text-sell">
                <TriangleAlert className="icon-xs" />
                <span className="text-2xs font-semibold">T22</span>
              </span>
            </Tooltip>
          )}
        </div>
        {compact ? (
          pill
        ) : (
          <div className="flex items-center justify-end gap-2 text-xs text-dim">
            <span>
              V <span className="text-fg">{fmtUsd(t.volumeUsd)}</span>
            </span>
            <Tooltip content={`${t.buys} buys / ${t.sells} sells. ${METRICS.txns.definition}`}>
              <span className="flex flex-col items-end">
                <span>
                  TX <span className="text-fg">{fmtCount(t.txns)}</span>
                </span>
                <span className="flex h-0.5 w-full overflow-hidden rounded-full bg-sell/70">
                  <span className="h-full bg-buy" style={{ width: `${buyShare * 100}%` }} />
                </span>
              </span>
            </Tooltip>
          </div>
        )}

        {/* Row 3: risk chips | buy action */}
        {!compact && (
          <>
            <RiskChips risk={t.risk} colored={metricColors} />
            {pill}
          </>
        )}
      </div>

      {onCurve && (
        <span className="pointer-events-none absolute right-0 bottom-0 left-0 h-0.5" aria-hidden="true">
          <span className="block h-full bg-muted/60" style={{ width: `${t.bondingProgress * 100}%` }} />
        </span>
      )}
    </div>
  );
});
