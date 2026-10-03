/**
 * Decodes a wire transaction (legacy or v0) with @solana/kit codecs and resolves address lookup
 * tables, refusing anything malformed, non-canonical or ambiguous. The firewall must see exactly
 * what the runtime will execute, so:
 *   - the bytes must re-encode identically (no trailing data, no alias shortvec encodings);
 *   - header, instruction and lookup indices must be in range (mirrors the runtime's sanitize);
 *   - no address may appear twice (static or loaded), so every account has one role;
 *   - every referenced lookup table must be supplied, and every index must exist in it.
 *
 * ALT contents are supplied by the caller and therefore untrusted. Rules treat loaded accounts as
 * "claimed" addresses: anything that decides where funds go (destinations, the user's token
 * accounts, CPI token programs) must be a static account key. See AccountRef.isStatic.
 */
import {
  type Address,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  getTransactionEncoder,
  isAddress,
} from "@solana/kit";
import { bytesEqual } from "../bytes";
import { PACKET_DATA_SIZE } from "./programs";
import type { AccountRef, AddressLookupTables, DecodedInstruction, DecodedTransaction } from "./types";

export type DecodeResult = { ok: true; tx: DecodedTransaction } | { ok: false; violations: string[] };

/** Accounts addressable by u8 indices. */
const MAX_ACCOUNTS = 256;

function lookupTable(tables: AddressLookupTables | undefined, address: string): readonly string[] | undefined {
  if (!tables) return undefined;
  if (tables instanceof Map) return tables.get(address);
  const record = tables as Readonly<Record<string, readonly string[]>>;
  return Object.hasOwn(record, address) ? record[address] : undefined;
}

export function decodeTransaction(txBytes: Uint8Array, lookupTables?: AddressLookupTables): DecodeResult {
  const refuse = (...violations: string[]): DecodeResult => ({ ok: false, violations });
  if (!(txBytes instanceof Uint8Array) || txBytes.length === 0) return refuse("transaction bytes are empty");
  if (txBytes.length > PACKET_DATA_SIZE)
    return refuse(`transaction is ${txBytes.length} bytes; legacy and v0 transactions are limited to ${PACKET_DATA_SIZE}`);
  // A set high bit in the first byte means the message-first (v1+) envelope: not supported here.
  if ((txBytes[0]! & 0x80) !== 0) return refuse("unsupported transaction format (only legacy and v0 are accepted)");

  let wire: ReturnType<ReturnType<typeof getTransactionDecoder>["decode"]>;
  let compiled: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>;
  try {
    wire = getTransactionDecoder().decode(txBytes);
    if (!bytesEqual(getTransactionEncoder().encode(wire), txBytes)) return refuse("transaction encoding is not canonical");
    compiled = getCompiledTransactionMessageDecoder().decode(wire.messageBytes);
    if (!bytesEqual(getCompiledTransactionMessageEncoder().encode(compiled), wire.messageBytes)) {
      return refuse("message encoding is not canonical (trailing or malformed bytes)");
    }
  } catch (e) {
    return refuse(`malformed transaction: ${(e as Error).message}`);
  }
  if (compiled.version !== "legacy" && compiled.version !== 0) return refuse(`unsupported message version ${String(compiled.version)}`);

  const { header, staticAccounts } = compiled;
  const numSigners = header.numSignerAccounts;
  if (numSigners < 1) return refuse("message requires no signatures");
  if (header.numReadonlySignerAccounts >= numSigners) return refuse("fee payer must be a writable signer");
  if (numSigners + header.numReadonlyNonSignerAccounts > staticAccounts.length)
    return refuse("message header is inconsistent with its account keys");

  // Resolve lookup tables: all writable loads (table order), then all readonly loads.
  const writableLoaded: Address[] = [];
  const readonlyLoaded: Address[] = [];
  const lookups = compiled.version === 0 ? (compiled.addressTableLookups ?? []) : [];
  const violations: string[] = [];
  for (const lookup of lookups) {
    const table = lookupTable(lookupTables, lookup.lookupTableAddress);
    if (!table) {
      violations.push(`address lookup table ${lookup.lookupTableAddress} was not provided`);
      continue;
    }
    if (lookup.writableIndexes.length + lookup.readonlyIndexes.length === 0) {
      violations.push(`address lookup table ${lookup.lookupTableAddress} is referenced without loading any account`);
    }
    for (const [indexes, out] of [
      [lookup.writableIndexes, writableLoaded],
      [lookup.readonlyIndexes, readonlyLoaded],
    ] as const) {
      for (const i of indexes) {
        const entry = table[i];
        if (entry === undefined) violations.push(`address lookup table ${lookup.lookupTableAddress} has no entry ${i}`);
        else if (typeof entry !== "string" || !isAddress(entry))
          violations.push(`address lookup table ${lookup.lookupTableAddress} entry ${i} is not an address`);
        else out.push(entry);
      }
    }
  }
  if (violations.length) return { ok: false, violations };

  const all: Address[] = [...staticAccounts, ...writableLoaded, ...readonlyLoaded];
  if (all.length > MAX_ACCOUNTS) return refuse(`transaction references ${all.length} accounts (max ${MAX_ACCOUNTS})`);
  const seen = new Set<string>();
  for (const a of all) {
    if (seen.has(a)) return refuse(`account ${a} appears more than once in the message`);
    seen.add(a);
  }

  const writableSigners = numSigners - header.numReadonlySignerAccounts;
  const writableNonSignersEnd = staticAccounts.length - header.numReadonlyNonSignerAccounts;
  const accounts: AccountRef[] = all.map((address, index) => {
    if (index < staticAccounts.length) {
      const isSigner = index < numSigners;
      const isWritable = isSigner ? index < writableSigners : index < writableNonSignersEnd;
      return { address, index, isSigner, isWritable, isStatic: true };
    }
    const isWritable = index < staticAccounts.length + writableLoaded.length;
    return { address, index, isSigner: false, isWritable, isStatic: false };
  });

  const instructions: DecodedInstruction[] = [];
  for (const [position, ix] of compiled.instructions.entries()) {
    const programIndex = ix.programAddressIndex;
    if (programIndex === 0 || programIndex >= staticAccounts.length) {
      return refuse(`instruction #${position} program index ${programIndex} must be a static, non-fee-payer account`);
    }
    const program = accounts[programIndex]!;
    if (program.isWritable) return refuse(`instruction #${position} invokes a writable program account ${program.address}`);
    const refs: AccountRef[] = [];
    for (const i of ix.accountIndices ?? []) {
      const ref = accounts[i];
      if (!ref) return refuse(`instruction #${position} references account index ${i} out of range`);
      refs.push(ref);
    }
    instructions.push({ index: position, programAddress: program.address, accounts: refs, data: ix.data ?? new Uint8Array(0) });
  }

  return {
    ok: true,
    tx: {
      version: compiled.version,
      messageBytes: wire.messageBytes,
      feePayer: staticAccounts[0]!,
      accounts,
      instructions,
      lifetimeToken: compiled.lifetimeToken,
      lookupTableAddresses: lookups.map((l) => l.lookupTableAddress),
    },
  };
}
