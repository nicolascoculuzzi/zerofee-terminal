import { Check, Share2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Button, IconButton } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/bits";
import { TokenAvatar } from "../../components/ui/TokenAvatar";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { DASH, fmtPnlPct, fmtTokens, signClass } from "../../lib/format";
import { sell } from "../../lib/tradeActions";
import type { Position } from "../../protocol";
import { useMarket } from "../../state/market";
import { useToken } from "../../state/token";
import { useActiveStatus } from "../../state/wallet";
import { fmtMoney, Money, quoteUnit, toQuote, useQuote } from "./money";
import { type Col, ch, DataTable, flex } from "./table";

/*
 * Positions tab (DESIGN.md 4.9 "Positions"): token · bought · sold · holding (tokens + value) ·
 * average entry as MC · PnL (absolute + %) · Sell 25 / 50 / 100 as sell-tint xs buttons and share.
 * Open positions of the active wallet, this token first and selected. Two-line value cells after
 * OKX https://mobbin.com/screens/da509525-ceef-4935-aa96-01a2f52521a6
 */

type Key = "token" | "bought" | "sold" | "holding" | "entry" | "pnl" | "actions";

function cols(quote: "USD" | "SOL"): Col<Key>[] {
  const u = quoteUnit(quote);
  return [
    { key: "token", label: "Token", width: flex(14) },
    { key: "bought", label: `Bought ${u}`, width: ch(9), align: "right" },
    { key: "sold", label: `Sold ${u}`, width: ch(9), align: "right" },
    { key: "holding", label: "Holding", width: ch(15), align: "right" },
    { key: "entry", label: "Avg entry MC", width: ch(9), align: "right" },
    { key: "pnl", label: `PnL ${u}`, width: ch(16), align: "right" },
    { key: "actions", label: "", width: ch(25), align: "right" },
  ];
}

function useSupply(mint: string): number | null {
  const fromMarket = useMarket((s) => s.tokens[mint]?.supply);
  const fromDetail = useToken((s) => (s.detail?.summary.mint === mint ? s.detail.summary.supply : undefined));
  return fromDetail ?? fromMarket ?? null;
}

function ShareButton({ p }: { p: Position }) {
  const { quote, solUsd } = useQuote();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1200);
    return () => clearTimeout(t);
  }, [done]);
  const pnl = p.realizedPnlSol + p.unrealizedPnlSol;
  return (
    <IconButton
      size="xs"
      label={done ? "Copied" : `Copy ${p.symbol} PnL summary`}
      onClick={() => {
        const v = toQuote(quote, solUsd, { sol: pnl });
        const text = `${p.symbol} PnL ${fmtMoney(quote, v, "signed")}${quote === "SOL" ? " SOL" : ""} (${fmtPnlPct(pnl, p.boughtSol)}) · zerofee, 0% platform fee`;
        void copyText(text).then((ok) => setDone(ok));
      }}
    >
      {done ? <Check /> : <Share2 />}
    </IconButton>
  );
}

/** Average entry as market cap: needs the token's supply, known for tokens in the live set. */
function EntryMc({ p }: { p: Position }) {
  const supply = useSupply(p.mint);
  return supply && p.avgEntryPriceSol > 0 ? (
    <Money sol={p.avgEntryPriceSol * supply} className="text-fg-2" />
  ) : (
    <span className="text-fg-4">{DASH}</span>
  );
}

function positionCell(p: Position, key: Key): ReactNode {
  const pnl = p.realizedPnlSol + p.unrealizedPnlSol;
  switch (key) {
    case "token":
      return (
        <Link to={`/t/${p.mint}`} className="group flex min-w-0 items-center gap-2" title={`${p.name} (${p.symbol})`}>
          <TokenAvatar mint={p.mint} symbol={p.symbol} imageUri={p.imageUri} size="xs" />
          <span className="max-w-[10ch] truncate font-medium text-fg-1 group-hover:underline">{p.symbol}</span>
          <span className="truncate text-fg-3">{p.name}</span>
        </Link>
      );
    case "bought":
      return <Money sol={p.boughtSol} kind="exact" />;
    case "sold":
      return p.soldSol > 0 ? <Money sol={p.soldSol} kind="exact" /> : <span className="zf-num text-fg-4">0</span>;
    case "holding":
      return (
        <span className="flex items-baseline gap-1">
          <span className="zf-num text-fg-3">{fmtTokens(p.holdingTokens)}</span>
          <Money sol={p.valueSol} kind="exact" />
        </span>
      );
    case "entry":
      return <EntryMc p={p} />;
    case "pnl":
      return (
        <span className="flex items-baseline gap-1">
          <Money sol={pnl} kind="signed" />
          <span className={cn("zf-num text-label", signClass(p.boughtSol > 0 ? pnl : null))}>{fmtPnlPct(pnl, p.boughtSol)}</span>
        </span>
      );
    case "actions":
      return (
        <span className="flex items-center gap-1">
          <span className="mr-0.5 text-label text-fg-3">Sell</span>
          {[25, 50, 100].map((pct) => (
            <Button
              key={pct}
              variant="sell-tint"
              size="xs"
              className="zf-num min-w-10 justify-center"
              aria-label={`Sell ${pct}% of ${p.symbol}`}
              onClick={() => void sell({ mint: p.mint, pct, source: "token" })}
            >
              {pct}%
            </Button>
          ))}
          <ShareButton p={p} />
        </span>
      );
  }
}

export function TokenPositions({ mint }: { mint: string }) {
  const status = useActiveStatus();
  const { quote } = useQuote();
  const columns = useMemo(() => cols(quote), [quote]);
  const open = useMemo(() => {
    const list = (status?.positions ?? []).filter((p) => !p.closed && p.holdingTokens > 0);
    return list.sort((a, b) => (a.mint === mint ? -1 : b.mint === mint ? 1 : b.lastTradeAt - a.lastTradeAt));
  }, [status, mint]);
  return (
    <div className="h-full overflow-auto">
      <DataTable
        label="Open positions"
        minWidth={820}
        cols={columns}
        rows={open}
        rowKey={(p) => p.mint}
        cell={(p, key) => positionCell(p, key)}
        rowClassName={(p) => p.mint === mint && "bg-surface-3"}
      />
      {/* Empty: one calm line under the real headers (DESIGN.md 4.18). */}
      {open.length === 0 && <EmptyState title="No open positions" body="Buy from the trade panel or Pulse, or press / to search." />}
    </div>
  );
}

/** Count for the tab label. */
export function useOpenPositionCount(): number {
  return useActiveStatus()?.positions.filter((p) => !p.closed && p.holdingTokens > 0).length ?? 0;
}
