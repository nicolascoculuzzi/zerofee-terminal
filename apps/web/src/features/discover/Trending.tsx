import { Info, ListFilter, SlidersHorizontal } from "lucide-react";
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { Age } from "../../components/ui/Age";
import { Button, IconButton } from "../../components/ui/Button";
import { EmptyState, SocialLinks } from "../../components/ui/bits";
import { Checkbox, NumberInput, Segmented } from "../../components/ui/controls";
import { LaunchpadMark } from "../../components/ui/Logo";
import { BottomSheet } from "../../components/ui/Modal";
import { Num } from "../../components/ui/Num";
import { TokenAvatar } from "../../components/ui/TokenAvatar";
import { Tooltip } from "../../components/ui/Tooltip";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { useCssPx } from "../../lib/cssVar";
import { compileBlacklists, isBlacklisted } from "../../lib/filters";
import { fmtInt, fmtRiskPct } from "../../lib/format";
import { bandsText, riskTone, TONE_TEXT } from "../../lib/metrics";
import { navigateTo } from "../../lib/nav";
import type { TokenSummary } from "../../protocol";
import { useMarket } from "../../state/market";
import { useSettings } from "../../state/settings";
import { MetaCount, PaneToolbar, PausedChip, SearchField } from "../trackers/bits";
import { hoverTarget, MOBILE_ROW_PX, useIsMobile, useLivePause } from "../trackers/hooks";
import { QuoteValue, useQuote } from "../trackers/money";
import { QuickBuyPill, WatchStar } from "../trackers/QuickBuyButton";
import { Cell, CursorBar, HeaderCell, HeaderRow, rowTone, SortHeaderCell } from "../trackers/table";
import { VirtualGrid } from "../trackers/VirtualList";
import { discoverFiltersActive, useDiscoverPrefs } from "./prefs";
import {
  defaultDir,
  matchesTrendFilters,
  type RankedToken,
  rankTrending,
  sortRanked,
  TREND_EXPLAINER,
  TREND_WINDOWS,
  type TrendWindow,
} from "./ranking";

const TOP_N = 100;
/** Sorted lists re-sort at most every 2 s (DESIGN.md 6.7); rows keep updating in place. */
const RERANK_MS = 2000;

const rankedKey = (r: RankedToken): string => r.token.mint;

/** Market snapshot for ranking, refreshed at most every `intervalMs` (row values stay live). */
function useRankingSnapshot(intervalMs: number): Record<string, TokenSummary> {
  const [snap, setSnap] = useState(() => useMarket.getState().tokens);
  const empty = useRef(Object.keys(snap).length === 0);
  useEffect(() => {
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      last = Date.now();
      const tokens = useMarket.getState().tokens;
      empty.current = Object.keys(tokens).length === 0;
      setSnap(tokens);
    };
    flush();
    const unsub = useMarket.subscribe((s, prev) => {
      if (s.tokens === prev.tokens || timer) return;
      const wait = empty.current ? 0 : Math.max(0, intervalMs - (Date.now() - last));
      timer = setTimeout(flush, wait);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [intervalMs]);
  return snap;
}

/*
 * Trending columns (DESIGN.md 4.9: fixed `ch` widths, one flexible label column, numbers
 * right-aligned). Lower-priority columns drop as the panel narrows (container queries).
 */
const COL = {
  rank: "w-[4ch] justify-end",
  token: "min-w-0 flex-1",
  name: "@max-[720px]:hidden",
  socials: "@max-[960px]:hidden",
  price: "w-[11ch] justify-end @max-[1040px]:hidden",
  change: "w-[8ch] justify-end",
  mc: "w-[9ch] justify-end",
  liq: "w-[9ch] justify-end @max-[640px]:hidden",
  vol: "w-[9ch] justify-end @max-[560px]:hidden",
  txns: "w-[7ch] justify-end @max-[880px]:hidden",
  holders: "w-[7ch] justify-end @max-[940px]:hidden",
  top10: "w-[6ch] justify-end @max-[800px]:hidden",
  dex: "w-[5ch] justify-center @max-[1120px]:hidden",
  pill: "w-16 justify-end",
  star: "w-6 justify-center",
} as const;

const ROW = "flex items-center gap-2 px-2";

/** "DEX" in a neutral outline chip (Dex Paid says nothing about safety, DESIGN.md 3.11). */
function DexChip({ paid }: { paid: boolean }) {
  if (!paid) return <Num kind="count" value={null} />;
  return (
    <span className="inline-flex h-4 items-center rounded-xs border border-hairline-strong px-1 text-micro font-semibold text-fg-2">
      DEX
    </span>
  );
}

function Top10({ pct }: { pct: number }) {
  const thresholds = useSettings((s) => s.display.riskThresholds);
  return <span className={cn("zf-num", TONE_TEXT[riskTone("top10", pct, thresholds)])}>{fmtRiskPct(pct)}</span>;
}

/**
 * Trending row (24 / 28 px): rank, token, then live numbers; quick-buy and star at the end.
 * Values update in place; only the order is throttled.
 */
const TrendingRow = memo(function TrendingRow({ fallback, rank, active }: { fallback: TokenSummary; rank: number; active: boolean }) {
  const t = useMarket((s) => s.tokens[fallback.mint]) ?? fallback;
  const quote = useQuote();
  const tab = active ? 0 : -1;
  return (
    <div {...hoverTarget(t.mint)} className={cn(ROW, "relative h-full text-data", active ? "bg-surface-2" : rowTone({}))}>
      <CursorBar show={active} />
      <Cell className={cn("shrink-0 text-fg-3", COL.rank)}>
        <span className="zf-num">{rank}</span>
      </Cell>
      <Cell className={cn("items-center gap-1", COL.token)}>
        <Link to={`/t/${t.mint}`} tabIndex={-1} className="absolute inset-0">
          <span className="sr-only">
            Open {t.symbol}, {t.name}
          </span>
        </Link>
        <TokenAvatar mint={t.mint} symbol={t.symbol} imageUri={t.imageUri} size="2xs" />
        <span className="max-w-[10ch] shrink-0 truncate font-semibold text-fg-1">{t.symbol}</span>
        <LaunchpadMark launchpad={t.launchpad} />
        <span className={cn("min-w-0 truncate text-fg-3", COL.name)}>{t.name}</span>
        <Age ts={t.createdAt} className="shrink-0" />
        <span className={cn("relative shrink-0", COL.socials)}>
          <SocialLinks socials={t.socials} mint={t.mint} pump={t.launchpad === "pump" || t.launchpad === "mayhem"} />
        </span>
      </Cell>
      <Cell className={cn("shrink-0 text-fg-1", COL.price)}>
        <Num kind="price" value={quote === "USD" ? t.priceUsd : t.priceSol} usd={quote === "USD"} />
      </Cell>
      <Cell className={cn("shrink-0", COL.change)}>
        <Num kind="pct" value={t.change5mPct} signed />
      </Cell>
      <Cell className={cn("shrink-0 font-medium text-fg-1", COL.mc)}>
        <QuoteValue usd={t.marketCapUsd} sol={t.marketCapSol} />
      </Cell>
      <Cell className={cn("shrink-0 text-fg-2", COL.liq)}>
        <QuoteValue usd={t.liquidityUsd} />
      </Cell>
      <Cell className={cn("shrink-0 text-fg-2", COL.vol)}>
        <QuoteValue usd={t.volumeUsd} />
      </Cell>
      <Cell className={cn("shrink-0 text-fg-2", COL.txns)}>
        <Num kind="count" value={t.txns} />
      </Cell>
      <Cell className={cn("shrink-0 text-fg-2", COL.holders)}>
        <Num kind="count" value={t.holders} />
      </Cell>
      <Cell className={cn("shrink-0", COL.top10)}>
        <Top10 pct={t.risk.top10Pct} />
      </Cell>
      <Cell className={cn("shrink-0", COL.dex)}>
        <DexChip paid={t.dexPaid} />
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

/** Phone row (64 px): rank and avatar; ticker and age over MC and 5m; quick-buy and star at 44 px. */
const MobileTrendingRow = memo(function MobileTrendingRow({ fallback, rank }: { fallback: TokenSummary; rank: number }) {
  const t = useMarket((s) => s.tokens[fallback.mint]) ?? fallback;
  return (
    <div {...hoverTarget(t.mint)} className="relative flex h-full items-center gap-2 pr-1 pl-3">
      <Link to={`/t/${t.mint}`} className="absolute inset-0">
        <span className="sr-only">
          Open {t.symbol}, {t.name}
        </span>
      </Link>
      <span className="zf-num w-[3ch] shrink-0 text-right text-data text-fg-3">{rank}</span>
      <TokenAvatar mint={t.mint} symbol={t.symbol} imageUri={t.imageUri} size="sm" />
      <Cell className="min-w-0 flex-1 flex-col gap-1">
        <span className="flex h-5 min-w-0 items-center gap-2">
          <span className="truncate text-amount font-semibold text-fg-1">{t.symbol}</span>
          <LaunchpadMark launchpad={t.launchpad} size={14} />
          <Age ts={t.createdAt} className="shrink-0 text-data" />
        </span>
        <span className="flex h-5 min-w-0 items-center gap-2 text-data">
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

/** Phones: a Filters button with a bottom sheet of touch-size fields (44 px rows, 16 px inputs). */
function MobileTrendFilters({ count }: { count: number }) {
  const filters = useDiscoverPrefs((s) => s.filters);
  const setFilters = useDiscoverPrefs((s) => s.setFilters);
  const resetFilters = useDiscoverPrefs((s) => s.resetFilters);
  const [open, setOpen] = useState(false);
  const active =
    (filters.dexPaid ? 1 : 0) + (filters.minLiq !== null ? 1 : 0) + (filters.minVol !== null ? 1 : 0) + (filters.maxTop10 !== null ? 1 : 0);
  return (
    <>
      <Button
        size="md"
        variant={active > 0 ? "secondary" : "ghost"}
        icon={<SlidersHorizontal />}
        className="max-md:h-11"
        onClick={() => setOpen(true)}
      >
        Filters
        {active > 0 && <span className="zf-num text-fg-2">{active}</span>}
      </Button>
      <BottomSheet open={open} onClose={() => setOpen(false)} title="Trending filters">
        <div className="flex flex-col gap-4 p-4">
          <Checkbox checked={filters.dexPaid} onChange={(dexPaid) => setFilters({ dexPaid })} label="Dex paid only" className="py-3.5" />
          <div className="flex flex-col gap-1">
            <span className="zf-label">Minimum liquidity, USD</span>
            <NumberInput
              size="amount"
              value={filters.minLiq}
              onChange={(minLiq) => setFilters({ minLiq })}
              prefix="$"
              placeholder="Any"
              min={0}
              inputClassName="text-title"
              ariaLabel="Minimum liquidity in USD (accepts 10k)"
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="zf-label">Minimum volume, USD</span>
            <NumberInput
              size="amount"
              value={filters.minVol}
              onChange={(minVol) => setFilters({ minVol })}
              prefix="$"
              placeholder="Any"
              min={0}
              inputClassName="text-title"
              ariaLabel="Minimum volume in USD (accepts 50k)"
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="zf-label">Maximum top 10 holders share</span>
            <NumberInput
              size="amount"
              value={filters.maxTop10}
              onChange={(maxTop10) => setFilters({ maxTop10 })}
              suffix="%"
              placeholder="Any"
              min={0}
              max={100}
              inputClassName="text-title"
              ariaLabel="Maximum top 10 holders share in percent"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button size="xl" variant="secondary" onClick={resetFilters}>
              Reset filters
            </Button>
            <Button size="xl" variant="primary" onClick={() => setOpen(false)}>
              Show {fmtInt(count)} tokens
            </Button>
          </div>
        </div>
      </BottomSheet>
    </>
  );
}

function WindowInfo() {
  return (
    <Tooltip
      maxWidth={320}
      content={
        <span className="flex flex-col gap-1">
          <span className="text-data font-semibold text-fg-1">How trending is ranked</span>
          {TREND_WINDOWS.map((w) => (
            <span key={w} className="text-fg-2">
              {TREND_EXPLAINER[w]}
            </span>
          ))}
          <span className="text-micro text-fg-3">Estimated from cumulative live stats until windowed stats are served.</span>
        </span>
      }
    >
      <IconButton label="How trending is ranked" className="max-md:size-11">
        <Info />
      </IconButton>
    </Tooltip>
  );
}

/**
 * Trending: the live set ranked for the chosen window, top 100, as a dense table (DESIGN.md 4.9)
 * with the Pulse quick-buy pill. Re-ranks at most every 2 s and freezes while hovered or
 * focused. Sortable headers and tabular numbers in every column after OpenSea's tokens table;
 * a dense dark screener after Fey; the star column after OpenSea collections; window tabs after
 * OKX markets' category tabs:
 * https://mobbin.com/screens/a2072a4d-d59f-4b22-92be-ddcc3100db61
 * https://mobbin.com/screens/08c97ee6-5818-4bcc-ae01-2e2a751c1323
 * https://mobbin.com/screens/3c43da7c-1aa1-4e4f-8a8d-cdf85c546240
 * https://mobbin.com/screens/d8d401bd-925d-490d-b367-0fcbf7628c0f
 */
export function TrendingPanel() {
  const trendWindow = useDiscoverPrefs((s) => s.window);
  const setWindow = useDiscoverPrefs((s) => s.setWindow);
  const sort = useDiscoverPrefs((s) => s.sort);
  const setSort = useDiscoverPrefs((s) => s.setSort);
  const filters = useDiscoverPrefs((s) => s.filters);
  const setFilters = useDiscoverPrefs((s) => s.setFilters);
  const resetFilters = useDiscoverPrefs((s) => s.resetFilters);
  const blacklists = useSettings((s) => s.blacklists);
  const thresholds = useSettings((s) => s.display.riskThresholds);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const snapshot = useRankingSnapshot(RERANK_MS);
  const mobile = useIsMobile();
  const rowPx = useCssPx("--zf-row", 24);

  const ranked = useMemo(() => {
    const compiled = compileBlacklists(blacklists);
    const f = { ...filters, query: deferredQuery };
    return rankTrending(Object.values(snapshot), trendWindow, Date.now(), (t) => !isBlacklisted(t, compiled) && matchesTrendFilters(t, f));
  }, [snapshot, trendWindow, filters, deferredQuery, blacklists]);
  const rows = useMemo(() => sortRanked(ranked.slice(0, TOP_N), sort.key, sort.dir), [ranked, sort]);
  const { shown, paused, pending, bind, release } = useLivePause(rows, rankedKey);
  const total = Object.keys(snapshot).length;
  const filtered = discoverFiltersActive(filters);
  const searching = deferredQuery.trim() !== "";

  const open = useCallback((r: RankedToken, how: { newTab: boolean }) => {
    const to = `/t/${r.token.mint}`;
    if (how.newTab) window.open(to, "_blank", "noopener");
    else navigateTo(to);
  }, []);
  const copy = useCallback((r: RankedToken) => void copyText(r.token.mint), []);
  const sortProps = (k: Parameters<typeof defaultDir>[0]) => ({
    k,
    sort,
    onSort: setSort,
    defaultDir: defaultDir(k),
    align: "right" as const,
  });

  return (
    <div className="@container flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-topbar shrink-0 items-center gap-2 border-b border-hairline px-2 max-md:h-auto max-md:flex-wrap max-md:px-3 max-md:py-2">
        <h2 className="pl-1 text-data font-semibold text-fg-1 max-md:pl-0">Trending</h2>
        <Segmented<TrendWindow>
          value={trendWindow}
          onChange={setWindow}
          options={TREND_WINDOWS.map((w) => ({ value: w, label: w, title: TREND_EXPLAINER[w] }))}
          label="Trending window"
          className="max-md:h-13"
        />
        <WindowInfo />
        <span className="ml-auto flex items-center gap-2 max-md:order-last max-md:ml-0 max-md:w-full">
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder="Search name, ticker or CA"
            label="Search trending tokens"
            mobile={mobile}
            className={mobile ? "min-w-0 flex-1" : "w-60"}
          />
        </span>
      </div>
      <PaneToolbar>
        {mobile ? (
          <MobileTrendFilters count={Math.min(TOP_N, ranked.length)} />
        ) : (
          <>
            <Checkbox
              checked={filters.dexPaid}
              onChange={(dexPaid) => setFilters({ dexPaid })}
              label="Dex paid only"
              className="shrink-0"
            />
            <NumberInput
              value={filters.minLiq}
              onChange={(minLiq) => setFilters({ minLiq })}
              prefix="Liq $"
              placeholder="Min"
              min={0}
              className="w-28"
              ariaLabel="Minimum liquidity in USD (accepts 10k)"
            />
            <NumberInput
              value={filters.minVol}
              onChange={(minVol) => setFilters({ minVol })}
              prefix="Vol $"
              placeholder="Min"
              min={0}
              className="w-28"
              ariaLabel="Minimum volume in USD (accepts 50k)"
            />
            <NumberInput
              value={filters.maxTop10}
              onChange={(maxTop10) => setFilters({ maxTop10 })}
              prefix="Top 10"
              suffix="%"
              placeholder="Max"
              min={0}
              max={100}
              className="w-28"
              ariaLabel="Maximum top 10 holders share in percent"
            />
            {filtered && (
              <Button size="xs" variant="ghost" onClick={resetFilters}>
                Reset filters
              </Button>
            )}
          </>
        )}
        <span className="ml-auto flex items-center gap-2 pl-2">
          <PausedChip paused={paused} />
          <MetaCount>
            Top {fmtInt(Math.min(TOP_N, ranked.length))} of {fmtInt(total)}
          </MetaCount>
        </span>
      </PaneToolbar>
      <VirtualGrid
        items={shown}
        getKey={rankedKey}
        rowHeight={mobile ? MOBILE_ROW_PX : rowPx}
        label="Trending tokens"
        header={
          mobile ? undefined : (
            <HeaderRow className={ROW}>
              <SortHeaderCell {...sortProps("rank")} label="#" className={COL.rank} title="Trending rank for the window" />
              <HeaderCell className={COL.token}>Token</HeaderCell>
              <SortHeaderCell {...sortProps("price")} label="Price" className={COL.price} metric="price" />
              <SortHeaderCell {...sortProps("change")} label="5m" className={COL.change} metric="change5m" />
              <SortHeaderCell {...sortProps("mc")} label="MC" className={COL.mc} metric="marketCap" />
              <SortHeaderCell {...sortProps("liq")} label="Liq" className={COL.liq} metric="liquidity" />
              <SortHeaderCell {...sortProps("vol")} label="Vol" className={COL.vol} metric="volume" />
              <SortHeaderCell {...sortProps("txns")} label="Txns" className={COL.txns} metric="txns" />
              <SortHeaderCell {...sortProps("holders")} label="Holders" className={COL.holders} metric="holders" />
              <SortHeaderCell
                {...sortProps("top10")}
                label="Top 10"
                className={COL.top10}
                metric="top10"
                bands={bandsText("top10", thresholds)}
              />
              <HeaderCell className={COL.dex} align="center" metric="dexPaid">
                Dex
              </HeaderCell>
              <HeaderCell className={COL.pill} />
              <HeaderCell className={COL.star} />
            </HeaderRow>
          )
        }
        empty={
          total === 0 ? (
            <EmptyState title="Waiting for the live market" body="Tokens show up as soon as the feed connects." />
          ) : filtered || searching ? (
            <EmptyState
              icon={<ListFilter />}
              title={searching ? `No tokens match “${deferredQuery.trim()}”` : "No tokens match these filters"}
              body="Loosen a filter or clear the search."
              action={
                filtered ? (
                  <Button size="sm" variant="secondary" onClick={resetFilters}>
                    Reset filters
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <EmptyState title="Nothing is trending yet" body="The ranking fills in as tokens trade." />
          )
        }
        paused={paused}
        pending={pending}
        onRelease={release}
        bind={bind}
        onOpen={open}
        onCopy={copy}
        mintOf={rankedKey}
        renderRow={(r, { active }) =>
          mobile ? <MobileTrendingRow fallback={r.token} rank={r.rank} /> : <TrendingRow fallback={r.token} rank={r.rank} active={active} />
        }
      />
    </div>
  );
}
