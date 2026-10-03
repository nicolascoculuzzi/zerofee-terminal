import { type Address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { ASSOCIATED_TOKEN_PROGRAM } from "./programs";

const addressEncoder = getAddressEncoder();

/** Associated token address: PDA of [owner, token program, mint] under the ATA program. */
export async function findAssociatedTokenAddress(owner: Address, mint: Address, tokenProgram: Address): Promise<Address> {
  const [ata] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    seeds: [addressEncoder.encode(owner), addressEncoder.encode(tokenProgram), addressEncoder.encode(mint)],
  });
  return ata;
}

/** Per-check memo: the same few ATAs are derived by several rules. */
export function createAtaResolver(): (owner: Address, mint: Address, tokenProgram: Address) => Promise<Address> {
  const cache = new Map<string, Promise<Address>>();
  return (owner, mint, tokenProgram) => {
    const key = `${owner}:${mint}:${tokenProgram}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = findAssociatedTokenAddress(owner, mint, tokenProgram);
      cache.set(key, hit);
    }
    return hit;
  };
}
