/**
 * Minimal decoders for the trade events we reconcile fills against (prefix fields only; events only
 * ever gain trailing fields). Input is the event payload `disc(8) + borsh`, as found in
 * `Program data: <base64>` logs or after the 8-byte EVENT_IX_TAG of an event-CPI inner instruction.
 * Layouts: idl/pump.json TradeEvent, idl/pump_amm.json BuyEvent / SellEvent.
 */
import { type Address, getBase64Encoder } from "@solana/kit";
import { EVENT_DISCRIMINATORS, EVENT_IX_TAG } from "./constants";
import { Reader, startsWith } from "./util/bytes";

export interface PumpTradeEvent {
  kind: "pumpTrade";
  mint: Address;
  /** Net quote (excl. fees) - `sol_amount`. */
  quoteAmount: bigint;
  tokenAmount: bigint;
  isBuy: boolean;
  user: Address;
  timestamp: bigint;
  /** Post-trade reserves. */
  virtualQuoteReserves: bigint;
  virtualTokenReserves: bigint;
  realQuoteReserves: bigint;
  realTokenReserves: bigint;
  feeRecipient: Address;
  feeBps: bigint;
  fee: bigint;
  creator: Address;
  creatorFeeBps: bigint;
  creatorFee: bigint;
}

export interface AmmSwapEvent {
  kind: "ammBuy" | "ammSell";
  timestamp: bigint;
  baseAmount: bigint;
  /** buy: max_quote_amount_in; sell: min_quote_amount_out. */
  quoteLimit: bigint;
  /** Pre-trade reserves (raw vaults). */
  poolBaseReserves: bigint;
  poolQuoteReserves: bigint;
  /** buy: quote_amount_in (pre-fee); sell: quote_amount_out (pre-fee). */
  quoteAmount: bigint;
  lpFeeBps: bigint;
  lpFee: bigint;
  protocolFeeBps: bigint;
  protocolFee: bigint;
  /** buy: user_quote_amount_in (total paid); sell: user_quote_amount_out (received). */
  userQuoteAmount: bigint;
  pool: Address;
  user: Address;
}

export type DecodedEvent = PumpTradeEvent | AmmSwapEvent;

export function decodeEventPayload(payload: Uint8Array): DecodedEvent | null {
  if (startsWith(payload, EVENT_DISCRIMINATORS.pumpTrade)) {
    const r = new Reader(payload, 8);
    return {
      kind: "pumpTrade",
      mint: r.pubkey(),
      quoteAmount: r.u64(),
      tokenAmount: r.u64(),
      isBuy: r.bool(),
      user: r.pubkey(),
      timestamp: r.u64(),
      virtualQuoteReserves: r.u64(),
      virtualTokenReserves: r.u64(),
      realQuoteReserves: r.u64(),
      realTokenReserves: r.u64(),
      feeRecipient: r.pubkey(),
      feeBps: r.u64(),
      fee: r.u64(),
      creator: r.pubkey(),
      creatorFeeBps: r.u64(),
      creatorFee: r.u64(),
    };
  }
  const isBuy = startsWith(payload, EVENT_DISCRIMINATORS.ammBuy);
  if (isBuy || startsWith(payload, EVENT_DISCRIMINATORS.ammSell)) {
    const r = new Reader(payload, 8);
    const timestamp = r.u64();
    const baseAmount = r.u64();
    const quoteLimit = r.u64();
    r.u64(); // user_base_token_reserves
    r.u64(); // user_quote_token_reserves
    const poolBaseReserves = r.u64();
    const poolQuoteReserves = r.u64();
    const quoteAmount = r.u64();
    const lpFeeBps = r.u64();
    const lpFee = r.u64();
    const protocolFeeBps = r.u64();
    const protocolFee = r.u64();
    r.u64(); // quote_amount_in_with_lp_fee / quote_amount_out_without_lp_fee
    const userQuoteAmount = r.u64();
    return {
      kind: isBuy ? "ammBuy" : "ammSell",
      timestamp,
      baseAmount,
      quoteLimit,
      poolBaseReserves,
      poolQuoteReserves,
      quoteAmount,
      lpFeeBps,
      lpFee,
      protocolFeeBps,
      protocolFee,
      userQuoteAmount,
      pool: r.pubkey(),
      user: r.pubkey(),
    };
  }
  return null;
}

/** Decodes an event-CPI inner-instruction data blob (EVENT_IX_TAG + payload). */
export function decodeEventInstructionData(data: Uint8Array): DecodedEvent | null {
  return startsWith(data, EVENT_IX_TAG) ? decodeEventPayload(data.subarray(8)) : null;
}

/** Extracts and decodes every known event from `Program data: <base64>` log lines. */
export function decodeEventsFromLogs(logs: readonly string[]): DecodedEvent[] {
  const b64 = getBase64Encoder();
  const out: DecodedEvent[] = [];
  for (const line of logs) {
    const m = /^Program data: (.+)$/.exec(line);
    if (!m?.[1]) continue;
    try {
      const ev = decodeEventPayload(b64.encode(m[1]) as Uint8Array);
      if (ev) out.push(ev);
    } catch {
      /* not one of ours */
    }
  }
  return out;
}
