import { ChevronDown, Lock, LockOpen, Menu, Search, Settings, ShieldCheck, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { Button, IconButton } from "../components/ui/Button";
import { CountBadge } from "../components/ui/bits";
import { Hotkey, NumberInput, Segmented } from "../components/ui/controls";
import { MenuItem, MenuSeparator, Popover } from "../components/ui/Popover";
import { Tooltip } from "../components/ui/Tooltip";
import { openSettingsAt } from "../features/settings/sections";
import { cn } from "../lib/cn";
import { fmtSol, fmtSolShort, shortAddr } from "../lib/format";
import { compactLabel } from "../lib/hotkeys";
import { LANDING_INFO } from "../lib/landing";
import { getServices } from "../services";
import { isOpenOrder, useOrders } from "../state/orders";
import { PRESET_IDS, type PresetId, useSettings } from "../state/settings";
import { useUi } from "../state/ui";
import { useWallet } from "../state/wallet";
import { Logo } from "./Logo";

/*
 * Top bar (DESIGN.md 4.1): 40/44px, surface-1 on a hairline, quiet monochrome nav, one row of
 * market context and account actions. Balance chip, Deposit and a search pill on one row after
 * Kraken Pro: https://mobbin.com/screens/5bdd6cb2-5040-44c4-8781-c70f3aea60a8
 * Header height and monochrome nav after OKX: https://mobbin.com/screens/c3ca83ef-f1de-4703-abbf-aa02ff6fa1ff
 */

export const NAV_ITEMS = [
  { to: "/discover", label: "Discover" },
  { to: "/pulse", label: "Pulse" },
  { to: "/trackers", label: "Trackers" },
  { to: "/portfolio", label: "Portfolio" },
] as const;

/**
 * Landing chip: Reduced/Secure in text-2 with ShieldCheck; Fast in warn with Zap (sandwich risk).
 * Click opens Settings on the Landing section (DESIGN.md 4.1).
 */
export function LandingIndicator() {
  const preset = useSettings((s) => s.presets[s.activePreset]);
  const info = LANDING_INFO[preset.buy.landing];
  const Icon = info.risky ? Zap : ShieldCheck;
  return (
    <Tooltip
      content={
        <span className="block space-y-1">
          <span className="block font-semibold">
            Landing preset: {info.label} ({preset.id})
          </span>
          <span className="block text-fg-2">Route: {info.route}</span>
          <span className="block text-fg-2">Tip: {info.tip}</span>
          <span className={cn("block", info.risky ? "text-warn" : "text-fg-2")}>{info.note}</span>
        </span>
      }
    >
      <button
        type="button"
        onClick={() => openSettingsAt("landing")}
        className={cn(
          "flex h-control items-center gap-1 rounded-sm px-2 text-data font-medium transition-colors hover:bg-surface-3",
          info.risky ? "text-warn" : "text-fg-2",
        )}
        aria-label={`Landing preset ${info.label}`}
      >
        <Icon className="icon-sm" />
        {info.label}
      </button>
    </Tooltip>
  );
}

/** Preset segmented: a switch gives the control a highlight that fades over 600 ms (no toast). */
export function PresetSwitchTop() {
  const active = useSettings((s) => s.activePreset);
  const setActive = useSettings((s) => s.setActivePreset);
  const hotkeys = useSettings((s) => s.hotkeys);
  const [flash, setFlash] = useState(0);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (active) setFlash((n) => n + 1);
  }, [active]);
  return (
    <div className="relative">
      <Segmented<PresetId>
        value={active}
        onChange={setActive}
        options={PRESET_IDS.map((p, i) => {
          const key = compactLabel(hotkeys[`preset.${i + 1}` as "preset.1"]?.[0]);
          return { value: p, label: p, title: key ? `Preset ${p} (${key})` : `Preset ${p}` };
        })}
        label="Active preset"
      />
      {flash > 0 && <span key={flash} aria-hidden="true" className="zf-enter pointer-events-none absolute inset-0 rounded-sm" />}
    </div>
  );
}

export function QuickBuyControl() {
  const quickBuy = useSettings((s) => s.quickBuySol);
  const setQuickBuy = useSettings((s) => s.setQuickBuy);
  return (
    <div className="flex items-center gap-2">
      <Tooltip content="Default quick-buy amount for the pills on Pulse. Columns can override it.">
        <NumberInput
          value={quickBuy}
          onChange={(v) => setQuickBuy(v ?? 0)}
          prefix={<Zap />}
          suffix="SOL"
          min={0}
          step={(v) => (v < 1 ? 0.01 : 0.1)}
          className="w-24"
          inputClassName="font-semibold"
          ariaLabel="Quick buy amount in SOL"
        />
      </Tooltip>
      <PresetSwitchTop />
    </div>
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

function WalletMenu({ compact }: { compact?: boolean }) {
  const navigate = useNavigate();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const service = useWallet((s) => s.service);
  const activeAddress = useWallet((s) => s.activeAddress);
  const setActive = useWallet((s) => s.setActive);
  const status = useWallet((s) => s.status);
  const openFund = useUi((s) => s.openFund);
  const openSettings = useUi((s) => s.openSettings);
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
        className={cn(
          "flex shrink-0 items-center gap-2 rounded-sm border px-2 text-data whitespace-nowrap transition-colors hover:bg-surface-3",
          compact ? "h-11 border-transparent" : "h-control border-hairline-strong bg-surface-2",
        )}
        aria-label="Trading wallet"
        aria-expanded={open}
      >
        {locked ? <Lock className="icon-xs text-fg-3" /> : <LockOpen className="icon-xs text-fg-2" />}
        <span className="hidden max-w-24 truncate text-fg-3 2xl:inline">{active?.label ?? "Wallet"}</span>
        <span className="zf-num min-w-[7ch] text-right font-semibold text-fg-1">{fmtSol(balance)}</span>
        <span className="zf-unit -ml-1.5">{" "}SOL</span>
        <ChevronDown className="icon-xs text-fg-3" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} align="end" width={300}>
        <div className="zf-group-label px-2 pt-2 pb-1">Trading wallets</div>
        {wallets.map((w) => {
          const st = status[w.address];
          const isActive = w.address === activeAddress;
          return (
            <button
              key={w.id}
              type="button"
              onClick={go(() => setActive(w.address))}
              aria-pressed={isActive}
              className={cn(
                "focus-inset relative flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-data transition-colors hover:bg-surface-3",
                isActive && "bg-surface-3",
              )}
            >
              {isActive && <span aria-hidden="true" className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent" />}
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-fg-1">{w.label}</span>
                <span className="block font-mono text-label text-fg-3">{shortAddr(w.address)}</span>
              </span>
              <span className="zf-num text-right">
                <span className="block font-semibold text-fg-1">
                  {fmtSol(st?.solBalance ?? 0)}
                  <span className="zf-unit font-normal">{" "}SOL</span>
                </span>
                {st && st.reservedSol > 0 && <span className="block text-label text-fg-3">{fmtSol(st.reservedSol)} reserved</span>}
              </span>
            </button>
          );
        })}
        <MenuSeparator />
        <div className="flex items-center justify-between px-2 py-1 text-data">
          <span className="flex items-center gap-1.5 text-fg-2">
            {locked ? <Lock className="icon-xs text-fg-3" /> : <LockOpen className="icon-xs" />}
            {locked ? "Keystore locked" : "Keystore unlocked"}
          </span>
          {locked ? (
            <Button size="xs" variant="primary" onClick={go(() => requestUnlock("Unlock your trading wallet"))}>
              Unlock
            </Button>
          ) : (
            <Button size="xs" variant="secondary" onClick={() => getServices().wallet.lock()}>
              Lock now
            </Button>
          )}
        </div>
        {/* Below 1440px the mode switch lives here (DESIGN.md 4.1). */}
        <div className="flex items-center justify-between px-2 py-1 text-data 2xl:hidden">
          <span className="text-fg-2">Signing</span>
          <ModeSwitch />
        </div>
        <div className="px-2 pt-1 pb-2 text-label text-fg-3">
          Connected <span className="text-fg-2 capitalize">{service.connected.provider}</span>{" "}
          <span className="font-mono">{shortAddr(service.connected.address)}</span>
          {service.session ? " · signed in" : <span className="text-warn"> · not signed in</span>}
        </div>
        <MenuSeparator />
        <MenuItem onSelect={go(() => openFund("fund"))}>Fund</MenuItem>
        <MenuItem onSelect={go(() => openFund("withdraw"))}>Withdraw</MenuItem>
        <MenuItem onSelect={go(() => navigate("/onboarding"))}>New trading wallet</MenuItem>
        <MenuItem onSelect={go(() => openSettings())} icon={<Settings />} className="md:hidden">
          Settings
        </MenuItem>
      </Popover>
    </>
  );
}

function NavItem({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "flex h-6 items-center gap-1.5 rounded-sm px-2 text-data font-medium transition-colors",
          isActive ? "bg-surface-3 text-fg-1" : "text-fg-3 hover:text-fg-1",
        )
      }
    >
      {children}
    </NavLink>
  );
}

/** Between 768 and 1024px the nav collapses into a menu (DESIGN.md 4.1). */
function NavMenu({ armed }: { armed: number }) {
  const navigate = useNavigate();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton ref={anchor} label="Navigation" size="nav" onClick={() => setOpen((o) => !o)}>
        <Menu />
      </IconButton>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} width={200}>
        {[...NAV_ITEMS, { to: "/orders", label: "Orders" } as const].map((n) => (
          <MenuItem
            key={n.to}
            onSelect={() => {
              setOpen(false);
              navigate(n.to);
            }}
            hint={n.to === "/orders" && armed > 0 ? <CountBadge count={armed} /> : undefined}
          >
            {n.label}
          </MenuItem>
        ))}
      </Popover>
    </>
  );
}

/**
 * Mobile header (DESIGN.md 5.8): 44px, the mark, a quick-buy chip, the balance and search. Token
 * pages draw their own phone header (back, avatar, ticker, star, share), so this one steps aside.
 */
function MobileHeader() {
  const { pathname } = useLocation();
  const openSearch = useUi((s) => s.openSearch);
  const quickBuy = useSettings((s) => s.quickBuySol);
  const openSettings = useUi((s) => s.openSettings);
  if (pathname.startsWith("/t/")) return null;
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-hairline bg-surface-1 px-3 pt-[env(safe-area-inset-top)] md:hidden">
      <Link to="/pulse" aria-label="zerofee home" className="shrink-0">
        <Logo compact />
      </Link>
      <button
        type="button"
        onClick={() => openSettings("presets")}
        className="flex h-11 items-center px-1"
        aria-label={`Quick-buy amount ${fmtSolShort(quickBuy)} SOL`}
      >
        <span className="flex h-7 items-center gap-1 rounded-xs border border-hairline-strong bg-surface-3 px-2 text-data font-semibold text-fg-1">
          <Zap className="icon-xs text-fg-3" />
          <span className="zf-num">{fmtSolShort(quickBuy)}</span>
        </span>
      </button>
      <div className="ml-auto flex items-center">
        <WalletMenu compact />
        <IconButton label="Search" size="nav" className="size-11" onClick={() => openSearch(true)}>
          <Search />
        </IconButton>
      </div>
    </header>
  );
}

export function TopNav() {
  const openSearch = useUi((s) => s.openSearch);
  const openSettings = useUi((s) => s.openSettings);
  const openFund = useUi((s) => s.openFund);
  const searchBinding = useSettings((s) => s.hotkeys["search.open"][0]);
  const settingsKey = useSettings((s) => compactLabel(s.hotkeys["settings.open"]?.[0]));
  const armed = useOrders((s) => Object.values(s.byId).filter(isOpenOrder).length);

  return (
    <>
      <MobileHeader />
      <header className="hidden h-topbar shrink-0 items-center gap-2 border-b border-hairline bg-surface-1 px-3 md:flex">
        <Link to="/pulse" className="mr-2 shrink-0" aria-label="zerofee home">
          <Logo />
        </Link>
        <nav className="hidden items-center gap-1 lg:flex" aria-label="Main">
          {NAV_ITEMS.map((n) => (
            <NavItem key={n.to} to={n.to}>
              {n.label}
            </NavItem>
          ))}
          <NavItem to="/orders">
            Orders
            {armed > 0 && <CountBadge count={armed} />}
          </NavItem>
        </nav>
        <div className="lg:hidden">
          <NavMenu armed={armed} />
        </div>

        <button
          type="button"
          onClick={() => openSearch(true)}
          className="ml-2 flex h-control w-80 max-w-80 min-w-50 shrink items-center gap-2 rounded-sm border border-hairline-strong bg-surface-2 px-2 text-data text-fg-4 transition-colors hover:border-fg-3"
        >
          <Search className="icon-sm text-fg-3" />
          <span className="truncate">Search token, CA or wallet</span>
          <span className="ml-auto">
            <Hotkey binding={searchBinding} />
          </span>
        </button>

        <div className="ml-auto flex items-center gap-2">
          <div className="hidden lg:block">
            <QuickBuyControl />
          </div>
          <div className="hidden xl:block">
            <LandingIndicator />
          </div>
          <div className="hidden 2xl:block">
            <ModeSwitch />
          </div>
          <WalletMenu />
          {/* Between 768 and 1280px Fund lives in the wallet menu, so the bar never overflows. */}
          <div className="hidden xl:block">
            <Button variant="secondary" size="md" onClick={() => openFund("fund")}>
              Fund
            </Button>
          </div>
          <IconButton
            label="Settings"
            size="nav"
            onClick={() => openSettings()}
            title={settingsKey ? `Settings (${settingsKey})` : "Settings"}
          >
            <Settings />
          </IconButton>
        </div>
      </header>
    </>
  );
}
