/**
 * The shared accounts of armed pump, PumpSwap, Raydium LaunchLab and Raydium CPMM trades: what the
 * operator's lookup table may hold.
 *
 * Lookup-table contents are UNTRUSTED to the signer firewall: it requires every account that
 * decides where funds go, or which program the venue CPIs into, to be a STATIC key
 * (packages/signer/src/firewall/rules/*). So the table may hold only venue-validated shared
 * accounts:
 *   pump / PumpSwap / fees / ATA program ids, the pump and PumpSwap Global, config, fee-config,
 *   event-authority and global-volume-accumulator PDAs, every fee / mayhem / buyback / AMM protocol
 *   fee recipient and its quote-mint ATA (the programs check these by seeds), the
 *   RecentBlockhashes sysvar used by `AdvanceNonceAccount`, LaunchLab GlobalConfigs (swap position 2)
 *   and the CPMM AmmConfigs graduated coins trade on (swap position 2). The Raydium programs check
 *   both against the pool state, and the signer firewall does not pin them.
 * Never in the table (always static keys in an armed tx):
 *   token programs, mints (base and quote), the System program, the user's token accounts and wSOL
 *   account, the PumpSwap pool, ATA owners, every SOL/token transfer destination (tip accounts,
 *   own wSOL account, connected wallet), the jitodontfront marker, the nonce account (SIMD-0242),
 *   all signers, and every Raydium account the firewall pins (packages/signer raydium-idl.ts
 *   *_STATIC_POSITIONS): the LaunchLab vault / event authorities, platform config, pool and platform
 *   fee vault; the CPMM authority, pool, vaults and observation. LaunchLab base / quote vaults and
 *   creator fee vaults are not pinned but are per coin, so they are not shareable either.
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
  RAYDIUM_CPMM_AUTHORITY,
  RAYDIUM_CPMM_GRADUATION_AMM_CONFIGS,
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_LAUNCHLAB_AUTHORITY,
  RAYDIUM_LAUNCHLAB_EVENT_AUTHORITY,
  RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  RAYDIUM_LAUNCHLAB_SOL_GLOBAL_CONFIG,
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
  /**
   * Shared Raydium accounts: LaunchLab GlobalConfigs (default: the SOL constant-product config) and CPMM
   * AmmConfigs (default: RAYDIUM_CPMM_GRADUATION_AMM_CONFIGS). `false` leaves Raydium out.
   */
  raydium?: { launchLabGlobalConfigs?: readonly Address[]; cpmmAmmConfigs?: readonly Address[] } | false;
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

/** Shared Raydium accounts of the operator table (see ArmedStaticAccountsOptions.raydium). */
export function armedRaydiumSharedAccounts(opts: ArmedStaticAccountsOptions["raydium"] = {}): Address[] {
  if (opts === false) return [];
  return [
    ...new Set([
      ...(opts.launchLabGlobalConfigs ?? [RAYDIUM_LAUNCHLAB_SOL_GLOBAL_CONFIG]),
      ...(opts.cpmmAmmConfigs ?? RAYDIUM_CPMM_GRADUATION_AMM_CONFIGS),
    ]),
  ];
}

/**
 * The shared lookup-table contents for armed pump, PumpSwap and Raydium trades (~67 addresses with wSOL
 * only and the default Raydium configs).
 */
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
    ...armedRaydiumSharedAccounts(opts.raydium),
  ];
  const out = [...new Set(all)];
  assertShareableLookupTableContents(out);
  return out;
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
  // Fixed Raydium accounts the firewall pins (also covered by the venue positions below).
  RAYDIUM_LAUNCHLAB_AUTHORITY,
  RAYDIUM_LAUNCHLAB_EVENT_AUTHORITY,
  RAYDIUM_CPMM_AUTHORITY,
]);

/**
 * LaunchLab swap positions the signer firewall requires as static keys (launchLabSwapAccountMetas
 * order; mirrors packages/signer LAUNCHLAB_STATIC_POSITIONS, cross-checked in test/armed-raydium.test.ts):
 * payer, vault authority, platform config (seeds the platform fee vault), pool, the user's base / quote
 * token accounts, base / quote mint, base / quote token program, event authority, System program and
 * platform fee vault.
 */
export const LAUNCHLAB_FIREWALL_STATIC_POSITIONS: readonly number[] = [0, 1, 3, 4, 5, 6, 9, 10, 11, 12, 13, 15, 16];
/**
 * CPMM swap positions the signer firewall requires as static keys (cpmmSwapAccountMetas order; mirrors
 * packages/signer CPMM_STATIC_POSITIONS): everything but amm_config (2), which the program checks against
 * the pool.
 */
export const CPMM_FIREWALL_STATIC_POSITIONS: readonly number[] = [0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/**
 * Venue instruction positions the signer firewall requires as static keys (0-based, matching
 * pumpV2AccountMetas / ammSwapAccountMetas / launchLabSwapAccountMetas / cpmmSwapAccountMetas): pump
 * base/quote mint, base/quote token program and the user's base/quote ATAs; PumpSwap pool, base/quote
 * mint, the user's base/quote token accounts and base/quote token program; Raydium as above.
 */
export const FIREWALL_STATIC_VENUE_POSITIONS: ReadonlyMap<Address, readonly number[]> = new Map([
  [PUMP_PROGRAM_ID, [1, 2, 3, 4, 14, 15]],
  [PUMP_AMM_PROGRAM_ID, [0, 3, 4, 5, 6, 11, 12]],
  [RAYDIUM_LAUNCHLAB_PROGRAM_ID, LAUNCHLAB_FIREWALL_STATIC_POSITIONS],
  [RAYDIUM_CPMM_PROGRAM_ID, CPMM_FIREWALL_STATIC_POSITIONS],
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
