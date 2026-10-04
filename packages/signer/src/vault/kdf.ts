/**
 * Password -> AES-256-GCM key via Argon2id (hash-wasm, pinned 4.12.0).
 *
 * OWASP Password Storage Cheat Sheet: Argon2id with at least m=19 MiB (19456 KiB), t=2, p=1.
 *   https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
 * Production default is stronger: m=64 MiB, t=3, p=1 (about 0.1 s natively, a few hundred ms in
 * mobile browsers). Parameters live in the vault header, which is the AES-GCM associated data.
 */
import { argon2id } from "hash-wasm";
import { asBufferSource, zeroize } from "../bytes";
import { SignerError } from "../errors";

export interface KdfParams {
  readonly memoryKiB: number;
  readonly iterations: number;
  readonly parallelism: number;
}

export const DEFAULT_KDF_PARAMS: KdfParams = Object.freeze({ memoryKiB: 65_536, iterations: 3, parallelism: 1 });

/** OWASP minimum we accept for creating or unlocking a vault (unless explicitly overridden for tests). */
export const MIN_KDF_PARAMS = Object.freeze({ memoryKiB: 19_456, iterations: 2 });

/**
 * Upper bounds, checked before running the KDF: the header is attacker-writable storage, and an
 * absurd memory size would hang or crash the tab before the GCM tag could reject it.
 */
export const MAX_KDF_PARAMS = Object.freeze({ memoryKiB: 1_048_576, iterations: 64, parallelism: 16 });

export const KDF_SALT_BYTES = 16;
export const KDF_OUTPUT_BYTES = 32;

export function validateKdfParams(params: KdfParams, options: { allowWeak?: boolean } = {}): void {
  const { memoryKiB, iterations, parallelism } = params;
  for (const [name, value] of [
    ["memoryKiB", memoryKiB],
    ["iterations", iterations],
    ["parallelism", parallelism],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new SignerError("INVALID_VAULT", `KDF ${name} must be a positive integer`);
  }
  if (memoryKiB < 8 * parallelism) throw new SignerError("INVALID_VAULT", "KDF memory must be at least 8 KiB per lane");
  if (memoryKiB > MAX_KDF_PARAMS.memoryKiB || iterations > MAX_KDF_PARAMS.iterations || parallelism > MAX_KDF_PARAMS.parallelism) {
    throw new SignerError("INVALID_VAULT", "KDF parameters exceed the supported maximum");
  }
  if (!options.allowWeak && (memoryKiB < MIN_KDF_PARAMS.memoryKiB || iterations < MIN_KDF_PARAMS.iterations)) {
    throw new SignerError(
      "WEAK_KDF",
      `Argon2id parameters below the OWASP minimum (m>=${MIN_KDF_PARAMS.memoryKiB} KiB, t>=${MIN_KDF_PARAMS.iterations})`,
    );
  }
}

/**
 * Unicode-normalizes (NFKC, as NIST SP 800-63B suggests) so the same password typed on different
 * keyboards or OSes derives the same key, then UTF-8 encodes it.
 */
export function encodePassword(password: string): Uint8Array {
  return new TextEncoder().encode(password.normalize("NFKC"));
}

/** Derives the vault's AES-256-GCM key. The raw Argon2id output is zeroed after import. */
export async function deriveVaultKey(password: string, salt: Uint8Array, params: KdfParams): Promise<CryptoKey> {
  if (salt.length !== KDF_SALT_BYTES) throw new SignerError("INVALID_VAULT", `salt must be ${KDF_SALT_BYTES} bytes`);
  const passwordBytes = encodePassword(password);
  let raw: Uint8Array | undefined;
  try {
    raw = await argon2id({
      password: passwordBytes,
      salt,
      iterations: params.iterations,
      parallelism: params.parallelism,
      memorySize: params.memoryKiB,
      hashLength: KDF_OUTPUT_BYTES,
      outputType: "binary",
    });
    return await crypto.subtle.importKey("raw", asBufferSource(raw), { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  } finally {
    zeroize(passwordBytes, raw);
  }
}
