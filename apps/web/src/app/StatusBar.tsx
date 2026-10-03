import { Activity, Keyboard, Timer, Wallet } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router";
import { XGlyph } from "../components/ui/bits";
import { Popover } from "../components/ui/Popover";
import { Tooltip } from "../components/ui/Tooltip";
import { cn } from "../lib/cn";
import { fmtMs } from "../lib/format";
import type { LatencyBreakdown } from "../protocol";
import { getServices } from "../services";
import { useMarket } from "../state/market";
import { isOpenOrder, useOrders } from "../state/orders";
import { useSettings } from "../state/settings";
import { useTrackers } from "../state/trackers";
import { useTrades } from "../state/trades";
import { useUi } from "../state/ui";

/** Waterfall of one trade's latency record: click → built → signed → received → sent per lane → landed. */
export function LatencyBreakdownView({ latency, status }: { latency: LatencyBreakdown; status: "confirmed" | "failed" | null }) {
  const rows: { label: string; ms: number | null }[] = [
    { label: "Built (browser)", ms: latency.builtMs },
    { label: "Signed (browser)", ms: latency.signedMs },
    { label: "Received by server", ms: latency.receivedMs },
    ...latency.lanes.map((l) => ({ label: `Sent: ${l.lane}`, ms: l.sentMs })),
    { label: status === "failed" ? "Not landed" : "Landed", ms: latency.landedMs },
  ];
  const max = Math.max(1, ...rows.map((r) => r.ms ?? 0));
  return (
    <div className="space-y-1 text-xs">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[1fr_64px] items-center gap-2">
          <div className="min-w-0">
            <div className="truncate text-muted">{r.label}</div>
            <div className="mt-1 h-1 rounded-full bg-elev">
              <div
                className={cn("h-1 rounded-full", r.ms === null ? "bg-sell" : "bg-info")}
                style={{ width: `${((r.ms ?? max) / max) * 100}%` }}
              />
            </div>
          </div>
          <span className="text-right font-mono">{r.ms === null ? "—" : `+${fmtMs(r.ms)}`}</span>
        </div>
      ))}
      {latency.slot !== null && <div className="pt-1 text-dim">Slot {latency.slot.toLocaleString("en-US")}</div>}
    </div>
  );
}

function LastLatency() {
  const latency = useTrades((s) => s.lastLatency);
  const status = useTrades((s) => s.lastLatencyStatus);
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!latency) {
    return (
      <span className="flex items-center gap-1 text-dim">
        <Timer className="icon-sm" /> No trades yet
      </span>
    );
  }
  return (
    <>
      <button ref={anchor} type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 hover:text-fg">
        <Timer className="icon-sm" />
        Last trade
        <span className={cn("font-semibold", status === "failed" ? "text-sell" : "text-fg")}>
          {status === "failed" ? "failed" : fmtMs(latency.landedMs)}
        </span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} width={296}>
        <div className="mb-2 text-sm font-semibold">Latency, click to landed</div>
        <LatencyBreakdownView latency={latency} status={status} />
      </Popover>
    </>
  );
}

function DockToggle({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn("flex h-5 items-center gap-1 rounded-sm px-2 hover:text-fg", active && "bg-elev text-fg")}
    >
      {children}
    </button>
  );
}

/*
 * Status bar after Kraken Pro's footer ("Online" state, quiet single-line telemetry):
 * https://mobbin.com/screens/7cef61a7-167f-4abd-ab8a-effc2538da6f
 */
export function StatusBar() {
  const connection = useMarket((s) => s.connection);
  const feed = useMarket((s) => s.feed);
  const solUsd = useMarket((s) => s.solUsd);
  const slot = useMarket((s) => s.slot);
  const hz = useSettings((s) => s.display.pulseHz);
  const docks = useSettings((s) => s.docks);
  const setDocks = useSettings((s) => s.setDocks);
  const unreadTrades = useTrackers((s) => s.unreadTrades);
  const unreadPosts = useTrackers((s) => s.unreadPosts);
  const armed = useOrders((s) => Object.values(s.byId).filter(isOpenOrder).length);
  const setHelp = useUi((s) => s.setHotkeysHelp);
  const live = connection === "live";
  const simulated = getServices().simulated;

  return (
    <footer className="hidden h-statusbar shrink-0 items-center gap-3 border-t border-line bg-panel px-2 text-xs text-muted md:flex">
      <DockToggle active={docks.tracker} onClick={() => setDocks({ tracker: !docks.tracker })}>
        <Wallet className="icon-sm" /> Wallet tracker
        {unreadTrades > 0 && !docks.tracker && (
          <span className="rounded-sm bg-elev px-1 text-2xs text-fg">{Math.min(unreadTrades, 99)}</span>
        )}
      </DockToggle>
      <DockToggle active={docks.social} onClick={() => setDocks({ social: !docks.social })}>
        <XGlyph /> Social
        {unreadPosts > 0 && !docks.social && <span className="rounded-sm bg-elev px-1 text-2xs text-fg">{Math.min(unreadPosts, 99)}</span>}
      </DockToggle>
      <span className="h-3 w-px bg-line" />
      <Tooltip content={`Feed ${connection}. Ingest lag ${feed.lagMs} ms, ${feed.eventsPerSec} events/s. Lists refresh at ${hz} Hz.`}>
        <span className="flex items-center gap-2">
          <span className={cn("size-2 rounded-full", live ? "zf-live-dot bg-buy" : connection === "connecting" ? "bg-warn" : "bg-sell")} />
          <span className={live ? "text-fg" : ""}>{live ? "Live" : connection}</span>
          <span className="text-dim">
            {hz} Hz · lag {feed.lagMs} ms · {feed.eventsPerSec.toFixed(1)} ev/s
          </span>
        </span>
      </Tooltip>
      <span className="flex items-center gap-1 text-dim">
        <Activity className="icon-sm" /> Slot {slot ? slot.toLocaleString("en-US") : "—"}
      </span>
      <span>
        SOL <span className="font-semibold text-fg">${solUsd.toFixed(2)}</span>
      </span>
      <LastLatency />
      <div className="ml-auto flex items-center gap-3">
        {armed > 0 && (
          <Link to="/orders" className="hover:text-fg">
            <span className="font-semibold text-fg">{armed}</span> armed
          </Link>
        )}
        {simulated && (
          <Tooltip content="All market data, wallets and fills are simulated in your browser. No network calls, no real funds.">
            <span className="rounded-sm border border-warn/40 px-1 text-2xs font-semibold tracking-wide text-warn uppercase">
              Simulated data
            </span>
          </Tooltip>
        )}
        <button type="button" onClick={() => setHelp(true)} className="flex items-center gap-1 hover:text-fg">
          <Keyboard className="icon-sm" /> Hotkeys
        </button>
      </div>
    </footer>
  );
}
