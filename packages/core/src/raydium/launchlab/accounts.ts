/**
 * Raydium LaunchLab account decoders (no Anchor) and PDA derivation.
 *
 * Layouts (borsh, packed) from the CPI crate + IDL, cross-checked with the SDK layouts and live
 * mainnet accounts (2026-10-03):
 *   https://github.com/raydium-io/raydium-cpi/blob/115df2779d53bacc7db9d0be2773a4b48a6d372b/programs/launch-cpi/src/states.rs
 *   https://github.com/raydium-io/raydium-idl/blob/e7e0c96fe77bcf6a020b84a44c47a722aac8e359/raydium_launchpad/raydium_launchpad.json
 *   https://github.com/raydium-io/raydium-sdk-V2/blob/cc33ec28a8921a35609e83293e9e07ad830b0779/src/raydium/launchpad/layout.ts
 * PDAs: https://github.com/raydium-io/raydium-sdk-V2/blob/cc33ec28a8921a35609e83293e9e07ad830b0779/src/raydium/launchpad/pda.ts
 *
 * Naming: LaunchLab calls the launched coin "base" (SDK "A") and the pair token "quote" (SDK "B").
 */
import { type Address, getProgramDerivedAddress } from "@solana/kit";
import {
  LAUNCHLAB_POOL_STATUS,
  RAYDIUM_ACCOUNT_DISCRIMINATORS,
  RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  RAYDIUM_SEEDS,
  SEEDS,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "../../constants";
import type { TokenProgram } from "../../token";
import { addressBytes, Reader, startsWith, u8, u16le, utf8 } from "../../util/bytes";

// ---------------------------------------------------------------------------------------------
// PoolState (429 bytes)
// ---------------------------------------------------------------------------------------------

export interface LaunchLabVestingSchedule {
  totalLockedAmount: bigint;
  cliffPeriod: bigint;
  unlockPeriod: bigint;
  startTime: bigint;
  allocatedShareAmount: bigint;
}

export interface LaunchLabPool {
  epoch: bigint;
  authBump: number;
  /** 0 funding (tradable), 1 waiting for migration, 2 migrated (trade on CPMM / AMM v4). */
  status: number;
  baseDecimals: number;
  quoteDecimals: number;
  /** 0 = AMM v4, 1 = CPMM. */
  migrateType: number;
  supply: bigint;
  /** Base tokens sold when the curve completes. */
  totalBaseSell: bigint;
  /** Constant product: virtual liquidity; virtual_quote / virtual_base is the initial price. */
  virtualBase: bigint;
  virtualQuote: bigint;
  /** Base sold so far (grows on buys). */
  realBase: bigint;
  /** Quote raised so far, net of fees (grows on buys). */
  realQuote: bigint;
  /** Graduation target: the curve completes when real_quote reaches it. */
  totalQuoteFundRaising: bigint;
  quoteProtocolFee: bigint;
  platformFee: bigint;
  migrateFee: bigint;
  vestingSchedule: LaunchLabVestingSchedule;
  globalConfig: Address;
  platformConfig: Address;
  baseMint: Address;
  quoteMint: Address;
  baseVault: Address;
  quoteVault: Address;
  /** Coin creator - seeds the creator fee vault [creator, quote_mint]. */
  creator: Address;
  /** bit0: base is Token-2022, bit1: quote is Token-2022. */
  tokenProgramFlag: number;
  /** After CPMM migration the creator fee is on 0 = quote token, 1 = both tokens. */
  ammCreatorFeeOn: number;
  platformVestingShare: bigint;
  dataLength: number;
}

function readVesting(r: Reader): LaunchLabVestingSchedule {
  return {
    totalLockedAmount: r.u64(),
    cliffPeriod: r.u64(),
    unlockPeriod: r.u64(),
    startTime: r.u64(),
    allocatedShareAmount: r.u64(),
  };
}

export function decodeLaunchLabPool(data: Uint8Array): LaunchLabPool {
  if (!startsWith(data, RAYDIUM_ACCOUNT_DISCRIMINATORS.launchLabPoolState)) throw new Error("not a LaunchLab PoolState account");
  const r = new Reader(data, 8);
  return {
    epoch: r.u64(),
    authBump: r.u8(),
    status: r.u8(),
    baseDecimals: r.u8(),
    quoteDecimals: r.u8(),
    migrateType: r.u8(),
    supply: r.u64(),
    totalBaseSell: r.u64(),
    virtualBase: r.u64(),
    virtualQuote: r.u64(),
    realBase: r.u64(),
    realQuote: r.u64(),
    totalQuoteFundRaising: r.u64(),
    quoteProtocolFee: r.u64(),
    platformFee: r.u64(),
    migrateFee: r.u64(),
    vestingSchedule: readVesting(r),
    globalConfig: r.pubkey(),
    platformConfig: r.pubkey(),
    baseMint: r.pubkey(),
    quoteMint: r.pubkey(),
    baseVault: r.pubkey(),
    quoteVault: r.pubkey(),
    creator: r.pubkey(),
    tokenProgramFlag: r.u8(),
    ammCreatorFeeOn: r.u8(),
    // IDL 2026-05: platform_vesting_share u64 then [u8;54] padding (older CPI crate: [u8;62] padding).
    platformVestingShare: r.u64(),
    dataLength: data.length,
  };
}

/** Token program of the base mint from `token_program_flag` bit 0. */
export function launchLabBaseTokenProgram(pool: Pick<LaunchLabPool, "tokenProgramFlag">): TokenProgram {
  return pool.tokenProgramFlag & 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

/** Token program of the quote mint from `token_program_flag` bit 1. */
export function launchLabQuoteTokenProgram(pool: Pick<LaunchLabPool, "tokenProgramFlag">): TokenProgram {
  return pool.tokenProgramFlag & 2 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

export function isLaunchLabTradable(pool: Pick<LaunchLabPool, "status">): boolean {
  return pool.status === LAUNCHLAB_POOL_STATUS.fund;
}

// ---------------------------------------------------------------------------------------------
// GlobalConfig (371 bytes): protocol trade fee + curve type, per (quote mint, curve type, index)
// ---------------------------------------------------------------------------------------------

export interface LaunchLabGlobalConfig {
  epoch: bigint;
  /** 0 constant product, 1 fixed price, 2 linear price. */
  curveType: number;
  index: number;
  migrateFee: bigint;
  /** Protocol fee, parts per million of the quote amount. */
  tradeFeeRate: bigint;
  maxShareFeeRate: bigint;
  minBaseSupply: bigint;
  maxLockRate: bigint;
  minBaseSellRate: bigint;
  minBaseMigrateRate: bigint;
  minQuoteFundRaising: bigint;
  quoteMint: Address;
  protocolFeeOwner: Address;
  migrateFeeOwner: Address;
  migrateToAmmWallet: Address;
  /** Signs migrate_to_cpswap (graduation is not permissionless). */
  migrateToCpswapWallet: Address;
  /** IDL 2026-05 field carved from padding (0 on all configs observed). */
  requiresPlatformAuth: number;
}

export function decodeLaunchLabGlobalConfig(data: Uint8Array): LaunchLabGlobalConfig {
  if (!startsWith(data, RAYDIUM_ACCOUNT_DISCRIMINATORS.launchLabGlobalConfig)) throw new Error("not a LaunchLab GlobalConfig account");
  const r = new Reader(data, 8);
  return {
    epoch: r.u64(),
    curveType: r.u8(),
    index: r.u16(),
    migrateFee: r.u64(),
    tradeFeeRate: r.u64(),
    maxShareFeeRate: r.u64(),
    minBaseSupply: r.u64(),
    maxLockRate: r.u64(),
    minBaseSellRate: r.u64(),
    minBaseMigrateRate: r.u64(),
    minQuoteFundRaising: r.u64(),
    quoteMint: r.pubkey(),
    protocolFeeOwner: r.pubkey(),
    migrateFeeOwner: r.pubkey(),
    migrateToAmmWallet: r.pubkey(),
    migrateToCpswapWallet: r.pubkey(),
    requiresPlatformAuth: r.u8(),
  };
}

// ---------------------------------------------------------------------------------------------
// PlatformConfig (944 bytes): the launchpad (letsbonk, StonkFun, ...) fee and graduation config
// ---------------------------------------------------------------------------------------------

export interface LaunchLabPlatformConfig {
  epoch: bigint;
  platformFeeWallet: Address;
  platformNftWallet: Address;
  platformScale: bigint;
  creatorScale: bigint;
  burnScale: bigint;
  /** Platform fee, parts per million of the quote amount. */
  feeRate: bigint;
  name: string;
  web: string;
  img: string;
  /** CPMM AmmConfig that graduated pools are created on (seeds the canonical CPMM pool PDA). */
  cpswapConfig: Address;
  /** Creator fee, parts per million of the quote amount. */
  creatorFeeRate: bigint;
  transferFeeExtensionAuth: Address;
  platformVestingWallet: Address;
  platformVestingScale: bigint;
  platformCpCreator: Address;
}

/**
 * Decodes the fixed PlatformConfig prefix up to `platform_cp_creator` (fields on which the IDL,
 * the SDK layout and live accounts agree). The trailing curve-rule fields/vec are not needed to trade.
 */
export function decodeLaunchLabPlatformConfig(data: Uint8Array): LaunchLabPlatformConfig {
  if (!startsWith(data, RAYDIUM_ACCOUNT_DISCRIMINATORS.launchLabPlatformConfig)) {
    throw new Error("not a LaunchLab PlatformConfig account");
  }
  const r = new Reader(data, 8);
  return {
    epoch: r.u64(),
    platformFeeWallet: r.pubkey(),
    platformNftWallet: r.pubkey(),
    platformScale: r.u64(),
    creatorScale: r.u64(),
    burnScale: r.u64(),
    feeRate: r.u64(),
    name: r.fixedString(64),
    web: r.fixedString(256),
    img: r.fixedString(256),
    cpswapConfig: r.pubkey(),
    creatorFeeRate: r.u64(),
    transferFeeExtensionAuth: r.pubkey(),
    platformVestingWallet: r.pubkey(),
    platformVestingScale: r.u64(),
    platformCpCreator: r.pubkey(),
  };
}

// ---------------------------------------------------------------------------------------------
// PDAs
// ---------------------------------------------------------------------------------------------

async function pda(seeds: Uint8Array[]): Promise<Address> {
  const [a] = await getProgramDerivedAddress({ programAddress: RAYDIUM_LAUNCHLAB_PROGRAM_ID, seeds });
  return a;
}

/** Vault authority ["vault_auth_seed"] (= RAYDIUM_LAUNCHLAB_AUTHORITY). */
export const launchLabAuthorityPda = () => pda([utf8(RAYDIUM_SEEDS.launchLabAuth)]);
/** Event authority ["__event_authority"] (= RAYDIUM_LAUNCHLAB_EVENT_AUTHORITY). */
export const launchLabEventAuthorityPda = () => pda([utf8(SEEDS.eventAuthority)]);
/** Pool ["pool", base_mint, quote_mint]. */
export const launchLabPoolPda = (baseMint: Address, quoteMint: Address) =>
  pda([utf8(RAYDIUM_SEEDS.launchLabPool), addressBytes(baseMint), addressBytes(quoteMint)]);
/** Pool vault ["pool_vault", pool, mint]. */
export const launchLabVaultPda = (pool: Address, mint: Address) =>
  pda([utf8(RAYDIUM_SEEDS.launchLabVault), addressBytes(pool), addressBytes(mint)]);
/** GlobalConfig ["global_config", quote_mint, u8 curve_type, u16 index LE]. */
export const launchLabGlobalConfigPda = (quoteMint: Address, curveType: number, index: number) =>
  pda([utf8(RAYDIUM_SEEDS.launchLabGlobalConfig), addressBytes(quoteMint), u8(curveType), u16le(index)]);
/** PlatformConfig ["platform_config", platform_admin]. */
export const launchLabPlatformConfigPda = (platformAdmin: Address) =>
  pda([utf8(RAYDIUM_SEEDS.launchLabPlatformConfig), addressBytes(platformAdmin)]);
/** Platform fee vault [platform_config, quote_mint] - a quote token account, created by the program on demand. */
export const launchLabPlatformFeeVaultPda = (platformConfig: Address, quoteMint: Address) =>
  pda([addressBytes(platformConfig), addressBytes(quoteMint)]);
/** Creator fee vault [creator, quote_mint] - a quote token account, created by the program on demand. */
export const launchLabCreatorFeeVaultPda = (creator: Address, quoteMint: Address) => pda([addressBytes(creator), addressBytes(quoteMint)]);
/** Owner of every platform fee vault ["platform_fee_vault_auth_seed"]. */
export const launchLabPlatformFeeVaultAuthPda = () => pda([utf8(RAYDIUM_SEEDS.launchLabPlatformFeeVaultAuth)]);
/** Owner of every creator fee vault ["creator_fee_vault_auth_seed"]. */
export const launchLabCreatorFeeVaultAuthPda = () => pda([utf8(RAYDIUM_SEEDS.launchLabCreatorFeeVaultAuth)]);
