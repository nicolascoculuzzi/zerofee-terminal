/**
 * Market events that trigger armed orders, adapted from the stream decoders in ../events:
 *  - pump TradeEvent / PumpSwap SellEvent      -> "trade" (dev-sell exits)
 *  - CompletePumpAmmMigrationEvent (pumpMigrate) -> "migration" (migration snipes)
 */
import type { Address } from "@solana/kit";
import type { AmmSwapEvent, DecodedEvent, PumpMigrationEvent, PumpTradeEvent } from "../events";
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
 * Converts any decoded event the armed engine cares about; null for the rest. PumpSwap swaps need
 * `baseMintOfPool` (the engine's pool -> mint map) because their events lack the mint.
 */
export function marketEventFromDecoded(
  ev: DecodedEvent,
  opts: { slot?: bigint; baseMintOfPool?: (pool: Address) => Address | undefined } = {},
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
    default:
      return null;
  }
}
