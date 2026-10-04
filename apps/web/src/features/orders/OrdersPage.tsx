import { ListChecks } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/bits";
import { Hotkey } from "../../components/ui/controls";
import { HoldButton } from "../../components/ui/HoldButton";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import { fmtCount, fmtFee, fmtSol } from "../../lib/format";
import { registerHotkey } from "../../lib/hotkeys";
import { panic } from "../../lib/tradeActions";
import { BREAKPOINT, useMediaQuery } from "../../lib/useMediaQuery";
import type { Order, Position } from "../../protocol";
import { isOpenOrder, useOrders } from "../../state/orders";
import { useSettings } from "../../state/settings";
import { useUi } from "../../state/ui";
import { useActiveStatus } from "../../state/wallet";
import { PanelTabs, panelId, tabId } from "../portfolio/Tabs";
import { SkeletonRows, TABLE, Th } from "../portfolio/table";
import { useOrderQuoteFeed } from "./liveQuotes";
import { OrderDrawer } from "./OrderDrawer";
import { OrdersMobileList, OrdersTable } from "./OrdersTable";
import { canCancel, canRearm, groupByToken, NONCE_RENT_SOL, ORDER_TABS, type OrderTab, TAB_TEST, tabCounts, typeLabels } from "./orderText";
import { useOrderActions } from "./useOrderActions";

/**
 * Nonce meter (DESIGN.md 4.20): "Nonce slots 7/10", a 64 × 4 px bar (accent on surface-3), the
 * rent the nonce accounts hold, and "Manage" (Settings > Wallets and security > Nonce slots).
 */
function NonceMeter({ used, total }: { used: number; total: number }) {
  const openSettings = useUi((s) => s.openSettings);
  const share = total > 0 ? Math.min(1, used / total) : 0;
  return (
    <div className="flex items-center gap-2 text-data">
      <Tooltip content="Durable-nonce accounts: each armed order holds one (an OCO pair shares one). Cancelling or filling frees it.">
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so keyboard users get the definition */}
        <span tabIndex={0} className="zf-metric rounded-xs text-fg-2">
          Nonce slots{" "}
          <span className="zf-num text-fg-1">
            {fmtCount(used)}/{fmtCount(total)}
          </span>
        </span>
      </Tooltip>
      {/* The "7/10" text carries the value; the bar repeats it visually. */}
      <span aria-hidden="true" className="h-1 w-16 overflow-hidden rounded-xs bg-surface-3">
        <span className="block h-full bg-accent" style={{ width: `${share * 100}%` }} />
      </span>
      <Tooltip content={`${fmtCount(total)} nonce accounts × ${fmtFee(NONCE_RENT_SOL)} SOL, refundable when a slot is closed`}>
        <span className="zf-num text-fg-3">{fmtFee(total * NONCE_RENT_SOL)} SOL rent</span>
      </Tooltip>
      <Button size="xs" variant="ghost" onClick={() => openSettings("security")}>
        Manage
      </Button>
    </div>
  );
}

/**
 * Panic in the header (DESIGN.md 4.20, 1.7): danger styling, a 1,000 ms hold, and the label
 * that names the outcome. The hold is the confirmation; the button re-arms once Panic settles.
 */
function PanicHold({ openCount, className }: { openCount: number; className?: string }) {
  const binding = useSettings((s) => s.hotkeys.panic?.[0]);
  return (
    <Tooltip
      content={
        <span className="block">
          <span className="block">
            Fires the pre-signed cancel for {openCount === 1 ? "the open order" : `all ${fmtCount(openCount)} open orders`} and locks the
            keystore.
          </span>
          <span className="mt-1 inline-flex items-center gap-2 text-fg-3">
            Or press <Hotkey binding={binding} /> for the dialog
          </span>
        </span>
      }
    >
      <HoldButton className={className} onConfirm={panic}>
        Hold to cancel all and lock
      </HoldButton>
    </Tooltip>
  );
}

/*
 * Armed orders (DESIGN.md 5.7, 4.20): a 48 px header strip (title, summary, nonce meter, Panic),
 * status tabs with counts, then the grouped data grid; clicking a row opens the 560 px drawer.
 * Status tabs with counts after Square's orders: https://mobbin.com/screens/14618499-6730-4721-9822-bad566504229
 * Dot + label + duration statuses after Vercel: https://mobbin.com/screens/e9576405-bcef-419a-922a-8fb84b044a54
 * Severity tints (warn and sell only where they mean something) after Railway:
 * https://mobbin.com/screens/ea8d53dc-8270-430d-bbdd-1df73b4ca531
 */
export default function OrdersPage() {
  const navigate = useNavigate();
  const byId = useOrders((s) => s.byId);
  const loaded = useOrders((s) => s.loaded);
  const status = useActiveStatus();
  const mobile = !useMediaQuery(BREAKPOINT.md);
  const [tab, setTab] = useState<OrderTab>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const all = useMemo(() => Object.values(byId), [byId]);
  const openMints = useMemo(() => all.filter((o) => isOpenOrder(o) && o.mint).map((o) => o.mint as string), [all]);
  useOrderQuoteFeed(openMints);
  const labels = useMemo(() => typeLabels(all), [all]);
  const counts = useMemo(() => tabCounts(all), [all]);
  const groups = useMemo(() => groupByToken(all.filter(TAB_TEST[tab])), [all, tab]);
  const positions = useMemo(() => {
    const m = new Map<string, Position>();
    for (const p of status?.positions ?? []) m.set(p.mint, p);
    return m;
  }, [status]);
  const actions = useOrderActions(labels);
  const { requestCancel, rearm } = actions;

  const armedCount = counts.armed;
  const openCount = counts.armed + counts.rearm;
  const reserved = status?.reservedSol ?? 0;
  const slots = status?.nonceSlots ?? null;
  const selected = selectedId ? (byId[selectedId] ?? null) : null;
  const drawerOrder = openId ? (byId[openId] ?? null) : null;

  // Orders keys (DESIGN.md 6.4): Delete cancels the selected order (confirm), R re-arms it.
  useEffect(() => {
    const offs = [
      registerHotkey("orders.cancel", () => {
        if (selected && canCancel(selected)) requestCancel([selected]);
      }),
      registerHotkey("orders.rearm", () => {
        if (selected && canRearm(selected)) rearm(selected);
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [selected, requestCancel, rearm]);

  const onSelect = useCallback((o: Order) => setSelectedId(o.id), []);
  const onOpen = useCallback((o: Order) => {
    setSelectedId(o.id);
    setOpenId(o.id);
  }, []);

  const tabs = ORDER_TABS.map((t) => ({ id: t.id, label: t.label, count: counts[t.id], attention: t.id === "rearm" && counts.rearm > 0 }));
  const emptyAll = (
    <EmptyState
      className="text-balance"
      icon={<ListChecks />}
      title="No armed orders"
      body="Arm a limit, take-profit or stop-loss from any token page."
      action={
        <Button variant="secondary" size="sm" onClick={() => navigate("/pulse")}>
          Open Pulse
        </Button>
      }
    />
  );
  const emptyTab = (
    <EmptyState
      className="text-balance"
      title={`No ${ORDER_TABS.find((t) => t.id === tab)?.label.toLowerCase() ?? ""} orders`}
      body="Orders move between these tabs as their status changes."
    />
  );

  const summary = (
    <p className="text-data whitespace-nowrap text-fg-2">
      <span className="zf-num">{fmtCount(armedCount)}</span> armed
      {counts.rearm > 0 && (
        <>
          {" · "}
          <span className="zf-num text-warn">{fmtCount(counts.rearm)}</span> need re-arm
        </>
      )}
      {" · "}
      <span className="zf-num">{fmtSol(reserved)}</span> SOL reserved
    </p>
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-bg md:overflow-hidden">
      <header
        className={cn(
          "flex shrink-0 border-b border-hairline bg-surface-1 px-3",
          mobile ? "flex-col gap-2 py-3" : "h-12 items-center gap-4 overflow-x-auto",
        )}
      >
        <h1 className="text-heading font-semibold whitespace-nowrap text-fg-1">Armed orders</h1>
        {summary}
        {slots && <NonceMeter used={slots.used} total={slots.total} />}
        <div className={cn(mobile ? "pt-1" : "ml-auto shrink-0")}>
          <PanicHold openCount={openCount} className={mobile ? "h-11! w-full" : undefined} />
        </div>
      </header>
      <section aria-label="Orders" className="flex min-h-0 flex-1 flex-col bg-surface-1">
        <PanelTabs base="orders" tabs={tabs} value={tab} onChange={setTab} label="Order status" />
        <div role="tabpanel" id={panelId("orders", tab)} aria-labelledby={tabId("orders", tab)} className="flex min-h-0 flex-1 flex-col">
          {!loaded ? (
            <table className={TABLE} aria-label="Armed orders" aria-busy="true">
              <thead>
                <tr>
                  <Th>Status</Th>
                  <Th>Type</Th>
                  <Th>Trigger</Th>
                  <Th align="right">Distance</Th>
                  <Th>Size</Th>
                </tr>
              </thead>
              <tbody>
                <SkeletonRows rows={6} cells={["text", "text", "text", "num", "text"]} rowClassName="h-[calc(var(--zf-row)+4px)]" />
              </tbody>
            </table>
          ) : mobile ? (
            <OrdersMobileList groups={groups} labels={labels} onOpen={onOpen} empty={counts.all === 0 ? emptyAll : emptyTab} />
          ) : (
            <OrdersTable
              groups={groups}
              labels={labels}
              positions={positions}
              rearming={actions.rearming}
              selectedId={selectedId}
              onSelect={onSelect}
              onOpen={onOpen}
              onCancel={requestCancel}
              onRearm={rearm}
              empty={counts.all === 0 ? emptyAll : emptyTab}
            />
          )}
        </div>
      </section>
      <OrderDrawer
        order={drawerOrder}
        label={drawerOrder ? (labels.get(drawerOrder.id) ?? drawerOrder.kind) : ""}
        rearming={drawerOrder ? actions.rearming.has(drawerOrder.id) : false}
        onClose={() => setOpenId(null)}
        onCancel={(o) => requestCancel([o])}
        onRearm={rearm}
      />
      {actions.dialog}
    </div>
  );
}
