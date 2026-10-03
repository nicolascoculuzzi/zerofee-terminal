import { useEffect } from "react";
import { Link, useParams } from "react-router";
import { type HotkeyAction, registerHotkey } from "../../lib/hotkeys";
import { buy, sell, sellInitials } from "../../lib/tradeActions";
import { BREAKPOINT, useMediaQuery } from "../../lib/useMediaQuery";
import { useSettings } from "../../state/settings";
import { useToken, useTokenFeed } from "../../state/token";
import { useUi } from "../../state/ui";
import { TradePanel } from "../trade/TradePanel";
import { BottomTabs } from "./BottomTabs";
import { MobileTradeBar } from "./MobileTradeBar";
import { TokenChart } from "./TokenChart";
import { TokenHeader } from "./TokenHeader";
import { TokenInfo } from "./TokenInfo";
import { useTokenUi } from "./tokenUi";

/** Space+1..4 / Space+Q..R / Space+T trade this token with the Instant Trade amounts. */
function useTokenHotkeys(mint: string | undefined): void {
  useEffect(() => {
    if (!mint) return;
    const s = () => useSettings.getState();
    const preset = () => s().presets[s().activePreset];
    const offs: (() => void)[] = [];
    for (let i = 0; i < 4; i++) {
      offs.push(
        registerHotkey(`buy.${i + 1}` as HotkeyAction, () => {
          const sol = preset().instantBuy[i];
          if (sol) void buy({ mint, sol, source: "hotkey", wallets: s().instant.wallets });
        }),
        registerHotkey(`sell.${i + 1}` as HotkeyAction, () => {
          const p = preset();
          const wallets = s().instant.wallets;
          if (s().instant.sellMode === "sol") {
            const solValue = p.instantSellSol[i];
            if (solValue) void sell({ mint, solValue, source: "hotkey", wallets });
          } else {
            const pct = p.instantSellPct[i];
            if (pct) void sell({ mint, pct, source: "hotkey", wallets });
          }
        }),
      );
    }
    offs.push(registerHotkey("sell.initials", () => void sellInitials(mint, "hotkey")));
    return () => {
      for (const off of offs) off();
    };
  }, [mint]);
}

/**
 * Token page (/t/:mint): header, chart, bottom tables, and the trade panel + token info in the
 * right rail. Narrow screens stack everything and add a sticky Buy/Sell bar.
 */
export default function TokenPage() {
  const { mint } = useParams<{ mint: string }>();
  useTokenFeed(mint);
  useTokenHotkeys(mint);
  const detail = useToken((s) => s.detail);
  const status = useToken((s) => s.status);
  const wide = useMediaQuery(BREAKPOINT.lg);
  const setFocusedMint = useUi((s) => s.setFocusedMint);
  const addRecent = useSettings((s) => s.addRecentToken);

  useEffect(() => {
    if (!mint) return;
    setFocusedMint(mint);
    addRecent(mint);
    useTokenUi.getState().resetForToken();
  }, [mint, setFocusedMint, addRecent]);

  if (!mint || status === "missing") {
    return (
      <div className="p-4 text-data text-fg-2">
        This token isn't in the live set (unknown mint or pruned by the feed).{" "}
        <Link to="/pulse" className="text-fg-1 underline decoration-hairline-strong underline-offset-2">
          Back to Pulse
        </Link>
      </div>
    );
  }
  if (!detail || detail.summary.mint !== mint) {
    return <div className="p-4 text-data text-fg-3">Loading token…</div>;
  }

  if (!wide) {
    return (
      <div className="flex h-full flex-col">
        <TokenHeader token={detail.summary} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex h-80 flex-col border-b border-hairline">
            <TokenChart key={mint} mint={mint} supply={detail.summary.supply} />
          </div>
          <div className="h-120">
            <BottomTabs detail={detail} withInfo />
          </div>
        </div>
        <MobileTradeBar detail={detail} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <TokenHeader token={detail.summary} />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <TokenChart key={mint} mint={mint} supply={detail.summary.supply} />
          <div className="h-72 shrink-0 border-t border-hairline xl:h-80">
            <BottomTabs detail={detail} />
          </div>
        </div>
        <aside className="w-80 shrink-0 overflow-y-auto border-l border-hairline bg-surface-1" aria-label="Trade">
          <TradePanel key={mint} detail={detail} />
          <TokenInfo detail={detail} />
        </aside>
      </div>
    </div>
  );
}
