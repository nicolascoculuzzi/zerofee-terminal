import { type KeyboardEvent, useEffect, useRef } from "react";
import { cn } from "../../lib/cn";
import { fmtCount } from "../../lib/format";
import { compactLabel } from "../../lib/hotkeys";
import type { TokenDetail } from "../../protocol";
import { useSettings } from "../../state/settings";
import { useToken } from "../../state/token";
import { DevTokens } from "./DevTokens";
import { HoldersTable, TopTradersTable } from "./HoldersTables";
import { TokenInfo } from "./TokenInfo";
import { TokenOrders, useOpenOrderCount } from "./TokenOrders";
import { TokenPositions, useOpenPositionCount } from "./TokenPositions";
import { TradesTable } from "./TradesTable";
import { type BottomTab, useTokenUi } from "./tokenUi";

/*
 * Bottom panel tabs (DESIGN.md 4.8, 5.2): 32/36 px underline tabs, 12/500 labels, counts in
 * text-3 after the label ("Trades 1.2K"), the active tab text-1 with a 2 px accent bar. A
 * tablist with roving tabindex (Left/Right, Home/End); Shift+1…6 switch tabs. "Price chart |
 * Depth chart" underline tabs after Coinbase Advanced:
 * https://mobbin.com/screens/f8afc154-e5c8-4587-ab43-93c4799a979a
 */

export const TAB_ORDER: BottomTab[] = ["trades", "positions", "orders", "holders", "traders", "dev"];

const LABEL: Record<BottomTab, string> = {
  trades: "Trades",
  positions: "Positions",
  orders: "Orders",
  holders: "Holders",
  traders: "Top traders",
  dev: "Dev tokens",
  info: "Info",
};

export function BottomTabs({ detail, withInfo = false }: { detail: TokenDetail; withInfo?: boolean }) {
  const tab = useTokenUi((s) => s.tab);
  const setTab = useTokenUi((s) => s.setTab);
  const keys = useSettings((s) => s.hotkeys);
  const trades = useToken((s) => s.trades.length);
  const orders = useOpenOrderCount(detail.summary.mint);
  const positions = useOpenPositionCount();
  const tabs: BottomTab[] = withInfo ? [...TAB_ORDER, "info"] : TAB_ORDER;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const counts: Partial<Record<BottomTab, number>> = {
    trades,
    positions,
    orders,
    holders: detail.summary.holders,
  };

  // The Info tab only exists at 1024–1279 px; fall back when the layout drops it.
  useEffect(() => {
    if (!withInfo && tab === "info") setTab("trades");
  }, [withInfo, tab, setTab]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.indexOf(tab);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const t = tabs[next];
    if (t) {
      setTab(t);
      refs.current[next]?.focus();
    }
  };

  const panelId = `token-tab-${tab}`;
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-1">
      <div
        role="tablist"
        aria-label="Token tables"
        onKeyDown={onKey}
        className="flex h-panel-header shrink-0 items-stretch gap-1 overflow-x-auto border-b border-hairline px-2"
      >
        {tabs.map((t, i) => {
          const active = t === tab;
          const count = counts[t];
          const binding = i < 6 ? keys[`token.tab${i + 1}` as "token.tab1"]?.[0] : undefined;
          return (
            <button
              key={t}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`token-tab-btn-${t}`}
              aria-selected={active}
              aria-controls={`token-tab-${t}`}
              tabIndex={active ? 0 : -1}
              title={binding ? `${LABEL[t]} (${compactLabel(binding)})` : LABEL[t]}
              onClick={() => setTab(t)}
              className={cn(
                "focus-inset relative flex shrink-0 items-center gap-1 px-2 text-data font-medium whitespace-nowrap transition-colors",
                active ? "text-fg-1" : "text-fg-3 hover:text-fg-2",
              )}
            >
              {LABEL[t]}
              {count !== undefined && count > 0 && <span className="zf-num text-fg-3">{fmtCount(count)}</span>}
              {active && <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 bg-accent" />}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={panelId} aria-labelledby={`token-tab-btn-${tab}`} className="min-h-0 flex-1">
        {tab === "trades" && <TradesTable supply={detail.summary.supply} />}
        {tab === "positions" && <TokenPositions mint={detail.summary.mint} />}
        {tab === "orders" && <TokenOrders token={detail.summary} />}
        {tab === "holders" && <HoldersTable holders={detail.holders} token={detail.summary} />}
        {tab === "traders" && <TopTradersTable traders={detail.topTraders} />}
        {tab === "dev" && <DevTokens detail={detail} />}
        {tab === "info" && (
          <div className="h-full overflow-auto">
            <TokenInfo detail={detail} />
          </div>
        )}
      </div>
    </div>
  );
}
