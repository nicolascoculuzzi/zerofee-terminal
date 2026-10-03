/**
 * Server-side verification of a SIWS sign-in (from `solana:signIn`, or the signMessage fallback
 * wrapped with toSignInOutput). Pure apart from the nonce store; no web framework.
 *
 * Order matters: every stateless check (signature, parse, fields, timestamps) runs first and the
 * nonce is consumed last, so garbage requests cannot burn a legitimate user's outstanding nonce.
 */
import { type Address, getAddressEncoder, getPublicKeyFromAddress, isAddress, type SignatureBytes, verifySignature } from "@solana/kit";
import { bytesEqual } from "./encoding";
import type { NonceStore } from "./nonce";
import {
  type ParsedSignInMessage,
  parseRfc3339,
  parseSignInMessageText,
  SIWS_CHAIN_MAINNET,
  SIWS_MAX_EXPIRATION_MS,
  SIWS_VERSION,
  type SolanaSignInOutput,
} from "./siws";

export type SignInFailureReason =
  | "malformed_output"
  | "unsupported_signature_type"
  | "account_mismatch"
  | "invalid_signature"
  | "invalid_message_encoding"
  | "malformed_message"
  | "domain_mismatch"
  | "address_mismatch"
  | "uri_mismatch"
  | "statement_mismatch"
  | "version_mismatch"
  | "chain_mismatch"
  | "missing_nonce"
  | "missing_issued_at"
  | "invalid_timestamp"
  | "issued_at_out_of_range"
  | "missing_expiration"
  | "expiration_too_far"
  | "expired"
  | "not_yet_valid"
  | "nonce_invalid";

export type SignInVerification =
  | { ok: true; address: Address; message: ParsedSignInMessage }
  | { ok: false; reason: SignInFailureReason; detail: string };

export interface SignInExpectations {
  /** Our canonical domain; must equal the message's domain exactly. */
  domain: string;
  /** Issued nonces. The message's nonce is consumed only after every other check passes. */
  nonceStore: NonceStore;
  /** If set, the message URI must match exactly. */
  uri?: string;
  /** If set, the statement must match exactly. */
  statement?: string;
  /** Default "mainnet". */
  chainId?: string;
  /** Default "1". */
  version?: string;
  /** Current time in ms (or a clock). Default Date.now(). */
  now?: number | (() => number);
  /** Tolerance for future-dated issuedAt / notBefore. Default 60 s. */
  clockSkewMs?: number;
  /** issuedAt may be at most this old. Default 10 minutes (the nonce lifetime). */
  maxAgeMs?: number;
  /** expirationTime may be at most this far after issuedAt (and after now). Default and ceiling: 10 minutes. */
  maxExpirationMs?: number;
}

/** Messages longer than this are rejected before parsing (a SIWS message is a few hundred bytes). */
export const MAX_SIGN_IN_MESSAGE_BYTES = 4096;

const DEFAULT_CLOCK_SKEW_MS = 60_000;
const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;

function failure(reason: SignInFailureReason, detail: string): SignInVerification {
  return { ok: false, reason, detail };
}

function isBytes(value: unknown, length?: number): value is Uint8Array {
  return value instanceof Uint8Array && (length === undefined || value.length === length);
}

export async function verifySignIn(output: SolanaSignInOutput, expectations: SignInExpectations): Promise<SignInVerification> {
  // 1. Shape.
  const account = (output as Partial<SolanaSignInOutput> | undefined)?.account;
  if (!account || typeof account.address !== "string" || !isBytes(account.publicKey, 32)) {
    return failure("malformed_output", "account.address and a 32-byte account.publicKey are required");
  }
  if (!isBytes(output.signature, 64)) return failure("malformed_output", "signature must be 64 bytes");
  if (!isBytes(output.signedMessage) || output.signedMessage.length === 0 || output.signedMessage.length > MAX_SIGN_IN_MESSAGE_BYTES) {
    return failure("malformed_output", `signedMessage must be 1..${MAX_SIGN_IN_MESSAGE_BYTES} bytes`);
  }
  if (output.signatureType !== undefined && output.signatureType !== "ed25519") {
    return failure("unsupported_signature_type", `signatureType ${String(output.signatureType)}`);
  }

  // 2. The account's public key must be the address it claims.
  if (!isAddress(account.address)) return failure("malformed_output", "account.address is not a valid address");
  const address = account.address;
  if (!bytesEqual(new Uint8Array(getAddressEncoder().encode(address)), account.publicKey)) {
    return failure("account_mismatch", "account.publicKey does not match account.address");
  }

  // 3. Ed25519 signature over the exact bytes the wallet signed.
  let valid = false;
  try {
    const key = await getPublicKeyFromAddress(address);
    valid = await verifySignature(key, output.signature as SignatureBytes, output.signedMessage);
  } catch {
    valid = false;
  }
  if (!valid) return failure("invalid_signature", "signature does not verify for the signing account");

  // 4. Strict UTF-8 (a BOM is kept, so it fails the header check instead of being silently dropped).
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(output.signedMessage);
  } catch {
    return failure("invalid_message_encoding", "signedMessage is not valid UTF-8");
  }

  // 5. Canonical parse.
  const parsed = parseSignInMessageText(text);
  if (!parsed.ok) return failure("malformed_message", parsed.error);
  const m = parsed.message;

  // 6. Binding fields.
  if (m.domain !== expectations.domain) return failure("domain_mismatch", `message domain ${JSON.stringify(m.domain)}`);
  if (m.address !== address) return failure("address_mismatch", "message address is not the signing account");
  if (expectations.uri !== undefined && m.uri !== expectations.uri) return failure("uri_mismatch", `message uri ${JSON.stringify(m.uri)}`);
  if (expectations.statement !== undefined && m.statement !== expectations.statement) {
    return failure("statement_mismatch", "statement differs from the one issued");
  }
  const version = expectations.version ?? SIWS_VERSION;
  if (m.version !== version) return failure("version_mismatch", `expected version ${version}`);
  const chainId = expectations.chainId ?? SIWS_CHAIN_MAINNET;
  if (m.chainId !== chainId) return failure("chain_mismatch", `expected chain ${chainId}, got ${JSON.stringify(m.chainId)}`);
  if (m.nonce === undefined) return failure("missing_nonce", "message has no nonce");

  // 7. Time window.
  const now = typeof expectations.now === "function" ? expectations.now() : (expectations.now ?? Date.now());
  const skew = expectations.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
  const maxAge = expectations.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxExpiration = Math.min(expectations.maxExpirationMs ?? SIWS_MAX_EXPIRATION_MS, SIWS_MAX_EXPIRATION_MS);

  if (m.issuedAt === undefined) return failure("missing_issued_at", "message has no issuedAt");
  const issuedAt = parseRfc3339(m.issuedAt);
  if (issuedAt === undefined) return failure("invalid_timestamp", "issuedAt is not RFC 3339");
  if (issuedAt > now + skew) return failure("issued_at_out_of_range", "issuedAt is in the future");
  if (issuedAt < now - maxAge) return failure("issued_at_out_of_range", "issuedAt is too old");

  if (m.expirationTime === undefined) return failure("missing_expiration", "message has no expirationTime");
  const expiresAt = parseRfc3339(m.expirationTime);
  if (expiresAt === undefined) return failure("invalid_timestamp", "expirationTime is not RFC 3339");
  if (expiresAt <= issuedAt) return failure("expired", "expirationTime is not after issuedAt");
  if (expiresAt - issuedAt > maxExpiration || expiresAt - now > maxExpiration + skew) {
    return failure("expiration_too_far", `expirationTime must be within ${maxExpiration} ms`);
  }
  if (now >= expiresAt) return failure("expired", "message has expired");

  if (m.notBefore !== undefined) {
    const notBefore = parseRfc3339(m.notBefore);
    if (notBefore === undefined) return failure("invalid_timestamp", "notBefore is not RFC 3339");
    if (notBefore > now + skew) return failure("not_yet_valid", "notBefore is in the future");
  }

  // 8. Single use. Last, after everything else has passed.
  if (!(await expectations.nonceStore.consume(m.nonce))) {
    return failure("nonce_invalid", "nonce is unknown, expired or already used");
  }
  return { ok: true, address, message: m };
}
