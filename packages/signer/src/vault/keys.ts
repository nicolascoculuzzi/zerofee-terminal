/**
 * Ed25519 key handling with WebCrypto. Private keys are imported NON-extractable: page script can
 * ask the key to sign, but cannot read it back out of the CryptoKey.
 */
import { createKeyPairFromPrivateKeyBytes, type ReadonlyUint8Array } from "@solana/kit";
import { asBufferSource, randomBytes } from "../bytes";
import { SignerError } from "../errors";
import { PUBLIC_KEY_BYTES, SEED_BYTES } from "./format";

/** PKCS#8 v1 prefix for an Ed25519 private key (RFC 8410): SEQUENCE { 0, AlgId(1.3.101.112), OCTET STRING { OCTET STRING(32) } }. */
const PKCS8_ED25519_PREFIX = Uint8Array.of(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20);

/** Imports a 32-byte seed as a non-extractable Ed25519 signing key. Our PKCS#8 copy is wiped. */
export async function importSigningKey(seed: ReadonlyUint8Array): Promise<CryptoKey> {
  if (seed.length !== SEED_BYTES) throw new SignerError("INVALID_SECRET", "Ed25519 seed must be 32 bytes");
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + SEED_BYTES);
  pkcs8.set(PKCS8_ED25519_PREFIX, 0);
  pkcs8.set(seed, PKCS8_ED25519_PREFIX.length);
  try {
    return await crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", false, ["sign"]);
  } finally {
    pkcs8.fill(0);
  }
}

export async function importVerifyKey(publicKey: ReadonlyUint8Array): Promise<CryptoKey> {
  if (publicKey.length !== PUBLIC_KEY_BYTES) throw new SignerError("INVALID_SECRET", "Ed25519 public key must be 32 bytes");
  return crypto.subtle.importKey("raw", asBufferSource(publicKey), "Ed25519", true, ["verify"]);
}

/**
 * Derives the public key of a seed. WebCrypto can only do this through a temporarily extractable
 * key (kit's createKeyPairFromPrivateKeyBytes). We call it once per wallet, when the wallet is
 * generated or imported; unlock uses the public key stored in the encrypted payload instead.
 */
export async function derivePublicKey(seed: ReadonlyUint8Array): Promise<Uint8Array> {
  const pair = await createKeyPairFromPrivateKeyBytes(seed, false);
  return new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
}

/** True if `privateKey` signs for `publicKey` (sign and verify a random challenge). */
export async function keyPairMatches(privateKey: CryptoKey, publicKey: ReadonlyUint8Array): Promise<boolean> {
  const challenge = randomBytes(32);
  const signature = await crypto.subtle.sign("Ed25519", privateKey, challenge);
  return crypto.subtle.verify("Ed25519", await importVerifyKey(publicKey), signature, challenge);
}
