import { type Address, getAddressFromPublicKey } from "@solana/kit";

export interface TestSigner {
  address: Address;
  publicKey: Uint8Array;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

/** Throwaway, never-funded Ed25519 key (non-extractable private key; lives only for the test). */
export async function throwawaySigner(): Promise<TestSigner> {
  const keyPair = (await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"])) as CryptoKeyPair;
  const address = await getAddressFromPublicKey(keyPair.publicKey);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  return {
    address,
    publicKey,
    sign: async (message) => new Uint8Array(await crypto.subtle.sign("Ed25519", keyPair.privateKey, new Uint8Array(message))),
  };
}

/** 2026-10-03T12:00:00.000Z */
export const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
