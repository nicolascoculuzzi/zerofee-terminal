import { ChevronDown, Info, type LucideIcon, Monitor, OctagonX, ShieldCheck } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { Button } from "../../components/ui/Button";
import { EmptyState, ProgressBar } from "../../components/ui/bits";
import { Modal } from "../../components/ui/Modal";
import { cn } from "../../lib/cn";
import { fmtCount, fmtSol, fmtUsd } from "../../lib/format";
import { panic } from "../../lib/tradeActions";
import { useMarket } from "../../state/market";
import { isOpenOrder, useOrders } from "../../state/orders";
import { useActiveStatus } from "../../state/wallet";
import { OrdersList } from "./OrdersList";

/*
 * Armed orders: pre-signed durable-nonce transactions the server holds (SPEC "Armed orders").
 * Page anatomy follows Coinbase Advanced's order management (filters left, destructive
 * "Cancel all" kept apart) https://mobbin.com/screens/e8bc99dd-2b98-4b12-95b3-5ca277255b09
 * with summary cells after Kraken Pro's account modules
 * https://mobbin.com/screens/fe204312-8607-4018-b0dd-a36dc71f4978
 */

const TAB_CLOSED = [
  "Limit buy/sell on a known token",
  "TP ladder + SL",
  "Stop-loss grid",
  "Trailing stop (within the grid's range)",
  "DCA tranches",
  "Dev-sell exits",
  "pump.fun migration snipe",
  "Copy-trade sells after the buy fills",
];

const BROWSER_OPEN = [
  "Copy-trade buys",
  "AFK filter snipes",
  "X contract-address snipes",
  "Dev-wallet snipes (the mint isn't known in advance)",
  "Re-arming",
  "Creating nonce slots",
  "Withdrawals",
  "Key export",
];

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 bg-panel p-3">
      <span className="zf-label">{label}</span>
      <span className="truncate text-xl font-semibold">{value}</span>
      <div className="min-h-4 text-xs text-muted">{sub}</div>
    </div>
  );
}

function NoteColumn({ icon: Icon, title, items, tone }: { icon: LucideIcon; title: string; items: string[]; tone: "buy" | "warn" }) {
  return (
    <div className="min-w-0">
      <h3 className={cn("flex items-center gap-1 text-sm font-medium", tone === "buy" ? "text-buy" : "text-warn")}>
        <Icon className="icon-sm" />
        {title}
      </h3>
      <ul className="mt-2 grid gap-x-4 gap-y-1 text-xs text-muted sm:grid-cols-2">
        {items.map((item) => (
          <li key={item} className="flex gap-2">
            <span className="mt-2 size-1 shrink-0 rounded-full bg-dim" />
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

const NOTE_KEY = "zerofee.orders.tabNote";

function readNoteOpen(): boolean {
  try {
    return localStorage.getItem(NOTE_KEY) !== "closed";
  } catch {
    return true;
  }
}

/* What keeps running without the browser, from SPEC "Armed orders" (two-column comparison). */
function TabClosedNote() {
  const [open, setOpen] = useState(readNoteOpen);
  return (
    <details
      open={open}
      onToggle={(e) => {
        const next = e.currentTarget.open;
        setOpen(next);
        try {
          localStorage.setItem(NOTE_KEY, next ? "open" : "closed");
        } catch {
          // Storage unavailable (private mode): the note just reopens next time.
        }
      }}
      className="group rounded-lg border border-line bg-panel"
    >
      <summary className="flex h-8 cursor-pointer list-none items-center gap-2 px-3 text-sm font-semibold [&::-webkit-details-marker]:hidden">
        <Info className="icon-sm text-dim" />
        What keeps running when you close this tab
        <ChevronDown className="icon-sm ml-auto text-dim transition-transform group-open:rotate-180" />
      </summary>
      <div className="flex flex-col gap-3 border-t border-line p-3">
        <p className="text-sm text-muted">
          Your browser pre-signs each order against a durable nonce, so it never expires. The server holds the signed transactions and
          submits one only when its trigger fires; it can't change the size, minimum output, fees or destination. Every order also stores a
          pre-signed cancel. Orders whose token isn't known in advance have to be built and signed live, so they need this browser open.
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          <NoteColumn icon={ShieldCheck} tone="buy" title="Runs with the tab closed" items={TAB_CLOSED} />
          <NoteColumn icon={Monitor} tone="warn" title="Needs the browser open" items={BROWSER_OPEN} />
        </div>
      </div>
    </details>
  );
}

/*
 * Kill-switch confirmation in the shared Modal (Linear's dialog anatomy: title row, body,
 * actions bottom-right) https://mobbin.com/screens/eddaff7c-37b8-4382-b53c-e4e09c1003d0
 * Focus starts on the safe choice.
 */
function PanicDialog({
  open,
  onClose,
  openCount,
  reservedSol,
}: {
  open: boolean;
  onClose: () => void;
  openCount: number;
  reservedSol: number;
}) {
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try {
      await panic();
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Panic"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="md" onClick={onClose} data-autofocus>
            Keep orders
          </Button>
          <Button variant="sell" size="md" disabled={busy} onClick={() => void confirm()}>
            {busy ? "Cancelling…" : "Cancel all and lock"}
          </Button>
        </div>
      }
    >
      <p className="text-base text-fg">Panic cancels every armed order and locks the keystore.</p>
      <ul className="mt-3 flex flex-col gap-1 text-sm text-muted">
        <li>
          Fires the stored pre-signed cancel for {fmtCount(openCount)} open order{openCount === 1 ? "" : "s"}; their nonces advance, so the
          signed transactions can never land.
        </li>
        <li>{fmtSol(reservedSol)} SOL reserved by those orders becomes spendable again.</li>
        <li>To trade or arm new orders afterwards, unlock the keystore and re-arm what you still want.</li>
      </ul>
    </Modal>
  );
}

export default function OrdersPage() {
  const byId = useOrders((s) => s.byId);
  const loaded = useOrders((s) => s.loaded);
  const status = useActiveStatus();
  const solUsd = useMarket((s) => s.solUsd);
  const [panicOpen, setPanicOpen] = useState(false);

  const orders = useMemo(() => Object.values(byId), [byId]);
  const { openCount, staleCount } = useMemo(() => {
    let openN = 0;
    let staleN = 0;
    for (const o of orders) {
      if (isOpenOrder(o)) openN++;
      if (o.status === "stale") staleN++;
    }
    return { openCount: openN, staleCount: staleN };
  }, [orders]);

  const reserved = status?.reservedSol ?? 0;
  const slots = status?.nonceSlots ?? null;
  const slotShare = slots && slots.total > 0 ? slots.used / slots.total : 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex min-w-0 flex-col gap-3 p-3 sm:p-4">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-lg font-semibold">Armed orders</h1>
          <p className="text-sm text-muted">Pre-signed on durable nonces. The server can submit them, never change them.</p>
        </header>

        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line lg:grid-cols-4">
          <Stat
            label="Open orders"
            value={fmtCount(openCount)}
            sub={staleCount > 0 ? <span className="text-warn">{fmtCount(staleCount)} need re-arm</span> : "None need re-arm"}
          />
          <Stat
            label="Reserved"
            value={status ? `${fmtSol(reserved)} SOL` : "—"}
            sub={status ? `${fmtUsd(reserved * solUsd)} held back from your balance` : "No trading wallet"}
          />
          <Stat
            label="Nonce slots"
            value={slots ? `${fmtCount(slots.used)} / ${fmtCount(slots.total)}` : "—"}
            sub={
              slots ? (
                <div className="flex items-center gap-2">
                  <ProgressBar
                    value={slotShare}
                    className="max-w-24"
                    color={slots.used >= slots.total ? "bg-sell" : slotShare >= 0.8 ? "bg-warn" : "bg-info"}
                  />
                  <span className="whitespace-nowrap">{fmtCount(Math.max(0, slots.total - slots.used))} free</span>
                </div>
              ) : (
                "No trading wallet"
              )
            }
          />
          <div className="flex min-w-0 flex-col justify-center gap-1 bg-panel p-3">
            <Button variant="danger" size="md" icon={<OctagonX className="icon-sm" />} onClick={() => setPanicOpen(true)}>
              Panic
            </Button>
            <span className="text-center text-2xs text-dim">Cancel all orders, lock keystore</span>
          </div>
        </div>

        <TabClosedNote />

        <section className="min-w-0 rounded-lg border border-line bg-panel">
          {loaded ? <OrdersList orders={orders} /> : <EmptyState title="Loading orders…" />}
        </section>
      </div>
      <PanicDialog open={panicOpen} onClose={() => setPanicOpen(false)} openCount={openCount} reservedSol={reserved} />
    </div>
  );
}
