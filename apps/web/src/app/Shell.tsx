import { useEffect } from "react";
import { Outlet, useNavigate } from "react-router";
import { isBase58Address } from "../lib/address";
import { isTypingTarget, registerHotkey } from "../lib/hotkeys";
import { navigateTo, setNavigator } from "../lib/nav";
import { closeTopOverlay } from "../lib/overlayStack";
import { buy } from "../lib/tradeActions";
import { getServices } from "../services";
import { PRESET_IDS, useSettings } from "../state/settings";
import { useToasts } from "../state/toasts";
import { useUi } from "../state/ui";
import { GlobalOverlays } from "./GlobalOverlays";
import { MobileNav } from "./MobileNav";
import { StatusBar } from "./StatusBar";
import { TopNav } from "./TopNav";
import { useGlobalHotkeys } from "./useGlobalHotkeys";

/** Global (page-independent) hotkey handlers. Trade handlers are registered by pages. */
function useGlobalActions(): void {
  useEffect(() => {
    const ui = useUi.getState;
    const offs = [
      registerHotkey("search.open", () => ui().openSearch(true)),
      registerHotkey("ui.close", () => {
        if (!closeTopOverlay()) ui().closeTop();
      }),
      registerHotkey("settings.open", () => ui().openSettings()),
      registerHotkey("hotkeys.help", () => ui().setHotkeysHelp(true)),
      registerHotkey("instant.toggle", () => {
        const s = useSettings.getState();
        s.setInstant({ open: !s.instant.open });
      }),
      registerHotkey("nav.discover", () => navigateTo("/discover")),
      registerHotkey("nav.pulse", () => navigateTo("/pulse")),
      registerHotkey("nav.trackers", () => navigateTo("/trackers")),
      registerHotkey("nav.portfolio", () => navigateTo("/portfolio")),
      registerHotkey("nav.orders", () => navigateTo("/orders")),
      ...PRESET_IDS.map((id, i) =>
        registerHotkey(`preset.${i + 1}` as "preset.1", () => {
          useSettings.getState().setActivePreset(id);
          useToasts.getState().push({ kind: "info", title: `Preset ${id} active`, ttl: 1200 });
        }),
      ),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, []);
}

/** Paste a contract address anywhere (outside inputs) to open it; optional auto-buy. */
function usePasteToTrade(): void {
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const text = e.clipboardData?.getData("text")?.trim() ?? "";
      if (!isBase58Address(text)) return;
      e.preventDefault();
      void getServices()
        .data.search(text, 1)
        .then((res) => {
          const token = res.tokens.find((t) => t.mint === text);
          if (token) {
            useSettings.getState().addRecentToken(token.mint);
            navigateTo(`/t/${token.mint}`);
            const s = useSettings.getState();
            if (s.autoBuyOnPaste) void buy({ mint: token.mint, sol: s.quickBuySol, source: "paste" });
            else useToasts.getState().push({ kind: "info", title: `Opened $${token.symbol} from clipboard`, ttl: 2000 });
            return;
          }
          navigateTo(`/portfolio?wallet=${encodeURIComponent(text)}`);
        });
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);
}

/** Any interaction resets the keystore's idle auto-lock timer. */
function useActivityTouch(): void {
  useEffect(() => {
    let last = 0;
    const touch = () => {
      const now = Date.now();
      if (now - last < 15_000) return;
      last = now;
      getServices().wallet.touch();
    };
    window.addEventListener("pointerdown", touch, { passive: true });
    window.addEventListener("keydown", touch);
    return () => {
      window.removeEventListener("pointerdown", touch);
      window.removeEventListener("keydown", touch);
    };
  }, []);
}

export function Shell() {
  const navigate = useNavigate();
  useEffect(() => {
    setNavigator((to) => navigate(to));
    return () => setNavigator(null);
  }, [navigate]);
  useGlobalHotkeys();
  useGlobalActions();
  usePasteToTrade();
  useActivityTouch();

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg">
      <TopNav />
      <main className="relative min-h-0 flex-1 overflow-hidden">
        <Outlet />
      </main>
      <StatusBar />
      <MobileNav />
      <GlobalOverlays />
    </div>
  );
}
