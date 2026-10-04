/** Byte encodings for the wire (standard base64, as packages/protocol specifies) and base58 signatures. */

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

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Base58 (Bitcoin alphabet) of `bytes`: signatures and keys. Local rather than @solana/kit's codec so the
 * wallet layer on the first screen does not pull in kit's codecs (bytes.test.ts checks it against kit).
 */
export function toBase58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i] as number;
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] as number) << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let k = digits.length - 1; k >= 0; k--) out += B58[digits[k] as number];
  return out;
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
