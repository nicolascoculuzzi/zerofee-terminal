/**
 * Address-lookup-table compression that keeps the signer firewall's static keys static.
 *
 * Lookup-table contents reach the signer as caller-supplied data, so the firewall refuses any account
 * that decides who signs, where funds come from or go, or which cap applies, unless it is a static key
 * (packages/signer/src/firewall/rules/*). kit's compressTransactionMessageUsingAddressLookupTables moves
 * every eligible account it finds in a table; this reverts the ones the firewall needs static:
 *   - the fee payer, token programs, the System program, the quote mints, tip accounts, jitodontfront;
 *   - every account of a System, SPL Token, Token-2022 or ATA instruction (transfer destinations, ATAs,
 *     owners, mints, close destinations);
 *   - the venue positions the firewall pins: pump / PumpSwap (armed/staticAccounts.ts) and Jupiter's
 *     route_v2 / shared_accounts_route_v2 user side (authority, user token accounts, mints, token programs).
 * Route hops and venue-validated accounts may still come from the tables.
 */
import type { AccountLookupMeta, AccountMeta, Address, AddressesByLookupTableAddress, Instruction } from "@solana/kit";
import { compressTransactionMessageUsingAddressLookupTables } from "@solana/kit";
import { FIREWALL_ALL_STATIC_PROGRAMS, FIREWALL_STATIC_VENUE_POSITIONS, NEVER_LOOKED_UP } from "../armed/staticAccounts";
import { JUPITER_PROGRAM_ID } from "../constants";
import { decodeJupiterRouteArgs, JUPITER_STATIC_POSITIONS } from "../jupiter/route";
import type { TipAccountSets } from "./tip";

/** Accounts of `instructions` that must not be loaded from a lookup table. */
export function firewallStaticAccounts(
  feePayer: Address,
  instructions: readonly Instruction[],
  tipAccounts?: TipAccountSets,
): Set<Address> {
  const keep = new Set<Address>([feePayer, ...NEVER_LOOKED_UP, ...(tipAccounts?.helius ?? []), ...(tipAccounts?.jito ?? [])]);
  for (const ix of instructions) {
    const accounts = ix.accounts ?? [];
    if (FIREWALL_ALL_STATIC_PROGRAMS.has(ix.programAddress)) for (const a of accounts) keep.add(a.address);
    let positions = FIREWALL_STATIC_VENUE_POSITIONS.get(ix.programAddress) ?? [];
    if (ix.programAddress === JUPITER_PROGRAM_ID) {
      const route = ix.data ? decodeJupiterRouteArgs(new Uint8Array(ix.data)) : null;
      positions = route ? JUPITER_STATIC_POSITIONS[route.instruction] : [];
    }
    for (const i of positions) {
      const a = accounts[i];
      if (a) keep.add(a.address);
    }
    for (const a of accounts) if (a.address.startsWith("jitodontfront")) keep.add(a.address);
  }
  return keep;
}

type Compressible = Parameters<typeof compressTransactionMessageUsingAddressLookupTables>[0];
type AnyMeta = AccountMeta | AccountLookupMeta;

/** Compresses with kit, then reverts every lookup of an account in `keepStatic` (in all instructions). */
export function compressKeepingStatic<T extends Compressible>(
  message: T,
  tables: AddressesByLookupTableAddress | undefined,
  keepStatic: ReadonlySet<Address>,
): T {
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
  return Object.freeze({ ...compressed, instructions }) as unknown as T;
}
