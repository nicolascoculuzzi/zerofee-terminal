import { memo, useMemo } from "react";
import { Link } from "react-router";
import { Age } from "../../components/ui/Age";
import { Segmented } from "../../components/ui/controls";
import { TokenAvatar } from "../../components/ui/TokenAvatar";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import { fmtSignedSol, fmtUsd, shortAddr } from "../../lib/format";
import type { TokenRef, TrackedTrade } from "../../protocol";
import { useSettings } from "../../state/settings";
import { type TrackedWallet, useTrackedMap, useTrackers } from "../../state/trackers";
import { PauseStatus } from "./bits";
import { tokenBlocker } from "./feedFilters";
import { useHoverPause, useRowHeight } from "./hooks";
import { type MonitorSort, useTrackerPrefs } from "./prefs";
import { QuickBuyButton } from "./QuickBuyButton";
import { WalletGlyph } from "./TradeRow";
import { VirtualList } from "./VirtualList";

interface Flow {
  token: TokenRef;
  /** Distinct tracked wallets that bought, most recent first. */
  buyers: string[];
  sellers: number;
  buys: number;
  sells: number;
  inSol: number;
  outSol: number;
  lastTs: number;
  lastMc: number;
}

/** Rolls the recent tracked-trade feed (newest first) up by token. */
function aggregate(live: TrackedTrade[], blocked: (mint: string) => boolean): Flow[] {
  const flows = new Map<string, Flow>();
  const buyerSets = new Map<string, Set<string>>();
  const sellerSets = new Map<string, Set<string>>();
  for (const { trade, token } of live) {
    if (blocked(token.mint)) continue;
    let flow = flows.get(token.mint);
    let buyers = buyerSets.get(token.mint);
    let sellers = sellerSets.get(token.mint);
    if (!flow || !buyers || !sellers) {
      flow = { token, buyers: [], sellers: 0, buys: 0, sells: 0, inSol: 0, outSol: 0, lastTs: trade.ts, lastMc: trade.marketCapUsd };
      buyers = new Set();
      sellers = new Set();
      flows.set(token.mint, flow);
      buyerSets.set(token.mint, buyers);
      sellerSets.set(token.mint, sellers);
    }
    if (trade.side === "buy") {
      flow.buys++;
      flow.inSol += trade.solAmount;
      if (!buyers.has(trade.maker)) {
        buyers.add(trade.maker);
        flow.buyers.push(trade.maker);
      }
    } else {
      flow.sells++;
      flow.outSol += trade.solAmount;
      sellers.add(trade.maker);
    }
  }
  for (const [mint, flow] of flows) flow.sellers = sellerSets.get(mint)?.size ?? 0;
  return [...flows.values()];
}

const SORTERS: Record<MonitorSort, (a: Flow, b: Flow) => number> = {
  wallets: (a, b) => b.buyers.length - a.buyers.length || b.lastTs - a.lastTs,
  net: (a, b) => b.inSol - b.outSol - (a.inSol - a.outSol) || b.lastTs - a.lastTs,
  recent: (a, b) => b.lastTs - a.lastTs,
};

const MonitorRow = memo(function MonitorRow({ flow, tracked }: { flow: Flow; tracked: Map<string, TrackedWallet> }) {
  const { token } = flow;
  const net = flow.inSol - flow.outSol;
  const names = flow.buyers.map((a) => tracked.get(a)?.name ?? shortAddr(a));
  return (
    <div className="relative flex h-7 items-center gap-2 px-3 text-xs hover:bg-hover">
      <Link to={`/t/${token.mint}`} className="absolute inset-0">
        <span className="sr-only">
          Open {token.symbol}: {flow.buyers.length} tracked wallets bought
        </span>
      </Link>
      <span className="flex min-w-0 flex-1 items-center gap-1">
        <TokenAvatar mint={token.mint} symbol={token.symbol} imageUri={token.imageUri} size="xs" />
        <span className="truncate font-medium text-fg">{token.symbol}</span>
        <Age ts={token.createdAt} className="hidden shrink-0 text-dim @sm:inline" />
      </span>
      <Tooltip
        content={names.length > 0 ? `Bought: ${names.slice(0, 12).join(", ")}${names.length > 12 ? "…" : ""}` : "No tracked buys"}
        wrapperClassName="w-12 shrink-0 justify-end @md:w-20"
      >
        <span className="relative flex items-center justify-end gap-1">
          <span className="hidden items-center gap-px @md:flex">
            {flow.buyers.slice(0, 3).map((a) => {
              const w = tracked.get(a);
              return <WalletGlyph key={a} emoji={w?.emoji} name={w?.name ?? a} />;
            })}
          </span>
          <span className="font-semibold text-fg">{flow.buyers.length}</span>
        </span>
      </Tooltip>
      <span className="hidden w-14 shrink-0 text-right @md:block">
        <span className="text-buy">{flow.buys}</span>
        <span className="text-dim">/</span>
        <span className="text-sell">{flow.sells}</span>
      </span>
      <span className={cn("w-16 shrink-0 text-right font-medium", net >= 0 ? "text-buy" : "text-sell")}>{fmtSignedSol(net)}</span>
      <span className="hidden w-14 shrink-0 text-right text-muted @lg:block">{fmtUsd(flow.lastMc)}</span>
      <Age ts={flow.lastTs} className="w-8 shrink-0 text-right text-dim" />
      <span className="flex w-14 shrink-0 justify-end">
        <QuickBuyButton mint={token.mint} symbol={token.symbol} source="tracker" />
      </span>
    </div>
  );
});

/*
 * Monitor: how many tracked wallets are in each coin, with net SOL flow. Anatomy follows Binance's
 * Smart Money signal cards ("4 Smart Money bought … within 15 mins"), flattened into table rows:
 * https://mobbin.com/screens/224a5744-3640-4889-96c6-c7ae16481a77
 */
export function Monitor() {
  const live = useTrackers((s) => s.live);
  const tracked = useTrackedMap();
  const sort = useTrackerPrefs((s) => s.monitorSort);
  const setSort = useTrackerPrefs((s) => s.setMonitorSort);
  const blacklists = useSettings((s) => s.blacklists);
  const flows = useMemo(() => aggregate(live, tokenBlocker(blacklists)).sort(SORTERS[sort]), [live, blacklists, sort]);
  const { shown, paused, bind } = useHoverPause(flows);
  const rowHeight = useRowHeight();

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-2">
        <Segmented<MonitorSort>
          value={sort}
          onChange={setSort}
          options={[
            { value: "wallets", label: "Wallets", title: "Most distinct tracked buyers" },
            { value: "net", label: "Net flow", title: "Largest net SOL bought by tracked wallets" },
            { value: "recent", label: "Recent", title: "Latest tracked activity" },
          ]}
          label="Sort tokens"
        />
        <span className="ml-auto">
          <PauseStatus
            paused={paused}
            pending={0}
            idle={`${flows.length.toLocaleString("en-US")} tokens · last ${live.length.toLocaleString("en-US")} trades`}
          />
        </span>
      </div>
      <div className="zf-label flex h-6 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="min-w-0 flex-1">Token</span>
        <span className="w-12 shrink-0 text-right @md:w-20" title="Distinct tracked wallets that bought">
          Wallets
        </span>
        <span className="hidden w-14 shrink-0 text-right @md:block">B/S</span>
        <span className="w-16 shrink-0 text-right" title="SOL bought minus SOL sold by tracked wallets">
          Net SOL
        </span>
        <span className="hidden w-14 shrink-0 text-right @lg:block">MC</span>
        <span className="w-8 shrink-0 text-right">Last</span>
        <span className="w-14 shrink-0" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col" {...bind}>
        {shown.length === 0 ? (
          <p className="px-3 py-4 text-sm text-dim">No tracked activity yet.</p>
        ) : (
          <VirtualList
            label="Tokens bought by tracked wallets"
            count={shown.length}
            rowHeight={rowHeight}
            getKey={(i) => shown[i]?.token.mint ?? i}
            renderRow={(i) => {
              const flow = shown[i];
              return flow ? <MonitorRow flow={flow} tracked={tracked} /> : null;
            }}
          />
        )}
      </div>
    </div>
  );
}
