/**
 * Raydium fixtures for the armed-order tests: LaunchLab / CPMM armed contexts and trigger-engine market
 * states built from the offline mainnet snapshot (test/fixtures/raydium-mainnet.json).
 */
import { type Address, address } from "@solana/kit";
import {
  type CpmmArmedContext,
  cpmmFeeRates,
  decodeCpmmAmmConfig,
  decodeCpmmPool,
  decodeLaunchLabGlobalConfig,
  decodeLaunchLabPlatformConfig,
  decodeLaunchLabPool,
  decodeMint,
  decodeTokenAccount,
  type LaunchLabArmedContext,
  type LiveMarketState,
  launchLabTradeParams,
  MAINNET_SLOTS_PER_EPOCH,
  WSOL_MINT,
} from "../src";
import { RAYDIUM_SNAPSHOT_SLOT, rfixture } from "./raydium-fixtures";

/** LaunchLab pools in the snapshot (all funding except `graduated`). */
export const LL_POOLS = {
  /** letsbonk.fun, SOL pair, SPL base. */
  bonk: address("6kgXHSnUa2g9n2VH6aGL9GYBEuQJYxVLwNzSsgNqmrYo"),
  /** StonkFun, SOL pair, Token-2022 base with a 3% transfer fee. */
  stonkFee: address("2mVGHRxDWc5ckj93LgwzcBhZVbzi1QNWf3SWXumfKKX2"),
  /** TRiX, SOL pair, creator fee. */
  trix: address("G5WBxuD4cEjRSVvbxodNtJ7ruDatqwSQwNCMxdFdozZY"),
  /** StonkFun quoted in a Token-2022 xStock. */
  stonkXstock: address("EkvuyEhr2JHmgMnoNQGzBYw8mAAqgB7W6BBQAkpVTnBS"),
  /** letsbonk.fun coin that graduated into CPMM_POOLS.bonk. */
  graduated: address("yBtLj7s4aWFuBgSZCE5JpU6LoY6rofRui8cRmgbjT4S"),
} as const;

/** CPMM pools in the snapshot. */
export const CPMM_POOLS = {
  /** wSOL / 7dmcQ9Ty… (SPL), the graduated letsbonk coin. */
  bonk: address("92WCdsbayLJNUFAL3EQypWJLTL8gvmSpXMh6qZxo6PHh"),
  /** wSOL / 9RcvjFss… (Token-2022 with a transfer fee), a graduated StonkFun coin. */
  stonk: address("F5MuM3C8PanScX296quAoNcLYGjtt8pN7JkBM3qsiK6Z"),
} as const;

export const SNAPSHOT_EPOCH = BigInt(RAYDIUM_SNAPSHOT_SLOT) / MAINNET_SLOTS_PER_EPOCH;

export const launchLabPool = (p: Address) => decodeLaunchLabPool(rfixture(p).data);
export const cpmmPool = (p: Address) => decodeCpmmPool(rfixture(p).data);
const mintInfo = (m: Address) => (m === WSOL_MINT ? null : decodeMint(rfixture(m).data, rfixture(m).owner));
const transferFee = (m: Address) => mintInfo(m)?.extensions.transferFeeConfig ?? null;

export function launchLabArmedContext(user: Address, poolAddress: Address): LaunchLabArmedContext {
  return { poolAddress, pool: launchLabPool(poolAddress), user };
}

/** The coin of a CPMM pool: the mint that is not wSOL. */
export function cpmmBaseMint(poolAddress: Address): Address {
  const p = cpmmPool(poolAddress);
  return p.token0Mint === WSOL_MINT ? p.token1Mint : p.token0Mint;
}

export function cpmmArmedContext(user: Address, poolAddress: Address): CpmmArmedContext {
  return { poolAddress, pool: cpmmPool(poolAddress), user, baseMint: cpmmBaseMint(poolAddress) };
}

/** Trigger-engine view of a LaunchLab pool at the snapshot. */
export function launchLabMarket(poolAddress: Address): Extract<LiveMarketState, { venue: "launchlab" }> {
  const pool = launchLabPool(poolAddress);
  return {
    venue: "launchlab",
    pool,
    params: launchLabTradeParams({
      globalConfig: decodeLaunchLabGlobalConfig(rfixture(pool.globalConfig).data),
      platformConfig: decodeLaunchLabPlatformConfig(rfixture(pool.platformConfig).data),
    }),
    transferFees: { base: transferFee(pool.baseMint), quote: transferFee(pool.quoteMint), epoch: SNAPSHOT_EPOCH },
    mintSupply: mintInfo(pool.baseMint)?.supply ?? 0n,
  };
}

/** Trigger-engine view of a CPMM pool at the snapshot (vault balances from the snapshot). */
export function cpmmMarket(poolAddress: Address, unixTimestamp?: bigint): Extract<LiveMarketState, { venue: "cpmm" }> {
  const pool = cpmmPool(poolAddress);
  const baseMint = cpmmBaseMint(poolAddress);
  const quoteMint = pool.token0Mint === baseMint ? pool.token1Mint : pool.token0Mint;
  const vault = (a: Address) => decodeTokenAccount(rfixture(a).data).amount;
  return {
    venue: "cpmm",
    pool,
    vault0Amount: vault(pool.token0Vault),
    vault1Amount: vault(pool.token1Vault),
    rates: cpmmFeeRates(decodeCpmmAmmConfig(rfixture(pool.ammConfig).data), pool),
    baseMint,
    transferFees: { base: transferFee(baseMint), quote: transferFee(quoteMint), epoch: SNAPSHOT_EPOCH },
    ...(unixTimestamp !== undefined ? { unixTimestamp } : {}),
    baseMintSupply: mintInfo(baseMint)?.supply ?? 0n,
  };
}
