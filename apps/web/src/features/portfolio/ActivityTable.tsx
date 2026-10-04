import { ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import { memo, type ReactNode, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Age } from "../../components/ui/Age";
import { Button } from "../../components/ui/Button";
import { ExplorerLink } from "../../components/ui/bits";
import { Num } from "../../components/ui/Num";
import { TokenAvatar } from "../../components/ui/TokenAvatar";
import { cn } from "../../lib/cn";
import { useCssPx } from "../../lib/cssVar";
import { fmtClock, fmtDate } from "../../lib/format";
import type { ActivityItem } from "../../protocol";
import { useLongList } from "./helpers";
import { MarketCap, Money } from "./quote";
import { CursorBar, colW, rowClass, SkeletonRows, TABLE, TD, Th } from "./table";
import { useRowCursor } from "./useRowCursor";

const KIND: Record<ActivityItem["kind"], { label: string; className: string }> = {
  buy: { label: "Buy", className: "text-buy" },
  sell: { label: "Sell", className: "text-sell" },
  deposit: { label: "Deposit", className: "text-fg-2" },
  withdraw: { label: "Withdraw", className: "text-fg-2" },
};

/** Keeps the newest entry for each id (a delta can repeat an item that the snapshot carried). */
export function dedupeActivity(items: readonly ActivityItem[]): ActivityItem[] {
  const seen = new Set<string>();
  const out: ActivityItem[] = [];
  for (const a of items) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
  }
  return out;
}

function TokenCell({ item, tabbable }: { item: ActivityItem; tabbable: boolean }) {
  if (!item.mint) {
    const Icon = item.kind === "deposit" ? ArrowDownToLine : ArrowUpFromLine;
    return (
      <span className="flex items-center gap-2 text-fg-2">
        <span className="flex size-4 items-center justify-center rounded-xs bg-surface-3 text-fg-3">
          <Icon className="icon-xs" />
        </span>
        SOL
      </span>
    );
  }
  return (
    <Link
      to={`/t/${item.mint}`}
      tabIndex={tabbable ? 0 : -1}
      onClick={(e) => e.stopPropagation()}
      className="group flex min-w-0 items-center gap-2"
    >
      <TokenAvatar mint={item.mint} symbol={item.symbol ?? "?"} imageUri={null} size="2xs" badge={false} />
      <span className="truncate font-medium text-fg-1 group-hover:underline">{item.symbol ?? "Token"}</span>
    </Link>
  );
}

const ActivityRow = memo(function ActivityRow({
  item,
  index,
  measure,
  rowRef,
  cursor,
  focusWithin,
  onPick,
}: {
  item: ActivityItem;
  index: number;
  measure: (el: Element | null) => void;
  rowRef: (el: HTMLElement | null) => void;
  cursor: boolean;
  focusWithin: boolean;
  onPick: (index: number) => void;
}) {
  const kind = KIND[item.kind];
  const trade = item.kind === "buy" || item.kind === "sell";
  return (
    <tr
      data-index={index}
      data-row-index={index}
      ref={(el) => {
        measure(el);
        rowRef(el);
      }}
      tabIndex={cursor ? 0 : -1}
      onClick={() => onPick(index)}
      className={cn(rowClass({ cursor: cursor && focusWithin }), "h-row")}
    >
      <td className={cn(TD, "relative font-medium", kind.className)}>
        <CursorBar on={cursor && focusWithin} />
        {kind.label}
      </td>
      <td className={TD}>
        <TokenCell item={item} tabbable={cursor} />
      </td>
      <td className={cn(TD, "text-right")}>
        <Money sol={item.solAmount} unit={false} quote="SOL" />
      </td>
      <td className={cn(TD, "text-right text-fg-2")}>
        {trade && item.tokenAmount !== null ? <Num value={item.tokenAmount} kind="tokens" /> : <Num value={null} kind="tokens" />}
      </td>
      <td className={cn(TD, "text-right text-fg-2")}>
        <MarketCap usd={item.marketCapUsd} unit={false} />
      </td>
      <td className={cn(TD, "text-right")} title={`${fmtDate(item.ts)} ${fmtClock(item.ts)}`}>
        <Age ts={item.ts} />
      </td>
      <td className={cn(TD, "text-center")}>
        <ExplorerLink signature={item.signature} />
      </td>
    </tr>
  );
});

/*
 * Wallet activity (DESIGN.md 4.9 data grid): Type (side colour on the word) · Token · SOL ·
 * Tokens · MC at the fill · Age · Tx. 24/28 px rows with hairline dividers, virtualised past
 * 100 rows, ages on the shared clock. Type, asset, amount and time after Kraken's transactions
 * list: https://mobbin.com/screens/ae5f4277-3a6d-4572-945f-db2e008c7d1f
 * Side colour on the figure that matters, time right-aligned, after Binance market trades:
 * https://mobbin.com/screens/8d1b7823-6418-44c5-b3d5-ab69b3bfd6e3
 */
export function ActivityTable({
  items,
  loading = false,
  empty,
  className,
}: {
  items: ActivityItem[];
  loading?: boolean;
  empty?: ReactNode;
  className?: string;
}) {
  const navigate = useNavigate();
  const [focusWithin, setFocusWithin] = useState(false);
  const rowPx = useCssPx("--zf-row", 24);
  const headerPx = useCssPx("--zf-header-row", 28);
  const list = useLongList(items, (a) => a.id, rowPx, headerPx);
  const cursor = useRowCursor(items.length, {
    onOpen: (i) => {
      const a = items[i];
      if (a?.mint) navigate(`/t/${a.mint}`);
    },
    scrollToIndex: list.scrollToIndex,
  });
  // Fixed columns plus a 16ch floor for the flexible token column, each with 16 px of padding.
  const widths = [9, 9, 9, 8, 5, 3];
  const minWidth = `calc(${widths.reduce((a, b) => a + b, 0) + 16}ch + ${(widths.length + 1) * 16}px)`;
  return (
    <div ref={list.scrollRef} className={cn("min-h-0 overflow-auto", className)}>
      <table className={TABLE} style={{ minWidth }} aria-label="Wallet activity" aria-busy={loading || undefined}>
        <colgroup>
          <col style={colW(9)} />
          <col />
          <col style={colW(9)} />
          <col style={colW(9)} />
          <col style={colW(8)} />
          <col style={colW(5)} />
          <col style={colW(3)} />
        </colgroup>
        <thead>
          <tr>
            <Th>Type</Th>
            <Th>Token</Th>
            <Th align="right">Amount SOL</Th>
            <Th align="right">Tokens</Th>
            <Th align="right" title="Market cap when the transaction landed">
              MC
            </Th>
            <Th align="right">Age</Th>
            <Th align="center">Tx</Th>
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
            <SkeletonRows rows={8} cells={["text", "avatar", "num", "num", "num", "num", "none"]} rowClassName="h-row" />
          ) : (
            <>
              {list.padTop > 0 && (
                <tr style={{ height: list.padTop }}>
                  <td colSpan={7} />
                </tr>
              )}
              {list.rows.map(({ item, index }) => (
                <ActivityRow
                  key={item.id}
                  item={item}
                  index={index}
                  measure={list.measure}
                  rowRef={cursor.rowRef(index)}
                  cursor={index === cursor.cursor}
                  focusWithin={focusWithin}
                  onPick={cursor.setCursor}
                />
              ))}
              {list.padBottom > 0 && (
                <tr style={{ height: list.padBottom }}>
                  <td colSpan={7} />
                </tr>
              )}
            </>
          )}
        </tbody>
      </table>
      {!loading && items.length === 0 && empty}
    </div>
  );
}

/** Mobile activity: 56 px two-line rows, 50 at a time. */
export function ActivityList({ items, empty }: { items: ActivityItem[]; empty?: ReactNode }) {
  const [limit, setLimit] = useState(50);
  const shown = useMemo(() => items.slice(0, limit), [items, limit]);
  if (items.length === 0) return <>{empty}</>;
  return (
    <>
      <ul aria-label="Wallet activity">
        {shown.map((a) => {
          const kind = KIND[a.kind];
          const body = (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body font-semibold text-fg-1">
                  <span className={kind.className}>{kind.label}</span> {a.symbol ?? "SOL"}
                </span>
                <span className="block text-label text-fg-3">
                  <Age ts={a.ts} className="text-fg-3" /> ago
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-body font-semibold text-fg-1">
                  <Money sol={a.solAmount} quote="SOL" />
                </span>
                <span className="block text-label text-fg-3">{a.tokenAmount !== null && <Num value={a.tokenAmount} kind="tokens" />}</span>
              </span>
            </>
          );
          return (
            <li key={a.id} className="border-b border-hairline">
              {a.mint ? (
                <Link to={`/t/${a.mint}`} className="flex h-14 items-center gap-3 px-3 active:bg-surface-2">
                  {body}
                </Link>
              ) : (
                <div className="flex h-14 items-center gap-3 px-3">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
      {items.length > limit && (
        <div className="p-3">
          <Button variant="secondary" size="lg" className="h-11 w-full" onClick={() => setLimit((n) => n + 50)}>
            Show {Math.min(50, items.length - limit)} more transactions
          </Button>
        </div>
      )}
    </>
  );
}
