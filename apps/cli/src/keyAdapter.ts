/**
 * Node/Bun-only dev-key adapter (deliberately OUTSIDE packages/core). Reads WALLET_PRIVATE_KEY
 * (base58, 64-byte secret key) from the environment and turns it into a non-extractable WebCrypto
 * key pair. The key string is never logged, returned, or written anywhere; error messages never
 * include it. In production the browser generates and holds the trading key instead.
 */
import { type Address, createKeyPairFromBytes, getAddressFromPublicKey, getBase58Encoder } from "@solana/kit";

export interface DevSigner {
  address: Address;
  keyPair: CryptoKeyPair;
}

export async function loadDevSigner(): Promise<DevSigner | null> {
  const raw = process.env.WALLET_PRIVATE_KEY?.trim();
  if (!raw) return null;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(getBase58Encoder().encode(raw));
  } catch {
    throw new Error("WALLET_PRIVATE_KEY is not valid base58");
  }
  if (bytes.length !== 64) {
    bytes.fill(0);
    throw new Error("WALLET_PRIVATE_KEY must decode to a 64-byte secret key");
  }
  try {
    const keyPair = await createKeyPairFromBytes(bytes, false);
    return { address: await getAddressFromPublicKey(keyPair.publicKey), keyPair };
  } catch {
    throw new Error("WALLET_PRIVATE_KEY could not be imported (public half mismatch?)");
  } finally {
    bytes.fill(0);
  }
}
