import { Eye, EyeOff, Wallet } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/bits";
import { CopyButton, Hotkey, Segmented } from "../../components/ui/controls";
import { Tooltip } from "../../components/ui/Tooltip";
import { isBase58Address } from "../../lib/address";
import { cn } from "../../lib/cn";
import { fmtCount, shortAddr } from "../../lib/format";
import { BREAKPOINT, useMediaQuery } from "../../lib/useMediaQuery";
import type { PnlPoint, Position, WalletStatus } from "../../protocol";
import { getServices } from "../../services";
import { type QuoteCurrency, useSettings } from "../../state/settings";
import { useTrackers } from "../../state/trackers";
import { useActiveStatus, useWallet } from "../../state/wallet";
import { ActivityList, ActivityTable, dedupeActivity } from "./ActivityTable";
import { HeaderStrip } from "./HeaderStrip";
import { HistoryCalendar } from "./HistoryCalendar";
import { DUST_SOL, isDust, type PnlRange, RANGES, summarize } from "./helpers";
import { PerformancePanel } from "./PerformancePanel";
import { PnlChart } from "./PnlChart";
import { PositionsList, PositionsTable } from "./PositionsTable";
import { ShareDialog } from "./ShareDialog";
import { PanelTabs, panelId, tabId } from "./Tabs";
import { PanelError } from "./table";
import { usePolled } from "./usePolled";
import { WalletsTable } from "./WalletsTable";

/*
 * Portfolio (DESIGN.md 5.3): header strip (balance in display-1, micro-labelled stats, 7d | 30d |
 * Max, search other wallets), the PnL chart beside Performance, then the tabbed grid (Active
 * positions | History | Activity | Wallets). Panels tile edge to edge on 1 px hairlines; no
 * gutters, no card grid. Structure after Axiom's portfolio (https://docs.axiom.trade/axiom/portfolio):
 * balance, PnL chart, performance buckets, positions, activity, search other wallets. Balance,
 * period toggle and "Hide assets <1 USD" after Binance assets:
 * https://mobbin.com/screens/5acd0f5e-9019-4e1f-95e1-1446bbccd036
 */

type Tab = "active" | "history" | "activity" | "wallets";
type HistoryView = "list" | "calendar";

const RANGE_KEY = "zerofee.portfolio.range";

function readRange(): PnlRange {
  try {
    const v = localStorage.getItem(RANGE_KEY);
    return RANGES.includes(v as PnlRange) ? (v as PnlRange) : "30d";
  } catch {
    return "30d";
  }
}

/** The one global quote (DESIGN.md 3.9), also in the status bar and on T then C. */
function QuoteToggle() {
  const quote = useSettings((s) => s.display.quote);
  const setDisplay = useSettings((s) => s.setDisplay);
  const binding = useSettings((s) => s.hotkeys["quote.toggle"]?.[0]);
  return (
    <Tooltip
      content={
        <span className="inline-flex items-center gap-2">
          Values in USD or SOL <Hotkey binding={binding} />
        </span>
      }
    >
      <Segmented<QuoteCurrency>
        value={quote}
        onChange={(q) => setDisplay({ quote: q })}
        size="xs"
        label="Quote currency"
        options={[
          { value: "USD", label: "USD" },
          { value: "SOL", label: "SOL" },
        ]}
      />
    </Tooltip>
  );
}

/** Dust toggle, after Binance's "Hide assets <1 USD". */
function ShowHidden({ on, count, onChange }: { on: boolean; count: number; onChange: (on: boolean) => void }) {
  return (
    <Tooltip content={`Positions worth under ${DUST_SOL} SOL are hidden unless this is on`}>
      <button
        type="button"
        aria-pressed={on}
        onClick={() => onChange(!on)}
        className={cn(
          "inline-flex h-5 items-center gap-1 rounded-sm px-1.5 text-label font-medium transition-colors",
          on ? "bg-surface-3 text-fg-1" : "text-fg-3 hover:bg-surface-3 hover:text-fg-1",
        )}
      >
        {on ? <Eye className="icon-xs" /> : <EyeOff className="icon-xs" />}
        Show hidden
        {count > 0 && <span className="zf-num text-fg-3">{fmtCount(count)}</span>}
      </button>
    </Tooltip>
  );
}

/** "Viewing 7xKX…sAsU · read-only · Back to my portfolio" (DESIGN.md 5.3), 28 px. */
function ViewingBanner({
  address,
  valid,
  name,
  own,
  onMakeActive,
}: {
  address: string;
  valid: boolean;
  name: string | null;
  own: boolean;
  onMakeActive: () => void;
}) {
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 overflow-hidden bg-surface-2 px-3 text-data whitespace-nowrap">
      <Eye className="icon-sm shrink-0 text-fg-3" />
      {valid ? (
        <>
          <span className="text-fg-2">Viewing</span>
          <span className="font-mono text-fg-1" title={address}>
            {shortAddr(address)}
          </span>
          <CopyButton text={address} label="Copy wallet address" />
          {name && <span className="min-w-0 truncate text-fg-2">{name}</span>}
          <span className="text-fg-3">· {own ? "your trading wallet" : "read-only"} ·</span>
        </>
      ) : (
        <span className="text-fg-2">That isn't a Solana address ·</span>
      )}
      <Link to="/portfolio" className="text-fg-1 hover:underline">
        Back to my portfolio
      </Link>
      {own && (
        <Button size="xs" variant="ghost" className="ml-auto" onClick={onMakeActive}>
          Make active
        </Button>
      )}
    </div>
  );
}

export default function PortfolioPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const activeAddress = useWallet((s) => s.activeAddress);
  const tradingWallets = useWallet((s) => s.service.tradingWallets);
  const setActive = useWallet((s) => s.setActive);
  const ownStatus = useActiveStatus();
  const mobile = !useMediaQuery(BREAKPOINT.md);
  const wide = useMediaQuery(BREAKPOINT.lg);

  const [range, setRangeState] = useState<PnlRange>(readRange);
  const [tab, setTab] = useState<Tab>("active");
  const [showHidden, setShowHidden] = useState(false);
  const [historyView, setHistoryView] = useState<HistoryView>("list");
  const [sharing, setSharing] = useState<Position | null>(null);

  const setRange = useCallback((r: PnlRange) => {
    setRangeState(r);
    try {
      localStorage.setItem(RANGE_KEY, r);
    } catch {
      // Private mode: the range just resets next visit.
    }
  }, []);

  const param = params.get("wallet")?.trim() || null;
  const viewing = param !== null && param !== activeAddress;
  const paramValid = param === null || isBase58Address(param);
  const liveWallets = useMemo(() => tradingWallets.filter((w) => !w.archived), [tradingWallets]);
  const ownViewed = viewing ? liveWallets.find((w) => w.address === param) : undefined;
  // Own wallets stream over their wallet topic already; any other wallet comes over REST.
  const ownViewedStatus = useWallet((s) => (ownViewed ? (s.status[ownViewed.address] ?? null) : null));
  const remoteKey = viewing && paramValid && !ownViewed ? param : null;
  const loadRemote = useCallback(() => getServices().data.getWallet(remoteKey ?? ""), [remoteKey]);
  const remote = usePolled<WalletStatus | null>(remoteKey, loadRemote, 10_000);

  const address = viewing ? (paramValid ? param : null) : activeAddress;
  const status: WalletStatus | null = viewing ? (ownViewed ? ownViewedStatus : remote.data) : ownStatus;
  const actionable = !viewing || !!ownViewed;
  const trackedName = useTrackers((s) => (viewing ? (s.wallets.find((w) => w.address === param)?.name ?? null) : null));
  const walletLabel = liveWallets.find((w) => w.address === address)?.label ?? null;

  const loadPnl = useCallback(() => getServices().data.getPnlHistory(address ?? "", range), [address, range]);
  const pnl = usePolled<PnlPoint[]>(status && address ? `${address}:${range}` : null, loadPnl, 30_000, address);
  const calendarOn = tab === "history" && historyView === "calendar";
  const loadMax = useCallback(() => getServices().data.getPnlHistory(address ?? "", "max"), [address]);
  const calendar = usePolled<PnlPoint[]>(calendarOn && status && address ? `${address}:max` : null, loadMax, 60_000);

  const summary = useMemo(() => (status ? summarize(status, range, Date.now()) : null), [status, range]);
  const activity = useMemo(() => (status ? dedupeActivity(status.activity) : []), [status]);
  const { open, closed, dust } = useMemo(() => {
    const openList: Position[] = [];
    const closedList: Position[] = [];
    let dustCount = 0;
    for (const p of status?.positions ?? []) {
      if (p.closed) closedList.push(p);
      else if (isDust(p)) {
        dustCount++;
        if (showHidden) openList.push(p);
      } else openList.push(p);
    }
    return { open: openList, closed: closedList, dust: dustCount };
  }, [status, showHidden]);

  const openWallet = (next: string) => setParams(next === activeAddress ? {} : { wallet: next });
  const noWallet = !viewing && !activeAddress;
  const remoteFailed = remoteKey !== null && remote.failures > 0 && remote.data === null;
  const remoteMissing = remoteKey !== null && !remote.loading && remote.failures === 0 && remote.data === null;
  const loading = !status && !remoteFailed && !remoteMissing && !noWallet && paramValid;

  const tabs = [
    { id: "active" as const, label: "Active positions", count: status ? open.length : null },
    { id: "history" as const, label: "History" },
    { id: "activity" as const, label: "Activity" },
    ...(!viewing && liveWallets.length > 0 ? [{ id: "wallets" as const, label: "Wallets", count: liveWallets.length }] : []),
  ];
  const currentTab: Tab = tabs.some((t) => t.id === tab) ? tab : "active";

  const openPulse = (
    <Button variant="secondary" size="sm" onClick={() => navigate("/pulse")}>
      Open Pulse
    </Button>
  );
  const activeEmpty =
    open.length === 0 && dust > 0 && !showHidden ? (
      <EmptyState
        className="text-balance"
        title="Only dust positions"
        body={`${fmtCount(dust)} position${dust === 1 ? " is" : "s are"} worth under ${DUST_SOL} SOL and hidden.`}
        action={
          <Button variant="secondary" size="sm" onClick={() => setShowHidden(true)}>
            Show hidden
          </Button>
        }
      />
    ) : actionable ? (
      <EmptyState className="text-balance" title="No open positions" body="Buy from Pulse, or press / to search." action={openPulse} />
    ) : (
      <EmptyState className="text-balance" title="No open positions" body="This wallet holds nothing in the live set right now." />
    );

  let panel: ReactNode;
  if (noWallet) {
    panel = (
      <EmptyState
        className="text-balance"
        icon={<Wallet />}
        title="No trading wallet yet"
        body="Set one up to trade, or search any wallet above to view it."
        action={
          <Button variant="secondary" size="sm" onClick={() => navigate("/onboarding")}>
            Set up a wallet
          </Button>
        }
      />
    );
  } else if (!paramValid) {
    panel = <EmptyState className="text-balance" title="Not a Solana address" body="Paste a full base58 wallet address into the search." />;
  } else if (remoteFailed) {
    panel = <PanelError what="this wallet" failures={remote.failures} onRetry={remote.retry} />;
  } else if (remoteMissing) {
    panel = <EmptyState className="text-balance" title="No data for this wallet" body="It has no trades in the live set." />;
  } else if (currentTab === "active") {
    panel = mobile ? (
      loading ? (
        <EmptyState className="text-balance" title="Loading positions…" />
      ) : (
        <PositionsList positions={open} empty={activeEmpty} />
      )
    ) : (
      <PositionsTable
        positions={open}
        ownWallet={actionable}
        wallet={viewing ? param : null}
        activity={activity}
        onShare={actionable ? setSharing : undefined}
        loading={loading}
        empty={activeEmpty}
        className="flex-1"
      />
    );
  } else if (currentTab === "history") {
    const historyEmpty = (
      <EmptyState className="text-balance" title="No closed positions" body="A position moves here when you sell all of it." />
    );
    if (historyView === "calendar") {
      panel = <HistoryCalendar points={calendar.data} loading={calendar.loading} failures={calendar.failures} onRetry={calendar.retry} />;
    } else {
      panel = mobile ? (
        <PositionsList positions={closed} variant="history" empty={historyEmpty} />
      ) : (
        <PositionsTable
          positions={closed}
          variant="history"
          ownWallet={actionable}
          activity={activity}
          onShare={actionable ? setSharing : undefined}
          loading={loading}
          empty={historyEmpty}
          className="flex-1"
        />
      );
    }
  } else if (currentTab === "activity") {
    const activityEmpty = (
      <EmptyState
        className="text-balance"
        title="No activity yet"
        body="Buys, sells, deposits and withdrawals show up here as they land."
      />
    );
    panel = mobile ? (
      <ActivityList items={activity} empty={activityEmpty} />
    ) : (
      <ActivityTable items={activity} loading={loading} empty={activityEmpty} className="flex-1" />
    );
  } else {
    panel = (
      <WalletsTable
        mobile={mobile}
        empty={<EmptyState className="text-balance" title="No trading wallets" body="Create one to start trading." />}
      />
    );
  }

  const controls = (
    <>
      {currentTab === "active" && status && !mobile && <ShowHidden on={showHidden} count={dust} onChange={setShowHidden} />}
      {currentTab === "history" && (
        <Segmented<HistoryView>
          value={historyView}
          onChange={setHistoryView}
          size="xs"
          label="History view"
          options={[
            { value: "list", label: "List" },
            { value: "calendar", label: "Calendar" },
          ]}
        />
      )}
      <QuoteToggle />
    </>
  );

  const banner = viewing && param && (
    <ViewingBanner
      address={param}
      valid={paramValid}
      name={ownViewed?.label ?? trackedName}
      own={!!ownViewed}
      onMakeActive={() => {
        if (!ownViewed) return;
        setActive(ownViewed.address);
        setParams({});
      }}
    />
  );

  const tabsPanel = (
    <section aria-label="Positions and activity" className={cn("flex flex-col bg-surface-1", !mobile && "min-h-80 flex-1")}>
      <PanelTabs base="portfolio" tabs={tabs} value={currentTab} onChange={setTab} label="Portfolio">
        {controls}
      </PanelTabs>
      <div
        role="tabpanel"
        id={panelId("portfolio", currentTab)}
        aria-labelledby={tabId("portfolio", currentTab)}
        className={cn("flex flex-col", !mobile && "min-h-0 flex-1")}
      >
        {panel}
      </div>
    </section>
  );

  const showCharts = !noWallet && paramValid && !remoteMissing;

  return (
    <div className="h-full overflow-y-auto bg-bg">
      <div className={cn("flex flex-col gap-px bg-hairline", !mobile && "min-h-full")}>
        {banner}
        <HeaderStrip
          status={status}
          summary={summary}
          range={range}
          onRange={setRange}
          onSearch={openWallet}
          mobile={mobile}
          loading={loading}
          unavailable={noWallet ? "No trading wallet" : !paramValid || remoteMissing ? "No data" : remoteFailed ? "Unavailable" : null}
        />
        {showCharts &&
          (mobile ? (
            <PnlChart
              className="h-40"
              points={pnl.data}
              loading={pnl.loading || loading}
              failures={pnl.failures}
              onRetry={pnl.retry}
              range={range}
            />
          ) : (
            <div className={cn("grid gap-px bg-hairline", wide && "grid-cols-[minmax(0,1fr)_320px]")}>
              <PnlChart
                className="h-60"
                points={pnl.data}
                loading={pnl.loading || loading}
                failures={pnl.failures}
                onRetry={pnl.retry}
                range={range}
              />
              <PerformancePanel summary={summary} range={range} className={wide ? "h-60" : undefined} />
            </div>
          ))}
        {tabsPanel}
        {showCharts && mobile && <PerformancePanel summary={summary} range={range} />}
      </div>
      {sharing && <ShareDialog position={sharing} activity={activity} walletLabel={walletLabel} onClose={() => setSharing(null)} />}
    </div>
  );
}
