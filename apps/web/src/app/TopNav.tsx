import { ChevronDown, Lock, LockOpen, Search, Settings, ShieldAlert, ShieldCheck, Zap } from "lucide-react";
import { useRef, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router";
import { Button, IconButton } from "../components/ui/Button";
import { Hotkey, NumberInput, Segmented } from "../components/ui/controls";
import { Popover } from "../components/ui/Popover";
import { Tooltip } from "../components/ui/Tooltip";
import { cn } from "../lib/cn";
import { fmtSol, shortAddr } from "../lib/format";
import { LANDING_INFO } from "../lib/landing";
import { getServices } from "../services";
import { isOpenOrder, useOrders } from "../state/orders";
import { PRESET_IDS, type PresetId, useSettings } from "../state/settings";
import { useUi } from "../state/ui";
import { useWallet } from "../state/wallet";
import { Logo } from "./Logo";

/*
 * Top bar anatomy follows Coinbase Advanced's header (product nav left, search, account
 * actions right; flat bar on a hairline) https://mobbin.com/screens/ff785484-4dd2-4fc0-a5f4-658e033b3b08
 * and Kraken Pro's ticker header https://mobbin.com/screens/ed2976fc-9aa3-45bd-a5af-5f42f8fb76e0
 */

export const NAV_ITEMS = [
  { to: "/discover", label: "Discover" },
  { to: "/pulse", label: "Pulse" },
  { to: "/trackers", label: "Trackers" },
  { to: "/portfolio", label: "Portfolio" },
] as const;

export function LandingIndicator() {
  const preset = useSettings((s) => s.presets[s.activePreset]);
  const openSettings = useUi((s) => s.openSettings);
  const info = LANDING_INFO[preset.buy.landing];
  const Icon = info.risky ? ShieldAlert : ShieldCheck;
  return (
    <Tooltip
      content={
        <span className="block space-y-1">
          <span className="block font-semibold">
            Landing preset: {info.label} ({preset.id})
          </span>
          <span className="block text-muted">Route: {info.route}</span>
          <span className="block text-muted">Tip: {info.tip}</span>
          <span className={cn("block", info.risky ? "text-warn" : "text-muted")}>{info.note}</span>
        </span>
      }
    >
      <button
        type="button"
        onClick={() => openSettings("presets")}
        className={cn(
          "flex h-7 items-center gap-1 rounded-md border px-2 text-xs hover:bg-hover",
          info.risky ? "border-warn/40 text-warn" : "border-line text-muted",
        )}
        aria-label={`Landing preset ${info.label}`}
      >
        <Icon className="icon-sm" />
        <span className="font-medium">{info.label}</span>
      </button>
    </Tooltip>
  );
}

export function QuickBuyControl() {
  const quickBuy = useSettings((s) => s.quickBuySol);
  const setQuickBuy = useSettings((s) => s.setQuickBuy);
  const active = useSettings((s) => s.activePreset);
  const setActive = useSettings((s) => s.setActivePreset);
  return (
    <div className="flex items-center gap-1">
      <Tooltip content="Quick-buy amount used by every buy pill (columns can override it)">
        <NumberInput
          value={quickBuy}
          onChange={(v) => setQuickBuy(v ?? 0)}
          prefix={<Zap className="icon-sm" />}
          suffix="SOL"
          min={0}
          alignRight
          className="w-28"
          ariaLabel="Quick buy amount in SOL"
        />
      </Tooltip>
      <Segmented<PresetId>
        value={active}
        onChange={setActive}
        options={PRESET_IDS.map((p) => ({ value: p, label: p, title: `Preset ${p}` }))}
        label="Active preset"
      />
    </div>
  );
}

function WalletMenu() {
  const navigate = useNavigate();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const service = useWallet((s) => s.service);
  const activeAddress = useWallet((s) => s.activeAddress);
  const setActive = useWallet((s) => s.setActive);
  const status = useWallet((s) => s.status);
  const openFund = useUi((s) => s.openFund);
  const requestUnlock = useUi((s) => s.requestUnlock);
  const wallets = service.tradingWallets.filter((w) => !w.archived);
  const active = wallets.find((w) => w.address === activeAddress);
  const balance = activeAddress ? (status[activeAddress]?.solBalance ?? 0) : 0;
  const locked = service.locked;

  if (!service.connected || wallets.length === 0) {
    return (
      <Button variant="primary" size="md" onClick={() => navigate("/onboarding")}>
        Connect wallet
      </Button>
    );
  }

  const go = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 shrink-0 items-center gap-2 rounded-md border border-line px-2 text-sm whitespace-nowrap hover:bg-hover"
        aria-label="Trading wallet"
      >
        {locked ? <Lock className="icon-sm text-warn" /> : <LockOpen className="icon-sm text-muted" />}
        <span className="hidden max-w-20 truncate text-muted lg:inline">{active?.label ?? "Wallet"}</span>
        <span className="font-semibold">{fmtSol(balance)} SOL</span>
        <ChevronDown className="icon-sm text-dim" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} align="end" width={296}>
        <div className="space-y-2">
          <div className="zf-label px-1">Trading wallets</div>
          <div>
            {wallets.map((w) => {
              const st = status[w.address];
              const isActive = w.address === activeAddress;
              return (
                <button
                  key={w.id}
                  type="button"
                  onClick={go(() => setActive(w.address))}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-hover",
                    isActive && "bg-hover",
                  )}
                >
                  <span className={cn("size-2 rounded-full", isActive ? "bg-fg" : "bg-line-strong")} />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{w.label}</span>
                    <span className="block font-mono text-2xs text-dim">{shortAddr(w.address, 6, 6)}</span>
                  </span>
                  <span className="text-right">
                    <span className="block font-semibold">{fmtSol(st?.solBalance ?? 0)} SOL</span>
                    {st && st.reservedSol > 0 && <span className="block text-2xs text-dim">{fmtSol(st.reservedSol)} reserved</span>}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex items-center justify-between border-t border-line px-1 pt-2 text-sm">
            <span className="flex items-center gap-1 text-muted">
              {locked ? <Lock className="icon-sm text-warn" /> : <LockOpen className="icon-sm" />}
              {locked ? "Keystore locked" : "Keystore unlocked"}
            </span>
            {locked ? (
              <Button size="xs" variant="primary" onClick={go(() => requestUnlock("Unlock your trading wallet"))}>
                Unlock
              </Button>
            ) : (
              <Button size="xs" variant="outline" onClick={() => getServices().wallet.lock()}>
                Lock now
              </Button>
            )}
          </div>
          <div className="px-1 text-xs text-dim">
            Connected <span className="text-muted capitalize">{service.connected.provider}</span>{" "}
            <span className="font-mono">{shortAddr(service.connected.address, 4, 4)}</span>
            {service.session ? " · signed in" : <span className="text-warn"> · not signed in</span>}
          </div>
          <div className="grid grid-cols-3 gap-1 border-t border-line pt-2">
            <Button size="sm" variant="subtle" onClick={go(() => openFund("fund"))}>
              Fund
            </Button>
            <Button size="sm" variant="subtle" onClick={go(() => openFund("withdraw"))}>
              Withdraw
            </Button>
            <Button size="sm" variant="subtle" onClick={go(() => navigate("/onboarding"))}>
              New wallet
            </Button>
          </div>
        </div>
      </Popover>
    </>
  );
}

export function ModeSwitch() {
  const mode = useWallet((s) => s.mode);
  const setMode = useWallet((s) => s.setMode);
  return (
    <Tooltip
      content={
        mode === "instant"
          ? "Instant: the trading wallet in this browser signs with no popup."
          : "Direct: your connected wallet approves every trade in a popup. Slower, no hot wallet."
      }
    >
      <Segmented
        value={mode}
        onChange={setMode}
        options={[
          { value: "instant", label: "Instant" },
          { value: "direct", label: "Direct" },
        ]}
        label="Trading mode"
      />
    </Tooltip>
  );
}

function NavItem({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "flex h-full items-center gap-1 border-b-2 px-2 text-sm font-medium transition-colors",
          isActive ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg",
        )
      }
    >
      {children}
    </NavLink>
  );
}

export function TopNav() {
  const openSearch = useUi((s) => s.openSearch);
  const openSettings = useUi((s) => s.openSettings);
  const openFund = useUi((s) => s.openFund);
  const searchBinding = useSettings((s) => s.hotkeys["search.open"][0]);
  const armed = useOrders((s) => Object.values(s.byId).filter(isOpenOrder).length);

  return (
    <header className="flex h-topbar shrink-0 items-center gap-2 border-b border-line bg-panel px-2 sm:px-3">
      <Link to="/pulse" className="mr-2 shrink-0" aria-label="zerofee home">
        {/* The wordmark hides on phones; the mark stays. */}
        <Logo wordmarkClassName="hidden sm:inline" />
      </Link>
      <nav className="hidden h-full items-stretch md:flex" aria-label="Main">
        {NAV_ITEMS.map((n) => (
          <NavItem key={n.to} to={n.to}>
            {n.label}
          </NavItem>
        ))}
        <NavItem to="/orders">
          Orders
          {armed > 0 && <span className="rounded-sm bg-elev px-1 text-2xs font-semibold text-fg">{armed}</span>}
        </NavItem>
      </nav>

      <button
        type="button"
        onClick={() => openSearch(true)}
        className="ml-2 hidden h-7 max-w-80 min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-bg px-2 text-sm text-dim hover:border-line-strong md:flex"
      >
        <Search className="icon-sm" />
        <span className="truncate">Search name, ticker, CA or wallet</span>
        <span className="ml-auto">
          <Hotkey binding={searchBinding} />
        </span>
      </button>
      <IconButton label="Search" size="md" className="md:hidden" onClick={() => openSearch(true)}>
        <Search className="icon-md" />
      </IconButton>

      <div className="ml-auto flex items-center gap-2">
        <div className="hidden xl:block">
          <QuickBuyControl />
        </div>
        <div className="hidden lg:block">
          <LandingIndicator />
        </div>
        <div className="hidden lg:block">
          <ModeSwitch />
        </div>
        <WalletMenu />
        {/* Wrapped: Button's own inline-flex would beat a "hidden" passed through className. */}
        <div className="hidden sm:block">
          <Button variant="primary" size="md" onClick={() => openFund("fund")}>
            Fund
          </Button>
        </div>
        <IconButton label="Settings" size="md" onClick={() => openSettings()}>
          <Settings className="icon-md" />
        </IconButton>
      </div>
    </header>
  );
}
