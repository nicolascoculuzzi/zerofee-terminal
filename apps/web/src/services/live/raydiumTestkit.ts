/**
 * Raydium trade contexts for the apps/web live tests, shaped exactly as the server streams them
 * (apps/server/src/market/token.ts raydiumTradeContext) from core's offline mainnet snapshot
 * (packages/core/test/fixtures/raydium-mainnet.json): LaunchLab curves (letsbonk.fun, StonkFun with a 3%
 * Token-2022 transfer fee, TRiX) and CPMM graduation pools (reserves net of the fees the pool owes). Not
 * imported by app code.
 */
import { type Address, address } from "@solana/kit";
import {
  cpmmPoolPda,
  cpmmVaultAmountsWithoutFees,
  decodeCpmmAmmConfig,
  decodeCpmmPool,
  decodeLaunchLabGlobalConfig,
  decodeLaunchLabPlatformConfig,
  decodeLaunchLabPool,
  decodeMint,
  decodeTokenAccount,
  MAINNET_SLOTS_PER_EPOCH,
  TOKEN_PROGRAM_ID,
  type TransferFeeConfig,
  WSOL_MINT,
} from "@zerofee/core";
import type { CpmmTradeContext, LaunchLabTradeContext, TransferFeeInfo } from "@zerofee/protocol";
import { RAYDIUM_SNAPSHOT_SLOT, rfixture } from "../../../../../packages/core/test/raydium-fixtures";

export { RAYDIUM_SNAPSHOT_SLOT, rfixture };

/** Epoch of the snapshot (mainnet: slot / 432,000), the Clock core's loader reads from it. */
export const SNAPSHOT_EPOCH = BigInt(RAYDIUM_SNAPSHOT_SLOT) / MAINNET_SLOTS_PER_EPOCH;

/** LaunchLab pools in the snapshot (see packages/core/test/armedRaydiumKit.ts). */
export const LL = {
  /** letsbonk.fun, SOL pair, SPL base. */
  bonk: address("6kgXHSnUa2g9n2VH6aGL9GYBEuQJYxVLwNzSsgNqmrYo"),
  /** StonkFun, SOL pair, Token-2022 base with a 3% transfer fee. */
  stonkFee: address("2mVGHRxDWc5ckj93LgwzcBhZVbzi1QNWf3SWXumfKKX2"),
  /** TRiX, SOL pair, creator fee. */
  trix: address("G5WBxuD4cEjRSVvbxodNtJ7ruDatqwSQwNCMxdFdozZY"),
  /** StonkFun quoted in a Token-2022 xStock (not SOL: Jupiter fallback). */
  stonkXstock: address("EkvuyEhr2JHmgMnoNQGzBYw8mAAqgB7W6BBQAkpVTnBS"),
  /** letsbonk.fun coin that graduated into CPMM.bonk. */
  graduated: address("yBtLj7s4aWFuBgSZCE5JpU6LoY6rofRui8cRmgbjT4S"),
} as const;

/** CPMM pools in the snapshot. */
export const CPMM = {
  /** wSOL / 7dmcQ9Ty… (SPL), the graduated letsbonk coin. */
  bonk: address("92WCdsbayLJNUFAL3EQypWJLTL8gvmSpXMh6qZxo6PHh"),
  /** wSOL / 9RcvjFss… (Token-2022 with a 3% transfer fee), a graduated StonkFun coin. */
  stonk: address("F5MuM3C8PanScX296quAoNcLYGjtt8pN7JkBM3qsiK6Z"),
} as const;

const mintInfo = (m: Address) =>
  m === WSOL_MINT
    ? { supply: 0n, decimals: 9, tokenProgram: TOKEN_PROGRAM_ID as Address, extensions: { transferFeeConfig: null } }
    : decodeMint(rfixture(m).data, rfixture(m).owner);

/** The server's transferFeeInfo (apps/server/src/market/token.ts). */
function transferFeeInfo(cfg: TransferFeeConfig | null): TransferFeeInfo | null {
  if (!cfg) return null;
  const f = (x: TransferFeeConfig["olderTransferFee"]) => ({
    epoch: x.epoch.toString(),
    maximumFee: x.maximumFee.toString(),
    basisPoints: Number(x.transferFeeBasisPoints),
  });
  return { older: f(cfg.olderTransferFee), newer: f(cfg.newerTransferFee) };
}

const vaultAmount = (a: Address) => decodeTokenAccount(rfixture(a).data).amount;

/** The base mint of a snapshot LaunchLab pool. */
export const launchLabMint = (poolAddress: Address): Address => decodeLaunchLabPool(rfixture(poolAddress).data).baseMint;

/** The coin of a snapshot CPMM pool: the mint that is not wSOL. */
export function cpmmMint(poolAddress: Address): Address {
  const p = decodeCpmmPool(rfixture(poolAddress).data);
  return p.token0Mint === WSOL_MINT ? p.token1Mint : p.token0Mint;
}

/** `tradectx:<mint>` for a snapshot LaunchLab pool, as the server builds it from the same accounts. */
export async function launchLabContext(poolAddress: Address): Promise<LaunchLabTradeContext> {
  const pool = decodeLaunchLabPool(rfixture(poolAddress).data);
  const global = decodeLaunchLabGlobalConfig(rfixture(pool.globalConfig).data);
  const platform = decodeLaunchLabPlatformConfig(rfixture(pool.platformConfig).data);
  const base = mintInfo(pool.baseMint);
  const quote = mintInfo(pool.quoteMint);
  return {
    venue: "launchlab",
    mint: pool.baseMint,
    tokenProgram: base.tokenProgram,
    decimals: base.decimals,
    supply: base.supply.toString(),
    quoteMint: pool.quoteMint,
    quoteTokenProgram: quote.tokenProgram,
    quoteDecimals: quote.decimals,
    isMayhemMode: false,
    isCashbackCoin: false,
    isHolderReward: false,
    creatorFeeBps: "0",
    slot: RAYDIUM_SNAPSHOT_SLOT,
    updatedAt: 1,
    pool: poolAddress,
    globalConfig: pool.globalConfig,
    platformConfig: pool.platformConfig,
    platform: platform.name || null,
    baseVault: pool.baseVault,
    quoteVault: pool.quoteVault,
    creator: pool.creator,
    tokenProgramFlag: pool.tokenProgramFlag,
    status: pool.status,
    migrateType: pool.migrateType,
    virtualBase: pool.virtualBase.toString(),
    virtualQuote: pool.virtualQuote.toString(),
    realBase: pool.realBase.toString(),
    realQuote: pool.realQuote.toString(),
    totalBaseSell: pool.totalBaseSell.toString(),
    totalQuoteFundRaising: pool.totalQuoteFundRaising.toString(),
    curveType: global.curveType,
    protocolFeeRate: global.tradeFeeRate.toString(),
    platformFeeRate: platform.feeRate.toString(),
    creatorFeeRate: platform.creatorFeeRate.toString(),
    baseTransferFee: transferFeeInfo(base.extensions.transferFeeConfig),
    quoteTransferFee: transferFeeInfo(quote.extensions.transferFeeConfig),
    epoch: SNAPSHOT_EPOCH.toString(),
    graduationPool: await cpmmPoolPda(platform.cpswapConfig, pool.baseMint, pool.quoteMint),
    cpswapConfig: platform.cpswapConfig,
    platformCpCreator: platform.platformCpCreator,
  };
}

/** `tradectx:<mint>` for a snapshot CPMM pool: reserves are the vault balances net of the fees the pool owes. */
export function cpmmContext(poolAddress: Address, launchLabPool: Address | null = null): CpmmTradeContext {
  const pool = decodeCpmmPool(rfixture(poolAddress).data);
  const cfg = decodeCpmmAmmConfig(rfixture(pool.ammConfig).data);
  const net = cpmmVaultAmountsWithoutFees(pool, vaultAmount(pool.token0Vault), vaultAmount(pool.token1Vault));
  const mint = cpmmMint(poolAddress);
  const quoteMint = mint === pool.token0Mint ? pool.token1Mint : pool.token0Mint;
  const base = mintInfo(mint);
  const quote = mintInfo(quoteMint);
  return {
    venue: "cpmm",
    mint,
    tokenProgram: base.tokenProgram,
    decimals: base.decimals,
    supply: base.supply.toString(),
    quoteMint,
    quoteTokenProgram: quote.tokenProgram,
    quoteDecimals: quote.decimals,
    isMayhemMode: false,
    isCashbackCoin: false,
    isHolderReward: false,
    creatorFeeBps: "0",
    slot: RAYDIUM_SNAPSHOT_SLOT,
    updatedAt: 1,
    pool: poolAddress,
    ammConfig: pool.ammConfig,
    poolCreator: pool.poolCreator,
    token0Mint: pool.token0Mint,
    token1Mint: pool.token1Mint,
    token0Vault: pool.token0Vault,
    token1Vault: pool.token1Vault,
    token0Program: pool.token0Program,
    token1Program: pool.token1Program,
    observation: pool.observationKey,
    lpMint: pool.lpMint,
    status: pool.status,
    openTime: pool.openTime.toString(),
    creatorFeeOn: pool.creatorFeeOn,
    enableCreatorFee: pool.enableCreatorFee,
    token0Reserve: net.token0.toString(),
    token1Reserve: net.token1.toString(),
    tradeFeeRate: cfg.tradeFeeRate.toString(),
    protocolFeeRate: cfg.protocolFeeRate.toString(),
    fundFeeRate: cfg.fundFeeRate.toString(),
    creatorFeeRate: cfg.creatorFeeRate.toString(),
    baseTransferFee: transferFeeInfo(base.extensions.transferFeeConfig),
    quoteTransferFee: transferFeeInfo(quote.extensions.transferFeeConfig),
    epoch: SNAPSHOT_EPOCH.toString(),
    launchLabPool,
    platform: null,
  };
}
