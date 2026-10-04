import { Rows3, Timer, Wallet } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { Link } from "react-router";
import { CountBadge, XGlyph } from "../components/ui/bits";
import { Segmented } from "../components/ui/controls";
import { Popover } from "../components/ui/Popover";
import { Tooltip } from "../components/ui/Tooltip";
import { cn } from "../lib/cn";
import { fmtCount, fmtInt, fmtMs, fmtUsdExact } from "../lib/format";
import { compactLabel } from "../lib/hotkeys";
import { useNow } from "../lib/useNow";
import { getServices } from "../services";
import { useBackend } from "../state/backend";
import { useMarket } from "../state/market";
import { isOpenOrder, useOrders } from "../state/orders";
import { type QuoteCurrency, useSettings } from "../state/settings";
import { useTrackers } from "../state/trackers";
import { useTrades } from "../state/trades";
import { useUi } from "../state/ui";
import { LatencyBreakdownView } from "./Latency";

export { LatencyBreakdownView } from "./Latency";

function Sep() {
  return <span aria-hidden="true" className="h-3 w-px shrink-0 bg-hairline" />;
}

function LastFill() {
  const latency = useTrades((s) => s.lastLatency);
  const status = useTrades((s) => s.lastLatencyStatus);
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!latency) {
    return (
      <span className="flex items-center gap-1">
        <Timer className="icon-xs" /> No fills yet
      </span>
    );
  }
  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 transition-colors hover:text-fg-1"
        title="Latency breakdown of the last trade"
      >
        <Timer className="icon-xs" />
        Last fill
        <span className={cn("zf-num", status === "failed" ? "text-sell" : "text-fg-1")}>
          {status === "failed" ? "failed" : fmtMs(latency.landedMs)}
        </span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} width={300} padding="form">
        <div className="mb-2 text-data font-semibold text-fg-1">Latency, click to landed</div>
        <LatencyBreakdownView latency={latency} status={status} />
      </Popover>
    </>
  );
}

function DockToggle({ active, onClick, children, label }: { active: boolean; onClick: () => void; children: ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      className={cn("flex h-5 items-center gap-1 rounded-xs px-1.5 transition-colors hover:text-fg-1", active && "bg-surface-3 text-fg-1")}
    >
      {children}
    </button>
  );
}

function SolUsd() {
  const solUsd = useMarket((s) => s.solUsd);
  const at = useMarket((s) => s.solUsdAt);
  const now = useNow();
  const age = Math.floor((now - at) / 1000);
  const stale = age > 60;
  return (
    <span className={cn("zf-num", stale ? "text-warn" : "text-fg-2")} title="SOL/USD used for every USD value">
      SOL/USD {fmtUsdExact(solUsd)}
      {stale && ` · stale ${age}s`}
    </span>
  );
}

/*
 * Bottom status bar (DESIGN.md 4.2): 24px, label type in text-3, hairline-separated groups, no
 * ticker tape. "● Online" at the left of a thin bar after Kraken Pro:
 * https://mobbin.com/screens/5bdd6cb2-5040-44c4-8781-c70f3aea60a8
 * Live state and Crypto/USD toggles in the status bar after OpenSea:
 * https://mobbin.com/screens/a2072a4d-d59f-4b22-92be-ddcc3100db61
 */
export function StatusBar() {
  const connection = useMarket((s) => s.connection);
  const feed = useMarket((s) => s.feed);
  const slot = useMarket((s) => s.slot);
  const hz = useSettings((s) => s.display.pulseHz);
  const quote = useSettings((s) => s.display.quote);
  const setDisplay = useSettings((s) => s.setDisplay);
  const docks = useSettings((s) => s.docks);
  const setDocks = useSettings((s) => s.setDocks);
  const unreadTrades = useTrackers((s) => s.unreadTrades);
  const unreadPosts = useTrackers((s) => s.unreadPosts);
  const armed = useOrders((s) => Object.values(s.byId).filter(isOpenOrder).length);
  const setHelp = useUi((s) => s.setHotkeysHelp);
  const quoteKey = useSettings((s) => compactLabel(s.hotkeys["quote.toggle"]?.[0]));
  const densityKey = useSettings((s) => compactLabel(s.hotkeys["density.toggle"]?.[0]));
  const simulated = getServices().simulated;
  const dryRun = useBackend((s) => s.dryRun === true);

  const live = connection === "live" && feed.state !== "degraded";
  const dot = live ? "bg-buy" : connection === "live" || connection === "connecting" ? "bg-warn" : "bg-sell";
  const stateLabel =
    connection === "live" ? (feed.state === "degraded" ? "Degraded" : "Live") : connection === "connecting" ? "Reconnecting" : "Offline";

  const toggleDensity = () => {
    const current = document.documentElement.dataset.density === "comfortable" ? "comfortable" : "compact";
    setDisplay({ density: current === "compact" ? "comfortable" : "compact" });
  };

  return (
    <footer className="hidden h-statusbar shrink-0 items-center gap-3 overflow-hidden border-t border-hairline bg-surface-1 px-2 text-label whitespace-nowrap text-fg-3 md:flex">
      <DockToggle label="Wallet tracker dock" active={docks.tracker} onClick={() => setDocks({ tracker: !docks.tracker })}>
        <Wallet className="icon-xs" /> Wallets
        {unreadTrades > 0 && !docks.tracker && <CountBadge count={unreadTrades > 99 ? "99+" : unreadTrades} />}
      </DockToggle>
      <DockToggle label="X feed dock" active={docks.social} onClick={() => setDocks({ social: !docks.social })}>
        <XGlyph />
        {unreadPosts > 0 && !docks.social && <CountBadge count={unreadPosts > 99 ? "99+" : unreadPosts} />}
      </DockToggle>
      <Sep />
      <Tooltip content={`Feed ${stateLabel.toLowerCase()}. Lists refresh at ${hz} Hz; ingest lag ${feed.lagMs} ms.`}>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className={cn("size-1.5 rounded-full", dot)} />
          <span className="text-fg-2">{stateLabel}</span>
          <span className="zf-num hidden xl:inline">
            {hz} Hz · lag <span className="inline-block w-[4ch] text-right">{fmtInt(feed.lagMs)}</span> ms ·{" "}
            <span className="inline-block w-[5ch] text-right">{fmtCount(Math.round(feed.eventsPerSec))}</span> ev/s
          </span>
        </span>
      </Tooltip>
      <span className="zf-num hidden xl:inline">Slot {slot ? fmtInt(slot) : "–"}</span>
      <SolUsd />
      <LastFill />

      <div className="ml-auto flex items-center gap-3">
        {armed > 0 && (
          <Link to="/orders" className="transition-colors hover:text-fg-1">
            <span className="zf-num text-fg-1">{armed}</span> armed
          </Link>
        )}
        <Segmented<QuoteCurrency>
          size="xs"
          value={quote}
          onChange={(q) => setDisplay({ quote: q })}
          options={[
            { value: "USD", label: "USD", title: quoteKey ? `Show values in USD (${quoteKey})` : "Show values in USD" },
            { value: "SOL", label: "SOL", title: quoteKey ? `Show values in SOL (${quoteKey})` : "Show values in SOL" },
          ]}
          label="Quote currency"
        />
        <button
          type="button"
          onClick={toggleDensity}
          title={densityKey ? `Toggle density (${densityKey})` : "Toggle density"}
          aria-label="Toggle density"
          className="flex items-center transition-colors hover:text-fg-1"
        >
          <Rows3 className="icon-xs" />
        </button>
        {simulated && (
          <Tooltip content="All market data, wallets and fills are simulated in your browser. No network calls, no real funds.">
            <span className="rounded-xs bg-warn-tint px-1 text-micro font-semibold text-warn">Simulated data</span>
          </Tooltip>
        )}
        {dryRun && (
          <Tooltip content="Live market data. The server simulates every transaction you submit and sends nothing on-chain (DRY_RUN).">
            <span className="rounded-xs bg-warn-tint px-1 text-micro font-semibold text-warn">Dry run</span>
          </Tooltip>
        )}
        <button type="button" onClick={() => setHelp(true)} className="flex items-center gap-1 transition-colors hover:text-fg-1">
          <span className="font-mono text-fg-2">?</span> Shortcuts
        </button>
      </div>
    </footer>
  );
}
