import { useVirtualizer } from "@tanstack/react-virtual";
import { Columns3, Pause, Play, X } from "lucide-react";
import { type KeyboardEvent, memo, useMemo, useRef, useState } from "react";
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
import { useMarket } from "../../state/market";
import { useToken } from "../../state/token";
import { type TrackedWallet, useTrackedMap } from "../../state/trackers";
import { sizeBarPct } from "../trade/tradeMath";
import { useQuote } from "./money";
import { ALIGN, type Col, ch, flex, NewRowsBar, SkeletonRows, TableHeader, template, useLiveOrder, usePauseOnHover } from "./table";
import { useTokenUi } from "./tokenUi";

/*
 * Trades tape (DESIGN.md 4.9 "Trades"): dense 20/24 px rows without dividers, side as a B/S
 * square, SOL with exactly 3 decimals in the side colour and dim trailing zeros, a log-scaled
 * size bar behind each row, ages from the one shared clock, new rows flashing for 600 ms (6.6).
 * Hover, focus, scrolling away or Pause freeze the tape behind an "↑ N new" bar (6.7). Side
 * colour on the figure that matters after Binance https://mobbin.com/screens/8d1b7823-6418-44c5-b3d5-ab69b3bfd6e3;
 * the type filter in the header after Uniswap https://mobbin.com/screens/9a89244a-9b7b-49c1-9d6c-28cd7abdfa3f
 */

type MakerKind = "all" | "you" | "dev" | "tracked";
type ColKey = "age" | "side" | "mc" | "price" | "sol" | "tokens" | "usd" | "trader" | "tx";

const SHOWN_TAGS: WalletTag[] = ["sniper", "insider", "bundler", "kol", "whale", "pro"];

/** First seen time per trade id, shared by rows so a remount never re-flashes an old row. */
type Arrivals = Map<string, number>;

function columns(showPrice: boolean, quoteUnit: string): Col<ColKey>[] {
  const cols: Col<ColKey>[] = [
    { key: "age", label: "Age", width: ch(5), align: "right" },
    { key: "side", label: "", width: ch(3), align: "center" },
    { key: "mc", label: quoteUnit === "USD" ? "MC" : "MC SOL", width: ch(8), align: "right" },
    { key: "price", label: "Price", width: ch(10), align: "right" },
    { key: "sol", label: "SOL", width: ch(10), align: "right" },
    { key: "tokens", label: "Tokens", width: ch(8), align: "right" },
    { key: "usd", label: "USD", width: ch(8), align: "right" },
    { key: "trader", label: "Trader", width: flex(16) },
    { key: "tx", label: "", width: ch(3), align: "center" },
  ];
  return showPrice ? cols : cols.filter((c) => c.key !== "price");
}

function TraderCell({ trade, tracked, onPick }: { trade: Trade; tracked: TrackedWallet | undefined; onPick: (a: string) => void }) {
  const you = trade.tags.includes("you");
  const dev = trade.tags.includes("dev");
  const tags = SHOWN_TAGS.filter((t) => trade.tags.includes(t)).slice(0, 2);
  return (
    <span className="flex min-w-0 items-center gap-1">
      <Tooltip content={<span className="font-mono break-all">{trade.maker}</span>}>
        <button
          type="button"
          onClick={() => onPick(trade.maker)}
          className="focus-inset flex min-w-0 items-center gap-1 rounded-xs text-fg-2 transition-colors hover:text-fg-1"
          aria-label={`Show trades by ${tracked?.name ?? (you ? "you" : dev ? "the dev" : trade.maker)}`}
        >
          {you ? (
            <Tag tag="you" />
          ) : dev ? (
            <Tag tag="dev" />
          ) : tracked ? (
            <>
              <WalletAvatar seed={tracked.address} label={tracked.name} tag={tracked.emoji} size={16} />
              <span className="max-w-[16ch] truncate text-fg-1">{tracked.name}</span>
            </>
          ) : (
            <span className="truncate font-mono">{shortAddr(trade.maker)}</span>
          )}
        </button>
      </Tooltip>
      {tracked && <Tag tag="tracked" />}
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
  // Decided once at mount: rows scrolled back into view never flash again.
  const [fresh] = useState(() => Date.now() - arrivedAt < 600);
  const fxAtTrade = trade.priceSol > 0 ? trade.priceUsd / trade.priceSol : solUsd;
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
      case "mc":
        return (
          <span className="zf-num num-dense text-fg-1">
            {quote === "USD" ? fmtUsd(trade.marketCapUsd) : fmtSol(trade.priceSol * supply)}
          </span>
        );
      case "price":
        return (
          <Num kind="price" dense usd={quote === "USD"} value={quote === "USD" ? trade.priceUsd : trade.priceSol} className="text-fg-2" />
        );
      case "sol":
        return <Num kind="solTape" dense value={trade.solAmount} className={buy ? "text-buy" : "text-sell"} />;
      case "tokens":
        return <span className="zf-num num-dense text-fg-2">{fmtTokens(trade.tokenAmount)}</span>;
      case "usd":
        return <span className="zf-num num-dense text-fg-2">{fmtUsd(trade.solAmount * fxAtTrade)}</span>;
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
        "relative grid h-full items-center hover:bg-surface-2",
        fresh && (buy ? "zf-flash-buy" : "zf-flash-sell"),
        cursor && "bg-surface-2",
      )}
      style={{ gridTemplateColumns: template(cols) }}
    >
      {cursor && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-accent" />}
      <span
        aria-hidden="true"
        className={cn("absolute inset-y-0 right-0", buy ? "bg-bar-buy" : "bg-bar-sell")}
        style={{ width: `${sizeBarPct(trade.solAmount)}%` }}
      />
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

export function TradesTable({ supply }: { supply: number }) {
  const trades = useToken((s) => s.trades);
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

  const filtered = useMemo(
    () =>
      trades.filter((t) => {
        if (minSol !== null && t.solAmount < minSol) return false;
        if (maker && t.maker !== maker) return false;
        if (candle) {
          const sec = t.ts / 1000;
          if (sec < candle.from || sec >= candle.to) return false;
        }
        if (kind === "you") return t.tags.includes("you");
        if (kind === "dev") return t.tags.includes("dev");
        if (kind === "tracked") return tracked.has(t.maker);
        return true;
      }),
    [trades, minSol, maker, candle, kind, tracked],
  );
  const { rows, queued } = useLiveOrder(filtered, (t) => t.id, { frozen: pause.frozen });

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
      <div className="flex h-7 shrink-0 items-center gap-2 overflow-hidden border-b border-hairline px-2">
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
          placeholder="Min SOL"
          min={0}
          step={0.1}
          className="w-16 shrink-0"
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
        <span className="zf-num ml-auto shrink-0 text-label text-fg-3">{fmtCount(filtered.length)} shown</span>
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
      </div>
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
                  title={trades.length === 0 ? "No trades yet" : "No trades match these filters"}
                  body={
                    trades.length === 0
                      ? connection === "live"
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
  const rows = trades.slice(0, 100);
  if (rows.length === 0) return <EmptyState title="No trades yet" body="New trades appear within about a second of landing." />;
  return (
    <ul aria-label="Trades" className="divide-y divide-hairline">
      {rows.map((t) => {
        const buy = t.side === "buy";
        return (
          <li key={t.id} className="relative flex h-11 items-center gap-3 px-3 text-body">
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
            <span className="zf-num relative text-fg-2">
              {quote === "USD" ? fmtUsd(t.marketCapUsd) : fmtSol(t.priceSol * supply)}
              <span className="zf-unit">{quote === "USD" ? " MC" : " SOL MC"}</span>
            </span>
            <span className="relative ml-auto truncate font-mono text-label text-fg-3">
              {t.tags.includes("you") ? "YOU" : t.tags.includes("dev") ? "DEV" : shortAddr(t.maker)}
            </span>
            <Age ts={t.ts} className="relative w-[4ch] text-right" />
          </li>
        );
      })}
    </ul>
  );
}
