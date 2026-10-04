/** Offline mainnet account snapshot (captured by scripts/capture-fixtures.ts on 2026-10-03). */
import { type Address, address, getBase64Encoder } from "@solana/kit";
import snapshot from "./fixtures/mainnet-accounts.json";

const b64 = getBase64Encoder();

export interface FixtureAccount {
  address: Address;
  owner: Address;
  lamports: bigint;
  data: Uint8Array;
}

export function fixture(addr: string): FixtureAccount {
  const a = (snapshot.accounts as Record<string, { owner: string; lamports: string; data: string }>)[addr];
  if (!a) throw new Error(`fixture ${addr} missing`);
  return { address: address(addr), owner: address(a.owner), lamports: BigInt(a.lamports), data: new Uint8Array(b64.encode(a.data)) };
}

export const CURVE_MINT = address(snapshot.curveMint);
export const MAYHEM_MINT = address(snapshot.mayhemMint);
export const POOL = address(snapshot.pool);
