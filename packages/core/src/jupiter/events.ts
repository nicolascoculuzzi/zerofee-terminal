/**
 * Jupiter v6 swap events. Jupiter emits them by Anchor event-CPI (a self-invoke whose data is
 * EVENT_IX_TAG + event discriminator + Borsh), so they appear as inner instructions of the Jupiter
 * program, never as "Program data:" logs. Attribute by program first: SwapEvent shares its
 * discriminator with Raydium CPMM's SwapEvent (both are sha256("event:SwapEvent")).
 *   idl/jupiter.json `events` / `types`: SwapEvent { amm, input_mint, input_amount, output_mint, output_amount },
 *   SwapsEvent { swap_events: Vec<SwapEventV2 { input_mint, input_amount, output_mint, output_amount, amm }> }
 */
import type { Address } from "@solana/kit";
import { EVENT_IX_TAG } from "../constants";
import { Reader, startsWith } from "../util/bytes";

export const JUPITER_EVENT_DISCRIMINATORS = {
  swap: new Uint8Array([64, 198, 205, 232, 38, 8, 113, 226]),
  swaps: new Uint8Array([152, 47, 78, 235, 192, 96, 110, 106]),
} as const;

export interface JupiterSwapEvent {
  amm: Address;
  inputMint: Address;
  inputAmount: bigint;
  outputMint: Address;
  outputAmount: bigint;
}

/** Decodes a Jupiter event-CPI instruction's data (caller checks the program); null if it is not a swap event. */
export function decodeJupiterSwapEvents(data: Uint8Array): JupiterSwapEvent[] | null {
  if (!startsWith(data, EVENT_IX_TAG)) return null;
  const body = data.subarray(EVENT_IX_TAG.length);
  if (startsWith(body, JUPITER_EVENT_DISCRIMINATORS.swap)) {
    if (body.length < 8 + 32 * 3 + 16) return null;
    const r = new Reader(body, 8);
    const amm = r.pubkey();
    const inputMint = r.pubkey();
    const inputAmount = r.u64();
    const outputMint = r.pubkey();
    return [{ amm, inputMint, inputAmount, outputMint, outputAmount: r.u64() }];
  }
  if (startsWith(body, JUPITER_EVENT_DISCRIMINATORS.swaps)) {
    const r = new Reader(body, 8);
    const n = r.u32();
    if (body.length !== 12 + n * (32 * 3 + 16)) return null;
    const out: JupiterSwapEvent[] = [];
    for (let i = 0; i < n; i++) {
      const inputMint = r.pubkey();
      const inputAmount = r.u64();
      const outputMint = r.pubkey();
      const outputAmount = r.u64();
      out.push({ amm: r.pubkey(), inputMint, inputAmount, outputMint, outputAmount });
    }
    return out;
  }
  return null;
}
