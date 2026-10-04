import { useVirtualizer } from "@tanstack/react-virtual";
import type { Trade as WireTrade } from "@zerofee/protocol";
import { Columns3, Pause, Play, X } from "lucide-react";
import { type KeyboardEvent, memo, type ReactNode, type Ref, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Age } from "../../components/ui/Age";
import { IconButton } from "../../components/ui/Button";
import { EmptyState, ExplorerLink, Tag } from "../../components/ui/bits";
import { NumberInput, Segmented, Switch } from "../../components/ui/controls";
import { Num } from "../../components/ui/Num";
import { Popover } from "../../components/ui/Popover";
import { WalletAvatar } from "../../components/ui/TokenAvatar";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import { useCssPx } from "../../lib/cssVar";
import { fmtClock, fmtCount, fmtSol, fmtTokens, fmtUsd, shortAddr } from "../../lib/format";
import type { Trade, WalletTag } from "../../protocol";
import { apiUrl, IS_LIVE } from "../../runtime";
import { adaptTrade } from "../../services/live/adapters";
import { useMarket } from "../../state/market";
import { useToken } from "../../state/token";
import { type TrackedWallet, useTrackedMap } from "../../state/trackers";
import { sizeBarPct } from "../trade/tradeMath";
import { useQuote } from "./money";
import {
  ALIGN,
  type Col,
  ch,
  fit,
  flex,
  NewRowsBar,
  SkeletonRows,
  TableHeader,
  TableStrip,
  template,
  useLiveOrder,
  usePauseOnHover,
} from "./table";
import { useTokenUi } from "./tokenUi";

/*
 * Trades tape (DESIGN.md 4.9 "Trades"): dense 20/24 px rows without dividers, side as a B/S
 * square, SOL with exactly 3 decimals in the side colour and dim trailing zeros, a log-scaled
 * size bar behind each row, ages from the one shared clock, new rows flashing for 600 ms (6.6).
 * Hover, focus, scrolling away or Pause freeze the tape behind an "↑ N new" bar (6.7). Side
 * colour on the figure that matters after Binance https://mobbin.com/screens/8d1b7823-6418-44c5-b3d5-ab69b3bfd6e3;
 * the type filter in the header after Uniswap https://mobbin.com/screens/9a89244a-9b7b-49c1-9d6c-28cd7abdfa3f;
 * a faint right-anchored size bar that never competes with the digits, after Coinbase Advanced's
 * order book https://mobbin.com/screens/f8afc154-e5c8-4587-ab43-93c4799a979a and OKX's
 * https://mobbin.com/screens/fe41c6f7-54b0-4cb8-b281-5b0cf1d9428c. Rows by the dev, by you and by
 * tracked wallets carry a 2 px left edge and a 4-5% tint in their tag colour, never a coloured wall.
 */

type MakerKind = "all" | "you" | "dev" | "tracked";
type ColKey = "age" | "side" | "mc" | "price" | "sol" | "tokens" | "usd" | "trader" | "tx";

const SHOWN_TAGS: WalletTag[] = ["sniper", "insider", "bundler", "kol", "whale", "pro"];

/** Whose row it is, for the Axiom-style edge and tint (YOU wins over DEV over tracked). */
type RowMark = "you" | "dev" | "tracked" | null;

const MARK_EDGE: Record<Exclude<RowMark, null>, string> = {
  you: "bg-fg-2",
  dev: "bg-warn",
  tracked: "bg-info",
};
/* Local arbitrary tints (no global token): faint enough that the size bar and side colour still read. */
const MARK_TINT: Record<Exclude<RowMark, null>, string> = {
  you: "bg-[color-mix(in_srgb,var(--zf-text-1)_4%,transparent)]",
  dev: "bg-[color-mix(in_srgb,var(--zf-warn)_5%,transparent)]",
  tracked: "bg-[color-mix(in_srgb,var(--zf-info)_5%,transparent)]",
};

function rowMark(trade: Trade, tracked: TrackedWallet | undefined): RowMark {
  if (trade.tags.includes("you")) return "you";
  if (trade.tags.includes("dev")) return "dev";
  return tracked ? "tracked" : null;
}

/** First seen time per trade id, shared by rows so a remount never re-flashes an old row. */
type Arrivals = Map<string, number>;

function columns(showPrice: boolean, quoteUnit: string): Col<ColKey>[] {
  const cols: Col<ColKey>[] = [
    // Tight fixed tracks (4.9) so the numbers read as one tape; the trader column takes the slack.
    { key: "age", label: "Age", width: ch(5), align: "right" },
    { key: "side", label: "", width: ch(3), align: "center" },
    { key: "mc", label: quoteUnit === "USD" ? "MC" : "MC SOL", width: fit(8, 10), align: "right" },
    { key: "price", label: "Price", width: fit(10, 12), align: "right" },
    { key: "sol", label: "SOL", width: fit(10, 11), align: "right" },
    { key: "tokens", label: "Tokens", width: fit(8, 10), align: "right" },
    { key: "usd", label: "USD", width: fit(8, 10), align: "right" },
    { key: "trader", label: "Trader", width: flex(18) },
    { key: "tx", label: "", width: ch(3), align: "center" },
  ];
  return showPrice ? cols : cols.filter((c) => c.key !== "price");
}

/**
 * Trader: the name (tracked) or short mono address always starts at the same x, then the identity
 * tag (YOU, DEV, TRK) and at most one behaviour tag, so the column reads as one rhythm.
 */
function TraderCell({ trade, tracked, onPick }: { trade: Trade; tracked: TrackedWallet | undefined; onPick: (a: string) => void }) {
  const you = trade.tags.includes("you");
  const dev = trade.tags.includes("dev");
  const identity: WalletTag | null = you ? "you" : dev ? "dev" : tracked ? "tracked" : null;
  const tags = SHOWN_TAGS.filter((t) => trade.tags.includes(t)).slice(0, identity ? 1 : 2);
  return (
    <span className="flex min-w-0 items-center gap-1">
      <Tooltip content={<span className="font-mono break-all">{trade.maker}</span>}>
        <button
          type="button"
          onClick={() => onPick(trade.maker)}
          className="focus-inset flex min-w-0 items-center gap-1 rounded-xs text-fg-2 transition-colors hover:text-fg-1"
          aria-label={`Show trades by ${tracked?.name ?? (you ? "you" : dev ? "the dev" : trade.maker)}`}
        >
          {tracked ? (
            <>
              <WalletAvatar seed={tracked.address} label={tracked.name} tag={tracked.emoji} size={16} />
              <span className="max-w-[16ch] truncate text-fg-1">{tracked.name}</span>
            </>
          ) : (
            <span className={cn("truncate font-mono", (you || dev) && "text-fg-1")}>{shortAddr(trade.maker)}</span>
          )}
        </button>
      </Tooltip>
      {identity && <Tag tag={identity} />}
      {tags.map((t) => (
        <Tag key={t} tag={t} />
      ))}
    </span>
  );
}

const TradeRow = memo(function TradeRow({
  trade,
  cols,
  arrivedAt,
  tracked,
  quote,
  supply,
  solUsd,
  cursor,
  rowIndex,
  onPick,
}: {
  trade: Trade;
  cols: Col<ColKey>[];
  arrivedAt: number;
  tracked: TrackedWallet | undefined;
  quote: "USD" | "SOL";
  supply: number;
  solUsd: number;
  cursor: boolean;
  /** aria-rowindex (the header row is 1). */
  rowIndex: number;
  onPick: (a: string) => void;
}) {
  const buy = trade.side === "buy";
  const mark = rowMark(trade, tracked);
  // Decided once at mount: rows scrolled back into view never flash again.
  const [fresh] = useState(() => Date.now() - arrivedAt < 600);
  // The SOL/USD rate at the trade when both prices are known, else the live one.
  const fxAtTrade = trade.priceSol !== null && trade.priceUsd !== null && trade.priceSol > 0 ? trade.priceUsd / trade.priceSol : solUsd;
  const cell = (key: ColKey) => {
    switch (key) {
      case "age":
        return <Age ts={trade.ts} />;
      case "side":
        return (
          <span
            className={cn(
              "flex size-4 items-center justify-center rounded-xs text-micro font-semibold",
              buy ? "bg-buy-tint text-buy" : "bg-sell-tint text-sell",
            )}
          >
            {buy ? "B" : "S"}
          </span>
        );
      // Unknown values (null, from a partial live fill) leave the cell empty: the fixed tracks keep
      // the columns aligned and the tape never turns into a wall of dashes. Unknown is never 0.
      case "mc": {
        const mc = quote === "USD" ? trade.marketCapUsd : trade.priceSol === null ? null : trade.priceSol * supply;
        return mc === null ? null : <span className="zf-num num-dense text-fg-1">{quote === "USD" ? fmtUsd(mc) : fmtSol(mc)}</span>;
      }
      case "price": {
        const price = quote === "USD" ? trade.priceUsd : trade.priceSol;
        return price === null ? null : <Num kind="price" dense usd={quote === "USD"} value={price} className="text-fg-2" />;
      }
      case "sol":
        return trade.solAmount === null ? null : (
          <Num kind="solTape" dense value={trade.solAmount} className={buy ? "text-buy" : "text-sell"} />
        );
      case "tokens":
        return <span className="zf-num num-dense text-fg-2">{fmtTokens(trade.tokenAmount)}</span>;
      case "usd":
        return trade.solAmount === null ? null : <span className="zf-num num-dense text-fg-2">{fmtUsd(trade.solAmount * fxAtTrade)}</span>;
      case "trader":
        return <TraderCell trade={trade} tracked={tracked} onPick={onPick} />;
      case "tx":
        return <ExplorerLink signature={trade.signature} />;
    }
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern for the virtualised tape (DESIGN.md 7)
    // biome-ignore lint/a11y/useFocusableInteractive: the grid container holds focus and moves the row cursor
    <div
      role="row"
      aria-rowindex={rowIndex}
      aria-selected={cursor}
      title={fmtClock(trade.ts)}
      className={cn(
        "relative grid h-full items-center",
        mark && MARK_TINT[mark],
        "hover:bg-surface-2",
        fresh && (buy ? "zf-flash-buy" : "zf-flash-sell"),
        cursor && "bg-surface-2",
      )}
      style={{ gridTemplateColumns: template(cols) }}
    >
      {/* Size bar (4.9): right-anchored, log-scaled, at 70% of the bar token so digits stay on top. */}
      <span
        aria-hidden="true"
        className={cn("absolute inset-y-0 right-0 opacity-70", buy ? "bg-bar-buy" : "bg-bar-sell")}
        style={{ width: `${sizeBarPct(trade.solAmount)}%` }}
      />
      {cursor ? (
        <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-accent" />
      ) : (
        mark && <span aria-hidden="true" className={cn("absolute inset-y-px left-0 w-0.5 opacity-80", MARK_EDGE[mark])} />
      )}
      {cols.map((c) => (
        // biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern for the virtualised tape (DESIGN.md 7)
        // biome-ignore lint/a11y/useFocusableInteractive: cells are read through the row cursor, not tab stops
        <span key={c.key} role="gridcell" className={cn("relative flex min-w-0 items-center px-2", ALIGN[c.align ?? "left"])}>
          {cell(c.key)}
        </span>
      ))}
    </div>
  );
});

/**
 * Footer row under the tape, for pagination of older trades (DESIGN.md 4.18): one dense row in the
 * tape's own rhythm. `sentinelRef` goes on the row so an IntersectionObserver can ask for the next
 * page when it scrolls into view. Presentation only: fetching lives with the caller.
 */
export function TapeFooter({
  state,
  onRetry,
  sentinelRef,
  backfilling = false,
}: {
  state: "idle" | "loading" | "end" | "error";
  onRetry?: () => void;
  sentinelRef?: Ref<HTMLDivElement>;
  /** The server is still reading the coin's history from chain: the oldest row held is not the start. */
  backfilling?: boolean;
}) {
  return (
    <div
      ref={sentinelRef}
      data-tape-footer={state}
      aria-live="polite"
      className="flex h-row-dense items-center gap-2 px-2 text-label text-fg-3"
    >
      {state === "loading" && (
        <>
          <span aria-hidden="true" className="h-2 w-16 rounded-xs bg-surface-3" />
          Loading older trades
        </>
      )}
      {state === "end" && <span className="text-fg-4">{backfilling ? "Loading full history…" : "Start of trade history"}</span>}
      {state === "error" && (
        <>
          Couldn't load older trades
          {onRetry && (
            <button type="button" onClick={onRetry} className="focus-inset rounded-xs text-fg-2 transition-colors hover:text-fg-1">
              Retry
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** Trades per older page (the gateway allows up to 1,000). */
const OLDER_PAGE = 200;
/** After the oldest stored trade, look again at most this often (a backfill may have stored older ones since). */
const OLDER_RETRY_MS = 10_000;

type OlderState = "idle" | "loading" | "end" | "error";

/**
 * Every stored buy and sell of the coin below the live tape: pages of GET /api/trades (newest first, cursor
 * `next`; the server backfills a coin first seen mid-life from chain), loaded once when the token opens and
 * then whenever the footer scrolls into view. Live mode only (the simulation's tape is the whole history).
 * Rows already in the live tape are skipped.
 */
function useOlderTrades(mint: string | null, live: readonly Trade[], supply: number, solUsd: number) {
  const decimals = useToken((s) => s.detail?.summary.decimals ?? 6);
  const [older, setOlder] = useState<Trade[]>([]);
  const [state, setState] = useState<OlderState>("idle");
  const cursor = useRef<{ next: string | null; done: boolean; at: number; busy: boolean }>({ next: null, done: false, at: 0, busy: false });
  const liveRef = useRef(live);
  liveRef.current = live;
  const olderRef = useRef(older);
  olderRef.current = older;

  useEffect(() => {
    void mint;
    cursor.current = { next: null, done: false, at: 0, busy: false };
    setOlder([]);
    setState("idle");
  }, [mint]);

  const loadMore = useCallback(() => {
    const c = cursor.current;
    if (!IS_LIVE || !mint || c.busy || (c.done && Date.now() - c.at < OLDER_RETRY_MS)) return;
    // after the last page: continue from the oldest trade held, in case a backfill stored older ones since
    const all = [...liveRef.current, ...olderRef.current];
    const before = c.done ? (all[all.length - 1]?.signature ?? null) : c.next;
    c.busy = true;
    c.at = Date.now();
    setState("loading");
    const qs = new URLSearchParams({ mint, limit: String(OLDER_PAGE) });
    if (before) qs.set("before", before);
    fetch(apiUrl(`/api/trades?${qs}`), { credentials: "same-origin" })
      .then((r) =>
        r.ok ? (r.json() as Promise<{ trades?: WireTrade[]; next?: string | null }>) : Promise.reject(new Error(String(r.status))),
      )
      .then((body) => {
        if (cursor.current !== c) return; // the token changed meanwhile
        const have = new Set([...liveRef.current, ...olderRef.current].map((t) => t.id));
        const page = (body.trades ?? []).filter((t) => !have.has(t.id)).map((t) => adaptTrade(t, { decimals, solUsd, supply }));
        c.next = body.next ?? null;
        c.done = !body.next;
        if (page.length) setOlder((prev) => [...prev, ...page]);
        setState(c.done ? "end" : "idle");
      })
      .catch(() => {
        if (cursor.current === c) setState("error");
      })
      .finally(() => {
        c.busy = false;
      });
  }, [mint, decimals, solUsd, supply]);

  // the first page as soon as the token opens: a coin first seen mid-life has more on the server than live
  useEffect(() => {
    if (mint) loadMore();
  }, [mint, loadMore]);

  const liveIds = useMemo(() => new Set(live.map((t) => t.id)), [live]);
  const rest = useMemo(() => older.filter((t) => !liveIds.has(t.id)), [older, liveIds]);
  return { older: rest, state, loadMore };
}

export function TradesTable({
  supply,
  footer,
}: {
  supply: number;
  /**
   * Rendered under the last row inside the scroll container for older pages. Default (live mode): the tape's
   * own <TapeFooter> over GET /api/trades.
   */
  footer?: ReactNode;
}) {
  const trades = useToken((s) => s.trades);
  const mint = useToken((s) => s.mint);
  const tracked = useTrackedMap();
  const candle = useTokenUi((s) => s.candle);
  const setCandle = useTokenUi((s) => s.setCandle);
  const maker = useTokenUi((s) => s.maker);
  const setMaker = useTokenUi((s) => s.setMaker);
  const showPrice = useTokenUi((s) => s.tradeCols.price);
  const setTradeCols = useTokenUi((s) => s.setTradeCols);
  const { quote, solUsd } = useQuote();
  const loading = useToken((s) => s.status === "loading");
  const connection = useMarket((s) => s.connection);
  const [kind, setKind] = useState<MakerKind>("all");
  const [minSol, setMinSol] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const [cursor, setCursor] = useState<number | null>(null);
  const [colsOpen, setColsOpen] = useState(false);
  const colsAnchor = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const arrivals = useRef<Arrivals>(new Map());
  const rowH = useCssPx("--zf-row-dense", 20);
  const pause = usePauseOnHover(paused);
  const cols = useMemo(() => columns(showPrice, quote), [showPrice, quote]);

  const keep = useCallback(
    (t: Trade) => {
      // An unknown size (null) fails a minimum: unknown is not zero.
      if (minSol !== null && (t.solAmount === null || t.solAmount < minSol)) return false;
      if (maker && t.maker !== maker) return false;
      if (candle) {
        const sec = t.ts / 1000;
        if (sec < candle.from || sec >= candle.to) return false;
      }
      if (kind === "you") return t.tags.includes("you");
      if (kind === "dev") return t.tags.includes("dev");
      if (kind === "tracked") return tracked.has(t.maker);
      return true;
    },
    [minSol, maker, candle, kind, tracked],
  );
  const filtered = useMemo(() => trades.filter(keep), [trades, keep]);
  const olderTrades = useOlderTrades(mint, trades, supply, solUsd);
  const filteredOlder = useMemo(() => olderTrades.older.filter(keep), [olderTrades.older, keep]);
  const live = useLiveOrder(filtered, (t) => t.id, { frozen: pause.frozen });
  const queued = live.queued;
  // older pages sit below the live tape and are never queued behind the pause
  const rows = useMemo(() => (filteredOlder.length ? [...live.rows, ...filteredOlder] : live.rows), [live.rows, filteredOlder]);

  // the footer asks for the next page when it scrolls into view (and again while it stays in view)
  const loadMore = olderTrades.loadMore;
  const olderState = olderTrades.state;
  const sentinelEl = useRef<HTMLDivElement | null>(null);
  const observer = useRef<IntersectionObserver | null>(null);
  const sentinel = useCallback(
    (el: HTMLDivElement | null) => {
      observer.current?.disconnect();
      observer.current = null;
      sentinelEl.current = el;
      if (!el || !IS_LIVE || typeof IntersectionObserver === "undefined") return;
      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) loadMore();
        },
        { root: scrollRef.current, rootMargin: "400px 0px" },
      );
      io.observe(el);
      observer.current = io;
    },
    [loadMore],
  );
  useEffect(() => () => observer.current?.disconnect(), []);
  useEffect(() => {
    const el = sentinelEl.current;
    const root = scrollRef.current;
    if (olderState !== "idle" || !el || !root) return;
    if (el.getBoundingClientRect().top - root.getBoundingClientRect().bottom < 400) loadMore();
  }, [olderState, loadMore]);
  const backfilling = useToken((s) => s.detail?.summary.historyState === "backfilling");
  const tapeFooter =
    footer ?? (IS_LIVE ? <TapeFooter state={olderState} onRetry={loadMore} sentinelRef={sentinel} backfilling={backfilling} /> : null);

  // Insertion times: rows present at first render count as old; a row inserted later flashes
  // once (DESIGN.md 6.6), including a batch released after a pause, unless it is an old trade
  // that a filter change brought back.
  const seen = arrivals.current;
  const initial = seen.size === 0;
  const now = Date.now();
  for (const t of rows) if (!seen.has(t.id)) seen.set(t.id, initial || now - t.ts > 15_000 ? 0 : now);
  if (seen.size > 4000) {
    const keep = new Set(trades.map((t) => t.id));
    for (const id of seen.keys()) if (!keep.has(id)) seen.delete(id);
  }

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 12,
    getItemKey: (i) => rows[i]?.id ?? i,
  });

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    let next: number | null = null;
    if (e.key === "ArrowDown") next = Math.min(rows.length - 1, (cursor ?? -1) + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, (cursor ?? 1) - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = rows.length - 1;
    else if (e.key === "Enter" && cursor !== null) {
      const t = rows[cursor];
      if (t) setMaker(maker === t.maker ? null : t.maker);
      e.preventDefault();
      return;
    } else if (e.key === "Escape" && cursor !== null) {
      setCursor(null);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (next === null || rows.length === 0) return;
    e.preventDefault();
    setCursor(next);
    virtualizer.scrollToIndex(next, { align: "auto" });
  };

  const applyQueued = () => {
    pause.release();
    setPaused(false);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TableStrip className="gap-2">
        <Segmented<MakerKind>
          size="xs"
          value={kind}
          onChange={setKind}
          options={[
            { value: "all", label: "All" },
            { value: "you", label: "You" },
            { value: "dev", label: "Dev" },
            { value: "tracked", label: "Tracked" },
          ]}
          label="Trader filter"
        />
        <NumberInput
          value={minSol}
          onChange={setMinSol}
          placeholder="Min"
          suffix="SOL"
          min={0}
          step={0.1}
          className="h-5 w-[72px] shrink-0 px-1.5"
          ariaLabel="Minimum trade size in SOL"
        />
        {maker && (
          <button
            type="button"
            onClick={() => setMaker(null)}
            className="flex h-5 shrink-0 items-center gap-1 rounded-xs border border-hairline bg-surface-2 px-1.5 text-label"
            aria-label="Clear trader filter"
          >
            <span className="text-fg-3">Trader</span>
            <span className="font-mono text-fg-1">{shortAddr(maker)}</span>
            <X className="icon-xs text-fg-3" />
          </button>
        )}
        {candle && (
          <button
            type="button"
            onClick={() => setCandle(null)}
            className="flex h-5 shrink-0 items-center gap-1 rounded-xs border border-hairline bg-surface-2 px-1.5 text-label"
            aria-label="Clear candle filter"
          >
            <span className="text-fg-3">Candle</span>
            <span className="zf-num text-fg-1">{fmtClock(candle.from * 1000)}</span>
            <X className="icon-xs text-fg-3" />
          </button>
        )}
        <span className="ml-auto" />
        {filtered.length !== trades.length && (
          <span className="zf-num shrink-0 text-label text-fg-3">
            <span className="text-fg-2">{fmtCount(filtered.length)}</span> of {fmtCount(trades.length)}
          </span>
        )}
        <IconButton ref={colsAnchor} size="xs" label="Columns" active={colsOpen} onClick={() => setColsOpen((o) => !o)}>
          <Columns3 />
        </IconButton>
        <Popover open={colsOpen} onClose={() => setColsOpen(false)} anchor={colsAnchor} align="end" width={200} padding="form">
          <div className="flex items-center justify-between gap-3 text-data text-fg-1">
            Price column
            <Switch checked={showPrice} onChange={(v) => setTradeCols({ price: v })} label="Show the price column" />
          </div>
        </Popover>
        <IconButton size="xs" label={paused ? "Resume tape" : "Pause tape"} active={paused} onClick={() => setPaused((p) => !p)}>
          {paused ? <Play /> : <Pause />}
        </IconButton>
      </TableStrip>
      <div className="relative min-h-0 flex-1">
        <NewRowsBar count={queued} onApply={applyQueued} className="top-[var(--zf-header-row)]" />
        {/* biome-ignore lint/a11y/useSemanticElements: ARIA grid pattern for the virtualised tape (DESIGN.md 7) */}
        <div
          ref={scrollRef}
          role="grid"
          tabIndex={0}
          aria-label="Trades"
          aria-rowcount={rows.length + 1}
          onKeyDown={onKey}
          onScroll={pause.onScroll}
          {...pause.bind}
          className="focus-inset h-full overflow-auto text-data"
        >
          <div className="min-w-[640px]">
            <TableHeader cols={cols} />
            {rows.length === 0 ? (
              loading ? (
                <SkeletonRows cols={cols} rows={12} dense />
              ) : (
                <EmptyState
                  title={trades.length === 0 ? (backfilling ? "Loading full history…" : "No trades yet") : "No trades match these filters"}
                  body={
                    trades.length === 0
                      ? backfilling
                        ? "Trades come in from chain as they are read, newest first."
                        : connection === "live"
                          ? "New trades appear within about a second of landing."
                          : "Trades resume when the live feed reconnects."
                      : "Clear a filter to see the whole tape."
                  }
                />
              )
            ) : (
              <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
                {virtualizer.getVirtualItems().map((item) => {
                  const t = rows[item.index];
                  if (!t) return null;
                  return (
                    <div
                      key={item.key}
                      className="absolute top-0 left-0 w-full"
                      style={{ height: rowH, transform: `translateY(${item.start}px)` }}
                    >
                      <TradeRow
                        trade={t}
                        cols={cols}
                        arrivedAt={seen.get(t.id) ?? 0}
                        tracked={tracked.get(t.maker)}
                        quote={quote}
                        supply={supply}
                        solUsd={solUsd}
                        cursor={cursor === item.index}
                        rowIndex={item.index + 2}
                        onPick={(a) => setMaker(maker === a ? null : a)}
                      />
                    </div>
                  );
                })}
              </div>
            )}
            {rows.length > 0 && tapeFooter}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Phone tape (DESIGN.md 5.8): 44 px rows, the latest 100 trades, no virtualisation. */
export function MobileTradesList({ supply }: { supply: number }) {
  const trades = useToken((s) => s.trades);
  const { quote } = useQuote();
  const backfilling = useToken((s) => s.detail?.summary.historyState === "backfilling");
  const rows = trades.slice(0, 100);
  if (rows.length === 0)
    return backfilling ? (
      <EmptyState title="Loading full history…" body="Trades come in from chain as they are read, newest first." />
    ) : (
      <EmptyState title="No trades yet" body="New trades appear within about a second of landing." />
    );
  return (
    <ul aria-label="Trades" className="@container">
      {rows.map((t) => {
        const buy = t.side === "buy";
        return (
          <li key={t.id} className="relative flex h-11 items-center gap-3 px-3 text-body @max-[339px]:gap-2">
            <span
              aria-hidden="true"
              className={cn("absolute inset-y-0 right-0", buy ? "bg-bar-buy" : "bg-bar-sell")}
              style={{ width: `${sizeBarPct(t.solAmount)}%` }}
            />
            <span
              className={cn(
                "relative flex size-5 items-center justify-center rounded-xs text-micro font-semibold",
                buy ? "bg-buy-tint text-buy" : "bg-sell-tint text-sell",
              )}
            >
              {buy ? "B" : "S"}
            </span>
            <Num kind="solTape" value={t.solAmount} unit="SOL" className={cn("relative min-w-[11ch]", buy ? "text-buy" : "text-sell")} />
            {(quote === "USD" ? t.marketCapUsd : t.priceSol) !== null && (
              <span className="zf-num relative text-fg-2">
                {quote === "USD" ? fmtUsd(t.marketCapUsd) : fmtSol(t.priceSol === null ? null : t.priceSol * supply)}
                <span className="zf-unit">{quote === "USD" ? " MC" : " SOL MC"}</span>
              </span>
            )}
            <span className="relative ml-auto truncate font-mono text-label text-fg-3 @max-[339px]:hidden">
              {t.tags.includes("you") ? "YOU" : t.tags.includes("dev") ? "DEV" : shortAddr(t.maker)}
            </span>
            <Age ts={t.ts} className="relative w-[4ch] text-right @max-[339px]:ml-auto" />
          </li>
        );
      })}
    </ul>
  );
}
