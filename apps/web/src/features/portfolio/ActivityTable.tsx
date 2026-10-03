import { memo } from "react";
import { Link } from "react-router";
import { Age } from "../../components/ui/Age";
import { EmptyState, ExplorerLink } from "../../components/ui/bits";
import { cn } from "../../lib/cn";
import { fmtSol, fmtTokens, fmtUsd } from "../../lib/format";
import type { ActivityItem } from "../../protocol";
import { useLongList } from "./helpers";

const KIND: Record<ActivityItem["kind"], { label: string; className: string }> = {
  buy: { label: "Buy", className: "text-buy" },
  sell: { label: "Sell", className: "text-sell" },
  deposit: { label: "Deposit", className: "text-fg-1" },
  withdraw: { label: "Withdraw", className: "text-fg-1" },
};

const ActivityRow = memo(function ActivityRow({
  item,
  index,
  measure,
}: {
  item: ActivityItem;
  index: number;
  measure: (el: Element | null) => void;
}) {
  const kind = KIND[item.kind];
  const trade = item.kind === "buy" || item.kind === "sell";
  return (
    <tr data-index={index} ref={measure} className="h-row border-b border-hairline last:border-b-0 hover:bg-surface-2">
      <td className={cn("px-2 font-medium", kind.className)}>{kind.label}</td>
      <td className="truncate px-2">
        {item.mint ? (
          <Link to={`/t/${item.mint}`} className="font-medium text-fg-1 hover:underline">
            {item.symbol ?? "Token"}
          </Link>
        ) : (
          <span className="text-fg-2">SOL</span>
        )}
      </td>
      <td className="px-2 text-right">
        {trade && item.tokenAmount !== null && <span className="mr-1 text-fg-3">{fmtTokens(item.tokenAmount)}</span>}
        {fmtSol(item.solAmount)} SOL
      </td>
      <td className="px-2 text-right">{item.marketCapUsd === null ? <span className="text-fg-3">—</span> : fmtUsd(item.marketCapUsd)}</td>
      <td className="px-2 text-right text-fg-2" title={new Date(item.ts).toLocaleString()}>
        <Age ts={item.ts} />
      </td>
      <td className="px-2 text-right">
        <ExplorerLink signature={item.signature} />
      </td>
    </tr>
  );
});

/*
 * Wallet activity log. Anatomy follows Kraken's transactions list (type, asset, amount, time)
 * https://mobbin.com/screens/ae5f4277-3a6d-4572-945f-db2e008c7d1f with Coinbase Advanced's
 * dense uppercase table header https://mobbin.com/screens/e8bc99dd-2b98-4b12-95b3-5ca277255b09
 */
export function ActivityTable({ items }: { items: ActivityItem[] }) {
  const list = useLongList(items, (a) => a.id, 28);
  if (items.length === 0) return <EmptyState title="No activity yet." />;
  return (
    <div ref={list.scrollRef} className={cn("overflow-x-auto", list.virtual && "max-h-120 overflow-y-auto")}>
      <table className="w-full min-w-152 table-fixed border-collapse text-label">
        <colgroup>
          <col className="w-20" />
          <col />
          <col className="w-40" />
          <col className="w-24" />
          <col className="w-16" />
          <col className="w-16" />
        </colgroup>
        <thead className={cn("text-micro text-fg-3", list.virtual && "sticky top-0 z-10 bg-surface-1")}>
          <tr className="h-row border-b border-hairline">
            <th scope="col" className="px-2 text-left font-medium">
              Type
            </th>
            <th scope="col" className="px-2 text-left font-medium">
              Token
            </th>
            <th scope="col" className="px-2 text-right font-medium">
              Amount
            </th>
            <th scope="col" className="px-2 text-right font-medium">
              Market cap
            </th>
            <th scope="col" className="px-2 text-right font-medium">
              Age
            </th>
            <th scope="col" className="px-2 text-right font-medium">
              Explorer
            </th>
          </tr>
        </thead>
        <tbody>
          {list.padTop > 0 && <tr style={{ height: list.padTop }} />}
          {list.rows.map(({ item, index }) => (
            <ActivityRow key={item.id} item={item} index={index} measure={list.measure} />
          ))}
          {list.padBottom > 0 && <tr style={{ height: list.padBottom }} />}
        </tbody>
      </table>
    </div>
  );
}
