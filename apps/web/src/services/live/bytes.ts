/** Byte encodings for the wire (standard base64, as packages/protocol specifies) and base58 signatures. */
import { getBase58Decoder } from "@solana/kit";

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const b58 = getBase58Decoder();

export function toBase58(bytes: Uint8Array): string {
  return b58.decode(bytes);
}

/** The fee payer's signature (the transaction id) of a wire transaction: [shortvec n][sig 0]... */
export function firstSignature(wire: Uint8Array): string | null {
  let count = 0;
  let shift = 0;
  let i = 0;
  for (; i < 3; i++) {
    const b = wire[i];
    if (b === undefined) return null;
    count |= (b & 0x7f) << shift;
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  const start = i + 1;
  if (count < 1 || wire.length < start + 64) return null;
  return toBase58(wire.subarray(start, start + 64));
}
