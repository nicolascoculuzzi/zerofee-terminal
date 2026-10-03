/**
 * Minimal, allocation-light byte helpers. Isomorphic: Uint8Array + DataView only (no Buffer).
 */
import { type Address, getAddressDecoder, getAddressEncoder } from "@solana/kit";

const addressDecoder = getAddressDecoder();
const addressEncoder = getAddressEncoder();
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function utf8(s: string): Uint8Array {
  return textEncoder.encode(s);
}

export function addressBytes(a: Address): Uint8Array {
  return addressEncoder.encode(a) as Uint8Array;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function startsWith(data: Uint8Array, prefix: Uint8Array): boolean {
  if (data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (data[i] !== prefix[i]) return false;
  return true;
}

export function u8(n: number): Uint8Array {
  return new Uint8Array([n & 0xff]);
}

export function u16le(n: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, n, true);
  return out;
}

export function u32le(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

const U64_MAX = (1n << 64n) - 1n;

export function u64le(n: bigint): Uint8Array {
  if (n < 0n || n > U64_MAX) throw new RangeError(`u64 out of range: ${n}`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, true);
  return out;
}

/**
 * Sequential little-endian reader that zero-pads reads past the end of the buffer.
 * pump accounts only ever gain trailing fields and the official SDK zero-pads short buffers
 * before decoding (CPI_README / pump-sdk src/sdk.ts), so missing trailing fields read as 0/false/default.
 */
export class Reader {
  private readonly view: DataView;
  offset: number;

  constructor(
    private readonly data: Uint8Array,
    offset = 0,
  ) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.offset = offset;
  }

  get length(): number {
    return this.data.length;
  }

  /** True when the next `n` bytes are fully present. */
  has(n: number): boolean {
    return this.offset + n <= this.data.length;
  }

  private slice(n: number): Uint8Array {
    const out = new Uint8Array(n);
    const start = this.offset;
    const end = Math.min(start + n, this.data.length);
    if (end > start) out.set(this.data.subarray(start, end));
    this.offset += n;
    return out;
  }

  skip(n: number): this {
    this.offset += n;
    return this;
  }

  bytes(n: number): Uint8Array {
    return this.slice(n);
  }

  u8(): number {
    if (!this.has(1)) {
      this.offset += 1;
      return 0;
    }
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  u16(): number {
    if (!this.has(2)) return new DataView(this.slice(2).buffer).getUint16(0, true);
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  u32(): number {
    if (!this.has(4)) return new DataView(this.slice(4).buffer).getUint32(0, true);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  u64(): bigint {
    if (!this.has(8)) return new DataView(this.slice(8).buffer).getBigUint64(0, true);
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }

  /** Signed two's-complement i64 (Anchor `i64`, e.g. event timestamps). */
  i64(): bigint {
    const raw = this.u64();
    return raw >= 1n << 63n ? raw - (1n << 64n) : raw;
  }

  u128(): bigint {
    const lo = this.u64();
    const hi = this.u64();
    return (hi << 64n) | lo;
  }

  /**
   * Borsh `String` (u32 LE length + UTF-8). A length running past the end of the buffer or above
   * `maxLen` throws (it is corrupt or not this layout), unlike fixed-size reads which zero-pad.
   * A string that starts exactly at the end of the buffer reads as "" (missing trailing field).
   */
  string(maxLen = 1024): string {
    if (!this.has(4)) {
      this.offset += 4;
      return "";
    }
    const len = this.u32();
    if (len > maxLen || !this.has(len)) throw new RangeError(`string length ${len} invalid at offset ${this.offset - 4}`);
    const s = textDecoder.decode(this.data.subarray(this.offset, this.offset + len));
    this.offset += len;
    return s;
  }

  /** Signed two's-complement i128 (e.g. PumpSwap Pool.virtual_quote_reserves). */
  i128(): bigint {
    const raw = this.u128();
    return raw >= 1n << 127n ? raw - (1n << 128n) : raw;
  }

  pubkey(): Address {
    return addressDecoder.decode(this.slice(32));
  }
}
