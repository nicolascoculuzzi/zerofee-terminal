/**
 * Address Lookup Tables (own encoders) for armed orders.
 *
 * A curve buy is 1,182 of 1,232 bytes before a nonce is added (NOTES.md), so armed transactions
 * are v0 messages that load the static pump/PumpSwap accounts from operator-owned tables. The
 * operator creates and extends the tables; they are NEVER deactivated while an armed order
 * references them, because a closed table strands every order that uses it.
 *
 * Layouts: https://github.com/anza-xyz/solana-sdk/blob/master/address-lookup-table-interface/src/instruction.rs
 *          https://github.com/anza-xyz/solana-sdk/blob/master/address-lookup-table-interface/src/state.rs
 */
import {
  AccountRole,
  type Address,
  type AddressesByLookupTableAddress,
  getProgramDerivedAddress,
  type Instruction,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import {
  ADDRESS_LOOKUP_TABLE_PROGRAM_ID,
  ALT_IX,
  LOOKUP_TABLE_DEACTIVATION_COOLDOWN_SLOTS,
  LOOKUP_TABLE_EXTEND_CHUNK,
  LOOKUP_TABLE_MAX_ADDRESSES,
  LOOKUP_TABLE_META_SIZE,
  SYSTEM_PROGRAM_ID,
} from "../constants";
import { fetchRawAccounts } from "../state";
import { addressBytes, concatBytes, Reader, u8, u32le, u64le } from "../util/bytes";

const U64_MAX = (1n << 64n) - 1n;

function altIx(tag: number, accounts: Instruction["accounts"], ...data: Uint8Array[]): Instruction {
  return { programAddress: ADDRESS_LOOKUP_TABLE_PROGRAM_ID, accounts, data: concatBytes(u32le(tag), ...data) };
}

/** Table address = PDA([authority, recent_slot u64 LE], ALT program). */
export async function deriveLookupTableAddress(authority: Address, recentSlot: bigint): Promise<{ address: Address; bump: number }> {
  const [address, bump] = await getProgramDerivedAddress({
    programAddress: ADDRESS_LOOKUP_TABLE_PROGRAM_ID,
    seeds: [addressBytes(authority), u64le(recentSlot)],
  });
  return { address, bump };
}

/**
 * `CreateLookupTable` (0). `recentSlot` must still be in the SlotHashes sysvar (use a recent
 * finalized slot). The authority signs by default, which works with and without the relaxed
 * authority-signer feature.
 */
export async function createLookupTableInstruction(args: {
  authority: Address;
  payer: Address;
  recentSlot: bigint;
  authoritySigns?: boolean;
}): Promise<{ instruction: Instruction; address: Address; bump: number }> {
  const { address, bump } = await deriveLookupTableAddress(args.authority, args.recentSlot);
  const instruction = altIx(
    ALT_IX.createLookupTable,
    [
      { address, role: AccountRole.WRITABLE },
      { address: args.authority, role: args.authoritySigns === false ? AccountRole.READONLY : AccountRole.READONLY_SIGNER },
      { address: args.payer, role: AccountRole.WRITABLE_SIGNER },
      { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
    ],
    u64le(args.recentSlot),
    u8(bump),
  );
  return { instruction, address, bump };
}

/** `ExtendLookupTable` (2): appends `addresses` (bincode Vec<Pubkey>). `payer` tops up rent for the larger account. */
export function extendLookupTableInstruction(args: {
  table: Address;
  authority: Address;
  payer: Address;
  addresses: readonly Address[];
}): Instruction {
  if (args.addresses.length === 0) throw new RangeError("extend needs at least one address");
  return altIx(
    ALT_IX.extendLookupTable,
    [
      { address: args.table, role: AccountRole.WRITABLE },
      { address: args.authority, role: AccountRole.READONLY_SIGNER },
      { address: args.payer, role: AccountRole.WRITABLE_SIGNER },
      { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
    ],
    u64le(BigInt(args.addresses.length)),
    ...args.addresses.map(addressBytes),
  );
}

/** `DeactivateLookupTable` (3). Starts the ~513-slot cooldown; only do this once no armed order references the table. */
export function deactivateLookupTableInstruction(args: { table: Address; authority: Address }): Instruction {
  return altIx(ALT_IX.deactivateLookupTable, [
    { address: args.table, role: AccountRole.WRITABLE },
    { address: args.authority, role: AccountRole.READONLY_SIGNER },
  ]);
}

/** `CloseLookupTable` (4): refunds rent to `recipient`; fails until the deactivation cooldown has passed. */
export function closeLookupTableInstruction(args: { table: Address; authority: Address; recipient: Address }): Instruction {
  return altIx(ALT_IX.closeLookupTable, [
    { address: args.table, role: AccountRole.WRITABLE },
    { address: args.authority, role: AccountRole.READONLY_SIGNER },
    { address: args.recipient, role: AccountRole.WRITABLE },
  ]);
}

// ---------------------------------------------------------------------------------------------
// Account decoding and status
// ---------------------------------------------------------------------------------------------

export interface LookupTableState {
  /** u64::MAX while active. */
  deactivationSlot: bigint;
  lastExtendedSlot: bigint;
  /** Addresses at or after this index were appended in `lastExtendedSlot` (unusable until the next slot). */
  lastExtendedSlotStartIndex: number;
  /** Null once frozen. */
  authority: Address | null;
  addresses: Address[];
}

/** Decodes a lookup table account: u32 type tag (1), LookupTableMeta, then 32-byte addresses from offset 56. */
export function decodeLookupTable(data: Uint8Array): LookupTableState {
  if (data.length < LOOKUP_TABLE_META_SIZE) throw new Error(`lookup table account too short (${data.length})`);
  const r = new Reader(data);
  const tag = r.u32();
  if (tag !== 1) throw new Error(`not an initialized lookup table (type ${tag})`);
  const deactivationSlot = r.u64();
  const lastExtendedSlot = r.u64();
  const lastExtendedSlotStartIndex = r.u8();
  const hasAuthority = r.u8() === 1;
  const authorityKey = r.pubkey();
  if ((data.length - LOOKUP_TABLE_META_SIZE) % 32 !== 0) throw new Error("lookup table address area is not a multiple of 32 bytes");
  const addresses: Address[] = [];
  const body = new Reader(data, LOOKUP_TABLE_META_SIZE);
  while (body.has(32)) addresses.push(body.pubkey());
  return { deactivationSlot, lastExtendedSlot, lastExtendedSlotStartIndex, authority: hasAuthority ? authorityKey : null, addresses };
}

export type LookupTableStatus = "active" | "deactivating" | "closeable";

/**
 * Approximate lifecycle (the runtime uses the SlotHashes sysvar; this uses slot arithmetic).
 * Deactivating tables still resolve lookups; closeable ones may disappear at any moment.
 */
export function lookupTableStatus(t: Pick<LookupTableState, "deactivationSlot">, currentSlot: bigint): LookupTableStatus {
  if (t.deactivationSlot === U64_MAX) return "active";
  return currentSlot > t.deactivationSlot + BigInt(LOOKUP_TABLE_DEACTIVATION_COOLDOWN_SLOTS) ? "closeable" : "deactivating";
}

/** Addresses a transaction landing in `slot` may load (entries appended in that same slot are not yet usable). */
export function usableLookupTableAddresses(t: LookupTableState, slot: bigint): Address[] {
  return slot > t.lastExtendedSlot ? t.addresses : t.addresses.slice(0, t.lastExtendedSlotStartIndex);
}

/** Missing addresses of `wanted`, chunked into ExtendLookupTable batches. Throws past the 256-address cap. */
export function planLookupTableExtension(
  existing: readonly Address[],
  wanted: readonly Address[],
  chunk: number = LOOKUP_TABLE_EXTEND_CHUNK,
): Address[][] {
  const have = new Set(existing);
  const missing: Address[] = [];
  for (const a of wanted) {
    if (!have.has(a)) {
      have.add(a);
      missing.push(a);
    }
  }
  if (existing.length + missing.length > LOOKUP_TABLE_MAX_ADDRESSES) {
    throw new RangeError(`lookup table would hold ${existing.length + missing.length} > ${LOOKUP_TABLE_MAX_ADDRESSES} addresses`);
  }
  const batches: Address[][] = [];
  for (let i = 0; i < missing.length; i += chunk) batches.push(missing.slice(i, i + chunk));
  return batches;
}

/** Fetches and decodes lookup tables; missing or non-table accounts map to null. */
export async function fetchLookupTables(
  rpc: Rpc<Pick<SolanaRpcApi, "getMultipleAccounts">>,
  tables: readonly Address[],
): Promise<Record<Address, LookupTableState | null>> {
  const raw = await fetchRawAccounts(rpc, tables);
  const out: Record<Address, LookupTableState | null> = {};
  tables.forEach((t, i) => {
    const acc = raw[i];
    out[t] = acc && acc.owner === ADDRESS_LOOKUP_TABLE_PROGRAM_ID ? decodeLookupTable(acc.data) : null;
  });
  return out;
}

/** The `{ table: addresses }` map that kit's compression and decompilation take. */
export function toAddressesByLookupTable(states: Record<Address, LookupTableState | null>): AddressesByLookupTableAddress {
  const out: AddressesByLookupTableAddress = {};
  for (const [table, state] of Object.entries(states) as [Address, LookupTableState | null][]) {
    if (state) out[table] = state.addresses;
  }
  return out;
}
