import { ArrowDown, ArrowUp, ChartCandlestick } from "lucide-react";
import { memo, type ReactNode, useCallback, useMemo, useState } from "react";
import { Link } from "react-router";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/bits";
import { TokenAvatar } from "../../components/ui/TokenAvatar";
import { cn } from "../../lib/cn";
import { fmtPnlPct, fmtSignedSol, fmtSol, fmtSolPrice, fmtTokens, fmtUsd } from "../../lib/format";
import { sell } from "../../lib/tradeActions";
import type { Position } from "../../protocol";
import { type Currency, fmtSignedUsd, pnlTone, positionPnl, useLongList } from "./helpers";

export type { Currency } from "./helpers";

export interface PositionsTableProps {
  positions: Position[];
  solUsd: number;
  currency: Currency;
  /** Row to emphasise (the token page passes its own mint). */
  highlightMint?: string;
  /** Dense rows, no token names, narrower minimum width. */
  compact?: boolean;
  /** Show the Sell 100% action (only for the active trading wallet). */
  ownWallet: boolean;
}

type SortKey = "token" | "bought" | "sold" | "remaining" | "pnl";
type SortDir = "asc" | "desc";
interface SortState {
  key: SortKey | null;
  dir: SortDir;
}

const SORT_VALUE: Record<SortKey, (p: Position) => number | string> = {
  token: (p) => p.symbol.toLowerCase(),
  bought: (p) => p.boughtSol,
  sold: (p) => p.soldSol,
  remaining: (p) => p.valueSol,
  pnl: positionPnl,
};

function money(sol: number, currency: Currency, solUsd: number): string {
  return currency === "USD" ? fmtUsd(sol * solUsd) : fmtSol(sol);
}

function signedMoney(sol: number, currency: Currency, solUsd: number): string {
  return currency === "USD" ? fmtSignedUsd(sol * solUsd) : fmtSignedSol(sol);
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  align,
}: {
  label: string;
  sortKey: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
  align: "left" | "right";
}) {
  const active = sort.key === sortKey;
  let arrow: ReactNode = null;
  if (active) arrow = sort.dir === "asc" ? <ArrowUp className="icon-xs" /> : <ArrowDown className="icon-xs" />;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      className={cn("px-2 font-medium", align === "right" ? "text-right" : "text-left")}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn("inline-flex items-center gap-1 hover:text-fg-1", active && "text-fg-1")}
      >
        {align === "right" && arrow}
        {label}
        {align === "left" && arrow}
      </button>
    </th>
  );
}

interface RowProps {
  position: Position;
  index: number;
  measure: (el: Element | null) => void;
  solUsd: number;
  currency: Currency;
  highlighted: boolean;
  compact: boolean;
  ownWallet: boolean;
}

const PositionRow = memo(function PositionRow({
  position: p,
  index,
  measure,
  solUsd,
  currency,
  highlighted,
  compact,
  ownWallet,
}: RowProps) {
  const [selling, setSelling] = useState(false);
  const pnl = positionPnl(p);
  const tone = pnlTone(pnl);
  const holding = !p.closed && p.holdingTokens > 0;
  const onSell = () => {
    setSelling(true);
    void sell({ mint: p.mint, pct: 100, source: "portfolio" }).finally(() => setSelling(false));
  };
  return (
    <tr
      data-index={index}
      ref={measure}
      className={cn(
        "border-b border-hairline last:border-b-0",
        compact ? "h-row-dense" : "h-row",
        highlighted ? "bg-surface-3" : "hover:bg-surface-2",
      )}
    >
      <td className="px-2">
        <Link to={`/t/${p.mint}`} className="group flex min-w-0 items-center gap-2" title={`${p.name} (${p.symbol})`}>
          <TokenAvatar mint={p.mint} symbol={p.symbol} imageUri={p.imageUri} size="xs" />
          <span className="truncate font-medium text-fg-1 group-hover:underline">{p.symbol}</span>
          {!compact && <span className="hidden truncate text-fg-3 sm:inline">{p.name}</span>}
        </Link>
      </td>
      <td className="px-2 text-right" title={`${fmtTokens(p.boughtTokens)} tokens, avg entry ${fmtSolPrice(p.avgEntryPriceSol)} SOL`}>
        {money(p.boughtSol, currency, solUsd)}
      </td>
      <td
        className="px-2 text-right"
        title={
          p.avgExitPriceSol === null
            ? "Nothing sold yet"
            : `${fmtTokens(p.soldTokens)} tokens, avg exit ${fmtSolPrice(p.avgExitPriceSol)} SOL`
        }
      >
        {p.soldSol > 0 ? money(p.soldSol, currency, solUsd) : <span className="text-fg-3">—</span>}
      </td>
      <td
        className="px-2 text-right"
        title={holding ? `${fmtTokens(p.holdingTokens)} tokens held, cost basis ${fmtSol(p.costBasisSol)} SOL` : undefined}
      >
        {holding ? (
          <>
            {!compact && <span className="mr-1 text-fg-3">{fmtTokens(p.holdingTokens)}</span>}
            {money(p.valueSol, currency, solUsd)}
          </>
        ) : (
          <span className="text-fg-3">—</span>
        )}
      </td>
      <td className={cn("px-2 text-right", tone)}>
        {signedMoney(pnl, currency, solUsd)} <span className="text-micro">({fmtPnlPct(pnl, p.boughtSol)})</span>
      </td>
      {ownWallet && (
        <td className="px-2">
          <div className="flex items-center justify-end gap-1">
            {holding && (
              <Button variant="sell" size="xs" disabled={selling} onClick={onSell} aria-label={`Sell 100% of ${p.symbol}`}>
                {selling ? "Selling…" : "Sell 100%"}
              </Button>
            )}
            <Link
              to={`/t/${p.mint}`}
              aria-label={`Open ${p.symbol}`}
              title={`Open ${p.symbol}`}
              className="inline-flex size-5 items-center justify-center rounded-xs text-fg-2 hover:bg-surface-3 hover:text-fg-1"
            >
              <ChartCandlestick className="icon-sm" />
            </Link>
          </div>
        </td>
      )}
    </tr>
  );
});

/*
 * Positions table. Anatomy follows Binance's "My Assets" table (asset cell left, right-aligned
 * numeric columns, sortable headers) https://mobbin.com/screens/5acd0f5e-9019-4e1f-95e1-1446bbccd036
 * and Kraken Pro's balances table (small uppercase headers on a hairline)
 * https://mobbin.com/screens/fe204312-8607-4018-b0dd-a36dc71f4978
 *
 * Renders whatever positions it is given (the caller picks active/history and dust); sorting
 * is local. Reused by the token page for a single token.
 */
export function PositionsTable({ positions, solUsd, currency, highlightMint, compact = false, ownWallet }: PositionsTableProps) {
  const [sort, setSort] = useState<SortState>({ key: null, dir: "desc" });

  const onSort = useCallback((key: SortKey) => {
    setSort((s) => {
      if (s.key !== key) return { key, dir: key === "token" ? "asc" : "desc" };
      const first: SortDir = key === "token" ? "asc" : "desc";
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

  const list = useLongList(sorted, (p) => p.mint, compact ? 24 : 28);

  if (positions.length === 0) return <EmptyState title="No positions." />;

  const unit = currency === "USD" ? "USD" : "SOL";
  const header = (label: string, key: SortKey, align: "left" | "right" = "right"): ReactNode => (
    <SortHeader label={label} sortKey={key} sort={sort} onSort={onSort} align={align} />
  );

  return (
    <div ref={list.scrollRef} className={cn("overflow-x-auto", list.virtual && "max-h-120 overflow-y-auto")}>
      <table className={cn("w-full table-fixed border-collapse text-label", compact ? "min-w-148" : "min-w-176")}>
        <colgroup>
          <col />
          <col className={compact ? "w-20" : "w-24"} />
          <col className={compact ? "w-20" : "w-24"} />
          <col className={compact ? "w-24" : "w-32"} />
          <col className={compact ? "w-32" : "w-36"} />
          {ownWallet && <col className="w-28" />}
        </colgroup>
        <thead className={cn("text-micro text-fg-3", list.virtual && "sticky top-0 z-10 bg-surface-1")}>
          <tr className="h-row border-b border-hairline">
            {header("Token", "token", "left")}
            {header(`Bought (${unit})`, "bought")}
            {header(`Sold (${unit})`, "sold")}
            {header(`Remaining (${unit})`, "remaining")}
            {header(`PnL (${unit})`, "pnl")}
            {ownWallet && (
              <th scope="col" className="px-2 text-right font-medium">
                Actions
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {list.padTop > 0 && <tr style={{ height: list.padTop }} />}
          {list.rows.map(({ item, index }) => (
            <PositionRow
              key={item.mint}
              position={item}
              index={index}
              measure={list.measure}
              solUsd={solUsd}
              currency={currency}
              highlighted={item.mint === highlightMint}
              compact={compact}
              ownWallet={ownWallet}
            />
          ))}
          {list.padBottom > 0 && <tr style={{ height: list.padBottom }} />}
        </tbody>
      </table>
    </div>
  );
}
