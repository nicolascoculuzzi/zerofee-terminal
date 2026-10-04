import { lazy, Suspense, useEffect, useRef } from "react";
import { Link, useParams } from "react-router";
import { type HotkeyAction, registerHotkey } from "../../lib/hotkeys";
import { closeTopOverlay } from "../../lib/overlayStack";
import { buy, sell, sellInitials } from "../../lib/tradeActions";
import { BREAKPOINT, useMediaQuery } from "../../lib/useMediaQuery";
import { useSettings } from "../../state/settings";
import { useToken, useTokenFeed } from "../../state/token";
import { useUi } from "../../state/ui";
import { useWallet } from "../../state/wallet";
import { TradePanel } from "../trade/TradePanel";
import { useAlertWatcher } from "./alerts";
import { BottomTabs, TAB_ORDER } from "./BottomTabs";
import { CancelOrderDialog } from "./CancelOrderDialog";
import { crosshair } from "./chart/crosshair";
import { MobileToken } from "./MobileToken";
import { Splitter } from "./Splitter";
import { TokenHeader } from "./TokenHeader";
import { TokenInfo } from "./TokenInfo";
import { useTokenUi } from "./tokenUi";

/** Lightweight Charts loads in its own chunk (DESIGN.md 4.10, 8: token route budget excludes the chart). */
const TokenChart = lazy(() => import("./TokenChart"));

/*
 * Token page (/t/:mint), DESIGN.md 5.2. Desktop: the 48 px header, then the chart (56% by
 * default, resizable and persisted) over the bottom tables, and a right rail of 288 / 300 / 320 px
 * (lg / xl / 2xl) with the trade panel, the position strip and, from 1280 px, token info (below
 * that it becomes an Info tab). 768–1023 px stacks header, chart 360, the trade panel in two
 * columns and the tables. Phones get the 5.8 layout with a sticky trade bar.
 */

function ChartFallback({ tf }: { tf: string }) {
  return (
    <div className="flex h-full flex-col bg-surface-1">
      <div className="h-8 shrink-0 border-b border-hairline" />
      <div className="p-2 text-data text-fg-3">Loading {tf} candles…</div>
    </div>
  );
}

/** A static 8 px skeleton bar (DESIGN.md 4.18: surface-3, 2 px radius, no shimmer). */
function Bar({ w, h = "h-2" }: { w: string; h?: string }) {
  return <span aria-hidden="true" className={`block rounded-xs bg-surface-3 ${h} ${w}`} />;
}

/**
 * First paint before the token detail arrives: the page's own frame (48 px header with identity
 * and stat cells, chart toolbar, right rail) with static bars where values will land, so nothing
 * jumps when the data comes in.
 */
function TokenPageSkeleton() {
  return (
    <div className="flex h-full flex-col" aria-busy="true">
      <div className="flex h-12 shrink-0 items-center border-b border-hairline bg-surface-1 pl-3">
        <span aria-hidden="true" className="size-7 shrink-0 rounded-sm bg-surface-3" />
        <div className="ml-2 flex w-40 flex-col gap-2 pr-3">
          <Bar w="w-24" />
          <Bar w="w-32" />
        </div>
        {["w-14", "w-16", "w-12", "w-12", "w-10", "w-10", "w-10"].map((w, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder cells
          <div key={i} className="flex h-full flex-col justify-center gap-2 border-l border-hairline px-3">
            <Bar w="w-8" />
            <Bar w={w} h={i === 0 ? "h-3" : "h-2"} />
          </div>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 gap-px bg-hairline">
        <div className="flex min-w-0 flex-1 flex-col bg-surface-1">
          <div className="h-8 shrink-0 border-b border-hairline" />
          <div className="p-2 text-data text-fg-3">Loading token…</div>
        </div>
        <div className="hidden w-72 shrink-0 space-y-2 bg-surface-1 p-3 lg:block xl:w-75 2xl:w-80">
          <span aria-hidden="true" className="block h-7 rounded-sm bg-surface-2" />
          <span aria-hidden="true" className="block h-7 border-b border-hairline" />
          <span aria-hidden="true" className="block h-8 rounded-sm bg-surface-2" />
          <span aria-hidden="true" className="block h-6 rounded-sm bg-surface-2" />
          <span aria-hidden="true" className="block h-(--zf-btn-xl) rounded-sm bg-surface-3" />
        </div>
      </div>
    </div>
  );
}

/** Token-page hotkeys (DESIGN.md 6.4). Trade keys need Space held; the shell's dispatcher enforces it. */
function useTokenHotkeys(mint: string | undefined): void {
  useEffect(() => {
    if (!mint) return;
    const s = () => useSettings.getState();
    const ui = () => useTokenUi.getState();
    const preset = () => s().presets[s().activePreset];
    const offs: (() => void)[] = [];
    const on = (action: HotkeyAction, fn: () => void) => offs.push(registerHotkey(action, fn));
    for (let i = 0; i < 4; i++) {
      on(`buy.${i + 1}` as HotkeyAction, () => {
        const sol = preset().instantBuy[i];
        if (sol) void buy({ mint, sol, source: "hotkey", wallets: s().instant.wallets });
      });
      on(`sell.${i + 1}` as HotkeyAction, () => {
        const p = preset();
        const wallets = s().instant.wallets;
        if (s().instant.sellMode === "sol") {
          const solValue = p.instantSellSol[i];
          if (solValue) void sell({ mint, solValue, source: "hotkey", wallets });
        } else {
          const pct = p.instantSellPct[i];
          if (pct) void sell({ mint, pct, source: "hotkey", wallets });
        }
      });
    }
    on("sell.initials", () => void sellInitials(mint, "hotkey"));
    on("buy.quick", () => void buy({ mint, sol: ui().buySol ?? s().quickBuySol, source: "hotkey" }));
    on("token.sideBuy", () => ui().setSide("buy"));
    on("token.sideSell", () => ui().setSide("sell"));
    on("token.market", () => ui().setOrderType("market"));
    on("token.limit", () => ui().setOrderType("limit"));
    on("token.advanced", () => ui().setOrderType("advanced"));
    on("token.prevTf", () => ui().stepTf(-1));
    on("token.nextTf", () => ui().stepTf(1));
    on("token.toggleMc", () => ui().setMode(ui().mode === "mc" ? "price" : "mc"));
    on("token.alert", () => {
      const detail = useToken.getState().detail;
      if (!detail || detail.summary.mint !== mint) return;
      const current = detail.summary.priceSol;
      // Unknown price (null): no direction to cross from, so no alert.
      if (current === null) return;
      ui().addAlert(mint, crosshair.priceSol ?? current * 1.1, current);
    });
    for (const [i, tab] of TAB_ORDER.entries()) on(`token.tab${i + 1}` as HotkeyAction, () => ui().setTab(tab));
    on("token.unlock", () => {
      if (useWallet.getState().service.locked) useUi.getState().requestUnlock("Unlock to trade");
    });
    return () => {
      for (const off of offs) off();
    };
  }, [mint]);
}

/** Esc restores a maximized chart once no overlay is left to close. */
function useMaximizeEscape(): void {
  const maximized = useTokenUi((s) => s.maximized);
  useEffect(() => {
    if (!maximized) return;
    return registerHotkey("ui.close", () => {
      if (closeTopOverlay()) return;
      if (useUi.getState().closeTop()) return;
      useTokenUi.getState().setMaximized(false);
    });
  }, [maximized]);
}

export default function TokenPage() {
  const { mint } = useParams<{ mint: string }>();
  useTokenFeed(mint);
  useTokenHotkeys(mint);
  useMaximizeEscape();
  const detail = useToken((s) => s.detail);
  const status = useToken((s) => s.status);
  const desktop = useMediaQuery(BREAKPOINT.lg);
  const tablet = useMediaQuery(BREAKPOINT.md);
  const wideRail = useMediaQuery(BREAKPOINT.xl);
  const tf = useTokenUi((s) => s.tf);
  const split = useTokenUi((s) => s.split);
  const setSplit = useTokenUi((s) => s.setSplit);
  const maximized = useTokenUi((s) => s.maximized);
  const setFocusedMint = useUi((s) => s.setFocusedMint);
  const addRecent = useSettings((s) => s.addRecentToken);
  const mainRef = useRef<HTMLDivElement>(null);
  const ready = detail && detail.summary.mint === mint ? detail : null;
  useAlertWatcher(ready?.summary ?? null);

  useEffect(() => {
    if (!mint) return;
    setFocusedMint(mint);
    addRecent(mint);
    useTokenUi.getState().resetForToken();
  }, [mint, setFocusedMint, addRecent]);

  if (!mint || status === "missing") {
    return (
      <div className="flex h-full items-start justify-center bg-surface-1 px-4 pt-16">
        <div className="flex max-w-80 flex-col items-center gap-1 text-center">
          <span className="text-body font-medium text-fg-2">Token not in the live set</span>
          <span className="text-data text-fg-3">An unknown mint, or one the feed has pruned.</span>
          <Link
            to="/pulse"
            className="mt-2 inline-flex h-6 items-center rounded-sm border border-hairline-strong bg-surface-3 px-2 text-data font-medium text-fg-1 transition-colors hover:bg-surface-3-hover"
          >
            Back to Pulse
          </Link>
        </div>
      </div>
    );
  }
  if (!ready) return tablet ? <TokenPageSkeleton /> : <div className="p-3 text-data text-fg-3">Loading token…</div>;

  if (!tablet) return <MobileToken key={mint} detail={ready} />;

  if (!desktop) {
    return (
      <div className="h-full overflow-y-auto bg-bg">
        <TokenHeader token={ready.summary} layout="tablet" />
        <div className="h-90 border-b border-hairline">
          <Suspense fallback={<ChartFallback tf={tf} />}>
            <TokenChart key={mint} detail={ready} />
          </Suspense>
        </div>
        <section aria-label="Trade" className="border-b border-hairline bg-surface-1">
          <TradePanel key={mint} detail={ready} layout="wide" />
        </section>
        <div className="h-120">
          <BottomTabs detail={ready} withInfo />
        </div>
        <CancelOrderDialog />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <TokenHeader token={ready.summary} />
      <div className="flex min-h-0 flex-1 gap-px bg-hairline">
        <div ref={mainRef} className="flex min-w-0 flex-1 flex-col bg-surface-1">
          <div className="min-h-60" style={{ flex: maximized ? "1 1 100%" : `0 1 ${split * 100}%` }}>
            <Suspense fallback={<ChartFallback tf={tf} />}>
              <TokenChart key={mint} detail={ready} />
            </Suspense>
          </div>
          {!maximized && (
            <>
              <Splitter container={mainRef} split={split} onChange={setSplit} />
              <div className="min-h-40 min-w-0 flex-1">
                <BottomTabs detail={ready} withInfo={!wideRail} />
              </div>
            </>
          )}
        </div>
        <aside aria-label="Trade" className="w-72 shrink-0 overflow-y-auto bg-surface-1 xl:w-75 2xl:w-80">
          <TradePanel key={mint} detail={ready} />
          {wideRail && <TokenInfo detail={ready} />}
        </aside>
      </div>
      <CancelOrderDialog />
    </div>
  );
}
