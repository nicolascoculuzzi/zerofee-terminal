import { Star } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { Age } from "../../components/ui/Age";
import { IconButton } from "../../components/ui/Button";
import { EmptyState, MetricLabel, Tag } from "../../components/ui/bits";
import { CopyButton, Segmented } from "../../components/ui/controls";
import { WalletAvatar } from "../../components/ui/TokenAvatar";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import { DASH, fmtCount, fmtPct, fmtRiskPct, fmtSignedSol, fmtSol, fmtTokens, shortAddr } from "../../lib/format";
import { bandsText, type RiskKey, riskTone, TONE_TEXT } from "../../lib/metrics";
import type { Holder, TokenSummary, TopTrader, WalletTag } from "../../protocol";
import { useSettings } from "../../state/settings";
import { type TrackedWallet, useTrackedMap, useTrackers } from "../../state/trackers";
import { Money, quoteUnit, useQuote } from "./money";
import { type Col, ch, DataTable, flex, NewRowsBar, nextSort, type SortState, useLiveOrder, usePauseOnHover } from "./table";
import { useTokenUi } from "./tokenUi";

/*
 * Holders and Top traders (DESIGN.md 4.9): data grids with 24/28 px rows and hairline dividers,
 * fixed ch widths, signed colour only on PnL. Holders gets the 28 px summary strip with values in
 * their risk-band colours and the All | Insiders | Snipers | Bundlers | Tracked filter. Live
 * order freezes on hover and re-sorts at most every 2 s (6.7). Holder-type tabs and signed change
 * colouring after Perplexity https://mobbin.com/screens/d265c7a4-c61e-46bc-b525-beb10db72df8;
 * two-line value cells after OKX https://mobbin.com/screens/da509525-ceef-4935-aa96-01a2f52521a6
 */

const ROW_TAGS: WalletTag[] = ["you", "dev", "sniper", "insider", "bundler", "kol", "whale", "pro"];

type HolderFilter = "all" | "insider" | "sniper" | "bundler" | "tracked";

function useTrackToggle(address: string): { tracked: boolean; toggle: () => void } {
  const tracked = useTrackers((s) => s.wallets.some((w) => w.address === address));
  const add = useTrackers((s) => s.addWallet);
  const remove = useTrackers((s) => s.removeWallet);
  return {
    tracked,
    toggle: () => (tracked ? remove(address) : add({ address, name: shortAddr(address), emoji: "", alerts: false })),
  };
}

function WalletCell({ address, tags, tracked }: { address: string; tags: WalletTag[]; tracked: TrackedWallet | undefined }) {
  const setMaker = useTokenUi((s) => s.setMaker);
  const setTab = useTokenUi((s) => s.setTab);
  const system = tags.includes("curve") || tags.includes("pool");
  if (system) {
    return (
      <span className="flex min-w-0 items-center gap-1">
        <span className="truncate text-fg-2">{tags.includes("curve") ? "Bonding curve" : "Liquidity pool"}</span>
        <Tag tag={tags.includes("curve") ? "curve" : "pool"} />
      </span>
    );
  }
  const label = tracked?.name ?? null;
  return (
    <span className="flex min-w-0 items-center gap-1">
      <WalletAvatar seed={address} label={label ?? address} tag={tracked?.emoji} size={16} />
      <Tooltip content={<span className="font-mono break-all">{address}</span>}>
        <button
          type="button"
          onClick={() => {
            setMaker(address);
            setTab("trades");
          }}
          aria-label={`Show trades by ${label ?? address}`}
          className={cn(
            "focus-inset min-w-0 truncate rounded-xs transition-colors hover:text-fg-1",
            label ? "max-w-[16ch] text-fg-1" : "font-mono text-fg-2",
          )}
        >
          {label ?? shortAddr(address)}
        </button>
      </Tooltip>
      {tracked && <Tag tag="tracked" />}
      {ROW_TAGS.filter((t) => tags.includes(t))
        .slice(0, 2)
        .map((t) => (
          <Tag key={t} tag={t} />
        ))}
    </span>
  );
}

function TrackStar({ address }: { address: string }) {
  const { tracked, toggle } = useTrackToggle(address);
  return (
    <IconButton size="xs" label={tracked ? "Stop tracking wallet" : "Track wallet"} active={tracked} onClick={toggle}>
      <Star className={cn(tracked && "fill-current")} />
    </IconButton>
  );
}

/** A value we can only show when the feed carries it; the tooltip says why and gives what we know. */
function Unknown({ tip }: { tip: string }) {
  return (
    <Tooltip content={tip}>
      <span className="zf-num text-fg-4">{DASH}</span>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Holders
// ---------------------------------------------------------------------------

type HolderKey = "rank" | "wallet" | "pct" | "tokens" | "value" | "entry" | "realized" | "unrealized" | "funded" | "actions";

function holderCols(quote: "USD" | "SOL"): Col<HolderKey>[] {
  const u = quoteUnit(quote);
  return [
    { key: "rank", label: "#", width: ch(3), align: "right" },
    { key: "wallet", label: "Wallet", width: flex(16) },
    { key: "pct", label: "% supply", width: ch(12), align: "right", sortable: true },
    { key: "tokens", label: "Tokens", width: ch(8), align: "right", sortable: true },
    { key: "value", label: `Value ${u}`, width: ch(8), align: "right", sortable: true },
    { key: "entry", label: `Avg entry MC`, width: ch(8), align: "right", title: "Average entry as market cap" },
    { key: "realized", label: "Realized", width: ch(9), align: "right", sortable: true },
    { key: "unrealized", label: "Unrealized", width: ch(9), align: "right", sortable: true },
    { key: "funded", label: "Funded by", width: ch(12) },
    { key: "actions", label: "", width: ch(6), align: "right" },
  ];
}

interface HolderView {
  h: Holder;
  system: boolean;
  rank: number;
  valueSol: number;
  avgPriceSol: number | null;
  realizedSol: number | null;
  unrealizedSol: number | null;
  totalPnlSol: number;
}

/**
 * Average-cost PnL from the holder's lifetime buys and sells. Tokens that arrived by transfer
 * (no buy) have no cost basis, so a holder who never bought shows "–".
 */
function holderView(h: Holder, rank: number, priceSol: number): HolderView {
  const system = h.tags.includes("curve") || h.tags.includes("pool");
  const valueSol = h.balance * priceSol;
  const avg = !system && h.boughtTokens > 0 ? h.boughtSol / h.boughtTokens : null;
  const costHeld = avg !== null ? avg * Math.min(h.balance, Math.max(0, h.boughtTokens - h.soldTokens)) : null;
  return {
    h,
    system,
    rank,
    valueSol,
    avgPriceSol: avg,
    realizedSol: avg !== null ? h.soldSol - avg * Math.min(h.soldTokens, h.boughtTokens) : null,
    unrealizedSol: costHeld !== null ? valueSol - costHeld : null,
    totalPnlSol: h.soldSol + valueSol - h.boughtSol,
  };
}

function holderCell(v: HolderView, key: HolderKey, token: TokenSummary, tracked: TrackedWallet | undefined): ReactNode {
  const { h } = v;
  const why = `No buys on record (tokens arrived by transfer), so there's no cost basis. Net flow ${fmtSignedSol(v.totalPnlSol)} SOL.`;
  switch (key) {
    case "rank":
      return <span className="zf-num text-fg-3">{v.system ? DASH : v.rank}</span>;
    case "wallet":
      return <WalletCell address={h.address} tags={h.tags} tracked={tracked} />;
    case "pct":
      return (
        <span className="flex items-center gap-2">
          <span className="zf-num">{fmtPct(h.pct)}</span>
          <span aria-hidden="true" className="h-1 w-10 bg-surface-3">
            <span className="block h-full bg-fg-3/50" style={{ width: `${Math.min(100, h.pct)}%` }} />
          </span>
        </span>
      );
    case "tokens":
      return <span className="zf-num text-fg-2">{fmtTokens(h.balance)}</span>;
    case "value":
      return <Money sol={v.valueSol} />;
    case "entry":
      return v.avgPriceSol === null ? (
        v.system ? (
          <span className="text-fg-4">{DASH}</span>
        ) : (
          <Unknown tip={why} />
        )
      ) : (
        <Money sol={v.avgPriceSol * token.supply} className="text-fg-2" />
      );
    case "realized":
      return v.realizedSol === null ? (
        v.system ? (
          <span className="text-fg-4">{DASH}</span>
        ) : (
          <Unknown tip={why} />
        )
      ) : (
        <Money sol={v.realizedSol} kind="signed" />
      );
    case "unrealized":
      return v.unrealizedSol === null ? (
        v.system ? (
          <span className="text-fg-4">{DASH}</span>
        ) : (
          <Unknown tip={why} />
        )
      ) : (
        <Money sol={v.unrealizedSol} kind="signed" />
      );
    case "funded":
      return h.fundedBy ? (
        h.fundedBy === token.creator ? (
          <Tooltip content={<span className="font-mono break-all">{h.fundedBy}</span>}>
            <span className="flex items-center gap-1 text-fg-2">
              <Tag tag="dev" /> wallet
            </span>
          </Tooltip>
        ) : (
          <span className="truncate font-mono text-fg-2">{shortAddr(h.fundedBy)}</span>
        )
      ) : (
        <span className="text-fg-4">{DASH}</span>
      );
    case "actions":
      return v.system ? null : (
        <span className="flex items-center">
          <TrackStar address={h.address} />
          <CopyButton text={h.address} label="Copy address" />
        </span>
      );
  }
}

function SummaryValue({ k, pct, label, sold }: { k: RiskKey; pct: number; label: string; sold?: boolean }) {
  const thresholds = useSettings((s) => s.display.riskThresholds);
  const tone = sold ? "neutral" : riskTone(k, pct, thresholds);
  return (
    <span className="flex items-center gap-1">
      <MetricLabel
        metric={k}
        bands={bandsText(k, thresholds)}
        value={<span className={TONE_TEXT[tone]}>{sold ? "DS" : fmtRiskPct(pct)}</span>}
      >
        {label}
      </MetricLabel>
      <span className={cn("zf-num font-medium", TONE_TEXT[tone])}>{sold ? "DS" : fmtRiskPct(pct)}</span>
    </span>
  );
}

const SORT_HOLDERS: Partial<Record<HolderKey, (v: HolderView) => number>> = {
  pct: (v) => v.h.pct,
  tokens: (v) => v.h.balance,
  value: (v) => v.valueSol,
  realized: (v) => v.realizedSol ?? Number.NEGATIVE_INFINITY,
  unrealized: (v) => v.unrealizedSol ?? Number.NEGATIVE_INFINITY,
};

export function HoldersTable({ holders, token }: { holders: Holder[]; token: TokenSummary }) {
  const tracked = useTrackedMap();
  const { quote } = useQuote();
  const [filter, setFilter] = useState<HolderFilter>("all");
  const [sort, setSort] = useState<SortState<HolderKey> | null>(null);
  const pause = usePauseOnHover();
  const cols = useMemo(() => holderCols(quote), [quote]);
  const r = token.risk;

  const views = useMemo(() => {
    let rank = 0;
    const all = holders.map((h) => {
      const system = h.tags.includes("curve") || h.tags.includes("pool");
      if (!system) rank++;
      return holderView(h, rank, token.priceSol);
    });
    const shown = all.filter((v) => {
      if (filter === "all") return true;
      if (filter === "tracked") return tracked.has(v.h.address);
      return v.h.tags.includes(filter);
    });
    const value = sort ? SORT_HOLDERS[sort.key] : undefined;
    if (sort && value) {
      const dir = sort.dir === "asc" ? 1 : -1;
      shown.sort((a, b) => (value(a) - value(b)) * dir);
    }
    return shown;
  }, [holders, token.priceSol, filter, tracked, sort]);

  const { rows, queued } = useLiveOrder(views, (v) => v.h.address, { frozen: pause.frozen, resortMs: 2000 });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-3 overflow-hidden border-b border-hairline px-2 text-label whitespace-nowrap text-fg-3">
        <span>
          <span className="zf-num text-fg-1">{fmtCount(token.holders)}</span> holders
        </span>
        <span aria-hidden="true">·</span>
        <SummaryValue k="top10" pct={r.top10Pct} label="Top 10" />
        <SummaryValue k="dev" pct={r.devPct} label="Dev" sold={r.devSold} />
        <SummaryValue k="snipers" pct={r.snipersPct} label="Snipers" />
        <SummaryValue k="insiders" pct={r.insidersPct} label="Insiders" />
        <SummaryValue k="bundlers" pct={r.bundlersPct} label="Bundlers" />
        <Segmented<HolderFilter>
          size="xs"
          className="ml-auto shrink-0"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "insider", label: "Insiders" },
            { value: "sniper", label: "Snipers" },
            { value: "bundler", label: "Bundlers" },
            { value: "tracked", label: "Tracked" },
          ]}
          label="Holder filter"
        />
      </div>
      <div className="relative min-h-0 flex-1">
        <NewRowsBar count={queued} onApply={pause.release} className="top-[var(--zf-header-row)]" />
        <div className="h-full overflow-auto" onScroll={pause.onScroll} {...pause.bind}>
          <DataTable
            label="Holders"
            minWidth={860}
            cols={cols}
            rows={rows}
            rowKey={(v) => v.h.address}
            cell={(v, key) => holderCell(v, key, token, tracked.get(v.h.address))}
            rowClassName={(v) => v.h.tags.includes("you") && "bg-surface-3"}
            sort={sort}
            onSort={(k) => setSort((s) => nextSort(s, k))}
          />
          {rows.length === 0 && (
            <EmptyState
              title={holders.length === 0 ? "No holders yet" : "No holders match this filter"}
              body={holders.length === 0 ? "Holders appear with the first buys." : "Pick All to see every holder."}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top traders
// ---------------------------------------------------------------------------

type TraderKey = "rank" | "wallet" | "bought" | "sold" | "realized" | "unrealized" | "remaining" | "held" | "last";

const TRADER_COLS: Col<TraderKey>[] = [
  { key: "rank", label: "#", width: ch(3), align: "right" },
  { key: "wallet", label: "Wallet", width: flex(16) },
  { key: "bought", label: "Bought SOL", width: ch(9), align: "right", sortable: true },
  { key: "sold", label: "Sold SOL", width: ch(9), align: "right", sortable: true },
  { key: "realized", label: "Realized PnL", width: ch(10), align: "right", sortable: true },
  { key: "unrealized", label: "Unrealized", width: ch(9), align: "right", sortable: true },
  { key: "remaining", label: "Remaining", width: ch(8), align: "right", title: "Balance still held, % of supply" },
  { key: "held", label: "Held for", width: ch(6), align: "right" },
  { key: "last", label: "Last tx", width: ch(6), align: "right" },
];

interface TraderView {
  t: TopTrader;
  realizedSol: number | null;
  unrealizedSol: number | null;
  firstBuyAt: number | null;
  lastTx: number | null;
}

const SORT_TRADERS: Partial<Record<TraderKey, (v: TraderView) => number>> = {
  bought: (v) => v.t.boughtSol,
  sold: (v) => v.t.soldSol,
  realized: (v) => v.realizedSol ?? Number.NEGATIVE_INFINITY,
  unrealized: (v) => v.unrealizedSol ?? Number.NEGATIVE_INFINITY,
};

export function TopTradersTable({ traders }: { traders: TopTrader[] }) {
  const tracked = useTrackedMap();
  const [sort, setSort] = useState<SortState<TraderKey> | null>(null);
  const pause = usePauseOnHover();

  const views = useMemo(() => {
    const list: TraderView[] = traders.map((t) => ({
      t,
      realizedSol: t.realizedPnlSol,
      unrealizedSol: t.holdingPct > 0 ? t.unrealizedPnlSol : 0,
      // "Held for" counts from the first buy while the wallet still holds.
      firstBuyAt: t.holdingPct > 0 ? t.firstBuyAt : null,
      lastTx: t.lastTradeAt,
    }));
    const value = sort ? SORT_TRADERS[sort.key] : undefined;
    if (sort && value) {
      const dir = sort.dir === "asc" ? 1 : -1;
      list.sort((a, b) => (value(a) - value(b)) * dir);
    }
    return list;
  }, [traders, sort]);

  const { rows, queued } = useLiveOrder(views, (v) => v.t.address, { frozen: pause.frozen, resortMs: 2000 });

  const content = (v: TraderView, i: number, key: TraderKey): ReactNode => {
    const why = `Needs this wallet's cost basis from the feed. Total PnL ${fmtSignedSol(v.t.pnlSol)} SOL.`;
    switch (key) {
      case "rank":
        return <span className="zf-num text-fg-3">{i + 1}</span>;
      case "wallet":
        return <WalletCell address={v.t.address} tags={v.t.tags} tracked={tracked.get(v.t.address)} />;
      case "bought":
        return <span className="zf-num text-buy">{fmtSol(v.t.boughtSol)}</span>;
      case "sold":
        return v.t.soldSol > 0 ? (
          <span className="zf-num text-sell">{fmtSol(v.t.soldSol)}</span>
        ) : (
          <span className="text-fg-4">{DASH}</span>
        );
      case "realized":
        return v.realizedSol === null ? <Unknown tip={why} /> : <Money sol={v.realizedSol} kind="signed" />;
      case "unrealized":
        return v.unrealizedSol === null ? <Unknown tip={why} /> : <Money sol={v.unrealizedSol} kind="signed" />;
      case "remaining":
        return v.t.holdingPct > 0 ? (
          <span className="zf-num text-fg-2">{fmtPct(v.t.holdingPct)}</span>
        ) : (
          <span className="text-fg-3">Exited</span>
        );
      case "held":
        return v.firstBuyAt ? <Age ts={v.firstBuyAt} className="text-fg-2" /> : <span className="text-fg-4">{DASH}</span>;
      case "last":
        return v.lastTx ? <Age ts={v.lastTx} /> : <span className="text-fg-4">{DASH}</span>;
    }
  };

  return (
    <div className="relative h-full min-h-0">
      <NewRowsBar count={queued} onApply={pause.release} className="top-[var(--zf-header-row)]" />
      <div className="h-full overflow-auto" onScroll={pause.onScroll} {...pause.bind}>
        <DataTable
          label="Top traders"
          minWidth={780}
          cols={TRADER_COLS}
          rows={rows}
          rowKey={(v) => v.t.address}
          cell={(v, key, i) => content(v, i, key)}
          rowClassName={(v) => v.t.tags.includes("you") && "bg-surface-3"}
          sort={sort}
          onSort={(k) => setSort((s) => nextSort(s, k))}
        />
        {rows.length === 0 && <EmptyState title="No traders yet" body="Wallets show up here after their first trade." />}
      </div>
    </div>
  );
}

/** Phone holders list (DESIGN.md 5.8): 44 px rows. */
export function MobileHoldersList({ holders, token }: { holders: Holder[]; token: TokenSummary }) {
  const tracked = useTrackedMap();
  let rank = 0;
  if (holders.length === 0) return <EmptyState title="No holders yet" body="Holders appear with the first buys." />;
  return (
    <ul aria-label="Holders" className="divide-y divide-hairline">
      {holders.slice(0, 100).map((h) => {
        const system = h.tags.includes("curve") || h.tags.includes("pool");
        if (!system) rank++;
        const t = tracked.get(h.address);
        return (
          <li key={h.address} className="flex h-11 items-center gap-3 px-3 text-body">
            <span className="zf-num w-[3ch] text-right text-fg-3">{system ? DASH : rank}</span>
            <span className="min-w-0 flex-1 truncate">
              {system ? (
                <span className="text-fg-2">{h.tags.includes("curve") ? "Bonding curve" : "Liquidity pool"}</span>
              ) : t ? (
                <span className="text-fg-1">{t.name}</span>
              ) : (
                <span className="font-mono text-fg-2">{shortAddr(h.address)}</span>
              )}
            </span>
            <span className="zf-num text-fg-1">{fmtPct(h.pct)}</span>
            <Money sol={h.balance * token.priceSol} unit className="min-w-[8ch] text-right text-fg-2" />
          </li>
        );
      })}
    </ul>
  );
}
