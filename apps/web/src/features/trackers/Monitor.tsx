import { Eye, Radar, Wallet } from "lucide-react";
import { memo, useCallback, useMemo } from "react";
import { Link } from "react-router";
import { Age } from "../../components/ui/Age";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/bits";
import { Segmented } from "../../components/ui/controls";
import { Num } from "../../components/ui/Num";
import { TokenAvatar } from "../../components/ui/TokenAvatar";
import { Tooltip } from "../../components/ui/Tooltip";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { useCssPx } from "../../lib/cssVar";
import { fmtInt, shortAddr } from "../../lib/format";
import { navigateTo } from "../../lib/nav";
import { useMarket } from "../../state/market";
import { useSettings } from "../../state/settings";
import { type TrackedWallet, useTrackedMap, useTrackers } from "../../state/trackers";
import { RiskChips } from "../pulse/RiskChips";
import { MetaCount, PaneToolbar, PausedChip } from "./bits";
import { normalizeQuery, tokenBlocker, tokenMatches, walletMatches } from "./feedFilters";
import { hoverTarget, MOBILE_ROW_PX, useIsMobile, useLivePause, useStableOrder } from "./hooks";
import { QuoteValue } from "./money";
import { aggregateMonitor, compareMonitor, type MonitorRow, sameMonitorRow } from "./monitorData";
import { type MonitorSortKey, type SortDir, useTrackerPrefs } from "./prefs";
import { QuickBuyPill } from "./QuickBuyButton";
import { Cell, CursorBar, HeaderCell, HeaderRow, rowTone, SortHeaderCell } from "./table";
import { VirtualGrid } from "./VirtualList";

const rowKey = (r: MonitorRow): string => r.mint;
const liveMc = (r: MonitorRow): number => useMarket.getState().tokens[r.mint]?.marketCapUsd ?? r.lastMcUsd;

/*
 * Monitor columns (DESIGN.md 5.4): token · tracked holders · net flow 15 m · first tracked buy ·
 * MC · risk chips · quick-buy. Risk chips (216 px) drop below a 760 px pane, then first buy and MC.
 */
const COL = {
  token: "min-w-0 flex-1",
  holders: "w-[8ch] justify-end",
  flow: "w-[10ch] justify-end",
  first: "w-[6ch] justify-end @max-[600px]:hidden",
  mc: "w-[9ch] justify-end @max-[480px]:hidden",
  risk: "w-[216px] @max-[760px]:hidden",
  pill: "w-16 justify-end",
} as const;

const ROW = "flex items-center gap-2 px-2";

function holderNames(holders: string[], tracked: ReadonlyMap<string, TrackedWallet>): string {
  if (holders.length === 0) return "No tracked wallet holds it now";
  const names = holders.slice(0, 12).map((a) => tracked.get(a)?.name ?? shortAddr(a));
  return `Held by ${names.join(", ")}${holders.length > 12 ? ` and ${holders.length - 12} more` : ""}`;
}

const MonitorRowView = memo(
  function MonitorRowView({ row, tracked, active }: { row: MonitorRow; tracked: ReadonlyMap<string, TrackedWallet>; active: boolean }) {
    const t = useMarket((s) => s.tokens[row.mint]);
    const { token } = row;
    return (
      <div {...hoverTarget(row.mint)} className={cn(ROW, "relative h-full text-data", active ? "bg-surface-2" : rowTone({}))}>
        <CursorBar show={active} />
        <Cell className={cn("items-center gap-1", COL.token)}>
          <Link to={`/t/${row.mint}`} tabIndex={-1} className="absolute inset-0">
            <span className="sr-only">
              Open {token.symbol}: {row.holders.length} tracked wallets hold it
            </span>
          </Link>
          <TokenAvatar mint={row.mint} symbol={token.symbol} imageUri={token.imageUri} size="2xs" />
          <span className="max-w-[10ch] truncate font-semibold text-fg-1">{token.symbol}</span>
          <Age ts={token.createdAt} className="text-fg-3" />
        </Cell>
        <Cell className={cn("shrink-0", COL.holders)}>
          <Tooltip content={holderNames(row.holders, tracked)} wrapperClassName="relative">
            <span className="flex items-center gap-1">
              <Eye className="icon-xs text-fg-3" />
              <span className="zf-num font-medium text-fg-1">{row.holders.length}</span>
            </span>
          </Tooltip>
        </Cell>
        <Cell className={cn("shrink-0", COL.flow)}>
          <Num kind="sol" value={row.flowSol} signed />
        </Cell>
        <Cell className={cn("shrink-0", COL.first)}>
          {row.firstBuyAt === null ? <Num kind="count" value={null} /> : <Age ts={row.firstBuyAt} />}
        </Cell>
        <Cell className={cn("shrink-0 text-fg-1", COL.mc)}>
          <QuoteValue usd={t?.marketCapUsd ?? row.lastMcUsd} sol={t?.marketCapSol} />
        </Cell>
        <Cell className={cn("relative shrink-0", COL.risk)}>
          <RiskChips risk={t?.risk ?? null} />
        </Cell>
        <Cell className={cn("shrink-0", COL.pill)}>
          <QuickBuyPill mint={row.mint} symbol={token.symbol} source="tracker" size="grid" tabIndex={active ? 0 : -1} />
        </Cell>
      </div>
    );
  },
  (a, b) => a.active === b.active && a.tracked === b.tracked && sameMonitorRow(a.row, b.row),
);

/** Phone row (64 px): ticker, holders and net flow over the risk chips; MC and the pill on the right. */
const MobileMonitorRow = memo(
  function MobileMonitorRow({ row }: { row: MonitorRow }) {
    const t = useMarket((s) => s.tokens[row.mint]);
    const { token } = row;
    return (
      <div {...hoverTarget(row.mint)} className="relative flex h-full items-center gap-3 px-3">
        <Link to={`/t/${row.mint}`} className="absolute inset-0">
          <span className="sr-only">
            Open {token.symbol}: {row.holders.length} tracked wallets hold it
          </span>
        </Link>
        <TokenAvatar mint={row.mint} symbol={token.symbol} imageUri={token.imageUri} size="sm" />
        <Cell className="min-w-0 flex-1 flex-col gap-1">
          <span className="flex h-5 min-w-0 items-center gap-2 text-data">
            <span className="truncate text-amount font-semibold text-fg-1">{token.symbol}</span>
            <span className="flex shrink-0 items-center gap-1">
              <Eye className="icon-xs text-fg-3" />
              <span className="zf-num font-medium">{row.holders.length}</span>
            </span>
            <Num kind="sol" value={row.flowSol} signed unit="SOL" className="shrink-0" />
            <span className="ml-auto shrink-0 text-fg-1">
              <QuoteValue usd={t?.marketCapUsd ?? row.lastMcUsd} sol={t?.marketCapSol} />
            </span>
          </span>
          <span className="relative flex h-5 min-w-0 items-center overflow-hidden">
            <RiskChips risk={t?.risk ?? null} />
          </span>
        </Cell>
        <QuickBuyPill mint={row.mint} symbol={token.symbol} source="tracker" size="touch" />
      </div>
    );
  },
  (a, b) => sameMonitorRow(a.row, b.row),
);

/** Definitions for the tracker-derived columns (dotted-underline tooltips, DESIGN.md 4.14). */
const DEFINE = {
  holders: {
    label: "Tracked holders",
    text: "Tracked wallets that still hold the token: bought minus sold, in tokens, above dust. Positions opened before the feed started don't count.",
  },
  flow: { label: "Net SOL, 15 minutes", text: "SOL your tracked wallets bought minus SOL they sold in the last 15 minutes." },
  firstBuy: { label: "First tracked buy", text: "How long ago the first tracked wallet bought, from the trades in the feed." },
  risk: {
    label: "Holder risk",
    text: "T Top 10 · D Dev · S Snipers · I Insiders · B Bundlers. Hover a chip for its definition and bands.",
  },
} as const;

const MOBILE_SORTS: { value: MonitorSortKey; label: string }[] = [
  { value: "holders", label: "Holders" },
  { value: "flow", label: "Net flow" },
  { value: "firstBuy", label: "Newest" },
];

const DEFAULT_DIR: Record<MonitorSortKey, SortDir> = { holders: "desc", flow: "desc", firstBuy: "asc", mc: "desc" };

/**
 * Monitor: the tokens your tracked wallets hold, with net SOL flow over 15 minutes, sorted by
 * tracked holders. The order re-sorts at most every 2 s and never while hovered or focused.
 * "N smart wallets bought" signals, flattened into rows, after Binance Smart Money:
 * https://mobbin.com/screens/37ad2b16-f814-48d2-861a-6f396445f479
 * https://mobbin.com/screens/09771a99-b9ea-406e-b3de-aed9a2fe4fb3
 */
export function Monitor({ query, onAddWallet }: { query: string; onAddWallet: () => void }) {
  const live = useTrackers((s) => s.live);
  const walletCount = useTrackers((s) => s.wallets.length);
  const tracked = useTrackedMap();
  const sort = useTrackerPrefs((s) => s.monitorSort);
  const setSort = useTrackerPrefs((s) => s.setMonitorSort);
  const blacklists = useSettings((s) => s.blacklists);
  const mobile = useIsMobile();
  const rowPx = useCssPx("--zf-row", 24) + 4;
  const q = normalizeQuery(query);

  const rows = useMemo(() => {
    const all = aggregateMonitor(live, Date.now(), tokenBlocker(blacklists));
    if (!q) return all;
    return all.filter(
      (r) => tokenMatches(r.token, q) || r.holders.some((a) => walletMatches({ name: tracked.get(a)?.name ?? "", address: a }, q)),
    );
  }, [live, blacklists, q, tracked]);
  const compare = useMemo(() => compareMonitor(sort.key, sort.dir, liveMc), [sort]);
  const ordered = useStableOrder(rows, rowKey, compare);
  const { shown, paused, pending, bind, release } = useLivePause(ordered, rowKey);

  const open = useCallback((r: MonitorRow, how: { newTab: boolean }) => {
    const to = `/t/${r.mint}`;
    if (how.newTab) window.open(to, "_blank", "noopener");
    else navigateTo(to);
  }, []);
  const copy = useCallback((r: MonitorRow) => void copyText(r.mint), []);

  const empty =
    walletCount === 0 ? (
      <EmptyState
        icon={<Wallet />}
        title="No wallets tracked"
        body="Add a wallet to see which tokens it holds and how much SOL flows in."
        action={
          <Button size="sm" variant="secondary" onClick={onAddWallet}>
            Add wallet
          </Button>
        }
      />
    ) : q ? (
      <EmptyState title={`No tokens match “${query.trim()}”`} body="Search by ticker, name, contract address or holder." />
    ) : (
      <EmptyState icon={<Radar />} title="No tracked holdings yet" body="Tokens show up here as soon as a tracked wallet buys." />
    );

  return (
    <div className="@container flex min-h-0 min-w-0 flex-1 flex-col">
      <PaneToolbar>
        {mobile ? (
          <Segmented<MonitorSortKey>
            size="sm"
            value={sort.key === "mc" ? "holders" : sort.key}
            onChange={(key) => setSort({ key, dir: DEFAULT_DIR[key] })}
            options={MOBILE_SORTS}
            label="Sort tokens"
            className="max-md:h-13"
          />
        ) : (
          <span className="zf-label">Tokens your tracked wallets hold · net flow over 15 minutes</span>
        )}
        <span className="ml-auto flex items-center gap-2 pl-2">
          <PausedChip paused={paused} />
          <MetaCount>{rows.length === 1 ? "1 token" : `${fmtInt(rows.length)} tokens`}</MetaCount>
        </span>
      </PaneToolbar>
      <VirtualGrid
        items={shown}
        getKey={rowKey}
        rowHeight={mobile ? MOBILE_ROW_PX : rowPx}
        label="Tokens held by tracked wallets"
        header={
          mobile ? undefined : (
            <HeaderRow className={ROW}>
              <HeaderCell className={COL.token}>Token</HeaderCell>
              <SortHeaderCell
                k="holders"
                label="Holders"
                sort={sort}
                onSort={setSort}
                className={COL.holders}
                align="right"
                define={DEFINE.holders}
              />
              <SortHeaderCell
                k="flow"
                label="Net SOL 15m"
                sort={sort}
                onSort={setSort}
                className={COL.flow}
                align="right"
                define={DEFINE.flow}
              />
              <SortHeaderCell
                k="firstBuy"
                label="First buy"
                sort={sort}
                onSort={setSort}
                defaultDir="asc"
                className={COL.first}
                align="right"
                define={DEFINE.firstBuy}
              />
              <SortHeaderCell k="mc" label="MC" sort={sort} onSort={setSort} className={COL.mc} align="right" metric="marketCap" />
              <HeaderCell className={COL.risk} define={DEFINE.risk}>
                Holder risk
              </HeaderCell>
              <HeaderCell className={COL.pill} />
            </HeaderRow>
          )
        }
        empty={empty}
        paused={paused}
        pending={pending}
        onRelease={release}
        bind={bind}
        onOpen={open}
        onCopy={copy}
        mintOf={rowKey}
        renderRow={(row, { active }) =>
          mobile ? <MobileMonitorRow row={row} /> : <MonitorRowView row={row} tracked={tracked} active={active} />
        }
      />
    </div>
  );
}
