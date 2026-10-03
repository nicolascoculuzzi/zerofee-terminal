/**
 * Shared plumbing for the per-program event decoders (./decode.ts, ./raydium.ts): discriminator tables and
 * the required-field / string checks behind the tolerance rules documented in ./decode.ts.
 */
import { Reader, startsWith } from "../util/bytes";
import { type DecodedEvent, type DecodedEventKind, EventDecodeError } from "./types";

export const DISC_LEN = 8;

/** `[discriminator, decoder]` pairs; a decoder receives a Reader positioned after the discriminator. */
export type DecoderTable<E extends DecodedEvent = DecodedEvent> = readonly (readonly [Uint8Array, (r: Reader) => E])[];

/** First table entry whose discriminator prefixes `payload`, decoded; null when none matches. */
export function decodeWithTables<E extends DecodedEvent>(tables: readonly DecoderTable<E>[], payload: Uint8Array): E | null {
  if (payload.length < DISC_LEN) return null;
  for (const table of tables) {
    for (const [disc, decode] of table) {
      if (startsWith(payload, disc)) return decode(new Reader(payload, DISC_LEN));
    }
  }
  return null;
}

export function requireUpTo(kind: DecodedEventKind, r: Reader, end: number): void {
  if (end > r.length) throw new EventDecodeError(kind, `payload ends at ${r.length} inside required fields (need ${end})`);
}

export function str(kind: DecodedEventKind, r: Reader, max: number): string {
  try {
    return r.string(max);
  } catch (e) {
    throw new EventDecodeError(kind, e instanceof Error ? e.message : String(e));
  }
}
