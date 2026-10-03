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

export function LatencyBreakdownView({ latency, status }: { latency: LatencyBreakdown; status: "confirmed" | "failed" | null }) {
  const rows: { label: string; ms: number | null }[] = [
    { label: "Built (browser)", ms: latency.builtMs },
    { label: "Signed (browser)", ms: latency.signedMs },
    { label: "Received by server", ms: latency.receivedMs },
    ...latency.lanes.map((l) => ({ label: `Sent · ${l.lane}`, ms: l.sentMs })),
    { label: status === "failed" ? "Not landed" : "Landed", ms: latency.landedMs },
  ];
  const max = Math.max(1, ...rows.map((r) => r.ms ?? 0));
  return (
    <div className="space-y-1 text-[11px]">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[1fr_60px] items-center gap-2">
          <div>
            <div className="flex justify-between text-muted">
              <span className="truncate">{r.label}</span>
            </div>
            <div className="mt-0.5 h-1 rounded-full bg-elev">
              <div
                className={cn("h-1 rounded-full", r.ms === null ? "bg-sell/60" : "bg-accent")}
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
        <Timer size={12} /> No trades yet
      </span>
    );
  }
  return (
    <>
      <button ref={anchor} type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 hover:text-fg">
        <Timer size={12} />
        Last trade{" "}
        <span className={cn("font-semibold", status === "failed" ? "text-sell" : "text-fg")}>
          {status === "failed" ? "failed" : fmtMs(latency.landedMs)}
        </span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} width={300}>
        <div className="mb-2 text-xs font-semibold">Latency breakdown (click → landed)</div>
        <LatencyBreakdownView latency={latency} status={status} />
      </Popover>
    </>
  );
}

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
    <footer className="hidden h-7 shrink-0 items-center gap-3 border-t border-line bg-panel px-2 text-[11px] text-muted md:flex">
      <button
        type="button"
        onClick={() => setDocks({ tracker: !docks.tracker })}
        className={cn("flex items-center gap-1 rounded px-1.5 py-0.5 hover:text-fg", docks.tracker && "bg-elev text-fg")}
        aria-pressed={docks.tracker}
      >
        <Wallet size={12} /> Wallet tracker
        {unreadTrades > 0 && !docks.tracker && (
          <span className="rounded bg-violet/20 px-1 text-[9px] font-semibold text-violet">{Math.min(unreadTrades, 99)}</span>
        )}
      </button>
      <button
        type="button"
        onClick={() => setDocks({ social: !docks.social })}
        className={cn("flex items-center gap-1 rounded px-1.5 py-0.5 hover:text-fg", docks.social && "bg-elev text-fg")}
        aria-pressed={docks.social}
      >
        <XGlyph /> Social
        {unreadPosts > 0 && !docks.social && (
          <span className="rounded bg-info/20 px-1 text-[9px] font-semibold text-info">{Math.min(unreadPosts, 99)}</span>
        )}
      </button>
      <span className="h-3 w-px bg-line" />
      <Tooltip content={`Feed ${connection}. Ingest lag ${feed.lagMs} ms, ${feed.eventsPerSec} events/s. Lists refresh at ${hz} Hz.`}>
        <span className="flex items-center gap-1.5">
          <span
            className={cn("h-1.5 w-1.5 rounded-full", live ? "zf-live-dot bg-buy" : connection === "connecting" ? "bg-warn" : "bg-sell")}
          />
          <span className={live ? "text-fg" : ""}>{live ? "Live" : connection}</span>
          <span className="text-dim">
            · {hz} Hz · lag {feed.lagMs} ms · {feed.eventsPerSec} ev/s
          </span>
        </span>
      </Tooltip>
      <span className="flex items-center gap-1 text-dim">
        <Activity size={12} /> Slot {slot ? slot.toLocaleString("en-US") : "—"}
      </span>
      <span>
        SOL <span className="font-semibold text-fg">${solUsd.toFixed(2)}</span>
      </span>
      <LastLatency />
      <div className="ml-auto flex items-center gap-3">
        {armed > 0 && (
          <Link to="/orders" className="hover:text-fg">
            <span className="font-semibold text-accent">{armed}</span> armed
          </Link>
        )}
        {simulated && (
          <Tooltip content="All market data, wallets and fills are simulated in your browser. No network calls, no real funds.">
            <span className="rounded border border-warn/30 bg-warn/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warn">
              Simulated data
            </span>
          </Tooltip>
        )}
        <button type="button" onClick={() => setHelp(true)} className="flex items-center gap-1 hover:text-fg">
          <Keyboard size={12} /> Hotkeys
        </button>
      </div>
    </footer>
  );
}
