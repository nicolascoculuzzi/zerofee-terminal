/**
 * Market events that trigger armed orders, adapted from the stream decoders in ../events:
 *  - pump TradeEvent / PumpSwap SellEvent / LaunchLab TradeEvent -> "trade" (dev-sell exits)
 *  - CompletePumpAmmMigrationEvent (pumpMigrate)                  -> "migration" (migration snipes)
 *  - a LaunchLab coin's graduation CPMM pool going live            -> "migration" (no event: the engine
 *    sees the pool account appear, or a cpmmSwap on it; marketEventFromLaunchLabGraduation)
 */
import type { Address } from "@solana/kit";
import type { AmmSwapEvent, DecodedEvent, LaunchLabTradeEvent, PumpMigrationEvent, PumpTradeEvent } from "../events";
import type { ArmedSide } from "./model";

export type ArmedMarketEvent =
  | { type: "migration"; mint: Address; pool: Address; slot?: bigint }
  | { type: "trade"; mint: Address; trader: Address; side: ArmedSide; tokenAmount: bigint; slot?: bigint };

const withSlot = (slot?: bigint) => (slot !== undefined ? { slot } : {});

export function marketEventFromMigration(ev: PumpMigrationEvent, slot?: bigint): ArmedMarketEvent {
  return { type: "migration", mint: ev.mint, pool: ev.pool, ...withSlot(slot) };
}

export function marketEventFromPumpTrade(ev: PumpTradeEvent, slot?: bigint): ArmedMarketEvent {
  return { type: "trade", mint: ev.mint, trader: ev.user, side: ev.isBuy ? "buy" : "sell", tokenAmount: ev.tokenAmount, ...withSlot(slot) };
}

/** PumpSwap events carry the pool, not the mint: pass the pool's base mint. */
export function marketEventFromAmmSwap(ev: AmmSwapEvent, baseMint: Address, slot?: bigint): ArmedMarketEvent {
  return {
    type: "trade",
    mint: baseMint,
    trader: ev.user,
    side: ev.kind === "ammBuy" ? "buy" : "sell",
    tokenAmount: ev.baseAmount,
    ...withSlot(slot),
  };
}

/**
 * LaunchLab TradeEvents carry neither the mint nor the trader: pass the pool's base mint and the trader
 * (the transaction's fee payer). The token amount is what moved on the curve (buy: base out of the vault;
 * sell: base into the vault, after any Token-2022 transfer fee).
 */
export function marketEventFromLaunchLabTrade(
  ev: LaunchLabTradeEvent,
  baseMint: Address,
  trader: Address,
  slot?: bigint,
): ArmedMarketEvent {
  return {
    type: "trade",
    mint: baseMint,
    trader,
    side: ev.isBuy ? "buy" : "sell",
    tokenAmount: ev.isBuy ? ev.amountOut : ev.amountIn,
    ...withSlot(slot),
  };
}

/** A LaunchLab coin graduated: its CPMM pool (launchLabGraduationPoolContext) exists. */
export function marketEventFromLaunchLabGraduation(mint: Address, cpmmPool: Address, slot?: bigint): ArmedMarketEvent {
  return { type: "migration", mint, pool: cpmmPool, ...withSlot(slot) };
}

/**
 * Converts any decoded event the armed engine cares about; null for the rest. PumpSwap swaps and
 * LaunchLab trades need `baseMintOfPool` (the engine's pool -> mint map) because their events lack the
 * mint; LaunchLab trades also need `trader` (the transaction's fee payer).
 */
export function marketEventFromDecoded(
  ev: DecodedEvent,
  opts: { slot?: bigint; baseMintOfPool?: (pool: Address) => Address | undefined; trader?: Address } = {},
): ArmedMarketEvent | null {
  switch (ev.kind) {
    case "pumpTrade":
      return marketEventFromPumpTrade(ev, opts.slot);
    case "pumpMigrate":
      return marketEventFromMigration(ev, opts.slot);
    case "ammBuy":
    case "ammSell": {
      const mint = opts.baseMintOfPool?.(ev.pool);
      return mint ? marketEventFromAmmSwap(ev, mint, opts.slot) : null;
    }
    case "launchlabTrade": {
      const mint = opts.baseMintOfPool?.(ev.pool);
      return mint && opts.trader ? marketEventFromLaunchLabTrade(ev, mint, opts.trader, opts.slot) : null;
    }
    default:
      return null;
  }
}
