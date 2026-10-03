import { ChevronDown, Lock, LockOpen, Search, Settings, ShieldCheck, Zap } from "lucide-react";
import { useRef, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router";
import { Button, IconButton } from "../components/ui/Button";
import { Hotkey, NumberInput, Segmented } from "../components/ui/controls";
import { Popover } from "../components/ui/Popover";
import { Tooltip } from "../components/ui/Tooltip";
import { cn } from "../lib/cn";
import { fmtSol, shortAddr } from "../lib/format";
import { getServices } from "../services";
import { isOpenOrder, useOrders } from "../state/orders";
import { PRESET_IDS, type PresetId, useSettings } from "../state/settings";
import { useUi } from "../state/ui";
import { useWallet } from "../state/wallet";
import { Logo } from "./Logo";

export const NAV_ITEMS = [
  { to: "/discover", label: "Discover" },
  { to: "/pulse", label: "Pulse" },
  { to: "/trackers", label: "Trackers" },
  { to: "/portfolio", label: "Portfolio" },
] as const;

const LANDING_INFO = {
  reduced: {
    label: "Reduced",
    tone: "text-buy",
    route: "Helius Sender with swqos_only + mev-protect",
    tip: "0.000005 SOL + priority-fee estimate (clamped)",
    note: "Default. MEV-protected route at minimal cost.",
  },
  secure: {
    label: "Secure",
    tone: "text-info",
    route: "Jito bundle-only with a jitodontfront account",
    tip: "max(1,000 lamports, live Jito p50–p75)",
    note: "Strongest sandwich protection; only works when the tx actually goes through Jito.",
  },
  fast: {
    label: "Fast",
    tone: "text-warn",
    route: "Sender Max: all lanes in parallel",
    tip: "0.001 SOL",
    note: "Fastest landing. Not protected: expect sandwich risk on large buys.",
  },
} as const;

export function LandingIndicator() {
  const preset = useSettings((s) => s.presets[s.activePreset]);
  const openSettings = useUi((s) => s.openSettings);
  const info = LANDING_INFO[preset.buy.landing];
  return (
    <Tooltip
      content={
        <span className="block space-y-1">
          <span className="block font-semibold">
            Landing preset · {info.label} ({preset.id})
          </span>
          <span className="block text-muted">Route: {info.route}</span>
          <span className="block text-muted">Tip: {info.tip}</span>
          <span className={cn("block", preset.buy.landing === "fast" ? "text-warn" : "text-muted")}>{info.note}</span>
        </span>
      }
    >
      <button
        type="button"
        onClick={() => openSettings("presets")}
        className="flex h-7 items-center gap-1 rounded-md border border-line px-2 text-[11px] hover:bg-hover"
        aria-label={`Landing preset ${info.label}`}
      >
        <ShieldCheck size={13} className={info.tone} />
        <span className={cn("font-medium", info.tone)}>{info.label}</span>
      </button>
    </Tooltip>
  );
}

export function QuickBuyControl({ compact }: { compact?: boolean }) {
  const quickBuy = useSettings((s) => s.quickBuySol);
  const setQuickBuy = useSettings((s) => s.setQuickBuy);
  const active = useSettings((s) => s.activePreset);
  const setActive = useSettings((s) => s.setActivePreset);
  return (
    <div className="flex items-center gap-1">
      <Tooltip content="Global quick-buy amount used by ⚡ buttons (columns can override it)">
        <NumberInput
          value={quickBuy}
          onChange={(v) => setQuickBuy(v ?? 0)}
          prefix={<Zap size={12} className="text-accent" />}
          suffix="SOL"
          min={0}
          className={compact ? "w-[86px]" : "w-[104px]"}
          ariaLabel="Quick buy amount in SOL"
        />
      </Tooltip>
      <Segmented<PresetId>
        value={active}
        onChange={setActive}
        options={PRESET_IDS.map((p) => ({ value: p, label: p, title: `Preset ${p}` }))}
        tone={() => "accent"}
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
      <Button variant="primary" size="sm" onClick={() => navigate("/onboarding")}>
        Connect wallet
      </Button>
    );
  }

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 items-center gap-1.5 rounded-md border border-line bg-panel-2 px-2 text-xs hover:bg-hover"
        aria-label="Trading wallet"
      >
        {locked ? <Lock size={12} className="text-warn" /> : <LockOpen size={12} className="text-buy" />}
        <span className="hidden max-w-[80px] truncate text-muted lg:inline">{active?.label ?? "Wallet"}</span>
        <span className="font-semibold">◎ {fmtSol(balance)}</span>
        <ChevronDown size={12} className="text-dim" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} align="end" width={290}>
        <div className="space-y-2">
          <div className="zf-label px-1">Trading wallets</div>
          <div className="space-y-0.5">
            {wallets.map((w) => {
              const st = status[w.address];
              return (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => {
                    setActive(w.address);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-hover",
                    w.address === activeAddress && "bg-elev",
                  )}
                >
                  <span className={cn("h-1.5 w-1.5 rounded-full", w.address === activeAddress ? "bg-accent" : "bg-line-strong")} />
                  <span className="flex-1">
                    <span className="block font-medium">{w.label}</span>
                    <span className="block font-mono text-[10px] text-dim">{shortAddr(w.address, 6, 6)}</span>
                  </span>
                  <span className="text-right">
                    <span className="block font-semibold">◎ {fmtSol(st?.solBalance ?? 0)}</span>
                    {st && st.reservedSol > 0 && <span className="block text-[10px] text-dim">{fmtSol(st.reservedSol)} reserved</span>}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex items-center justify-between rounded-md border border-line px-2 py-1.5 text-xs">
            <span className="flex items-center gap-1.5">
              {locked ? <Lock size={12} className="text-warn" /> : <LockOpen size={12} className="text-buy" />}
              {locked ? "Keystore locked" : "Keystore unlocked"}
            </span>
            {locked ? (
              <Button size="xs" variant="primary" onClick={() => requestUnlock("Unlock your trading wallet")}>
                Unlock
              </Button>
            ) : (
              <Button size="xs" variant="outline" onClick={() => getServices().wallet.lock()}>
                Lock now
              </Button>
            )}
          </div>
          <div className="rounded-md bg-panel-2 px-2 py-1.5 text-[11px] text-muted">
            Connected: <span className="capitalize text-fg">{service.connected.provider}</span>{" "}
            <span className="font-mono">{shortAddr(service.connected.address, 4, 4)}</span>
            {service.session ? <span className="ml-1 text-buy">· signed in</span> : <span className="ml-1 text-warn">· not signed in</span>}
          </div>
          <div className="grid grid-cols-3 gap-1">
            <Button
              size="xs"
              variant="subtle"
              onClick={() => {
                setOpen(false);
                openFund("fund");
              }}
            >
              Fund
            </Button>
            <Button
              size="xs"
              variant="subtle"
              onClick={() => {
                setOpen(false);
                openFund("withdraw");
              }}
            >
              Withdraw
            </Button>
            <Button
              size="xs"
              variant="subtle"
              onClick={() => {
                setOpen(false);
                navigate("/onboarding");
              }}
            >
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
        tone={(v) => (v === "instant" ? "accent" : "neutral")}
        label="Trading mode"
      />
    </Tooltip>
  );
}

export function TopNav() {
  const openSearch = useUi((s) => s.openSearch);
  const openSettings = useUi((s) => s.openSettings);
  const openFund = useUi((s) => s.openFund);
  const searchBinding = useSettings((s) => s.hotkeys["search.open"][0]);
  const armed = useOrders((s) => Object.values(s.byId).filter(isOpenOrder).length);

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-panel px-2 sm:px-3">
      <Link to="/pulse" className="mr-1 shrink-0" aria-label="zerofee home">
        <Logo className="hidden sm:inline-flex" />
        <Logo compact className="sm:hidden" />
      </Link>
      <nav className="hidden items-center gap-0.5 md:flex" aria-label="Main">
        {NAV_ITEMS.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            className={({ isActive }) =>
              cn(
                "rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors",
                isActive ? "bg-elev text-fg" : "text-muted hover:text-fg",
              )
            }
          >
            {n.label}
          </NavLink>
        ))}
        <NavLink
          to="/orders"
          className={({ isActive }) =>
            cn(
              "flex items-center gap-1 rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors",
              isActive ? "bg-elev text-fg" : "text-muted hover:text-fg",
            )
          }
        >
          Orders
          {armed > 0 && <span className="rounded bg-accent/15 px-1 text-[10px] font-semibold text-accent">{armed}</span>}
        </NavLink>
      </nav>

      <button
        type="button"
        onClick={() => openSearch(true)}
        className="ml-1 hidden h-7 min-w-0 max-w-[340px] flex-1 items-center gap-2 rounded-md border border-line bg-bg px-2 text-xs text-dim hover:border-line-strong md:flex"
      >
        <Search size={13} />
        <span className="truncate">Search name, ticker, CA or wallet</span>
        <span className="ml-auto">
          <Hotkey binding={searchBinding} />
        </span>
      </button>
      <IconButton label="Search" className="md:hidden" onClick={() => openSearch(true)}>
        <Search size={15} />
      </IconButton>

      <div className="ml-auto flex items-center gap-1.5">
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
        <Button variant="primary" size="sm" className="hidden sm:inline-flex" onClick={() => openFund("fund")}>
          Fund
        </Button>
        <IconButton label="Settings" size="md" onClick={() => openSettings()}>
          <Settings size={15} />
        </IconButton>
      </div>
    </header>
  );
}
