/**
 * Armed orders on Raydium LaunchLab (the bonding curves behind BONK.fun, StonkFun, TRiX) and Raydium CPMM
 * (where LaunchLab coins graduate): trade templates, the graduation pool of a LaunchLab coin, and the
 * LaunchLab -> CPMM migration snipe.
 *
 * Every template signs what the signer firewall accepts (packages/signer rules/raydium.ts): LaunchLab
 * buy_exact_in / sell_exact_in with share_fee_rate 0 on the pool PDA ["pool", base, quote]; CPMM
 * swap_base_input on a pool whose vaults and observation are its PDAs; the trading wallet's own ATAs.
 * armedTx.ts keeps every account the firewall pins static (FIREWALL_STATIC_VENUE_POSITIONS).
 *
 * Graduation is deterministic: `migrate_to_cpswap` (signed by Raydium's migration wallet, not
 * permissionless) creates the CPMM pool at PDA ["pool", PlatformConfig.cpswap_config, token_0, token_1]
 * with vaults ["pool_vault", pool, mint], observation ["observation", pool] and pool_creator =
 * PlatformConfig.platform_cp_creator, moving the curve's unsold base and raised quote (minus migrate_fee)
 * into the vaults. Verified against the letsbonk migration in test/fixtures/raydium-mainnet.json (tx
 * "migrate": every account and both vault amounts). So a CPMM buy can be pre-signed before the pool exists.
 * Caveats: a platform admin can change cpswap_config before graduation (the order then goes stale:
 * "graduation-pool-changed"), coins with migrate_type 0 graduate to AMM v4 (unsupported), and submitting
 * before the pool exists fails and consumes the nonce: the trigger engine fires only once the pool quotes.
 */
import type { Address, TransactionPartialSigner } from "@solana/kit";
import { DEFAULT_CU_LIMITS, LAUNCHLAB_POOL_STATUS } from "../constants";
import { type CpmmPool, cpmmObservationPda, cpmmPoolPda, cpmmVaultPda, sortCpmmMints } from "../raydium/cpmm/accounts";
import { buildCpmmSwapInstructions, type CpmmPoolKeys, type CpmmTradeContext } from "../raydium/cpmm/instructions";
import {
  type LaunchLabPlatformConfig,
  type LaunchLabPool,
  launchLabBaseTokenProgram,
  launchLabPoolPda,
  launchLabQuoteTokenProgram,
} from "../raydium/launchlab/accounts";
import {
  buildLaunchLabBuyInstructions,
  buildLaunchLabSellInstructions,
  type LaunchLabPoolKeys,
  type LaunchLabTradeContext,
} from "../raydium/launchlab/instructions";
import { type ArmedOrderSpec, ArmingError, armOrder, type TradeTemplate } from "./builders";
import type { ArmedOrder } from "./model";

// ---------------------------------------------------------------------------------------------
// LaunchLab
// ---------------------------------------------------------------------------------------------

/** A LaunchLab pool to arm on: its keys, plus the live status when known (only a funding curve trades). */
export interface LaunchLabArmedContext {
  poolAddress: Address;
  pool: LaunchLabPoolKeys & Partial<Pick<LaunchLabPool, "status">>;
  /** The trading wallet. */
  user: Address;
}

async function launchLabPinned(ctx: LaunchLabArmedContext): Promise<LaunchLabTradeContext> {
  if (ctx.pool.status !== undefined && ctx.pool.status !== LAUNCHLAB_POOL_STATUS.fund) {
    throw new ArmingError(`LaunchLab pool ${ctx.poolAddress} is not funding (status ${ctx.pool.status}): its curve no longer trades`);
  }
  // The firewall only trades the pool PDA of the mints it reads (one pool per pair).
  const expected = await launchLabPoolPda(ctx.pool.baseMint, ctx.pool.quoteMint);
  if (ctx.poolAddress !== expected) throw new ArmingError(`${ctx.poolAddress} is not the LaunchLab pool PDA ${expected} of its mints`);
  // The wallet's own ATAs and no share_fee_receiver: what the firewall accepts.
  return { poolAddress: ctx.poolAddress, pool: ctx.pool, user: ctx.user };
}

function launchLabFrozen(ctx: LaunchLabArmedContext): TradeTemplate["frozen"] {
  return {
    baseTokenProgram: launchLabBaseTokenProgram(ctx.pool),
    quoteMint: ctx.pool.quoteMint,
    creator: ctx.pool.creator,
    market: ctx.poolAddress,
    config: ctx.pool.platformConfig,
  };
}

/** Token-2022 accounts holding withheld transfer fees cannot be closed: a full exit would land and fail. */
function assertClosable(close: boolean, withheld: bigint | undefined): void {
  if (close && (withheld ?? 0n) > 0n) {
    throw new ArmingError(
      `the base token account holds ${withheld} withheld Token-2022 transfer fees, so CloseAccount fails; arm without closeBaseAccount`,
    );
  }
}

/** LaunchLab buy via buy_exact_in: spend `spend` quote (fees included) for >= minOut base (share_fee_rate 0). */
export async function launchLabBuyTemplate(ctx: LaunchLabArmedContext, order: { spend: bigint }): Promise<TradeTemplate> {
  if (order.spend <= 0n) throw new RangeError("spend must be > 0");
  const pinned = await launchLabPinned(ctx);
  return {
    venue: "launchlab",
    side: "buy",
    mint: ctx.pool.baseMint,
    amount: order.spend,
    closesBaseAccount: false,
    build: async (minOut) =>
      (await buildLaunchLabBuyInstructions(pinned, { mode: "exactIn", amount: order.spend, limit: minOut })).instructions,
    frozen: launchLabFrozen(ctx),
    defaultCuLimit: DEFAULT_CU_LIMITS.launchLabBuy,
  };
}

/**
 * LaunchLab sell via sell_exact_in: sell `amount` base for >= minOut quote; `closeBaseAccount` for full exits
 * (refused while `userBaseWithheld` > 0, see assertClosable).
 */
export async function launchLabSellTemplate(
  ctx: LaunchLabArmedContext,
  order: { amount: bigint; closeBaseAccount?: boolean; userBaseWithheld?: bigint },
): Promise<TradeTemplate> {
  if (order.amount <= 0n) throw new RangeError("amount must be > 0");
  const close = order.closeBaseAccount ?? false;
  assertClosable(close, order.userBaseWithheld);
  const pinned = await launchLabPinned(ctx);
  return {
    venue: "launchlab",
    side: "sell",
    mint: ctx.pool.baseMint,
    amount: order.amount,
    closesBaseAccount: close,
    build: async (minOut) =>
      (await buildLaunchLabSellInstructions(pinned, { mode: "exactIn", amount: order.amount, limit: minOut, closeBaseAccount: close }))
        .instructions,
    frozen: launchLabFrozen(ctx),
    defaultCuLimit: DEFAULT_CU_LIMITS.launchLabSell,
  };
}

// ---------------------------------------------------------------------------------------------
// CPMM
// ---------------------------------------------------------------------------------------------

/** A CPMM pool to arm on. The pool is just two mints: `baseMint` is the coin, the other one the quote. */
export interface CpmmArmedContext {
  poolAddress: Address;
  pool: CpmmPoolKeys & Pick<CpmmPool, "poolCreator">;
  /** The trading wallet. */
  user: Address;
  baseMint: Address;
}

interface CpmmSides {
  quoteMint: Address;
  baseTokenProgram: Address;
}

/** The firewall requires the vaults and the observation to be the pool's PDAs; check before signing. */
async function cpmmSides(ctx: CpmmArmedContext): Promise<CpmmSides> {
  const { pool, poolAddress } = ctx;
  let quoteMint: Address;
  let baseTokenProgram: Address;
  if (ctx.baseMint === pool.token0Mint) [quoteMint, baseTokenProgram] = [pool.token1Mint, pool.token0Program];
  else if (ctx.baseMint === pool.token1Mint) [quoteMint, baseTokenProgram] = [pool.token0Mint, pool.token1Program];
  else throw new ArmingError(`${ctx.baseMint} is not in CPMM pool ${poolAddress}`);
  const [v0, v1, obs] = await Promise.all([
    cpmmVaultPda(poolAddress, pool.token0Mint),
    cpmmVaultPda(poolAddress, pool.token1Mint),
    cpmmObservationPda(poolAddress),
  ]);
  if (v0 !== pool.token0Vault || v1 !== pool.token1Vault || obs !== pool.observationKey) {
    throw new ArmingError(`CPMM pool ${poolAddress}: vaults / observation are not its PDAs`);
  }
  return { quoteMint, baseTokenProgram };
}

function cpmmTrade(ctx: CpmmArmedContext, inputMint: Address): CpmmTradeContext {
  return { poolAddress: ctx.poolAddress, pool: ctx.pool, user: ctx.user, inputMint };
}

function cpmmFrozen(ctx: CpmmArmedContext, s: CpmmSides): TradeTemplate["frozen"] {
  return {
    baseTokenProgram: s.baseTokenProgram,
    quoteMint: s.quoteMint,
    creator: ctx.pool.poolCreator,
    market: ctx.poolAddress,
    config: ctx.pool.ammConfig,
  };
}

/** CPMM buy via swap_base_input: spend `spend` of the quote mint (wSOL wrapped around the swap) for >= minOut base. */
export async function cpmmBuyTemplate(ctx: CpmmArmedContext, order: { spend: bigint }): Promise<TradeTemplate> {
  if (order.spend <= 0n) throw new RangeError("spend must be > 0");
  const s = await cpmmSides(ctx);
  const trade = cpmmTrade(ctx, s.quoteMint);
  return {
    venue: "cpmm",
    side: "buy",
    mint: ctx.baseMint,
    amount: order.spend,
    closesBaseAccount: false,
    build: async (minOut) =>
      (await buildCpmmSwapInstructions(trade, { mode: "baseInput", amount: order.spend, limit: minOut })).instructions,
    frozen: cpmmFrozen(ctx, s),
    defaultCuLimit: DEFAULT_CU_LIMITS.cpmmBuy,
  };
}

/** CPMM sell via swap_base_input: sell `amount` base for >= minOut quote; `closeBaseAccount` for full exits. */
export async function cpmmSellTemplate(
  ctx: CpmmArmedContext,
  order: { amount: bigint; closeBaseAccount?: boolean; userBaseWithheld?: bigint },
): Promise<TradeTemplate> {
  if (order.amount <= 0n) throw new RangeError("amount must be > 0");
  const close = order.closeBaseAccount ?? false;
  assertClosable(close, order.userBaseWithheld);
  const s = await cpmmSides(ctx);
  const trade = cpmmTrade(ctx, ctx.baseMint);
  return {
    venue: "cpmm",
    side: "sell",
    mint: ctx.baseMint,
    amount: order.amount,
    closesBaseAccount: close,
    build: async (minOut) =>
      (await buildCpmmSwapInstructions(trade, { mode: "baseInput", amount: order.amount, limit: minOut, closeInputAccount: close }))
        .instructions,
    frozen: cpmmFrozen(ctx, s),
    defaultCuLimit: DEFAULT_CU_LIMITS.cpmmSell,
  };
}

// ---------------------------------------------------------------------------------------------
// LaunchLab -> CPMM graduation
// ---------------------------------------------------------------------------------------------

export interface LaunchLabGraduationArgs {
  /** LIVE LaunchLab pool. */
  pool: Pick<LaunchLabPool, "baseMint" | "quoteMint" | "tokenProgramFlag" | "migrateType" | "status">;
  /** LIVE PlatformConfig of the pool: cpswap_config picks the CPMM pool, platform_cp_creator becomes its pool_creator. */
  platformConfig: Pick<LaunchLabPlatformConfig, "cpswapConfig" | "platformCpCreator">;
  /** The trading wallet. */
  user: Address;
}

/**
 * CPMM context of the pool a LaunchLab coin graduates into (before or after it exists). Refuses coins that
 * graduate to AMM v4 (migrate_type 0).
 */
export async function launchLabGraduationPoolContext(args: LaunchLabGraduationArgs): Promise<CpmmArmedContext> {
  const { pool } = args;
  if (pool.migrateType !== 1)
    throw new ArmingError(`${pool.baseMint} graduates to Raydium AMM v4 (migrate_type ${pool.migrateType}), not CPMM`);
  const poolAddress = await cpmmPoolPda(args.platformConfig.cpswapConfig, pool.baseMint, pool.quoteMint);
  const [token0Mint, token1Mint] = sortCpmmMints(pool.baseMint, pool.quoteMint);
  const programOf = (mint: Address) => (mint === pool.baseMint ? launchLabBaseTokenProgram(pool) : launchLabQuoteTokenProgram(pool));
  const [token0Vault, token1Vault, observationKey] = await Promise.all([
    cpmmVaultPda(poolAddress, token0Mint),
    cpmmVaultPda(poolAddress, token1Mint),
    cpmmObservationPda(poolAddress),
  ]);
  return {
    poolAddress,
    pool: {
      ammConfig: args.platformConfig.cpswapConfig,
      token0Mint,
      token1Mint,
      token0Vault,
      token1Vault,
      token0Program: programOf(token0Mint),
      token1Program: programOf(token1Mint),
      observationKey,
      poolCreator: args.platformConfig.platformCpCreator,
    },
    user: args.user,
    baseMint: pool.baseMint,
  };
}

/**
 * ESTIMATE of the graduation pool's opening vault balances, to centre a snipe grid: `migrate_to_cpswap`
 * moves the curve's unsold base (supply - total_base_sell, less tokens locked for vesting, which stay
 * behind for claims) and its raised quote (real_quote, at least total_quote_fund_raising once complete)
 * minus migrate_fee; LaunchLab's protocol / platform fees stay in its own vault, and a new CPMM pool owes
 * no fees. Matches the letsbonk migration fixture exactly (a pool without vesting or migrate fee; vesting
 * pools are unverified). Exact figures are in the pool's vaults once it exists.
 */
export function estimateLaunchLabGraduationReserves(
  pool: Pick<LaunchLabPool, "supply" | "totalBaseSell" | "realQuote" | "totalQuoteFundRaising" | "migrateFee" | "vestingSchedule">,
): { base: bigint; quote: bigint } {
  const base = pool.supply - pool.totalBaseSell - pool.vestingSchedule.totalLockedAmount;
  const raised = pool.realQuote > pool.totalQuoteFundRaising ? pool.realQuote : pool.totalQuoteFundRaising;
  const quote = raised - pool.migrateFee;
  if (base <= 0n || quote <= 0n) throw new RangeError("estimated graduation reserves are not positive");
  return { base, quote };
}

/** Vault balances (token_0, token_1 order) of an estimate, for quoteCpmmSwapBaseInput. */
export function graduationVaultAmounts(
  ctx: Pick<CpmmArmedContext, "pool" | "baseMint">,
  reserves: { base: bigint; quote: bigint },
): { vault0Amount: bigint; vault1Amount: bigint } {
  return ctx.pool.token0Mint === ctx.baseMint
    ? { vault0Amount: reserves.base, vault1Amount: reserves.quote }
    : { vault0Amount: reserves.quote, vault1Amount: reserves.base };
}

/**
 * LaunchLab migration snipe: a CPMM buy pre-signed against the graduation pool, fired once the coin migrated
 * and the pool quotes (trigger "migration", venue "cpmm").
 */
export async function armLaunchLabMigrationSnipe(
  args: Omit<ArmedOrderSpec, "kind" | "templates" | "trigger"> & { launchLab: Omit<LaunchLabGraduationArgs, "user"> },
  signer: TransactionPartialSigner,
): Promise<ArmedOrder> {
  const { launchLab, ...spec } = args;
  if (spec.nonces.length !== 1) throw new ArmingError("a migration snipe is a buy: exactly one nonce");
  if (launchLab.pool.baseMint !== spec.mint) throw new ArmingError(`LaunchLab pool base mint ${launchLab.pool.baseMint} != ${spec.mint}`);
  if (launchLab.pool.status === LAUNCHLAB_POOL_STATUS.trade) {
    throw new ArmingError(`${spec.mint} already graduated: arm a CPMM order on its live pool instead`);
  }
  const ctx = await launchLabGraduationPoolContext({ ...launchLab, user: spec.wallet });
  const template = await cpmmBuyTemplate(ctx, { spend: spec.amount });
  return armOrder({ ...spec, kind: "migration-snipe", templates: [template], trigger: { type: "migration" } }, signer);
}
