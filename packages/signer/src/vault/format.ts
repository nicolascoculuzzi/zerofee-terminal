/**
 * Vault record format (version 1).
 *
 *   header      canonical JSON string, stored verbatim and used byte-for-byte as AES-GCM AAD:
 *               {"v":1,"kdf":{"alg":"argon2id","m":65536,"t":3,"p":1,"salt":"<base64 16B>"},
 *                "enc":"aes-256-gcm","connectedWallet":"<base58>"}
 *   iv          12 random bytes, fresh for every write
 *   ciphertext  AES-256-GCM(payload) with a 128-bit tag
 *   wallets     public metadata only (address, label, timestamps); rebuilt from the payload at unlock
 *
 * The payload is binary so secrets never become immutable JS strings:
 *   [0x01] then per wallet [32-byte Ed25519 seed][32-byte public key]   (Phantom's 64-byte layout)
 *
 * The connected wallet (the only unlimited withdrawal destination the firewall allows) lives in
 * the authenticated header, so swapping it in storage makes unlock fail instead of redirecting funds.
 */
import { type Address, getBase58Decoder, getBase58Encoder, isAddress } from "@solana/kit";
import { base64ToBytes, bytesToBase64, concatBytes } from "../bytes";
import { SignerError } from "../errors";
import { KDF_SALT_BYTES, type KdfParams } from "./kdf";

export const VAULT_HEADER_VERSION = 1;
export const PAYLOAD_VERSION = 1;
export const SEED_BYTES = 32;
export const PUBLIC_KEY_BYTES = 32;
export const AES_GCM_IV_BYTES = 12;
/** Product limit (Axiom parity). */
export const MAX_WALLETS = 25;

export interface VaultHeader {
  readonly v: 1;
  readonly kdf: { readonly alg: "argon2id"; readonly m: number; readonly t: number; readonly p: number; readonly salt: string };
  readonly enc: "aes-256-gcm";
  readonly connectedWallet: Address;
}

export interface StoredWalletInfo {
  readonly address: string;
  readonly label: string;
  readonly createdAt: number;
  readonly source: "generated" | "imported";
  readonly exportedAt?: number;
}

/** What the storage adapter persists. Nothing here is secret except the ciphertext. */
export interface StoredVault {
  readonly header: string;
  readonly iv: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly wallets: readonly StoredWalletInfo[];
}

export function createHeader(params: KdfParams, salt: Uint8Array, connectedWallet: Address): VaultHeader {
  return {
    v: VAULT_HEADER_VERSION,
    kdf: { alg: "argon2id", m: params.memoryKiB, t: params.iterations, p: params.parallelism, salt: bytesToBase64(salt) },
    enc: "aes-256-gcm",
    connectedWallet,
  };
}

/** Fixed key order, so the same header always serializes to the same AAD bytes. */
export function serializeHeader(h: VaultHeader): string {
  return JSON.stringify({
    v: h.v,
    kdf: { alg: h.kdf.alg, m: h.kdf.m, t: h.kdf.t, p: h.kdf.p, salt: h.kdf.salt },
    enc: h.enc,
    connectedWallet: h.connectedWallet,
  });
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}

/** Strict parse: exact shape, valid values, and canonical serialization. */
export function parseHeader(text: string): { header: VaultHeader; kdf: KdfParams; salt: Uint8Array } {
  const invalid = (why: string): never => {
    throw new SignerError("INVALID_VAULT", `vault header ${why}`);
  };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return invalid("is not JSON");
  }
  if (!hasExactKeys(raw, ["v", "kdf", "enc", "connectedWallet"])) return invalid("has an unexpected shape");
  if (raw.v !== VAULT_HEADER_VERSION) return invalid(`version ${String(raw.v)} is not supported`);
  if (raw.enc !== "aes-256-gcm") return invalid("cipher is not aes-256-gcm");
  const kdf = raw.kdf;
  if (!hasExactKeys(kdf, ["alg", "m", "t", "p", "salt"]) || kdf.alg !== "argon2id") return invalid("KDF is not argon2id");
  const { m, t, p, salt } = kdf;
  if (typeof m !== "number" || typeof t !== "number" || typeof p !== "number" || typeof salt !== "string")
    return invalid("KDF fields are malformed");
  const saltBytes = base64ToBytes(salt);
  if (!saltBytes || saltBytes.length !== KDF_SALT_BYTES) return invalid("salt is malformed");
  const connectedWallet = raw.connectedWallet;
  if (typeof connectedWallet !== "string" || !isAddress(connectedWallet)) return invalid("connected wallet is not an address");
  const header: VaultHeader = { v: VAULT_HEADER_VERSION, kdf: { alg: "argon2id", m, t, p, salt }, enc: "aes-256-gcm", connectedWallet };
  if (serializeHeader(header) !== text) return invalid("is not canonical");
  return { header, kdf: { memoryKiB: m, iterations: t, parallelism: p }, salt: saltBytes };
}

export interface PayloadEntry {
  readonly seed: Uint8Array;
  readonly publicKey: Uint8Array;
}

export function encodePayload(entries: readonly PayloadEntry[]): Uint8Array {
  if (entries.length > MAX_WALLETS) throw new SignerError("WALLET_LIMIT", `at most ${MAX_WALLETS} wallets`);
  const parts: Uint8Array[] = [Uint8Array.of(PAYLOAD_VERSION)];
  for (const e of entries) {
    if (e.seed.length !== SEED_BYTES || e.publicKey.length !== PUBLIC_KEY_BYTES) throw new SignerError("INTERNAL", "bad payload entry");
    parts.push(e.seed, e.publicKey);
  }
  return concatBytes(...parts);
}

/** Returns views into `plain`; the caller zeroes `plain` when done. */
export function decodePayload(plain: Uint8Array): PayloadEntry[] {
  const entrySize = SEED_BYTES + PUBLIC_KEY_BYTES;
  if (plain.length < 1 || plain[0] !== PAYLOAD_VERSION || (plain.length - 1) % entrySize !== 0) {
    throw new SignerError("INVALID_VAULT", "vault payload is malformed");
  }
  const count = (plain.length - 1) / entrySize;
  if (count > MAX_WALLETS) throw new SignerError("INVALID_VAULT", "vault payload holds too many wallets");
  const entries: PayloadEntry[] = [];
  for (let i = 0; i < count; i++) {
    const at = 1 + i * entrySize;
    entries.push({ seed: plain.subarray(at, at + SEED_BYTES), publicKey: plain.subarray(at + SEED_BYTES, at + entrySize) });
  }
  return entries;
}

/**
 * Accepts a Phantom-style secret key (base58 of 64 bytes: seed || public key), a base58 32-byte
 * seed, or the same as raw bytes. Returns fresh copies the caller must zero.
 */
export function parseSecretKey(secret: string | Uint8Array): { seed: Uint8Array; publicKey: Uint8Array | undefined } {
  let bytes: Uint8Array;
  if (typeof secret === "string") {
    const text = secret.trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(text)) throw new SignerError("INVALID_SECRET", "secret key must be base58");
    bytes = new Uint8Array(getBase58Encoder().encode(text));
  } else if (secret instanceof Uint8Array) {
    bytes = new Uint8Array(secret);
  } else {
    throw new SignerError("INVALID_SECRET", "secret key must be a base58 string or bytes");
  }
  try {
    if (bytes.length === SEED_BYTES + PUBLIC_KEY_BYTES) {
      return { seed: bytes.slice(0, SEED_BYTES), publicKey: bytes.slice(SEED_BYTES) };
    }
    if (bytes.length === SEED_BYTES) return { seed: bytes.slice(), publicKey: undefined };
    throw new SignerError("INVALID_SECRET", "secret key must be 64 bytes (seed + public key) or a 32-byte seed");
  } finally {
    bytes.fill(0);
  }
}

/** Phantom-compatible export: base58(seed || public key). */
export function formatSecretKey(seed: Uint8Array, publicKey: Uint8Array): string {
  const joined = concatBytes(seed, publicKey);
  try {
    return getBase58Decoder().decode(joined);
  } finally {
    joined.fill(0);
  }
}
