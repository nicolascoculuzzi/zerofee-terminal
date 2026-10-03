import { ArrowDown, ArrowUp, Check, Info } from "lucide-react";
import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { Age } from "../../components/ui/Age";
import { Button } from "../../components/ui/Button";
import { SocialLinks } from "../../components/ui/bits";
import { NumberInput, Segmented } from "../../components/ui/controls";
import { TokenAvatar } from "../../components/ui/TokenAvatar";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import { compileBlacklists, isBlacklisted } from "../../lib/filters";
import { fmtCount, fmtPct, fmtUsd, fmtUsdPrice } from "../../lib/format";
import { METRICS, riskTone, TONE_TEXT } from "../../lib/metrics";
import type { TokenSummary } from "../../protocol";
import { useMarket } from "../../state/market";
import { useSettings } from "../../state/settings";
import { PauseStatus, SearchField } from "../trackers/bits";
import { QuickBuyButton, WatchStar } from "../trackers/QuickBuyButton";
import { discoverFiltersActive, useDiscoverPrefs } from "./prefs";
import {
  defaultDir,
  matchesTrendFilters,
  rankTrending,
  type SortKey,
  sortRanked,
  TREND_EXPLAINER,
  TREND_WINDOWS,
  type TrendWindow,
} from "./ranking";

const TOP_N = 100;
const RERANK_MS = 2500;

/**
 * Market snapshot for ranking, refreshed at most every `intervalMs` (rows still update live) and
 * frozen while `frozen` is set, so the order doesn't reshuffle under the cursor.
 */
function useRankingSnapshot(intervalMs: number, frozen: boolean): Record<string, TokenSummary> {
  const [snap, setSnap] = useState(() => useMarket.getState().tokens);
  const empty = useRef(Object.keys(snap).length === 0);
  useEffect(() => {
    if (frozen) return;
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
  }, [intervalMs, frozen]);
  return snap;
}

/** Column layout shared by the header and the rows; hidden columns follow the container width. */
const COL = {
  rank: "w-6",
  price: "hidden w-20 @2xl:flex",
  change: "flex w-14",
  mc: "flex w-16",
  liq: "hidden w-16 @xl:flex",
  vol: "hidden w-16 @lg:flex",
  txns: "hidden w-14 @3xl:flex",
  holders: "hidden w-14 @4xl:flex",
  top10: "hidden w-14 @3xl:flex",
  dex: "hidden w-10 @4xl:flex",
  buy: "flex w-14",
  star: "flex w-5",
} as const;

const TrendingRow = memo(function TrendingRow({ mint, rank, fallback }: { mint: string; rank: number; fallback: TokenSummary }) {
  const t = useMarket((s) => s.tokens[mint]) ?? fallback;
  const up = t.change5mPct >= 0;
  return (
    <div className="relative flex h-7 items-center gap-1 px-3 text-xs hover:bg-hover @md:gap-2">
      <Link to={`/t/${t.mint}`} className="absolute inset-0">
        <span className="sr-only">
          Open {t.symbol}, {t.name}
        </span>
      </Link>
      <span className={cn(COL.rank, "shrink-0 text-right text-dim")}>{rank}</span>
      <span className="flex min-w-0 flex-1 items-center gap-1 @md:gap-2">
        <TokenAvatar mint={t.mint} symbol={t.symbol} imageUri={t.imageUri} size="xs" />
        <span className="truncate font-semibold text-fg">{t.symbol}</span>
        <span className="hidden min-w-0 truncate text-dim @lg:inline">{t.name}</span>
        <Age ts={t.createdAt} className="hidden shrink-0 text-dim @sm:inline" />
        <span className="relative hidden shrink-0 @xl:inline-flex">
          <SocialLinks socials={t.socials} />
        </span>
      </span>
      <span className={cn(COL.price, "shrink-0 justify-end text-fg")}>{fmtUsdPrice(t.priceUsd)}</span>
      <span className={cn(COL.change, "shrink-0 justify-end", up ? "text-buy" : "text-sell")}>
        {fmtPct(t.change5mPct, { signed: true, digits: 1 })}
      </span>
      <span className={cn(COL.mc, "shrink-0 justify-end font-medium text-fg")}>{fmtUsd(t.marketCapUsd)}</span>
      <span className={cn(COL.liq, "shrink-0 justify-end text-muted")}>{fmtUsd(t.liquidityUsd)}</span>
      <span className={cn(COL.vol, "shrink-0 justify-end text-muted")}>{fmtUsd(t.volumeUsd)}</span>
      <span className={cn(COL.txns, "shrink-0 justify-end text-muted")}>{fmtCount(t.txns)}</span>
      <span className={cn(COL.holders, "shrink-0 justify-end text-muted")}>{fmtCount(t.holders)}</span>
      <span className={cn(COL.top10, "shrink-0 justify-end", TONE_TEXT[riskTone("top10", t.risk.top10Pct)])}>
        {fmtPct(t.risk.top10Pct, { digits: 1 })}
      </span>
      <span className={cn(COL.dex, "shrink-0 justify-center")}>
        {t.dexPaid ? <Check className="icon-sm text-fg" aria-label="Dex paid" /> : <span className="text-dim">—</span>}
      </span>
      <span className={cn(COL.buy, "shrink-0 justify-end")}>
        <QuickBuyButton mint={t.mint} symbol={t.symbol} source="discover" />
      </span>
      <span className={cn(COL.star, "shrink-0 justify-end")}>
        <WatchStar mint={t.mint} symbol={t.symbol} />
      </span>
    </div>
  );
});

function SortHeader({ k, label, col, title }: { k: SortKey; label: string; col: string; title?: string }) {
  const sort = useDiscoverPrefs((s) => s.sort);
  const setSort = useDiscoverPrefs((s) => s.setSort);
  const active = sort.key === k;
  const Arrow = sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      title={title}
      onClick={() => setSort(active ? { key: k, dir: sort.dir === "asc" ? "desc" : "asc" } : { key: k, dir: defaultDir(k) })}
      className={cn(col, "shrink-0 items-center justify-end gap-1 uppercase hover:text-fg", active && "text-fg")}
    >
      {active && <Arrow className="icon-xs" />}
      {label}
    </button>
  );
}

function TrendingHeader() {
  return (
    <div className="zf-label sticky top-0 z-10 flex h-6 items-center gap-1 border-b border-line bg-panel px-3 @md:gap-2">
      <SortHeader k="rank" label="#" col={cn(COL.rank, "flex")} title="Trending rank for the selected window" />
      <span className="min-w-0 flex-1">Token</span>
      <SortHeader k="price" label="Price" col={COL.price} title={METRICS.price.definition} />
      <SortHeader k="change" label="5m" col={COL.change} title={METRICS.change5m.definition} />
      <SortHeader k="mc" label="MC" col={COL.mc} title={METRICS.marketCap.definition} />
      <SortHeader k="liq" label="Liq" col={COL.liq} title={METRICS.liquidity.definition} />
      <SortHeader k="vol" label="Vol" col={COL.vol} title={METRICS.volume.definition} />
      <SortHeader k="txns" label="Txns" col={COL.txns} title={METRICS.txns.definition} />
      <SortHeader k="holders" label="Holders" col={COL.holders} title={METRICS.holders.definition} />
      <SortHeader k="top10" label="Top 10" col={COL.top10} title={METRICS.top10.definition} />
      <span className={cn(COL.dex, "shrink-0 justify-center")} title={METRICS.dexPaid.definition}>
        Dex
      </span>
      <span className={cn(COL.buy, "shrink-0")} />
      <span className={cn(COL.star, "shrink-0")} />
    </div>
  );
}

function ToggleChip({ pressed, onClick, children, title }: { pressed: boolean; onClick: () => void; children: string; title?: string }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={title}
      onClick={onClick}
      className={cn(
        "flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-sm transition-colors",
        pressed ? "border-line-strong bg-elev text-fg" : "border-line text-muted hover:text-fg",
      )}
    >
      {pressed && <Check className="icon-sm" />}
      {children}
    </button>
  );
}

/*
 * Trending. Anatomy follows Kraken Pro's markets panel (window/category tabs, right-aligned numeric
 * columns, star column at the end) and Binance Wallet's trending list (time-window selector):
 * https://mobbin.com/screens/fe204312-8607-4018-b0dd-a36dc71f4978
 * https://mobbin.com/screens/f9e12f4b-794b-4deb-be96-4a3d3ff62e6a
 * Ranking heuristic: see ranking.ts. Order refreshes every few seconds and freezes on hover;
 * the numbers in each row stay live.
 */
export function TrendingSection({ className }: { className?: string }) {
  const trendWindow = useDiscoverPrefs((s) => s.window);
  const setWindow = useDiscoverPrefs((s) => s.setWindow);
  const sort = useDiscoverPrefs((s) => s.sort);
  const filters = useDiscoverPrefs((s) => s.filters);
  const setFilters = useDiscoverPrefs((s) => s.setFilters);
  const resetFilters = useDiscoverPrefs((s) => s.resetFilters);
  const blacklists = useSettings((s) => s.blacklists);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [hovered, setHovered] = useState(false);
  const snapshot = useRankingSnapshot(RERANK_MS, hovered);

  const ranked = useMemo(() => {
    const compiled = compileBlacklists(blacklists);
    const f = { ...filters, query: deferredQuery };
    return rankTrending(Object.values(snapshot), trendWindow, Date.now(), (t) => !isBlacklisted(t, compiled) && matchesTrendFilters(t, f));
  }, [snapshot, trendWindow, filters, deferredQuery, blacklists]);
  const rows = useMemo(() => sortRanked(ranked.slice(0, TOP_N), sort.key, sort.dir), [ranked, sort]);
  const total = Object.keys(snapshot).length;
  const active = discoverFiltersActive(filters) || deferredQuery.trim() !== "";

  return (
    <section aria-label="Trending" className={cn("@container flex min-w-0 flex-col rounded-lg border border-line bg-panel", className)}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-2">
        <h2 className="pl-1 text-md font-semibold">Trending</h2>
        <Segmented<TrendWindow>
          value={trendWindow}
          onChange={setWindow}
          options={TREND_WINDOWS.map((w) => ({ value: w, label: w, title: TREND_EXPLAINER[w] }))}
          label="Trending window"
        />
        <Tooltip
          maxWidth={320}
          content={
            <span className="flex flex-col gap-1">
              <span className="font-semibold">How trending is ranked</span>
              {TREND_WINDOWS.map((w) => (
                <span key={w} className="text-muted">
                  {TREND_EXPLAINER[w]}
                </span>
              ))}
              <span className="text-dim">Estimated from cumulative live stats until windowed stats are served.</span>
            </span>
          }
        >
          <button
            type="button"
            aria-label="How trending is ranked"
            className="flex size-6 items-center justify-center rounded-md text-dim hover:text-fg"
          >
            <Info className="icon-sm" />
          </button>
        </Tooltip>
        <span className="ml-auto">
          <PauseStatus
            paused={hovered}
            pending={0}
            idle={`Top ${Math.min(TOP_N, ranked.length).toLocaleString("en-US")} of ${total.toLocaleString("en-US")} live`}
          />
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-line p-2">
        <SearchField
          className="flex-1 basis-40 sm:max-w-64"
          value={query}
          onChange={setQuery}
          placeholder="Search name, ticker or CA"
          label="Search trending tokens"
        />
        <ToggleChip pressed={filters.dexPaid} onClick={() => setFilters({ dexPaid: !filters.dexPaid })} title={METRICS.dexPaid.definition}>
          Dex paid
        </ToggleChip>
        <NumberInput
          value={filters.minLiq}
          onChange={(minLiq) => setFilters({ minLiq })}
          prefix="Min liq $"
          min={0}
          placeholder="any"
          alignRight
          className="w-32"
          ariaLabel="Minimum liquidity in USD (accepts 10k)"
        />
        <NumberInput
          value={filters.minVol}
          onChange={(minVol) => setFilters({ minVol })}
          prefix="Min vol $"
          min={0}
          placeholder="any"
          alignRight
          className="w-32"
          ariaLabel="Minimum volume in USD (accepts 50k)"
        />
        <NumberInput
          value={filters.maxTop10}
          onChange={(maxTop10) => setFilters({ maxTop10 })}
          prefix="Max T10"
          suffix="%"
          min={0}
          max={100}
          placeholder="any"
          alignRight
          className="w-28"
          ariaLabel="Maximum top 10 holders share in percent"
        />
        {active && (
          <Button
            size="md"
            variant="ghost"
            onClick={() => {
              resetFilters();
              setQuery("");
            }}
          >
            Reset
          </Button>
        )}
      </div>

      <div className="xl:min-h-0 xl:flex-1 xl:overflow-y-auto">
        <TrendingHeader />
        <div
          onPointerEnter={(e) => {
            if (e.pointerType === "mouse") setHovered(true);
          }}
          onPointerLeave={() => setHovered(false)}
        >
          {rows.length === 0 ? (
            <p className="px-3 py-4 text-sm text-dim">
              {total === 0 ? "Waiting for the live market." : active ? "No tokens match these filters." : "No tokens are trending yet."}
            </p>
          ) : (
            <ul aria-label="Trending tokens">
              {rows.map((r) => (
                <li key={r.token.mint}>
                  <TrendingRow mint={r.token.mint} rank={r.rank} fallback={r.token} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
