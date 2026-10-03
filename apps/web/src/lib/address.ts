const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Shape check for a Solana address (base58, 32–44 chars). Not a curve-point check. */
export function isBase58Address(value: string): boolean {
  if (value.length < 32 || value.length > 44) return false;
  for (const ch of value) if (!BASE58.includes(ch)) return false;
  return true;
}
