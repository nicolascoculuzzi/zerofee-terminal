import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Segmented } from "../../components/ui/controls";
import { cn } from "../../lib/cn";
import type { TokenDetail } from "../../protocol";
import { useMarket } from "../../state/market";
import { isOpenOrder, useOrders } from "../../state/orders";
import { useActiveStatus } from "../../state/wallet";
import { PositionsTable } from "../portfolio/PositionsTable";
import { HoldersTable, TopTradersTable } from "./HoldersTables";
import { TokenInfo } from "./TokenInfo";
import { TokenOrders } from "./TokenOrders";
import { TradesTable } from "./TradesTable";

type Tab = "trades" | "holders" | "traders" | "positions" | "orders" | "info";

/**
 * Bottom panel tabs (Trades, Holders, Top Traders, Positions, Orders), after Kraken Pro's
 * bottom tab strip https://mobbin.com/screens/7cef61a7-167f-4abd-ab8a-effc2538da6f.
 * `withInfo` adds the token-info grid as a tab on narrow screens.
 */
export function BottomTabs({ detail, withInfo = false }: { detail: TokenDetail; withInfo?: boolean }) {
  const [tab, setTab] = useState<Tab>("trades");
  const [currency, setCurrency] = useState<"SOL" | "USD">("SOL");
  const status = useActiveStatus();
  const solUsd = useMarket((s) => s.solUsd);
  const byId = useOrders((s) => s.byId);
  const mint = detail.summary.mint;
  const openForToken = useMemo(() => Object.values(byId).filter((o) => o.mint === mint && isOpenOrder(o)).length, [byId, mint]);
  const positions = useMemo(() => {
    const list = (status?.positions ?? []).filter((p) => !p.closed || p.mint === mint);
    return [...list].sort((a, b) => (a.mint === mint ? -1 : b.mint === mint ? 1 : b.lastTradeAt - a.lastTradeAt));
  }, [status, mint]);

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "trades", label: "Trades" },
    { id: "holders", label: "Holders", count: detail.summary.holders },
    { id: "traders", label: "Top Traders" },
    { id: "positions", label: "Positions", count: positions.filter((p) => !p.closed).length },
    { id: "orders", label: "Orders", count: openForToken },
    ...(withInfo ? [{ id: "info" as const, label: "Info" }] : []),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex h-9 shrink-0 items-end gap-1 overflow-x-auto border-b border-line px-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              "-mb-px flex h-9 shrink-0 items-center gap-1 border-b-2 px-2 text-sm font-medium",
              tab === t.id ? "border-fg text-fg" : "border-transparent text-muted hover:text-fg",
            )}
          >
            {t.label}
            {t.count !== undefined && t.count > 0 && <span className="text-xs text-dim">{t.count.toLocaleString("en-US")}</span>}
          </button>
        ))}
        {tab === "positions" && (
          <div className="mb-1 ml-auto shrink-0">
            <Segmented<"SOL" | "USD">
              size="xs"
              value={currency}
              onChange={setCurrency}
              options={[
                { value: "SOL", label: "SOL" },
                { value: "USD", label: "USD" },
              ]}
              label="Positions currency"
            />
          </div>
        )}
        {tab === "orders" && (
          <Link to="/orders" className="mb-2 ml-auto shrink-0 text-xs text-muted hover:text-fg">
            All armed orders
          </Link>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {tab === "trades" && <TradesTable />}
        {tab === "holders" && <HoldersTable holders={detail.holders} token={detail.summary} />}
        {tab === "traders" && <TopTradersTable traders={detail.topTraders} />}
        {tab === "positions" && (
          <div className="h-full overflow-auto">
            <PositionsTable positions={positions} solUsd={solUsd} currency={currency} highlightMint={mint} compact ownWallet />
          </div>
        )}
        {tab === "orders" && <TokenOrders mint={mint} />}
        {tab === "info" && (
          <div className="h-full overflow-auto">
            <TokenInfo detail={detail} />
          </div>
        )}
      </div>
    </div>
  );
}
