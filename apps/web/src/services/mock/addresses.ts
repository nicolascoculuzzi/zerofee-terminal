import type { Rng } from "./rng";

export { isBase58Address } from "../../lib/address";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function randomBase58(rng: Rng, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += BASE58[Math.floor(rng.next() * BASE58.length)];
  return out;
}

/** A plausible-looking (not real) Solana address; launchpad vanity suffixes like "pump". */
export function fakeAddress(rng: Rng, suffix = ""): string {
  const length = rng.chance(0.5) ? 44 : 43;
  return randomBase58(rng, length - suffix.length) + suffix;
}

export function fakeSignature(rng: Rng): string {
  return randomBase58(rng, rng.chance(0.5) ? 88 : 87);
}
