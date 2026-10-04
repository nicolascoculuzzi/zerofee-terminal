/**
 * The first screen's entry points into tradeActions.ts (Pulse quick-buy, Pulse and global hotkeys). The module
 * (risk checks, toasts, receipts) loads on the first trade, or at idle via `preloadTradeActions()` from
 * services/live, so it stays off the first screen's critical path. Same signatures as tradeActions.ts.
 */
import type { BuyArgs, SellArgs } from "./tradeActions";

type Mod = typeof import("./tradeActions");
let mod: Promise<Mod> | null = null;

export function preloadTradeActions(): Promise<Mod> {
  mod ??= import("./tradeActions").catch((e: unknown) => {
    mod = null;
    throw e;
  });
  return mod;
}

export const buy = (args: BuyArgs) => preloadTradeActions().then((m) => m.buy(args));
export const sell = (args: SellArgs) => preloadTradeActions().then((m) => m.sell(args));
export const sellInitials = (...args: Parameters<Mod["sellInitials"]>) => preloadTradeActions().then((m) => m.sellInitials(...args));
