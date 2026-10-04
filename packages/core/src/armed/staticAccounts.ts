/**
 * The shared accounts of armed pump and PumpSwap trades: what the operator's lookup table may hold.
 *
 * Lookup-table contents are UNTRUSTED to the signer firewall: it requires every account that
 * decides where funds go, or which program the venue CPIs into, to be a STATIC key
 * (packages/signer/src/firewall/rules/*). So the table may hold only venue-validated shared
 * accounts:
 *   pump / PumpSwap / fees / ATA program ids, the pump and PumpSwap Global, config, fee-config,
 *   event-authority and global-volume-accumulator PDAs, every fee / mayhem / buyback / AMM protocol
 *   fee recipient and its quote-mint ATA (the programs check these by seeds), and the
 *   RecentBlockhashes sysvar used by `AdvanceNonceAccount`.
 * Never in the table (always static keys in an armed tx):
 *   token programs, mints (base and quote), the System program, the user's token accounts and wSOL
 *   account, the PumpSwap pool, ATA owners, every SOL/token transfer destination (tip accounts,
 *   own wSOL account, connected wallet), the jitodontfront marker, the nonce account (SIMD-0242) and
 *   all signers.
 * armedTx.ts additionally keeps those static even if a table were to contain them.
 */
import type { Address } from "@solana/kit";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  BUYBACK_FEE_RECIPIENTS,
  DEFAULT_PUBKEY,
  HELIUS_SENDER_TIP_ACCOUNTS,
  JITO_DONT_FRONT,
  JITO_TIP_ACCOUNTS_FALLBACK,
  MAYHEM_FEE_RECIPIENTS,
  NATIVE_MINT_2022,
  PUMP_AMM_PROGRAM_ID,
  PUMP_AMM_PROTOCOL_FEE_RECIPIENTS_FALLBACK,
  PUMP_FEE_PROGRAM_ID,
  PUMP_FEE_RECIPIENTS,
  PUMP_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  SYSVAR_RECENT_BLOCKHASHES_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_MINT,
  WSOL_MINT,
} from "../constants";
import { type PumpGlobal, pumpEventAuthorityPda, pumpFeeConfigPda, pumpGlobalPda, pumpGlobalVolumeAccumulatorPda } from "../pump/accounts";
import {
  type AmmGlobalConfig,
  ammEventAuthorityPda,
  ammFeeConfigPda,
  ammGlobalConfigPda,
  ammGlobalVolumeAccumulatorPda,
} from "../pumpswap/accounts";
import { findAssociatedTokenAddress } from "../token";

export interface QuoteMintSpec {
  mint: Address;
  /** Owner of the quote mint (SPL Token for wSOL and USDC). */
  tokenProgram: Address;
}

export interface ArmedStaticAccountsOptions {
  /** Live pump Global (fee, reserved and buyback recipient lists). */
  pumpGlobal?: Pick<
    PumpGlobal,
    "feeRecipient" | "feeRecipients" | "reservedFeeRecipient" | "reservedFeeRecipients" | "buybackFeeRecipients"
  > | null;
  /** Live PumpSwap GlobalConfig (protocol, reserved and buyback recipient lists). */
  ammGlobalConfig?: Pick<
    AmmGlobalConfig,
    "protocolFeeRecipients" | "reservedFeeRecipient" | "reservedFeeRecipients" | "buybackFeeRecipients"
  > | null;
  /** Quote mints whose recipient ATAs to include (the mints themselves stay static). Default: wSOL only. */
  quoteMints?: readonly QuoteMintSpec[];
}

const nonDefault = (l: readonly Address[]) => l.filter((a) => a !== DEFAULT_PUBKEY);

/** Every fee recipient a pump or PumpSwap trade may name (deduplicated, deterministic order). */
export function armedFeeRecipients(opts: ArmedStaticAccountsOptions = {}): Address[] {
  const g = opts.pumpGlobal;
  const gc = opts.ammGlobalConfig;
  const pick = (live: readonly Address[] | undefined, fallback: readonly Address[]) => {
    const l = nonDefault(live ?? []);
    return l.length ? l : [...fallback];
  };
  const lists = [
    pick(g ? [g.feeRecipient, ...g.feeRecipients] : undefined, PUMP_FEE_RECIPIENTS),
    pick(g ? [g.reservedFeeRecipient, ...g.reservedFeeRecipients] : undefined, MAYHEM_FEE_RECIPIENTS),
    pick(g?.buybackFeeRecipients, BUYBACK_FEE_RECIPIENTS),
    pick(gc?.protocolFeeRecipients, PUMP_AMM_PROTOCOL_FEE_RECIPIENTS_FALLBACK),
    pick(gc ? [gc.reservedFeeRecipient, ...gc.reservedFeeRecipients] : undefined, MAYHEM_FEE_RECIPIENTS),
    pick(gc?.buybackFeeRecipients, BUYBACK_FEE_RECIPIENTS),
  ];
  return [...new Set(lists.flat())];
}

/** The shared lookup-table contents for armed pump + PumpSwap trades (~63 addresses with wSOL only). */
export async function armedStaticAccounts(opts: ArmedStaticAccountsOptions = {}): Promise<Address[]> {
  const quoteMints = opts.quoteMints ?? [{ mint: WSOL_MINT, tokenProgram: TOKEN_PROGRAM_ID }];
  const pdas = await Promise.all([
    pumpGlobalPda(),
    pumpFeeConfigPda(),
    pumpEventAuthorityPda(),
    pumpGlobalVolumeAccumulatorPda(),
    ammGlobalConfigPda(),
    ammFeeConfigPda(),
    ammEventAuthorityPda(),
    ammGlobalVolumeAccumulatorPda(),
  ]);
  const recipients = armedFeeRecipients(opts);
  const recipientAtas = await Promise.all(
    quoteMints.flatMap((q) => recipients.map((r) => findAssociatedTokenAddress(r, q.mint, q.tokenProgram))),
  );
  const all: Address[] = [
    SYSVAR_RECENT_BLOCKHASHES_ID,
    PUMP_PROGRAM_ID,
    PUMP_AMM_PROGRAM_ID,
    PUMP_FEE_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    ...pdas,
    ...recipients,
    ...recipientAtas,
  ];
  return [...new Set(all)];
}

/**
 * Accounts that must never be loaded from a lookup table in any armed tx, whatever its contents:
 * the firewall requires them static (token programs, System program, quote mints, tips, marker).
 */
export const NEVER_LOOKED_UP: ReadonlySet<Address> = new Set<Address>([
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  WSOL_MINT,
  NATIVE_MINT_2022,
  USDC_MINT,
  JITO_DONT_FRONT,
  ...HELIUS_SENDER_TIP_ACCOUNTS,
  ...JITO_TIP_ACCOUNTS_FALLBACK,
]);

/**
 * Venue instruction positions the signer firewall requires as static keys (0-based, matching
 * pumpV2AccountMetas / ammSwapAccountMetas): pump base/quote mint, base/quote token program and
 * the user's base/quote ATAs; PumpSwap pool, base/quote mint, the user's base/quote token accounts
 * and base/quote token program.
 */
export const FIREWALL_STATIC_VENUE_POSITIONS: ReadonlyMap<Address, readonly number[]> = new Map([
  [PUMP_PROGRAM_ID, [1, 2, 3, 4, 14, 15]],
  [PUMP_AMM_PROGRAM_ID, [0, 3, 4, 5, 6, 11, 12]],
]);

/** Programs whose instructions must reference only static keys (transfer destinations, ATAs, owners, mints). */
export const FIREWALL_ALL_STATIC_PROGRAMS: ReadonlySet<Address> = new Set<Address>([
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
]);

/**
 * Operator guard before creating or extending a table: refuses addresses the firewall would
 * require static (they would only bloat the table, and a table carrying them signals a bug).
 * Per-user and per-token accounts cannot be detected here; keep the table to `armedStaticAccounts`.
 */
export function assertShareableLookupTableContents(addresses: readonly Address[]): void {
  const bad = addresses.filter((a) => NEVER_LOOKED_UP.has(a) || a.startsWith("jitodontfront"));
  if (bad.length) throw new Error(`addresses the signer firewall requires as static keys cannot go in the lookup table: ${bad.join(", ")}`);
}
