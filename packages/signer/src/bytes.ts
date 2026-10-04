/** Byte helpers. Kept local so the signer has no utility dependencies beyond @solana/kit. */
import type { ReadonlyUint8Array } from "@solana/kit";

export function concatBytes(...parts: readonly ReadonlyUint8Array[]): Uint8Array {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function bytesEqual(a: ReadonlyUint8Array, b: ReadonlyUint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function startsWith(data: ReadonlyUint8Array, prefix: ReadonlyUint8Array): boolean {
  if (data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (data[i] !== prefix[i]) return false;
  return true;
}

export function readU32LE(data: ReadonlyUint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > data.length) throw new RangeError("read past end of data");
  return (data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16)) + data[offset + 3]! * 0x1000000;
}

export function readU64LE(data: ReadonlyUint8Array, offset: number): bigint {
  return BigInt(readU32LE(data, offset)) | (BigInt(readU32LE(data, offset + 4)) << 32n);
}

export function toHex(data: ReadonlyUint8Array): string {
  let out = "";
  for (const b of data) out += b.toString(16).padStart(2, "0");
  return out;
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

/** Best-effort wipe of secret material held in JS memory. */
export function zeroize(...arrays: (Uint8Array | undefined)[]): void {
  for (const a of arrays) a?.fill(0);
}

/**
 * WebCrypto wants an ArrayBuffer-backed view. Returns the same view when it already is one (no copy
 * of secrets), otherwise a copy.
 */
export function asBufferSource(bytes: ReadonlyUint8Array): Uint8Array<ArrayBuffer> {
  const view = bytes as Uint8Array;
  return view.buffer instanceof ArrayBuffer ? (view as Uint8Array<ArrayBuffer>) : new Uint8Array(view);
}

const BASE64_ALPHABET = /^[A-Za-z0-9+/]*={0,2}$/;

export function bytesToBase64(bytes: ReadonlyUint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array | undefined {
  if (!BASE64_ALPHABET.test(text) || text.length % 4 !== 0) return undefined;
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return undefined;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
