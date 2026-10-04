import { Share2 } from "lucide-react";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Age } from "../../components/ui/Age";
import { Button, IconButton } from "../../components/ui/Button";
import { LaunchpadMark } from "../../components/ui/Logo";
import { Num } from "../../components/ui/Num";
import { TokenAvatar } from "../../components/ui/TokenAvatar";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import { useCssPx } from "../../lib/cssVar";
import { fmtAge, fmtSolPrice, fmtTokens } from "../../lib/format";
import { sell } from "../../lib/tradeActions";
import type { ActivityItem, Position } from "../../protocol";
import { useMarket } from "../../state/market";
import { type Currency, type FillMarketCaps, fillMarketCaps, positionPnl, useLongList } from "./helpers";
import { MarketCap, Money, useQuote } from "./quote";
import { CursorBar, colW, rowClass, SkeletonRows, type SortDir, TABLE, TD, Th } from "./table";
import { useRowCursor } from "./useRowCursor";

export type { Currency } from "./helpers";

export interface PositionsTableProps {
  positions: Position[];
  /** Accepted for older callers; values convert at the live SOL/USD from the market store. */
  solUsd?: number;
  /** Pins the display currency. Omitted, the table follows the one global quote (DESIGN.md 3.9). */
  currency?: Currency;
  /** Row to emphasise (the token page passes its own mint). */
  highlightMint?: string;
  /** Token-page variant: 24/28 px rows and no token names. */
  compact?: boolean;
  /** Trade actions (Sell 25 / 50 / 100, Share) only for the user's own trading wallets. */
  ownWallet: boolean;
  /** Trading wallet the Sell buttons act on; omitted, the active wallet. */
  wallet?: string | null;
  /** "history" lists closed positions: no holding or sell columns, closed age instead. */
  variant?: "active" | "history";
  /** Wallet fills, for the entry and exit MC of tokens that have left the live set. */
  activity?: readonly ActivityItem[];
  onShare?: (position: Position) => void;
  /** Show skeleton rows under the real header. */
  loading?: boolean;
  /** Rendered under the header when there are no rows. */
  empty?: ReactNode;
  /** Classes for the scroll box (bound its height to scroll inside a panel). */
  className?: string;
}

type SortKey = "token" | "bought" | "sold" | "value" | "pnl" | "closed";

const SORT_VALUE: Record<SortKey, (p: Position) => number | string> = {
  token: (p) => p.symbol.toLowerCase(),
  bought: (p) => p.boughtSol,
  sold: (p) => p.soldSol,
  value: (p) => p.valueSol,
  pnl: positionPnl,
  closed: (p) => p.lastTradeAt,
};

const SELL_PCTS = [25, 50, 100] as const;

/** Column widths in ch (DESIGN.md 4.9: fixed, one flexible label column). */
/** Sortable headers reserve 2ch for their arrow, so "Bought USD" and "Closed" never truncate. */
const W = { bought: 12, sold: 11, holding: 18, mc: 10, pnl: 19, sell: 16, share: 3, held: 6, closed: 8 } as const;

/** Entry or exit market cap: live supply when the token is in the live set, else the MC recorded with the fills. */
function FillMc({ mint, priceSol, fallbackUsd }: { mint: string; priceSol: number | null; fallbackUsd: number | null }) {
  const supply = useMarket((s) => s.tokens[mint]?.supply ?? null);
  const sol = priceSol !== null && priceSol > 0 && supply !== null && supply > 0 ? priceSol * supply : null;
  return <MarketCap sol={sol} usd={fallbackUsd} unit={false} />;
}

/**
 * Sell 25 / 50 / 100 (DESIGN.md 4.9): sell-tint xs buttons. No confirmation for market trades
 * within caps (1.7); the toast carries progress, so no spinner; the pressed state holds for
 * 300 ms after release (6.2). The repeat guard in tradeActions drops a double click.
 */
function SellButtons({ position, wallet, tabbable }: { position: Position; wallet: string | null | undefined; tabbable: boolean }) {
  const [pressed, setPressed] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <span className="inline-flex items-center gap-1">
      {SELL_PCTS.map((pct) => (
        <Tooltip key={pct} content={`Sell ${pct}% of ${position.symbol}`}>
          <Button
            variant="sell-tint"
            size="xs"
            tabIndex={tabbable ? 0 : -1}
            aria-label={`Sell ${pct}% of ${position.symbol}`}
            data-pressed={pressed === pct || undefined}
            className="data-pressed:bg-sell-tint-press"
            onClick={(e) => {
              e.stopPropagation();
              setPressed(pct);
              if (timer.current) clearTimeout(timer.current);
              timer.current = setTimeout(() => setPressed(null), 300);
              void sell({ mint: position.mint, pct, source: "portfolio", wallets: wallet ? [wallet] : undefined });
            }}
          >
            {pct}%
          </Button>
        </Tooltip>
      ))}
    </span>
  );
}

interface RowProps {
  position: Position;
  index: number;
  measure: (el: Element | null) => void;
  rowRef: (el: HTMLElement | null) => void;
  cursor: boolean;
  focusWithin: boolean;
  highlighted: boolean;
  compact: boolean;
  history: boolean;
  ownWallet: boolean;
  wallet: string | null | undefined;
  quote: Currency | undefined;
  fills: FillMarketCaps | undefined;
  onShare?: (position: Position) => void;
  onPick: (index: number) => void;
}

const PositionRow = memo(function PositionRow({
  position: p,
  index,
  measure,
  rowRef,
  cursor,
  focusWithin,
  highlighted,
  compact,
  history,
  ownWallet,
  wallet,
  quote,
  fills,
  onShare,
  onPick,
}: RowProps) {
  const pnl = positionPnl(p);
  const pnlPct = p.boughtSol > 0 ? (pnl / p.boughtSol) * 100 : null;
  const holding = !p.closed && p.holdingTokens > 0;
  const tabbable = cursor;
  return (
    <tr
      data-index={index}
      data-row-index={index}
      ref={(el) => {
        measure(el);
        rowRef(el);
      }}
      tabIndex={cursor ? 0 : -1}
      aria-selected={highlighted || undefined}
      onClick={() => onPick(index)}
      className={cn(rowClass({ cursor: cursor && focusWithin, selected: highlighted }), compact ? "h-row" : "h-[calc(var(--zf-row)+4px)]")}
    >
      <td className={cn(TD, "relative")}>
        <CursorBar on={cursor && focusWithin} />
        <Link
          to={`/t/${p.mint}`}
          tabIndex={tabbable ? 0 : -1}
          onClick={(e) => e.stopPropagation()}
          className="group flex min-w-0 items-center gap-2"
          title={`${p.name} (${p.symbol})`}
        >
          <TokenAvatar mint={p.mint} symbol={p.symbol} imageUri={p.imageUri} size="xs" badge={false} />
          <span className="truncate font-medium text-fg-1 group-hover:underline">{p.symbol}</span>
          <LaunchpadMark launchpad={p.launchpad} />
          {!compact && <span className="min-w-0 truncate text-fg-3">{p.name}</span>}
        </Link>
      </td>
      <td
        className={cn(TD, "text-right")}
        title={`${fmtTokens(p.boughtTokens)} tokens at an average ${fmtSolPrice(p.avgEntryPriceSol)} SOL`}
      >
        <Money sol={p.boughtSol} unit={false} quote={quote} />
      </td>
      <td className={cn(TD, "text-right")}>
        {/* Nothing sold yet: an empty cell, not a column of dashes (Axiom omits it the same way). */}
        {p.soldSol > 0 && <Money sol={p.soldSol} unit={false} quote={quote} />}
      </td>
      {!history && (
        <td className={cn(TD, "text-right")} title={holding ? `${fmtTokens(p.holdingTokens)} tokens held` : undefined}>
          {holding ? (
            <>
              <Num value={p.holdingTokens} kind="tokens" className="text-fg-3" /> <Money sol={p.valueSol} unit={false} quote={quote} />
            </>
          ) : null}
        </td>
      )}
      <td className={cn(TD, "text-right")}>
        <FillMc mint={p.mint} priceSol={p.avgEntryPriceSol} fallbackUsd={fills?.entryUsd ?? null} />
      </td>
      {history && (
        <td className={cn(TD, "text-right")}>
          <FillMc mint={p.mint} priceSol={p.avgExitPriceSol} fallbackUsd={fills?.exitUsd ?? null} />
        </td>
      )}
      <td className={cn(TD, "text-right")}>
        <Money sol={pnl} signed unit={false} quote={quote} /> <Num value={pnlPct} kind="pct" signed className="text-label" />
      </td>
      {history && (
        <td className={cn(TD, "text-right text-fg-2")}>
          <span className="zf-num">{fmtAge(p.openedAt, p.lastTradeAt)}</span>
        </td>
      )}
      {history && (
        <td className={cn(TD, "text-right")}>
          <Age ts={p.lastTradeAt} />
        </td>
      )}
      {ownWallet && !history && (
        <td className={cn(TD, "text-right")}>{holding && <SellButtons position={p} wallet={wallet} tabbable={tabbable} />}</td>
      )}
      {ownWallet && onShare && (
        <td className={cn(TD, "text-center")}>
          <Tooltip content={`Share ${p.symbol} PnL card`}>
            <IconButton
              size="xs"
              label={`Share ${p.symbol} PnL card`}
              title=""
              tabIndex={tabbable ? 0 : -1}
              onClick={(e) => {
                e.stopPropagation();
                onShare(p);
              }}
            >
              <Share2 />
            </IconButton>
          </Tooltip>
        </td>
      )}
    </tr>
  );
});

/*
 * Positions grid (DESIGN.md 4.9 "Positions", 5.3): Token (avatar 20, ticker, name) · Bought ·
 * Sold · Holding (tokens + value) · Avg entry (MC) · PnL (absolute + %) · Sell 25 / 50 / 100 ·
 * Share. 28/32 px rows on the Portfolio (the 5.3 blueprint), 24/28 px on the token page, 1 px
 * hairline dividers, sticky 28/32 px header, units in the header, values in the global quote.
 * Two-line value cells and PnL with % after OKX assets: https://mobbin.com/screens/da509525-ceef-4935-aa96-01a2f52521a6
 * Held-value table after OpenSea's profile tokens: https://mobbin.com/screens/4e4e5077-88bf-4446-8b3e-ce60f63498c0
 */
export function PositionsTable({
  positions,
  currency,
  highlightMint,
  compact = false,
  ownWallet,
  wallet,
  variant = "active",
  activity,
  onShare,
  loading = false,
  empty,
  className,
}: PositionsTableProps) {
  const navigate = useNavigate();
  const history = variant === "history";
  const q = useQuote();
  const unit = currency ?? q.quote;
  const [sort, setSort] = useState<{ key: SortKey | null; dir: SortDir }>({ key: null, dir: "desc" });
  const [focusWithin, setFocusWithin] = useState(false);

  const onSort = useCallback((key: SortKey) => {
    setSort((s) => {
      const first: SortDir = key === "token" ? "asc" : "desc";
      if (s.key !== key) return { key, dir: first };
      // Third click returns to the default order (most recently traded first).
      return s.dir === first ? { key, dir: first === "asc" ? "desc" : "asc" } : { key: null, dir: "desc" };
    });
  }, []);

  const sorted = useMemo(() => {
    const list = [...positions];
    const { key, dir } = sort;
    if (key === null) return list.sort((a, b) => b.lastTradeAt - a.lastTradeAt);
    const value = SORT_VALUE[key];
    const sign = dir === "asc" ? 1 : -1;
    return list.sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      const cmp = typeof va === "string" && typeof vb === "string" ? va.localeCompare(vb) : Number(va) - Number(vb);
      return cmp * sign || b.lastTradeAt - a.lastTradeAt;
    });
  }, [positions, sort]);

  const fills = useMemo(() => (activity ? fillMarketCaps(activity) : null), [activity]);
  const rowPx = useCssPx("--zf-row", 24) + (compact ? 0 : 4);
  const headerPx = useCssPx("--zf-header-row", 28);
  const list = useLongList(sorted, (p) => p.mint, rowPx, headerPx);
  const cursor = useRowCursor(sorted.length, {
    onOpen: (i) => {
      const p = sorted[i];
      if (p) navigate(`/t/${p.mint}`);
    },
    scrollToIndex: list.scrollToIndex,
  });

  const sortProps = (key: SortKey) => ({ sorted: sort.key === key ? sort.dir : null, onSort: () => onSort(key) });
  const showSell = ownWallet && !history;
  const showShare = ownWallet && !!onShare;
  const cols: number[] = [W.bought, W.sold, ...(history ? [W.mc, W.mc, W.pnl, W.held, W.closed] : [W.holding, W.mc, W.pnl])];
  if (showSell) cols.push(W.sell);
  if (showShare) cols.push(W.share);
  const minWidth = `calc(${cols.reduce((a, b) => a + b, 0) + 16}ch + ${(cols.length + 1) * 16}px)`;
  const cellCount = cols.length + 1;

  return (
    <div ref={list.scrollRef} className={cn("min-h-0 overflow-auto", className)}>
      <table
        className={TABLE}
        style={{ minWidth }}
        aria-label={history ? "Closed positions" : "Open positions"}
        aria-busy={loading || undefined}
      >
        <colgroup>
          <col />
          <col style={colW(W.bought)} />
          <col style={colW(W.sold)} />
          {!history && <col style={colW(W.holding)} />}
          <col style={colW(W.mc)} />
          {history && <col style={colW(W.mc)} />}
          <col style={colW(W.pnl)} />
          {history && <col style={colW(W.held)} />}
          {history && <col style={colW(W.closed)} />}
          {showSell && <col style={colW(W.sell)} />}
          {showShare && <col style={colW(W.share)} />}
        </colgroup>
        <thead>
          <tr>
            <Th {...sortProps("token")}>Token</Th>
            <Th align="right" {...sortProps("bought")}>{`Bought ${unit}`}</Th>
            <Th align="right" {...sortProps("sold")}>{`Sold ${unit}`}</Th>
            {!history && (
              <Th align="right" {...sortProps("value")}>
                {`Holding ${unit}`}
              </Th>
            )}
            <Th align="right" title="Average market cap at your buys">
              Avg entry MC
            </Th>
            {history && (
              <Th align="right" title="Average market cap at your sells">
                Avg exit MC
              </Th>
            )}
            <Th align="right" {...sortProps("pnl")}>{`PnL ${unit}`}</Th>
            {history && <Th align="right">Held</Th>}
            {history && (
              <Th align="right" {...sortProps("closed")}>
                Closed
              </Th>
            )}
            {showSell && <Th align="right">Sell</Th>}
            {showShare && (
              <Th align="center">
                <span className="sr-only">Share</span>
              </Th>
            )}
          </tr>
        </thead>
        <tbody
          onKeyDown={cursor.onKeyDown}
          onFocus={() => setFocusWithin(true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false);
          }}
        >
          {loading ? (
            <SkeletonRows
              rows={6}
              cells={["avatar", ...cols.map((_, i) => (showShare && i === cols.length - 1 ? ("none" as const) : ("num" as const)))]}
              rowClassName={compact ? "h-row" : "h-[calc(var(--zf-row)+4px)]"}
            />
          ) : (
            <>
              {list.padTop > 0 && (
                <tr style={{ height: list.padTop }}>
                  <td colSpan={cellCount} />
                </tr>
              )}
              {list.rows.map(({ item, index }) => (
                <PositionRow
                  key={item.mint}
                  position={item}
                  index={index}
                  measure={list.measure}
                  rowRef={cursor.rowRef(index)}
                  cursor={index === cursor.cursor}
                  focusWithin={focusWithin}
                  highlighted={item.mint === highlightMint}
                  compact={compact}
                  history={history}
                  ownWallet={ownWallet}
                  wallet={wallet}
                  quote={currency}
                  fills={fills?.get(item.mint)}
                  onShare={onShare}
                  onPick={cursor.setCursor}
                />
              ))}
              {list.padBottom > 0 && (
                <tr style={{ height: list.padBottom }}>
                  <td colSpan={cellCount} />
                </tr>
              )}
            </>
          )}
        </tbody>
      </table>
      {!loading && positions.length === 0 && empty}
    </div>
  );
}

/*
 * Mobile positions (DESIGN.md 5.8): 56 px rows, token on the left, value and signed PnL stacked
 * on the right; the whole row (44 px+ target) opens the token page, which has the sticky trade
 * bar. Two-line rows after Phantom's token list: https://mobbin.com/screens/d8231b54-856d-4f6a-95f8-06035dd7505a
 */
export function PositionsList({
  positions,
  variant = "active",
  empty,
}: {
  positions: Position[];
  variant?: "active" | "history";
  empty?: ReactNode;
}) {
  const [limit, setLimit] = useState(50);
  const sorted = useMemo(() => [...positions].sort((a, b) => b.lastTradeAt - a.lastTradeAt), [positions]);
  if (sorted.length === 0) return <>{empty}</>;
  const history = variant === "history";
  return (
    <>
      <ul aria-label={history ? "Closed positions" : "Open positions"}>
        {sorted.slice(0, limit).map((p) => {
          const pnl = positionPnl(p);
          const pct = p.boughtSol > 0 ? (pnl / p.boughtSol) * 100 : null;
          return (
            <li key={p.mint} className="border-b border-hairline">
              <Link to={`/t/${p.mint}`} className="flex h-14 items-center gap-3 px-3 active:bg-surface-2">
                <TokenAvatar mint={p.mint} symbol={p.symbol} imageUri={p.imageUri} size="sm" badge={false} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body font-semibold text-fg-1">{p.symbol}</span>
                  <span className="block truncate text-label text-fg-3">
                    {history ? (
                      <>
                        Closed <Age ts={p.lastTradeAt} className="text-fg-3" /> ago
                      </>
                    ) : (
                      <>
                        <Num value={p.holdingTokens} kind="tokens" /> {p.name}
                      </>
                    )}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-body font-semibold text-fg-1">
                    {history ? <Money sol={pnl} signed /> : <Money sol={p.valueSol} />}
                  </span>
                  <span className="block text-label">
                    {history ? (
                      <Num value={pct} kind="pct" signed />
                    ) : (
                      <>
                        <Money sol={pnl} signed unit={false} /> <Num value={pct} kind="pct" signed />
                      </>
                    )}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {sorted.length > limit && (
        <div className="p-3">
          <Button variant="secondary" size="lg" className="h-11 w-full" onClick={() => setLimit((n) => n + 50)}>
            Show {Math.min(50, sorted.length - limit)} more positions
          </Button>
        </div>
      )}
    </>
  );
}
