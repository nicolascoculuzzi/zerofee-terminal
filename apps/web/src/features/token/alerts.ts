import { useEffect, useRef } from "react";
import { fmtCompact, fmtSol } from "../../lib/format";
import { compactLabel } from "../../lib/hotkeys";
import { playTone } from "../../lib/sound";
import type { TokenSummary } from "../../protocol";
import { useMarket } from "../../state/market";
import { useSettings } from "../../state/settings";
import { useToasts } from "../../state/toasts";
import { useTokenUi } from "./tokenUi";

/** "MC $9.80K" / "MC 82.1 SOL" for an alert level. */
export function alertLevelText(priceSol: number, supply: number, quote: "USD" | "SOL", solUsd: number): string {
  const mc = priceSol * supply * (quote === "USD" ? solUsd : 1);
  return quote === "USD" ? `MC $${fmtCompact(mc)}` : `MC ${fmtSol(mc)} SOL`;
}

/**
 * Fires this token's price alerts when the live price crosses them, once each: a non-trade toast
 * ("alert triggered", DESIGN.md 4.13) and the alert line goes away. Alerts live in this browser
 * and fire while the token page is open.
 */
export function useAlertWatcher(token: TokenSummary | null): void {
  const prev = useRef<{ mint: string; price: number } | null>(null);
  useEffect(() => {
    if (!token) return;
    const { mint, priceSol: price } = token;
    const before = prev.current?.mint === mint ? prev.current.price : null;
    prev.current = { mint, price };
    if (before === null) return;
    const ui = useTokenUi.getState();
    for (const a of ui.alerts) {
      if (a.mint !== mint) continue;
      const crossed = a.above ? before < a.priceSol && price >= a.priceSol : before > a.priceSol && price <= a.priceSol;
      if (!crossed) continue;
      ui.removeAlert(a.id);
      const settings = useSettings.getState();
      const level = alertLevelText(a.priceSol, token.supply, settings.display.quote, useMarket.getState().solUsd);
      const key = compactLabel(settings.hotkeys["token.alert"]?.[0]);
      playTone("fill", settings.display.soundVolume);
      useToasts.getState().push({
        kind: "info",
        title: `Alert · ${token.symbol} ${level.replace("MC", `MC ${a.above ? "above" : "below"}`)}`,
        body: `The alert line is removed. Add another from the bell${key ? ` or with ${key}` : ""}.`,
      });
    }
  }, [token]);
}
