import { TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { Outlet, useNavigate } from "react-router";
import { isBase58Address } from "../lib/address";
import { isTypingTarget, registerHotkey } from "../lib/hotkeys";
import { navigateTo, setNavigator } from "../lib/nav";
import { closeTopOverlay } from "../lib/overlayStack";
import { buy } from "../lib/tradeActionsLazy";
import { getServices } from "../services";
import { useMarket } from "../state/market";
import { PRESET_IDS, useSettings } from "../state/settings";
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
      registerHotkey("nav.settings", () => ui().openSettings()),
      registerHotkey("quote.toggle", () => {
        const s = useSettings.getState();
        s.setDisplay({ quote: s.display.quote === "USD" ? "SOL" : "USD" });
      }),
      registerHotkey("density.toggle", () => {
        const s = useSettings.getState();
        const current = document.documentElement.dataset.density === "comfortable" ? "comfortable" : "compact";
        s.setDisplay({ density: current === "compact" ? "comfortable" : "compact" });
      }),
      registerHotkey("wallet.lock", () => {
        void getServices().wallet.lock();
      }),
      registerHotkey("panic", () => ui().openPanic()),
      // Preset switches show on the control itself (a highlight), never as a toast (DESIGN.md 4.1).
      ...PRESET_IDS.map((id, i) => registerHotkey(`preset.${i + 1}` as "preset.1", () => useSettings.getState().setActivePreset(id))),
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
            // Opening is the confirmation; no "opened from clipboard" toast (DESIGN.md 4.13).
            if (s.autoBuyOnPaste) void buy({ mint: token.mint, sol: s.quickBuySol, source: "paste" });
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

/**
 * Connection loss (DESIGN.md 4.18): a 28 px warn banner under the top bar while the feed is
 * down after having been live. Trading actions refuse to run until it is back (tradeActions).
 * Not a live region: only transaction toasts announce (DESIGN.md 7).
 */
function FeedBanner() {
  const connection = useMarket((s) => s.connection);
  const everLive = useMarket((s) => s.everLive);
  if (!everLive || connection === "live" || connection === "degraded") return null;
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-warn-edge bg-warn-tint px-3 text-data text-warn">
      <TriangleAlert className="icon-sm shrink-0" />
      <span className="truncate">Live data paused. Reconnecting… Trading is disabled until the feed is live.</span>
    </div>
  );
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
      <a
        href="#main"
        className="fixed top-2 left-2 z-tooltip -translate-y-16 rounded-sm bg-accent px-3 py-1.5 text-data font-medium text-ink focus-visible:translate-y-0"
      >
        Skip to main content
      </a>
      <TopNav />
      <FeedBanner />
      <main id="main" tabIndex={-1} className="relative min-h-0 flex-1 overflow-hidden outline-none">
        <Outlet />
      </main>
      <StatusBar />
      <MobileNav />
      <GlobalOverlays />
    </div>
  );
}
