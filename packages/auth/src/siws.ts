/**
 * Sign-In With Solana (SIWS): the message format behind the Wallet Standard `solana:signIn`
 * feature (Phantom, Solflare, Backpack).
 *
 * Format and field order follow Phantom's SIWS spec and the reference implementation that wallets
 * use to render the text they sign:
 *   https://github.com/phantom/sign-in-with-solana
 *   npm @solana/wallet-standard-util, src/signIn.ts (createSignInMessageText / parseSignInMessageText)
 *
 *   ${domain} wants you to sign in with your Solana account:
 *   ${address}
 *
 *   ${statement}
 *
 *   URI: ${uri}
 *   Version: ${version}
 *   Chain ID: ${chainId}
 *   Nonce: ${nonce}
 *   Issued At: ${issuedAt}
 *   Expiration Time: ${expirationTime}
 *   Not Before: ${notBefore}
 *   Request ID: ${requestId}
 *   Resources:
 *   - ${resources[0]}
 *   - ${resources[n]}
 *
 * The parser here is stricter than the reference regex: it is line based, rejects control
 * characters other than "\n", and only accepts text that re-serializes to exactly the same string.
 * Every signed message therefore has one meaning, with no CRLF variants, duplicate or reordered
 * fields, or trailing junk.
 */
import { isAddress } from "@solana/kit";

/** Wallet Standard `SolanaSignInInput` (all fields optional; wallets fill domain/address when omitted). */
export interface SolanaSignInInput {
  readonly domain?: string;
  readonly address?: string;
  readonly statement?: string;
  readonly uri?: string;
  readonly version?: string;
  readonly chainId?: string;
  readonly nonce?: string;
  readonly issuedAt?: string;
  readonly expirationTime?: string;
  readonly notBefore?: string;
  readonly requestId?: string;
  readonly resources?: readonly string[];
}

/** Wallet Standard `SolanaSignInOutput` (structurally compatible with @solana/wallet-standard-features). */
export interface SolanaSignInOutput {
  readonly account: { readonly address: string; readonly publicKey: Uint8Array };
  readonly signedMessage: Uint8Array;
  readonly signature: Uint8Array;
  readonly signatureType?: "ed25519";
}

/** The fields of a complete message: domain and address are always present in the text. */
export interface SignInMessageFields extends SolanaSignInInput {
  readonly domain: string;
  readonly address: string;
}

export type ParsedSignInMessage = Readonly<SignInMessageFields>;

export type SignInMessageParseResult = { ok: true; message: ParsedSignInMessage } | { ok: false; error: string };

/** Upper bound for expirationTime - issuedAt (product decision: sign-in messages live at most 10 minutes). */
export const SIWS_MAX_EXPIRATION_MS = 10 * 60 * 1000;
/** The only SIWS message version that exists. */
export const SIWS_VERSION = "1";
/** CAIP-style chain reference used by SIWS for Solana mainnet. */
export const SIWS_CHAIN_MAINNET = "mainnet";

const HEADER_SUFFIX = " wants you to sign in with your Solana account:";

/** Labelled single-line fields, in the only order the format allows. */
const FIELDS = [
  ["uri", "URI: "],
  ["version", "Version: "],
  ["chainId", "Chain ID: "],
  ["nonce", "Nonce: "],
  ["issuedAt", "Issued At: "],
  ["expirationTime", "Expiration Time: "],
  ["notBefore", "Not Before: "],
  ["requestId", "Request ID: "],
] as const satisfies readonly (readonly [keyof SolanaSignInInput, string])[];

type FieldKey = (typeof FIELDS)[number][0];

const RESOURCES_LABEL = "Resources:";
const RESOURCE_PREFIX = "- ";

/** True if the text contains any C0 control character or DEL other than "\n". */
function hasForbiddenControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 0x20 && c !== 0x0a) || c === 0x7f) return true;
  }
  return false;
}
/** RFC 3986 authority (host[:port]) without whitespace, path, query or fragment. */
const DOMAIN = /^[^\s/?#@]+$/;
/** SIWS requires at least 8 alphanumeric characters. */
const NONCE = /^[A-Za-z0-9]{8,}$/;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

export function isValidNonce(nonce: string): boolean {
  return NONCE.test(nonce);
}

/**
 * Parses an RFC 3339 / ISO 8601 timestamp (as produced by Date.toISOString) into epoch milliseconds.
 * Returns undefined for anything malformed or out of range. Implemented by hand so behaviour does
 * not depend on the JavaScript engine's lenient Date.parse.
 */
export function parseRfc3339(value: string): number | undefined {
  const m = RFC3339.exec(value);
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const fraction = m[7];
  if (year < 1970 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return undefined;
  const millis = fraction ? Number(fraction.slice(0, 3).padEnd(3, "0")) : 0;
  const base = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  if (new Date(base).getUTCDate() !== day) return undefined; // e.g. 2026-02-30
  if (m[8] === "Z") return base;
  const offsetHours = Number(m[10]);
  const offsetMinutes = Number(m[11]);
  if (offsetHours > 23 || offsetMinutes > 59) return undefined;
  const offset = (offsetHours * 60 + offsetMinutes) * 60_000;
  return m[9] === "+" ? base - offset : base + offset;
}

export function toRfc3339(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function startsWithFieldLabel(line: string): boolean {
  return line === RESOURCES_LABEL || FIELDS.some(([, label]) => line.startsWith(label));
}

/**
 * Throws if the fields cannot be rendered unambiguously. Applied by every builder, so this module
 * never produces a message that its own parser would read differently.
 */
export function assertValidSignInFields(fields: SignInMessageFields): void {
  const fail = (msg: string): never => {
    throw new TypeError(`invalid sign-in message: ${msg}`);
  };
  const singleLine = (name: string, value: string | undefined) => {
    if (value === undefined) return;
    if (typeof value !== "string" || value.length === 0) fail(`${name} must be a non-empty string`);
    if (value.includes("\n") || hasForbiddenControl(value)) fail(`${name} must be a single line without control characters`);
  };
  singleLine("domain", fields.domain);
  if (!DOMAIN.test(fields.domain)) fail("domain must be a bare host[:port]");
  singleLine("address", fields.address);
  if (!isAddress(fields.address)) fail("address is not a valid base58 Solana address");
  singleLine("statement", fields.statement);
  if (fields.statement !== undefined && startsWithFieldLabel(fields.statement)) fail("statement must not start with a field label");
  for (const [key] of FIELDS) singleLine(key, fields[key]);
  if (fields.nonce !== undefined && !isValidNonce(fields.nonce)) fail("nonce must be at least 8 alphanumeric characters");
  for (const key of ["issuedAt", "expirationTime", "notBefore"] as const) {
    const value = fields[key];
    if (value !== undefined && parseRfc3339(value) === undefined) fail(`${key} must be an RFC 3339 timestamp`);
  }
  if (fields.resources !== undefined) {
    if (!Array.isArray(fields.resources)) fail("resources must be an array");
    for (const r of fields.resources) singleLine("resource", r);
  }
}

/**
 * Renders the exact text a wallet signs. Byte-for-byte compatible with the Wallet Standard
 * reference `createSignInMessageText` for valid input.
 */
export function createSignInMessageText(fields: SignInMessageFields): string {
  assertValidSignInFields(fields);
  let message = `${fields.domain}${HEADER_SUFFIX}\n${fields.address}`;
  if (fields.statement !== undefined) message += `\n\n${fields.statement}`;
  const lines: string[] = [];
  for (const [key, label] of FIELDS) {
    const value = fields[key];
    if (value !== undefined) lines.push(`${label}${value}`);
  }
  if (fields.resources !== undefined) {
    lines.push(RESOURCES_LABEL);
    for (const r of fields.resources) lines.push(`${RESOURCE_PREFIX}${r}`);
  }
  if (lines.length > 0) message += `\n\n${lines.join("\n")}`;
  return message;
}

/** UTF-8 bytes of the message text: what `signMessage` signs in the fallback flow. */
export function createSignInMessage(fields: SignInMessageFields): Uint8Array {
  return new TextEncoder().encode(createSignInMessageText(fields));
}

/** Strict parser. Accepts only text that re-serializes to the identical string. */
export function parseSignInMessageText(text: string): SignInMessageParseResult {
  const fail = (error: string): SignInMessageParseResult => ({ ok: false, error });
  if (hasForbiddenControl(text)) return fail("message contains control characters other than \\n");
  const lines = text.split("\n");
  const header = lines[0] ?? "";
  if (!header.endsWith(HEADER_SUFFIX)) return fail("missing SIWS header line");
  const domain = header.slice(0, -HEADER_SUFFIX.length);
  const address = lines[1];
  if (!domain) return fail("empty domain");
  if (address === undefined || address === "") return fail("missing address line");

  const out: { -readonly [K in keyof SignInMessageFields]: SignInMessageFields[K] } = { domain, address };
  let i = 2;
  if (i < lines.length) {
    if (lines[i] !== "") return fail("expected a blank line after the address");
    i++;
    const first = lines[i];
    if (first === undefined || first === "") return fail("unexpected blank line");
    if (!startsWithFieldLabel(first)) {
      out.statement = first;
      i++;
      if (i < lines.length) {
        if (lines[i] !== "") return fail("expected a blank line after the statement");
        i++;
        if (i >= lines.length) return fail("trailing blank line");
      }
    }
    let nextField = 0;
    while (i < lines.length) {
      const line = lines[i] as string;
      if (line === RESOURCES_LABEL) {
        const resources: string[] = [];
        i++;
        while (i < lines.length) {
          const r = lines[i] as string;
          if (!r.startsWith(RESOURCE_PREFIX)) return fail("unexpected line after Resources");
          resources.push(r.slice(RESOURCE_PREFIX.length));
          i++;
        }
        out.resources = resources;
        break;
      }
      let matched = false;
      for (let f = nextField; f < FIELDS.length; f++) {
        const [key, label] = FIELDS[f] as (typeof FIELDS)[number];
        if (line.startsWith(label)) {
          (out as Record<FieldKey, string>)[key] = line.slice(label.length);
          nextField = f + 1;
          matched = true;
          break;
        }
      }
      if (!matched) return fail(`unexpected, duplicate or out-of-order line: ${JSON.stringify(line.slice(0, 40))}`);
      i++;
    }
  }

  let canonical: string;
  try {
    canonical = createSignInMessageText(out);
  } catch (e) {
    return fail((e as Error).message);
  }
  if (canonical !== text) return fail("message is not in canonical form");
  return { ok: true, message: Object.freeze(out) };
}

export interface CreateSignInInputParams {
  /** Our canonical domain (host[:port]), e.g. "zerofee.example". */
  domain: string;
  /** Server-issued nonce (see nonce.ts). */
  nonce: string;
  /** Origin of the app, e.g. "https://zerofee.example". */
  uri: string;
  statement?: string;
  /** Optional for `solana:signIn` (the wallet fills it in); required for the signMessage fallback. */
  address?: string;
  chainId?: string;
  /** Defaults to now. */
  issuedAt?: number;
  /** Lifetime of the message, default and maximum 10 minutes. */
  expiresInMs?: number;
  notBefore?: number;
  requestId?: string;
  resources?: readonly string[];
  now?: () => number;
}

export const DEFAULT_SIGN_IN_STATEMENT = "Sign in to zerofee-terminal. This request does not move funds or approve any transaction.";

/**
 * Builds the input for `wallet.features["solana:signIn"].signIn(input)`. Run it on the server
 * (or with server-provided nonce and timestamps) so issuedAt/expirationTime come from one clock.
 */
export function createSignInInput(params: CreateSignInInputParams): SolanaSignInInput {
  const now = params.now ?? Date.now;
  const issuedAt = params.issuedAt ?? now();
  const expiresInMs = params.expiresInMs ?? SIWS_MAX_EXPIRATION_MS;
  if (!Number.isFinite(expiresInMs) || expiresInMs <= 0 || expiresInMs > SIWS_MAX_EXPIRATION_MS) {
    throw new RangeError(`expiresInMs must be in (0, ${SIWS_MAX_EXPIRATION_MS}]`);
  }
  if (!/^https?:\/\//.test(params.uri)) throw new TypeError("uri must be an http(s) URL");
  const input: SolanaSignInInput = {
    domain: params.domain,
    ...(params.address !== undefined ? { address: params.address } : {}),
    statement: params.statement ?? DEFAULT_SIGN_IN_STATEMENT,
    uri: params.uri,
    version: SIWS_VERSION,
    chainId: params.chainId ?? SIWS_CHAIN_MAINNET,
    nonce: params.nonce,
    issuedAt: toRfc3339(issuedAt),
    expirationTime: toRfc3339(issuedAt + expiresInMs),
    ...(params.notBefore !== undefined ? { notBefore: toRfc3339(params.notBefore) } : {}),
    ...(params.requestId !== undefined ? { requestId: params.requestId } : {}),
    ...(params.resources !== undefined ? { resources: [...params.resources] } : {}),
  };
  // Validate with a placeholder address when the wallet will supply the real one.
  assertValidSignInFields({
    ...input,
    domain: params.domain,
    address: params.address ?? "11111111111111111111111111111111",
  });
  return input;
}

/**
 * Fallback for wallets without `solana:signIn`: the client renders the same text with
 * createSignInMessage (address required), asks the wallet to `signMessage` it, then wraps the
 * result in the `solana:signIn` output shape so the server runs one verification path.
 */
export function toSignInOutput(args: {
  address: string;
  publicKey: Uint8Array;
  signedMessage: Uint8Array;
  signature: Uint8Array;
}): SolanaSignInOutput {
  return {
    account: { address: args.address, publicKey: args.publicKey },
    signedMessage: args.signedMessage,
    signature: args.signature,
    signatureType: "ed25519",
  };
}
