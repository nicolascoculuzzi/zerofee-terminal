import { ArrowLeft, Eye, EyeOff, Search } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/bits";
import { CopyButton, Segmented } from "../../components/ui/controls";
import { isBase58Address } from "../../lib/address";
import { cn } from "../../lib/cn";
import { fmtCount, shortAddr } from "../../lib/format";
import type { ActivityItem, PnlPoint, Position, WalletStatus } from "../../protocol";
import { getServices } from "../../services";
import { useMarket } from "../../state/market";
import { useTrackers } from "../../state/trackers";
import { useActiveStatus, useWallet } from "../../state/wallet";
import { ActivityTable } from "./ActivityTable";
import { type Currency, DUST_SOL } from "./helpers";
import { Panel } from "./Panel";
import { PositionsTable } from "./PositionsTable";
import { BalancePanel, PerformancePanel, PnlPanel, type PnlRange, RANGE_LABEL } from "./SummaryPanels";

/*
 * Spot portfolio for the active trading wallet, or any wallet via ?wallet=<address>.
 * Layout follows Binance's Assets Overview (title, period toggle, balance, assets table with a
 * hide-small-assets switch) https://mobbin.com/screens/5acd0f5e-9019-4e1f-95e1-1446bbccd036
 * and Kraken Pro's home (hairline modules in a row, tabbed tables below)
 * https://mobbin.com/screens/fe204312-8607-4018-b0dd-a36dc71f4978
 */

const RANGES: { value: PnlRange; label: string }[] = (["7d", "30d", "max"] as const).map((value) => ({ value, label: RANGE_LABEL[value] }));

/** Another wallet's snapshot comes over REST; poll it so prices and PnL stay current. */
const VIEWED_REFRESH_MS = 10_000;
const PNL_REFRESH_MS = 30_000;

interface ViewedWallet {
  status: WalletStatus | null;
  loading: boolean;
  failed: boolean;
}

function useViewedWallet(address: string | null): ViewedWallet {
  const [loaded, setLoaded] = useState<{ address: string; status: WalletStatus | null; failed: boolean } | null>(null);
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    const load = () => {
      void getServices()
        .data.getWallet(address)
        .then(
          (status) => {
            if (!cancelled) setLoaded({ address, status, failed: false });
          },
          () => {
            // Keep the last good snapshot on a failed refresh.
            if (!cancelled) setLoaded((prev) => (prev?.address === address ? prev : { address, status: null, failed: true }));
          },
        );
    };
    load();
    const timer = setInterval(load, VIEWED_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [address]);
  const current = address !== null && loaded?.address === address ? loaded : null;
  return { status: current?.status ?? null, loading: address !== null && current === null, failed: current?.failed ?? false };
}

function usePnlHistory(address: string | null, range: PnlRange): { points: PnlPoint[] | null; loading: boolean } {
  const [loaded, setLoaded] = useState<{ address: string; range: PnlRange; points: PnlPoint[] } | null>(null);
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    const load = () => {
      void getServices()
        .data.getPnlHistory(address, range)
        .then(
          (points) => {
            if (!cancelled) setLoaded({ address, range, points });
          },
          () => {
            // Keep showing the previous series; the next refresh retries.
          },
        );
    };
    load();
    const timer = setInterval(load, PNL_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [address, range]);
  // While a new range loads the previous series stays up (same wallet), so the chart doesn't flash.
  const same = loaded !== null && loaded.address === address;
  return { points: same ? loaded.points : null, loading: !same || loaded.range !== range };
}

function WalletSearch({ onSubmit }: { onSubmit: (address: string) => void }) {
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!v) return;
    if (!isBase58Address(v)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setValue("");
    onSubmit(v);
  };
  return (
    <form onSubmit={submit} className="flex min-w-0 flex-1 flex-col gap-1 sm:w-72 sm:flex-none">
      <div className="relative">
        <Search className="icon-sm pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-fg-3" />
        <input
          type="text"
          enterKeyHint="search"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (invalid) setInvalid(false);
          }}
          placeholder="Search for other wallets..."
          aria-label="Search for other wallets by address"
          aria-invalid={invalid}
          spellCheck={false}
          autoComplete="off"
          className={cn("zf-input pl-8", invalid && "border-sell")}
        />
      </div>
      {invalid && <p className="text-label text-sell">Not a valid Solana address.</p>}
    </form>
  );
}

function TabButton({ active, onClick, count, children }: { active: boolean; onClick: () => void; count: number; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-sm px-2 text-data font-medium transition-colors",
        active ? "bg-surface-3 text-fg-1" : "text-fg-2 hover:text-fg-1",
      )}
    >
      {children}
      <span className="text-label font-normal text-fg-3">{fmtCount(count)}</span>
    </button>
  );
}

/*
 * Positions module: Active / History tabs, dust toggle and SOL/USD, after Binance's
 * "My Assets" toolbar (view tabs left, "Hide assets <1 USD" right)
 * https://mobbin.com/screens/5acd0f5e-9019-4e1f-95e1-1446bbccd036
 */
function PositionsSection({ positions, solUsd, own }: { positions: Position[]; solUsd: number; own: boolean }) {
  const [tab, setTab] = useState<"active" | "history">("active");
  const [showHidden, setShowHidden] = useState(false);
  const [currency, setCurrency] = useState<Currency>("SOL");

  const { active, history, hidden } = useMemo(() => {
    const open: Position[] = [];
    const closed: Position[] = [];
    let dust = 0;
    for (const p of positions) {
      if (p.closed) closed.push(p);
      else {
        open.push(p);
        if (p.valueSol < DUST_SOL) dust++;
      }
    }
    return { active: open, history: closed, hidden: dust };
  }, [positions]);

  const rows = useMemo(() => {
    if (tab === "history") return history;
    return showHidden ? active : active.filter((p) => p.valueSol >= DUST_SOL);
  }, [tab, active, history, showHidden]);

  let empty: string;
  if (tab === "history") empty = "No closed positions yet.";
  else if (active.length === 0) empty = own ? "No open positions. Buy from Pulse or a token page." : "No open positions.";
  else empty = `Only dust positions under ${DUST_SOL} SOL. Turn on Show hidden to see them.`;

  return (
    <section className="min-w-0 rounded-md border border-hairline bg-surface-1">
      <div className="flex min-h-8 flex-wrap items-center gap-2 border-b border-hairline px-3 py-1">
        <div role="tablist" aria-label="Positions" className="flex items-center gap-1">
          <TabButton active={tab === "active"} onClick={() => setTab("active")} count={active.length}>
            Active Positions
          </TabButton>
          <TabButton active={tab === "history"} onClick={() => setTab("history")} count={history.length}>
            History
          </TabButton>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {tab === "active" && (
            <button
              type="button"
              aria-pressed={showHidden}
              onClick={() => setShowHidden((v) => !v)}
              title={`Positions worth less than ${DUST_SOL} SOL are hidden by default`}
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-sm px-2 text-label transition-colors",
                showHidden ? "bg-surface-3 text-fg-1" : "text-fg-2 hover:text-fg-1",
              )}
            >
              {showHidden ? <Eye className="icon-sm" /> : <EyeOff className="icon-sm" />}
              Show hidden
              {hidden > 0 && <span className="text-fg-3">{fmtCount(hidden)}</span>}
            </button>
          )}
          <Segmented<Currency>
            value={currency}
            onChange={setCurrency}
            size="xs"
            label="Display currency"
            options={[
              { value: "SOL", label: "SOL" },
              { value: "USD", label: "USD", title: "Converted at the current SOL price" },
            ]}
          />
        </div>
      </div>
      {rows.length === 0 ? (
        <EmptyState title={empty} />
      ) : (
        <PositionsTable positions={rows} solUsd={solUsd} currency={currency} ownWallet={own} />
      )}
    </section>
  );
}

function dedupeActivity(items: ActivityItem[]): ActivityItem[] {
  const seen = new Set<string>();
  const out: ActivityItem[] = [];
  for (const a of items) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
  }
  return out;
}

function PortfolioBody({
  status,
  own,
  solUsd,
  range,
  pnl,
}: {
  status: WalletStatus;
  own: boolean;
  solUsd: number;
  range: PnlRange;
  pnl: { points: PnlPoint[] | null; loading: boolean };
}) {
  const activity = useMemo(() => dedupeActivity(status.activity), [status.activity]);
  return (
    <>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <BalancePanel status={status} solUsd={solUsd} own={own} />
        <PnlPanel points={pnl.points} loading={pnl.loading} range={range} className="md:order-last md:col-span-2 xl:order-none" />
        <PerformancePanel positions={status.positions} activity={activity} solUsd={solUsd} range={range} />
      </div>
      <PositionsSection positions={status.positions} solUsd={solUsd} own={own} />
      <Panel
        title="Activity"
        extra={activity.length > 0 && <span className="text-label text-fg-3">Latest {fmtCount(activity.length)}</span>}
      >
        <ActivityTable items={activity} />
      </Panel>
    </>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-hairline bg-surface-1">{children}</div>;
}

export default function PortfolioPage() {
  const [params, setParams] = useSearchParams();
  const activeAddress = useWallet((s) => s.activeAddress);
  const tradingWallets = useWallet((s) => s.service.tradingWallets);
  const setActive = useWallet((s) => s.setActive);
  const ownStatus = useActiveStatus();
  const solUsd = useMarket((s) => s.solUsd);
  const [range, setRange] = useState<PnlRange>("30d");

  const param = params.get("wallet")?.trim() || null;
  const viewing = param !== null && param !== activeAddress;
  const paramValid = param === null || isBase58Address(param);
  const viewed = useViewedWallet(viewing && paramValid ? param : null);
  const address = viewing ? (paramValid ? param : null) : activeAddress;
  const status = viewing ? viewed.status : ownStatus;
  const pnl = usePnlHistory(status ? address : null, range);

  const trackedName = useTrackers((s) => (viewing ? (s.wallets.find((w) => w.address === param)?.name ?? null) : null));
  const ownViewed = viewing ? tradingWallets.find((w) => !w.archived && w.address === param) : undefined;
  const activeLabel = tradingWallets.find((w) => w.address === activeAddress)?.label;

  const openWallet = (next: string) => setParams(next === activeAddress ? {} : { wallet: next });

  let body: ReactNode;
  if (viewing && !paramValid) {
    body = (
      <Notice>
        <EmptyState title="That isn't a valid Solana address." />
      </Notice>
    );
  } else if (!address) {
    body = (
      <Notice>
        <EmptyState
          title="No trading wallet yet."
          body="Search any wallet above, or"
          action={
            <Link to="/onboarding" className="text-fg-1 underline underline-offset-2">
              set one up
            </Link>
          }
        />
      </Notice>
    );
  } else if (!status) {
    const title =
      viewing && !viewed.loading ? (viewed.failed ? "Couldn't load this wallet." : "No data for this wallet.") : "Loading wallet…";
    body = (
      <Notice>
        <EmptyState title={title} />
      </Notice>
    );
  } else {
    body = <PortfolioBody status={status} own={!viewing} solUsd={solUsd} range={range} pnl={pnl} />;
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex min-w-0 flex-col gap-3 p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex h-6 items-center rounded-sm bg-surface-3 px-2 text-data font-medium text-fg-1">Spot</span>
            {viewing ? (
              <>
                <h1 className="flex min-w-0 items-center gap-1 text-title font-semibold">
                  Viewing
                  <span className="font-mono" title={param}>
                    {shortAddr(param, 4, 4)}
                  </span>
                  <CopyButton text={param} label="Copy wallet address" />
                </h1>
                {(ownViewed || trackedName) && <span className="truncate text-data text-fg-2">{ownViewed?.label ?? trackedName}</span>}
                {ownViewed && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setActive(ownViewed.address);
                      setParams({});
                    }}
                  >
                    Make active
                  </Button>
                )}
                <Link to="/portfolio" className="inline-flex items-center gap-1 text-data text-fg-2 hover:text-fg-1">
                  <ArrowLeft className="icon-sm" />
                  {activeAddress ? "Back to my wallet" : "Clear"}
                </Link>
              </>
            ) : (
              <h1 className="flex min-w-0 items-baseline gap-2 text-title font-semibold">
                Your holdings
                {activeLabel && <span className="truncate text-data font-normal text-fg-2">{activeLabel}</span>}
              </h1>
            )}
          </div>
          <div className="flex w-full min-w-0 items-start gap-2 sm:ml-auto sm:w-auto">
            <WalletSearch onSubmit={openWallet} />
            <Segmented<PnlRange> value={range} onChange={setRange} options={RANGES} label="Period" />
          </div>
        </div>
        {body}
      </div>
    </div>
  );
}
