import type { TradeMode } from "../../services/tradeService";

/** Instant vs direct signing (SPEC "Trade path" and "Direct mode"). Shared by Settings and onboarding. */
export const MODE_INFO: Record<TradeMode, { label: string; summary: string; detail: string }> = {
  instant: {
    label: "Instant",
    summary: "The trading wallet in this browser signs. No popup, fastest.",
    detail:
      "Every transaction passes the signer firewall before it is signed, and the key locks itself when idle. Keep only what you're willing to lose in the trading wallet.",
  },
  direct: {
    label: "Direct",
    summary: "Your connected wallet approves each trade in a popup. Slower, no hot wallet.",
    detail: "Nothing is signed without an approval in Phantom, Solflare or Backpack. Every trade waits for that popup and your click.",
  },
};

export const MODES: TradeMode[] = ["instant", "direct"];
