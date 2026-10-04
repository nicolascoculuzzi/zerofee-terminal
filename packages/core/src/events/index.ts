/**
 * pump.fun / PumpSwap and Raydium LaunchLab / CPMM event decoding: payload decoders, program-attributed log
 * parsing and transaction-level extraction (event-CPI first, logs as fallback).
 */
export * from "./decode";
export * from "./logs";
export { decodeCpmmEventPayload, decodeLaunchLabEventPayload } from "./raydium";
export * from "./tx";
export * from "./types";

import type { Address } from "@solana/kit";
import { EVENT_IX_TAG } from "../constants";
import { startsWith } from "../util/bytes";
import { decodeEventPayload } from "./decode";
import type { DecodedEvent } from "./types";

/** Decodes an event-CPI inner-instruction data blob (EVENT_IX_TAG + payload). Throws EventDecodeError if malformed. */
export function decodeEventInstructionData(data: Uint8Array, program?: Address | null): DecodedEvent | null {
  return startsWith(data, EVENT_IX_TAG) ? decodeEventPayload(data.subarray(EVENT_IX_TAG.length), program) : null;
}
