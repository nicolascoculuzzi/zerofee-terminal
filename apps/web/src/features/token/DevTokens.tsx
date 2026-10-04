import { type ReactNode, useMemo } from "react";
import { Link } from "react-router";
import { useShallow } from "zustand/react/shallow";
import { Age } from "../../components/ui/Age";
import { EmptyState } from "../../components/ui/bits";
import { TokenAvatar } from "../../components/ui/TokenAvatar";
import { fmtCount, fmtProgress, shortAddr } from "../../lib/format";
import type { TokenDetail, TokenSummary } from "../../protocol";
import { useMarket } from "../../state/market";
import { Money, quoteUnit, useQuote } from "./money";
import { type Col, ch, DataTable, flex } from "./table";

/*
 * Dev tokens tab (DESIGN.md 5.2): the creator's other launches still in the live set, with the
 * lifetime counts from the feed. A data grid like Holders (24/28 px rows, hairline dividers).
 */

type Key = "token" | "age" | "mc" | "progress" | "holders" | "volume";

function cols(quote: "USD" | "SOL"): Col<Key>[] {
  const u = quoteUnit(quote);
  return [
    { key: "token", label: "Token", width: flex(16) },
    { key: "age", label: "Age", width: ch(5), align: "right" },
    { key: "mc", label: quote === "USD" ? "MC" : "MC SOL", width: ch(8), align: "right" },
    { key: "progress", label: "Bonding", width: ch(9), align: "right" },
    { key: "holders", label: "Holders", width: ch(7), align: "right" },
    { key: "volume", label: `Volume ${u}`, width: ch(9), align: "right" },
  ];
}

export function DevTokens({ detail }: { detail: TokenDetail }) {
  const token = detail.summary;
  const { quote } = useQuote();
  const columns = useMemo(() => cols(quote), [quote]);
  const others = useMarket(useShallow((s) => Object.values(s.tokens).filter((t) => t.creator === token.creator && t.mint !== token.mint)));
  const sorted = useMemo(() => [...others].sort((a, b) => b.createdAt - a.createdAt), [others]);
  const content = (t: TokenSummary, key: Key): ReactNode => {
    switch (key) {
      case "token":
        return (
          <Link to={`/t/${t.mint}`} className="group flex min-w-0 items-center gap-2">
            <TokenAvatar mint={t.mint} symbol={t.symbol} imageUri={t.imageUri} size="xs" />
            <span className="max-w-[10ch] truncate font-medium text-fg-1 group-hover:underline">{t.symbol}</span>
            <span className="truncate text-fg-3">{t.name}</span>
          </Link>
        );
      case "age":
        return <Age ts={t.createdAt} />;
      case "mc":
        return <Money usd={t.marketCapUsd} sol={t.marketCapSol} />;
      case "progress":
        return t.migratedAt !== null ? (
          <span className="text-fg-2">Migrated</span>
        ) : (
          <span className="zf-num text-fg-2">{fmtProgress(t.bondingProgress)}</span>
        );
      case "holders":
        return <span className="zf-num text-fg-2">{fmtCount(t.holders)}</span>;
      case "volume":
        return <Money usd={t.volumeUsd} className="text-fg-2" />;
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-hairline px-2 text-label text-fg-3">
        <span>
          Dev <span className="font-mono text-fg-2">{shortAddr(token.creator)}</span>
        </span>
        <span aria-hidden="true">·</span>
        <span>
          <span className="zf-num text-fg-1">{fmtCount(detail.devLaunches)}</span> earlier launch{detail.devLaunches === 1 ? "" : "es"}
        </span>
        <span aria-hidden="true">·</span>
        <span>
          <span className="zf-num text-fg-1">{fmtCount(detail.devMigrations)}</span> migrated
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <DataTable label="Dev tokens" minWidth={560} cols={columns} rows={sorted} rowKey={(t) => t.mint} cell={content} />
        {sorted.length === 0 && (
          <EmptyState
            title="No other launches in the live set"
            body={detail.devLaunches > 0 ? "Older launches by this dev have left the live feed." : "This is the dev's first launch."}
          />
        )}
      </div>
    </div>
  );
}
