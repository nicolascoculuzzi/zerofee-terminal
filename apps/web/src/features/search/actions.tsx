import {
  ArrowDownToLine,
  Compass,
  DollarSign,
  Keyboard,
  KeyRound,
  LayoutGrid,
  ListChecks,
  Lock,
  LockOpen,
  OctagonX,
  Radar,
  Rows3,
  Settings,
  SlidersHorizontal,
  Wallet,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import type { HotkeyAction } from "../../lib/hotkeys";
import { navigateTo } from "../../lib/nav";
import { getServices } from "../../services";
import { type PresetId, useSettings } from "../../state/settings";
import { useUi } from "../../state/ui";
import { useWallet } from "../../state/wallet";
import { openSettingsAt } from "../settings/sections";

export interface PaletteAction {
  id: string;
  label: string;
  /** Extra words the filter matches ("navigate", "currency"…). */
  keywords: string;
  icon: ReactNode;
  /** Live binding shown as keycaps. */
  hotkey?: HotkeyAction;
  /** Short state hint on the right, before the keycaps ("Active", "SOL"). */
  hint?: string;
  run: () => void;
}

const presetAction = (id: PresetId, index: 1 | 2 | 3): PaletteAction => {
  const s = useSettings.getState();
  return {
    id: `preset.${index}`,
    label: `Switch to ${id} · ${s.presets[id].label}`,
    keywords: "preset slippage fee",
    icon: <SlidersHorizontal />,
    hotkey: `preset.${index}` as HotkeyAction,
    hint: s.activePreset === id ? "Active" : undefined,
    run: () => useSettings.getState().setActivePreset(id),
  };
};

/**
 * Palette actions (DESIGN.md 4.15): navigation, USD/SOL, presets, Instant Trade, lock, settings,
 * shortcuts, key export (its settings section) and Panic (the hold-to-confirm dialog). Built at
 * open time so labels reflect current state.
 */
export function paletteActions(): PaletteAction[] {
  const s = useSettings.getState();
  const ui = useUi.getState();
  const locked = useWallet.getState().service.locked;
  return [
    {
      id: "nav.pulse",
      label: "Go to Pulse",
      keywords: "navigate new pairs columns",
      icon: <LayoutGrid />,
      hotkey: "nav.pulse",
      run: () => navigateTo("/pulse"),
    },
    {
      id: "nav.discover",
      label: "Go to Discover",
      keywords: "navigate",
      icon: <Compass />,
      hotkey: "nav.discover",
      run: () => navigateTo("/discover"),
    },
    {
      id: "nav.trackers",
      label: "Go to Trackers",
      keywords: "navigate wallets",
      icon: <Radar />,
      hotkey: "nav.trackers",
      run: () => navigateTo("/trackers"),
    },
    {
      id: "nav.portfolio",
      label: "Go to Portfolio",
      keywords: "navigate positions pnl",
      icon: <Wallet />,
      hotkey: "nav.portfolio",
      run: () => navigateTo("/portfolio"),
    },
    {
      id: "nav.orders",
      label: "Go to Armed orders",
      keywords: "navigate limit take profit stop loss",
      icon: <ListChecks />,
      hotkey: "nav.orders",
      run: () => navigateTo("/orders"),
    },
    {
      id: "quote.toggle",
      label: "Toggle USD / SOL",
      keywords: "quote currency",
      icon: <DollarSign />,
      hotkey: "quote.toggle",
      hint: s.display.quote,
      run: () => {
        const st = useSettings.getState();
        st.setDisplay({ quote: st.display.quote === "USD" ? "SOL" : "USD" });
      },
    },
    {
      id: "density.toggle",
      label: "Toggle density",
      keywords: "compact comfortable rows",
      icon: <Rows3 />,
      hotkey: "density.toggle",
      run: () => {
        const current = document.documentElement.dataset.density === "comfortable" ? "comfortable" : "compact";
        useSettings.getState().setDisplay({ density: current === "compact" ? "comfortable" : "compact" });
      },
    },
    presetAction("P1", 1),
    presetAction("P2", 2),
    presetAction("P3", 3),
    {
      id: "instant.toggle",
      label: "Toggle Instant Trade",
      keywords: "window buy sell buttons",
      icon: <Zap />,
      hotkey: "instant.toggle",
      hint: s.instant.open ? "Open" : undefined,
      run: () => {
        const st = useSettings.getState();
        st.setInstant({ open: !st.instant.open });
      },
    },
    locked
      ? {
          id: "wallet.unlock",
          label: "Unlock keystore",
          keywords: "passkey passphrase",
          icon: <LockOpen />,
          run: () => ui.requestUnlock("Unlock your trading wallet."),
        }
      : {
          id: "wallet.lock",
          label: "Lock keystore",
          keywords: "security",
          icon: <Lock />,
          hotkey: "wallet.lock",
          run: () => getServices().wallet.lock(),
        },
    {
      id: "fund",
      label: "Fund trading wallet",
      keywords: "deposit transfer sol",
      icon: <ArrowDownToLine />,
      run: () => ui.openFund("fund"),
    },
    {
      id: "settings.open",
      label: "Open settings",
      keywords: "preferences",
      icon: <Settings />,
      hotkey: "settings.open",
      run: () => ui.openSettings(),
    },
    {
      id: "hotkeys.help",
      label: "Show shortcuts",
      keywords: "keyboard hotkeys help",
      icon: <Keyboard />,
      hotkey: "hotkeys.help",
      run: () => ui.setHotkeysHelp(true),
    },
    {
      id: "export",
      label: "Export trading key",
      keywords: "private key backup security",
      icon: <KeyRound />,
      run: () => openSettingsAt("security", "export"),
    },
    {
      id: "panic",
      label: "Panic: cancel all orders and lock",
      keywords: "kill switch emergency",
      icon: <OctagonX />,
      hotkey: "panic",
      run: () => ui.openPanic(),
    },
  ];
}

export function matchAction(a: PaletteAction, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${a.label} ${a.keywords}`.toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}
