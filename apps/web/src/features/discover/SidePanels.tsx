import { ArrowUpRight, Star } from "lucide-react";
import { memo, type ReactNode, useCallback, useMemo } from "react";
import { Link } from "react-router";
import { Age } from "../../components/ui/Age";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/bits";
import { Num } from "../../components/ui/Num";
import { TokenAvatar } from "../../components/ui/TokenAvatar";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { useCssPx } from "../../lib/cssVar";
import { compileBlacklists, isBlacklisted } from "../../lib/filters";
import { fmtInt } from "../../lib/format";
import { navigateTo } from "../../lib/nav";
import { useMarket } from "../../state/market";
import { useSettings } from "../../state/settings";
import { MetaCount, PausedChip } from "../trackers/bits";
import { HIGHLIGHT_MS, hoverTarget, MOBILE_ROW_PX, useInsertions, useIsMobile, useLivePause } from "../trackers/hooks";
import { QuoteValue } from "../trackers/money";
import { QuickBuyPill, WatchStar } from "../trackers/QuickBuyButton";
import { Cell, CursorBar, HeaderCell, HeaderRow, rowTone } from "../trackers/table";
import { VirtualGrid } from "../trackers/VirtualList";

const NEW_PAIRS = 16;
const identity = (mint: string): string => mint;

const COL = {
  token: "min-w-0 flex-1",
  age: "@max-[340px]:hidden",
  mc: "w-[9ch] justify-end",
  change: "w-[8ch] justify-end",
  pill: "w-16 justify-end",
  star: "w-6 justify-center",
} as const;

const ROW = "flex items-center gap-2 px-2";

/**
 * Compact token row (24 / 28 px): avatar, ticker and age; MC and 5m right-aligned; quick-buy and
 * star. Watchlist rows after Fey's watchlist and OpenSea's star column:
 * https://mobbin.com/screens/5c326535-4eb7-4652-855f-1c6fe9ecdb91
 * https://mobbin.com/screens/3c43da7c-1aa1-4e4f-8a8d-cdf85c546240
 */
const CompactTokenRow = memo(function CompactTokenRow({ mint, fresh, active }: { mint: string; fresh?: boolean; active: boolean }) {
  const t = useMarket((s) => s.tokens[mint]);
  if (!t) return null;
  const tab = active ? 0 : -1;
  return (
    <div
      {...hoverTarget(mint)}
      className={cn(ROW, "relative h-full text-data", active ? "bg-surface-2" : rowTone({}), fresh && "zf-enter")}
    >
      <CursorBar show={active} />
      <Cell className={cn("items-center gap-1", COL.token)}>
        <Link to={`/t/${t.mint}`} tabIndex={-1} className="absolute inset-0">
          <span className="sr-only">
            Open {t.symbol}, {t.name}
          </span>
        </Link>
        <TokenAvatar mint={t.mint} symbol={t.symbol} imageUri={t.imageUri} size="2xs" />
        <span className="truncate font-semibold text-fg-1">{t.symbol}</span>
        <Age ts={t.createdAt} className={cn("shrink-0", COL.age)} />
      </Cell>
      <Cell className={cn("shrink-0 font-medium text-fg-1", COL.mc)}>
        <QuoteValue usd={t.marketCapUsd} sol={t.marketCapSol} />
      </Cell>
      <Cell className={cn("shrink-0", COL.change)}>
        <Num kind="pct" value={t.change5mPct} signed />
      </Cell>
      <Cell className={cn("shrink-0", COL.pill)}>
        <QuickBuyPill mint={t.mint} symbol={t.symbol} source="discover" size="row" tabIndex={tab} />
      </Cell>
      <Cell className={cn("relative flex shrink-0", COL.star)}>
        <WatchStar mint={t.mint} symbol={t.symbol} tabIndex={tab} />
      </Cell>
    </div>
  );
});

/** Phone row (64 px). */
const MobileTokenRow = memo(function MobileTokenRow({ mint, fresh }: { mint: string; fresh?: boolean }) {
  const t = useMarket((s) => s.tokens[mint]);
  if (!t) return null;
  return (
    <div {...hoverTarget(mint)} className={cn("relative flex h-full items-center gap-3 pr-1 pl-3", fresh && "zf-enter")}>
      <Link to={`/t/${t.mint}`} className="absolute inset-0">
        <span className="sr-only">
          Open {t.symbol}, {t.name}
        </span>
      </Link>
      <TokenAvatar mint={t.mint} symbol={t.symbol} imageUri={t.imageUri} size="sm" />
      <Cell className="min-w-0 flex-1 flex-col gap-1">
        <span className="flex h-5 min-w-0 items-center gap-2">
          <span className="truncate text-amount font-semibold text-fg-1">{t.symbol}</span>
          <Age ts={t.createdAt} className="shrink-0 text-data" />
        </span>
        <span className="flex h-5 items-center gap-2 text-data">
          <span className="font-medium text-fg-1">
            <QuoteValue usd={t.marketCapUsd} sol={t.marketCapSol} />
          </span>
          <Num kind="pct" value={t.change5mPct} signed />
        </span>
      </Cell>
      <QuickBuyPill mint={t.mint} symbol={t.symbol} source="discover" size="touch" />
      <WatchStar mint={t.mint} symbol={t.symbol} touch />
    </div>
  );
});

function ColumnsHeader() {
  return (
    <HeaderRow className={ROW}>
      <HeaderCell className={COL.token}>Token</HeaderCell>
      <HeaderCell className={COL.mc} align="right" metric="marketCap">
        MC
      </HeaderCell>
      <HeaderCell className={COL.change} align="right" metric="change5m">
        5m
      </HeaderCell>
      <HeaderCell className={COL.pill} />
      <HeaderCell className={COL.star} />
    </HeaderRow>
  );
}

/** Tiled panel header (DESIGN.md 2.4, 4.9): 32 / 36 px, 12/600 title, count in text-3, a hairline under it. */
function PanelHeader({ title, meta, action }: { title: string; meta?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-panel-header shrink-0 items-center gap-2 border-b border-hairline px-3">
      <h2 className="text-data font-semibold text-fg-1">{title}</h2>
      {meta}
      {action && <span className="ml-auto flex items-center gap-2">{action}</span>}
    </div>
  );
}

function useTokenGridHandlers() {
  const open = useCallback((mint: string, how: { newTab: boolean }) => {
    const to = `/t/${mint}`;
    if (how.newTab) window.open(to, "_blank", "noopener");
    else navigateTo(to);
  }, []);
  const copy = useCallback((mint: string) => void copyText(mint), []);
  return { open, copy };
}

/**
 * Watchlist: starred tokens that are in the live set, newest star first. Tokens that left the
 * live set are counted with a one-click cleanup.
 */
export function WatchlistPanel({ header = true }: { header?: boolean }) {
  const watchlist = useSettings((s) => s.watchlist);
  const toggleWatch = useSettings((s) => s.toggleWatch);
  const tokens = useMarket((s) => s.tokens);
  const present = useMemo(() => watchlist.filter((m) => tokens[m] !== undefined), [watchlist, tokens]);
  const missing = watchlist.length - present.length;
  const mobile = useIsMobile();
  const rowPx = useCssPx("--zf-row", 24);
  const { open, copy } = useTokenGridHandlers();

  return (
    <section aria-label="Watchlist" className="@container flex min-h-0 min-w-0 flex-col bg-surface-1">
      {header && <PanelHeader title="Watchlist" meta={<MetaCount>{fmtInt(present.length)}</MetaCount>} />}
      <VirtualGrid
        items={present}
        getKey={identity}
        rowHeight={mobile ? MOBILE_ROW_PX : rowPx}
        label="Watched tokens"
        header={mobile || present.length === 0 ? undefined : <ColumnsHeader />}
        empty={
          watchlist.length === 0 ? (
            <EmptyState
              icon={<Star />}
              title="No watched tokens"
              body="Star a token in Trending, New pairs or on its page to keep it here."
            />
          ) : (
            <EmptyState title="Watched tokens are offline" body="They left the live set. They come back here when they trade again." />
          )
        }
        onOpen={open}
        onCopy={copy}
        mintOf={identity}
        renderRow={(m, { active }) => (mobile ? <MobileTokenRow mint={m} /> : <CompactTokenRow mint={m} active={active} />)}
      />
      {missing > 0 && (
        <div className="flex h-row shrink-0 items-center gap-2 border-t border-hairline px-3 text-label text-fg-3">
          <span className="truncate">
            {fmtInt(missing)} watched {missing === 1 ? "token is" : "tokens are"} not in the live set
          </span>
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            onClick={() => {
              const live = useMarket.getState().tokens;
              for (const m of useSettings.getState().watchlist) if (!live[m]) toggleWatch(m);
            }}
          >
            Remove them
          </Button>
        </div>
      )}
    </section>
  );
}

/**
 * New pairs: the newest launches from the Pulse "New Pairs" column, live. Hover or focus pauses
 * the list; new rows get the 1,200 ms highlight. Age beside the ticker and MC right-aligned
 * after Binance Meme Rush: https://mobbin.com/screens/972c602f-95aa-44ba-9cd3-1f869d9a58c3
 */
export function NewPairsPanel({ header = true }: { header?: boolean }) {
  const mints = useMarket((s) => s.columns.new);
  const blacklists = useSettings((s) => s.blacklists);
  const mobile = useIsMobile();
  const rowPx = useCssPx("--zf-row", 24);
  const latest = useMemo(() => {
    const compiled = compileBlacklists(blacklists);
    const tokens = useMarket.getState().tokens;
    const out: string[] = [];
    for (const m of mints) {
      const t = tokens[m];
      if (!t || isBlacklisted(t, compiled)) continue;
      out.push(m);
      if (out.length === NEW_PAIRS) break;
    }
    return out;
  }, [mints, blacklists]);
  const { shown, paused, pending, bind, release } = useLivePause(latest, identity);
  const isFresh = useInsertions(shown, identity, HIGHLIGHT_MS);
  const { open, copy } = useTokenGridHandlers();

  return (
    <section aria-label="New pairs" className="@container flex min-h-0 min-w-0 flex-col bg-surface-1">
      {header && (
        <PanelHeader
          title="New pairs"
          meta={<PausedChip paused={paused} />}
          action={
            <Link
              to="/pulse"
              className="flex items-center gap-1 text-label text-fg-3 transition-colors hover:text-fg-1"
              title="Open Pulse (G then P)"
            >
              Open Pulse
              <ArrowUpRight className="icon-xs" />
            </Link>
          }
        />
      )}
      <VirtualGrid
        items={shown}
        getKey={identity}
        rowHeight={mobile ? MOBILE_ROW_PX : rowPx}
        label="Newest tokens"
        header={mobile || shown.length === 0 ? undefined : <ColumnsHeader />}
        empty={<EmptyState title="Waiting for new launches" body="New tokens appear here as they launch." />}
        paused={paused}
        pending={pending}
        onRelease={release}
        bind={bind}
        onOpen={open}
        onCopy={copy}
        mintOf={identity}
        renderRow={(m, { active }) =>
          mobile ? <MobileTokenRow mint={m} fresh={isFresh(m)} /> : <CompactTokenRow mint={m} fresh={isFresh(m)} active={active} />
        }
      />
    </section>
  );
}
