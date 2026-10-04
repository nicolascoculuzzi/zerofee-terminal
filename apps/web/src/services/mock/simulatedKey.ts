/*
 * Simulated trading-wallet secret for the mock wallet service (never a real key).
 */

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 (Bitcoin/Solana alphabet); each leading zero byte becomes "1". */
export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i] ?? 0;
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] ?? 0) * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58[digits[i] ?? 0];
  return out;
}

/** FNV-1a, 32-bit. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * A stand-in for the trading wallet's 64-byte secret key, base58 (87–88 characters, the format
 * Phantom imports). The mock wallet service has no key, so `exportKey` derives a stable stand-in
 * from the wallet's id and address: onboarding's backup and every export show the same string.
 * The live signer returns the real key once, inside its own isolated window. This is NOT a key
 * and controls nothing.
 */
export function simulatedSecretKey(walletId: string, address: string): string {
  let s = hash32(`${walletId}:${address}`) || 1;
  const bytes = new Uint8Array(64);
  for (let i = 0; i < bytes.length; i++) {
    // xorshift32
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    bytes[i] = s & 0xff;
  }
  // A real key's first byte is rarely zero; keep the length stable at 87–88 characters.
  if (bytes[0] === 0) bytes[0] = 1;
  return base58Encode(bytes);
}
