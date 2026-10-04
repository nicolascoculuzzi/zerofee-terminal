/**
 * Armed transaction assembly: durable-nonce v0 messages, optionally compressed with lookup tables.
 *
 * Layout of every armed variant:
 *   [AdvanceNonceAccount, SetComputeUnitLimit, SetComputeUnitPrice, ...trade ixs, ...tips]
 * and of the pre-signed cancel:
 *   [AdvanceNonceAccount, SetComputeUnitLimit, (SetComputeUnitPrice), (...tips)]
 *
 * Whatever the tables contain, every account the signer firewall requires as a static key stays
 * static (see staticAccounts.ts): the nonce account (also SIMD-0242), tips and the jitodontfront
 * marker, token programs, mints, the System program, every account of System / Token / ATA
 * instructions (transfer destinations, ATAs, owners, close destinations), and the venue accounts
 * the firewall pins (pump: mints, token programs, user ATAs; PumpSwap: also the pool; Raydium
 * LaunchLab / CPMM: LAUNCHLAB_ / CPMM_FIREWALL_STATIC_POSITIONS).
 */
import {
  type AccountLookupMeta,
  type AccountMeta,
  type Address,
  type AddressesByLookupTableAddress,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Instruction,
  type Nonce,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingDurableNonce,
  type Transaction,
  type TransactionPartialSigner,
} from "@solana/kit";
import { PACKET_DATA_SIZE, SYSTEM_PROGRAM_ID } from "../constants";
import { transactionSize, withBudgetAndTips } from "../tx/assemble";
import { setComputeUnitLimitInstruction, setComputeUnitPriceInstruction } from "../tx/computeBudget";
import { type TipAccountSets, type TipSpec, tipInstruction } from "../tx/tip";
import { FIREWALL_ALL_STATIC_PROGRAMS, FIREWALL_STATIC_VENUE_POSITIONS, NEVER_LOOKED_UP } from "./staticAccounts";

/** One durable-nonce slot as seen at signing time. */
export interface DurableNonceRef {
  account: Address;
  /** Must be the trading wallet: it signs every variant and the cancel. */
  authority: Address;
  /** Durable nonce value read from the slot just before signing. */
  value: Nonce;
}

export interface ArmedTxFees {
  cuLimit: number;
  cuPriceMicroLamports: bigint;
  tips: readonly TipSpec[];
  /** Read-only `jitodontfront…` marker on the first Jito tip (armed orders go Jito bundle-only). */
  jitoDontFront: boolean;
}

export interface ArmedTxParams {
  /** Trading wallet: fee payer, nonce authority and token owner. */
  feePayer: Address;
  nonce: DurableNonceRef;
  /** Trade instructions only (no compute budget, no tips, no nonce advance). */
  instructions: readonly Instruction[];
  fees: ArmedTxFees;
  /** Operator lookup tables (table address -> its addresses, in table order). */
  lookupTables?: AddressesByLookupTableAddress;
  tipAccounts?: TipAccountSets;
  /** Default PACKET_DATA_SIZE (1,232 bytes). */
  sizeLimit?: number;
}

export class ArmedTxTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly limit: number,
  ) {
    super(`armed transaction too large: ${size} > ${limit} bytes (add the operator lookup table or trim tips)`);
  }
}

/** Accounts that must never be loaded from a lookup table in this armed tx. */
function mustStayStatic(nonce: DurableNonceRef, instructions: readonly Instruction[], tipAccounts?: TipAccountSets): Set<Address> {
  const keep = new Set<Address>([nonce.account, ...NEVER_LOOKED_UP, ...(tipAccounts?.helius ?? []), ...(tipAccounts?.jito ?? [])]);
  for (const ix of instructions) {
    const accounts = ix.accounts ?? [];
    if (FIREWALL_ALL_STATIC_PROGRAMS.has(ix.programAddress)) for (const a of accounts) keep.add(a.address);
    for (const i of FIREWALL_STATIC_VENUE_POSITIONS.get(ix.programAddress) ?? []) {
      const a = accounts[i];
      if (a) keep.add(a.address);
    }
    for (const a of accounts) if (a.address.startsWith("jitodontfront")) keep.add(a.address);
  }
  return keep;
}

type AnyMeta = AccountMeta | AccountLookupMeta;

function nonceMessage(feePayer: Address, nonce: DurableNonceRef, instructions: readonly Instruction[]) {
  return pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
    (m) =>
      setTransactionMessageLifetimeUsingDurableNonce(
        { nonce: nonce.value, nonceAccountAddress: nonce.account, nonceAuthorityAddress: nonce.authority },
        m,
      ),
  );
}
type NonceMessage = ReturnType<typeof nonceMessage>;

/** Compresses with kit, then reverts any lookup of an account that must stay static. */
function compress(message: NonceMessage, tables: AddressesByLookupTableAddress | undefined, keepStatic: Set<Address>): NonceMessage {
  if (!tables || Object.keys(tables).length === 0) return message;
  const compressed = compressTransactionMessageUsingAddressLookupTables(message, tables);
  const instructions = compressed.instructions.map((ix) => {
    const accounts = ix.accounts as readonly AnyMeta[] | undefined;
    if (!accounts?.some((a) => "lookupTableAddress" in a && keepStatic.has(a.address))) return ix;
    return Object.freeze({
      ...ix,
      accounts: accounts.map((a) => ("lookupTableAddress" in a && keepStatic.has(a.address) ? { address: a.address, role: a.role } : a)),
    });
  });
  return Object.freeze({ ...compressed, instructions }) as unknown as NonceMessage;
}

function armedInstructions(p: ArmedTxParams): Instruction[] {
  return withBudgetAndTips({
    feePayer: p.feePayer,
    instructions: p.instructions,
    fees: {
      cuLimit: p.fees.cuLimit,
      cuPriceMicroLamports: p.fees.cuPriceMicroLamports,
      tips: [...p.fees.tips],
      jitoDontFront: p.fees.jitoDontFront,
    },
    tipAccounts: p.tipAccounts,
  });
}

function assertNonce(feePayer: Address, nonce: DurableNonceRef): void {
  if (nonce.authority !== feePayer) throw new Error(`nonce authority ${nonce.authority} must be the trading wallet ${feePayer}`);
}

/** Compiles one armed variant (unsigned). Throws ArmedTxTooLargeError above the size limit. */
export function compileArmedTransaction(p: ArmedTxParams): { transaction: Transaction; size: number } {
  assertNonce(p.feePayer, p.nonce);
  const ixs = armedInstructions(p);
  const message = compress(nonceMessage(p.feePayer, p.nonce, ixs), p.lookupTables, mustStayStatic(p.nonce, ixs, p.tipAccounts));
  const transaction = compileTransaction(message);
  const size = transactionSize(transaction);
  const limit = p.sizeLimit ?? PACKET_DATA_SIZE;
  if (size > limit) throw new ArmedTxTooLargeError(size, limit);
  return { transaction, size };
}

export interface ArmedTxSize {
  /** Serialized size with the given lookup tables. */
  size: number;
  /** Serialized size with no lookup tables. */
  sizeWithoutLookupTables: number;
  limit: number;
  fits: boolean;
  staticAccounts: number;
  lookedUpAccounts: number;
}

function accountStats(tx: Transaction): { staticAccounts: number; lookedUpAccounts: number } {
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const lookups = "addressTableLookups" in msg ? (msg.addressTableLookups ?? []) : [];
  return {
    staticAccounts: msg.staticAccounts.length,
    lookedUpAccounts: lookups.reduce((n, l) => n + l.readonlyIndexes.length + l.writableIndexes.length, 0),
  };
}

/** Size calculator: compiles the variant with and without tables (never throws on size). */
export function measureArmedTransaction(p: ArmedTxParams): ArmedTxSize {
  assertNonce(p.feePayer, p.nonce);
  const ixs = armedInstructions(p);
  const plain = compileTransaction(nonceMessage(p.feePayer, p.nonce, ixs));
  const withTables = compileTransaction(
    compress(nonceMessage(p.feePayer, p.nonce, ixs), p.lookupTables, mustStayStatic(p.nonce, ixs, p.tipAccounts)),
  );
  const limit = p.sizeLimit ?? PACKET_DATA_SIZE;
  const size = transactionSize(withTables);
  return { size, sizeWithoutLookupTables: transactionSize(plain), limit, fits: size <= limit, ...accountStats(withTables) };
}

// ---------------------------------------------------------------------------------------------
// Pre-signed cancel
// ---------------------------------------------------------------------------------------------

/** Compute units for a cancel: it consumed 300 CU on Agave 4.3 (local validator, 2026-10-03); 2,000 leaves headroom. */
export const DEFAULT_CANCEL_CU_LIMIT = 2_000;

export interface CancelTxOptions {
  cuLimit?: number;
  /** 0 (default) omits SetComputeUnitPrice. */
  cuPriceMicroLamports?: bigint;
  /** Optional tips so the cancel can go through a tip-requiring lane (Helius Sender needs >= 5,000 lamports). */
  tips?: readonly TipSpec[];
  tipAccounts?: TipAccountSets;
}

/**
 * The cancel: a transaction that only advances the nonce. Landing it kills every variant signed
 * against the same nonce value (a failed landing would too: the advance still happens).
 */
export function compileCancelTransaction(
  feePayer: Address,
  nonce: DurableNonceRef,
  opts: CancelTxOptions = {},
): { transaction: Transaction; size: number } {
  assertNonce(feePayer, nonce);
  const price = opts.cuPriceMicroLamports ?? 0n;
  const ixs: Instruction[] = [setComputeUnitLimitInstruction(opts.cuLimit ?? DEFAULT_CANCEL_CU_LIMIT)];
  if (price > 0n) ixs.push(setComputeUnitPriceInstruction(price));
  for (const spec of opts.tips ?? []) ixs.push(tipInstruction({ from: feePayer, spec, tipAccounts: opts.tipAccounts }));
  const transaction = compileTransaction(nonceMessage(feePayer, nonce, ixs));
  return { transaction, size: transactionSize(transaction) };
}

// ---------------------------------------------------------------------------------------------
// Signing and wire format
// ---------------------------------------------------------------------------------------------

/** Signed bytes as stored by the server. */
export interface SignedTx {
  /** Base64 wire transaction (what the lanes send). */
  wireBase64: string;
  /** Base58 fee-payer signature = transaction id. */
  signature: string;
  size: number;
}

/**
 * Signs a batch in ONE signer call (one wallet popup in direct mode). Works with kit's
 * `createSignerFromKeyPair(keyPair)` for the browser trading wallet.
 */
export async function signTransactionBatch(signer: TransactionPartialSigner, txs: readonly Transaction[]): Promise<Transaction[]> {
  if (txs.length === 0) return [];
  const dicts = await signer.signTransactions(txs as Parameters<TransactionPartialSigner["signTransactions"]>[0]);
  if (dicts.length !== txs.length) throw new Error(`signer returned ${dicts.length} signature sets for ${txs.length} transactions`);
  return txs.map((tx, i) => Object.freeze({ ...tx, signatures: Object.freeze({ ...tx.signatures, ...dicts[i] }) }));
}

const base58 = getBase58Decoder();

export function toSignedTx(tx: Transaction, feePayer: Address): SignedTx {
  const sig = tx.signatures[feePayer];
  if (!sig) throw new Error(`transaction is not signed by ${feePayer}`);
  return { wireBase64: getBase64EncodedWireTransaction(tx), signature: base58.decode(sig), size: transactionSize(tx) };
}

export interface InspectedInstruction {
  program: Address;
  accountIndices: number[];
  /** Resolved keys; null where a lookup could not be resolved (table contents not supplied). */
  accounts: (Address | null)[];
  data: Uint8Array;
}

/** What a server can learn from signed armed bytes before trusting the metadata sent with them. */
export interface ArmedTxInspection {
  size: number;
  version: number | "legacy";
  feePayer: Address;
  /** Static signer keys, in order. */
  signers: Address[];
  signatures: Record<Address, Uint8Array | null>;
  messageBytes: Uint8Array;
  lifetimeToken: string;
  staticAccounts: Address[];
  lookupTables: Address[];
  /** Static keys followed by writable then read-only lookups (null when unresolved). */
  accountKeys: (Address | null)[];
  writable: boolean[];
  instructions: InspectedInstruction[];
  /** Decoded from instruction 0 when it is `AdvanceNonceAccount`. */
  nonce: { account: Address | null; authority: Address | null; accountIsStatic: boolean; accountIsWritable: boolean } | null;
}

const ADVANCE_NONCE_DATA = [4, 0, 0, 0];

/** Decodes a base64 wire transaction; pass the lookup tables to resolve loaded accounts. */
export function inspectArmedTransaction(wireBase64: string, lookupTables: AddressesByLookupTableAddress = {}): ArmedTxInspection {
  const bytes = getBase64Encoder().encode(wireBase64) as Uint8Array;
  const tx = getTransactionDecoder().decode(bytes);
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  // Armed transactions are v0 (v1 has no lookup tables and a different instruction layout).
  if (msg.version === 1) throw new Error("v1 transactions are not armed-order transactions");
  const staticAccounts = [...msg.staticAccounts];
  const { numSignerAccounts, numReadonlySignerAccounts, numReadonlyNonSignerAccounts } = msg.header;
  const writable = staticAccounts.map(
    (_a, i) =>
      i < numSignerAccounts - numReadonlySignerAccounts ||
      (i >= numSignerAccounts && i < staticAccounts.length - numReadonlyNonSignerAccounts),
  );
  const lookups = "addressTableLookups" in msg ? (msg.addressTableLookups ?? []) : [];
  const accountKeys: (Address | null)[] = [...staticAccounts];
  for (const l of lookups) {
    for (const i of l.writableIndexes) {
      accountKeys.push(lookupTables[l.lookupTableAddress]?.[i] ?? null);
      writable.push(true);
    }
  }
  for (const l of lookups) {
    for (const i of l.readonlyIndexes) {
      accountKeys.push(lookupTables[l.lookupTableAddress]?.[i] ?? null);
      writable.push(false);
    }
  }
  const instructions: InspectedInstruction[] = msg.instructions.map((ix) => {
    const program = staticAccounts[ix.programAddressIndex];
    if (!program) throw new Error(`program index ${ix.programAddressIndex} is not a static account`);
    const accountIndices = [...(ix.accountIndices ?? [])];
    return { program, accountIndices, accounts: accountIndices.map((i) => accountKeys[i] ?? null), data: new Uint8Array(ix.data ?? []) };
  });
  const first = instructions[0];
  let nonce: ArmedTxInspection["nonce"] = null;
  if (first && first.program === SYSTEM_PROGRAM_ID && first.data.length === 4 && ADVANCE_NONCE_DATA.every((b, i) => first.data[i] === b)) {
    const nonceIdx = first.accountIndices[0] ?? -1;
    nonce = {
      account: first.accounts[0] ?? null,
      authority: first.accounts[2] ?? null,
      accountIsStatic: nonceIdx >= 0 && nonceIdx < staticAccounts.length,
      accountIsWritable: writable[nonceIdx] ?? false,
    };
  }
  const feePayer = staticAccounts[0];
  if (!feePayer) throw new Error("transaction has no fee payer");
  return {
    size: bytes.length,
    version: msg.version,
    feePayer,
    signers: staticAccounts.slice(0, numSignerAccounts),
    signatures: { ...tx.signatures } as Record<Address, Uint8Array | null>,
    messageBytes: new Uint8Array(tx.messageBytes),
    lifetimeToken: msg.lifetimeToken,
    staticAccounts,
    lookupTables: lookups.map((l) => l.lookupTableAddress),
    accountKeys,
    writable,
    instructions,
    nonce,
  };
}
