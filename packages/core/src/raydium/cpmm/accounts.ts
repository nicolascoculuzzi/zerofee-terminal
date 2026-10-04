/**
 * Raydium CPMM (cp-swap) account decoders and PDA derivation. Layouts follow the program source,
 * which is newer than the IDL (AmmConfig.creator_fee_share_rate was carved out of padding on
 * 2026-10-02; the account sizes did not change):
 *   https://github.com/raydium-io/raydium-cp-swap/blob/b3187ae53a1b95a201f855a59024a12ca8f5b51a/programs/cp-swap/src/states/pool.rs
 *   https://github.com/raydium-io/raydium-cp-swap/blob/b3187ae53a1b95a201f855a59024a12ca8f5b51a/programs/cp-swap/src/states/config.rs
 * PoolState is zero-copy `repr(C, packed)`: fields are contiguous after the 8-byte discriminator.
 */
import { type Address, getProgramDerivedAddress } from "@solana/kit";
import { CPMM_POOL_STATUS_BIT, RAYDIUM_ACCOUNT_DISCRIMINATORS, RAYDIUM_CPMM_PROGRAM_ID, RAYDIUM_SEEDS } from "../../constants";
import { addressBytes, Reader, startsWith, u16be, utf8 } from "../../util/bytes";

export interface CpmmPool {
  ammConfig: Address;
  poolCreator: Address;
  token0Vault: Address;
  token1Vault: Address;
  lpMint: Address;
  token0Mint: Address;
  token1Mint: Address;
  token0Program: Address;
  token1Program: Address;
  observationKey: Address;
  authBump: number;
  /** Bit set = disabled: 1 deposit, 2 withdraw, 4 swap. */
  status: number;
  lpMintDecimals: number;
  mint0Decimals: number;
  mint1Decimals: number;
  lpSupply: bigint;
  protocolFeesToken0: bigint;
  protocolFeesToken1: bigint;
  fundFeesToken0: bigint;
  fundFeesToken1: bigint;
  /** Swaps revert with NotApproved before this unix time. */
  openTime: bigint;
  recentEpoch: bigint;
  /** 0 both tokens (fee on the input), 1 only token0, 2 only token1. */
  creatorFeeOn: number;
  enableCreatorFee: boolean;
  creatorFeesToken0: bigint;
  creatorFeesToken1: bigint;
  dataLength: number;
}

export function decodeCpmmPool(data: Uint8Array): CpmmPool {
  if (!startsWith(data, RAYDIUM_ACCOUNT_DISCRIMINATORS.cpmmPoolState)) throw new Error("not a CPMM PoolState account");
  const r = new Reader(data, 8);
  const pool = {
    ammConfig: r.pubkey(),
    poolCreator: r.pubkey(),
    token0Vault: r.pubkey(),
    token1Vault: r.pubkey(),
    lpMint: r.pubkey(),
    token0Mint: r.pubkey(),
    token1Mint: r.pubkey(),
    token0Program: r.pubkey(),
    token1Program: r.pubkey(),
    observationKey: r.pubkey(),
    authBump: r.u8(),
    status: r.u8(),
    lpMintDecimals: r.u8(),
    mint0Decimals: r.u8(),
    mint1Decimals: r.u8(),
    lpSupply: r.u64(),
    protocolFeesToken0: r.u64(),
    protocolFeesToken1: r.u64(),
    fundFeesToken0: r.u64(),
    fundFeesToken1: r.u64(),
    openTime: r.u64(),
    recentEpoch: r.u64(),
    creatorFeeOn: r.u8(),
    enableCreatorFee: r.bool(),
  };
  r.skip(6); // padding1
  return { ...pool, creatorFeesToken0: r.u64(), creatorFeesToken1: r.u64(), dataLength: data.length };
}

export function isCpmmSwapEnabled(pool: Pick<CpmmPool, "status">): boolean {
  return (pool.status & CPMM_POOL_STATUS_BIT.swap) === 0;
}

export interface CpmmAmmConfig {
  bump: number;
  disableCreatePool: boolean;
  index: number;
  /** LP trade fee, ppm of the input amount. */
  tradeFeeRate: bigint;
  /** Share of the trade fee, ppm. */
  protocolFeeRate: bigint;
  /** Share of the trade fee, ppm. */
  fundFeeRate: bigint;
  createPoolFee: bigint;
  protocolOwner: Address;
  fundOwner: Address;
  /** Pool-creator fee, ppm; applies only when PoolState.enable_creator_fee. */
  creatorFeeRate: bigint;
  /** Protocol's cut of the creator fee at collection time (no effect on swaps). config.rs b3187ae. */
  creatorFeeShareRate: bigint;
}

export function decodeCpmmAmmConfig(data: Uint8Array): CpmmAmmConfig {
  if (!startsWith(data, RAYDIUM_ACCOUNT_DISCRIMINATORS.cpmmAmmConfig)) throw new Error("not a CPMM AmmConfig account");
  const r = new Reader(data, 8);
  return {
    bump: r.u8(),
    disableCreatePool: r.bool(),
    index: r.u16(),
    tradeFeeRate: r.u64(),
    protocolFeeRate: r.u64(),
    fundFeeRate: r.u64(),
    createPoolFee: r.u64(),
    protocolOwner: r.pubkey(),
    fundOwner: r.pubkey(),
    creatorFeeRate: r.u64(),
    creatorFeeShareRate: r.u64(),
  };
}

/** Sorts two mints into (token_0, token_1) by raw byte order, as `initialize` requires. */
export function sortCpmmMints(a: Address, b: Address): [Address, Address] {
  const x = addressBytes(a);
  const y = addressBytes(b);
  for (let i = 0; i < 32; i++) {
    if (x[i] !== y[i]) return (x[i] as number) < (y[i] as number) ? [a, b] : [b, a];
  }
  throw new Error("CPMM pool needs two distinct mints");
}

async function pda(seeds: Uint8Array[]): Promise<Address> {
  const [a] = await getProgramDerivedAddress({ programAddress: RAYDIUM_CPMM_PROGRAM_ID, seeds });
  return a;
}

/** ["vault_and_lp_mint_auth_seed"] (= RAYDIUM_CPMM_AUTHORITY). */
export const cpmmAuthorityPda = () => pda([utf8(RAYDIUM_SEEDS.cpmmAuth)]);
/** ["amm_config", u16 index big-endian]. */
export const cpmmAmmConfigPda = (index: number) => pda([utf8(RAYDIUM_SEEDS.cpmmAmmConfig), u16be(index)]);
/** Canonical pool ["pool", amm_config, token_0, token_1] (mints in any order; sorted here). Graduated LaunchLab pools use it. */
export async function cpmmPoolPda(ammConfig: Address, mintA: Address, mintB: Address): Promise<Address> {
  const [m0, m1] = sortCpmmMints(mintA, mintB);
  return pda([utf8(RAYDIUM_SEEDS.cpmmPool), addressBytes(ammConfig), addressBytes(m0), addressBytes(m1)]);
}
/** ["pool_vault", pool, mint]. */
export const cpmmVaultPda = (pool: Address, mint: Address) => pda([utf8(RAYDIUM_SEEDS.cpmmVault), addressBytes(pool), addressBytes(mint)]);
/** ["observation", pool]. */
export const cpmmObservationPda = (pool: Address) => pda([utf8(RAYDIUM_SEEDS.cpmmObservation), addressBytes(pool)]);
/** ["pool_lp_mint", pool]. */
export const cpmmLpMintPda = (pool: Address) => pda([utf8(RAYDIUM_SEEDS.cpmmLpMint), addressBytes(pool)]);
