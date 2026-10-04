/**
 * pump.fun -> PumpSwap migration support for armed orders.
 *
 * `migrate` creates the canonical pool at PDA ["pool", u16 0, pool_authority(mint), mint, quote]
 * with ATA vaults owned by the pool and copies coin_creator / is_mayhem_mode / is_cashback_coin
 * from the curve (idl/pump.json `migrate` / `migrate_v2`, PUMP_SWAP_README). Every account a
 * PumpSwap trade needs is therefore known BEFORE the pool exists, so a migration snipe (or the
 * PumpSwap leg of an order that must survive graduation) can be pre-signed against it.
 * Caveat: submitting before the pool exists fails and consumes the nonce - the trigger engine only
 * fires once the pool is live.
 */
import type { Address } from "@solana/kit";
import { POOL_ACCOUNT_NEW_SIZE, TOKEN_PROGRAM_ID } from "../constants";
import { type BondingCurve, canonicalPoolPda, curveQuoteMint, type PumpGlobal } from "../pump/accounts";
import type { AmmGlobalConfig } from "../pumpswap/accounts";
import type { AmmTradeContext } from "../pumpswap/instructions";
import type { AmmReserves } from "../pumpswap/math";
import { findAssociatedTokenAddress } from "../token";

export interface MigrationPoolArgs {
  mint: Address;
  /** LIVE curve fields; coin_creator is copied from `creator` at migration (a later creator change makes the order stale). */
  curve: Pick<BondingCurve, "creator" | "isMayhemMode" | "isCashbackCoin" | "quoteMint">;
  baseTokenProgram: Address;
  /** Owner of the quote mint (SPL Token for wSOL / USDC). */
  quoteTokenProgram?: Address;
  user: Address;
  globalConfig?: AmmGlobalConfig | null;
  protocolFeeRecipient?: Address;
  buybackFeeRecipient?: Address;
}

/** PumpSwap trade context for the not-yet-existing canonical pool of `mint`. */
export async function migrationPoolContext(args: MigrationPoolArgs): Promise<AmmTradeContext> {
  const quoteMint = curveQuoteMint(args.curve);
  const quoteTokenProgram = args.quoteTokenProgram ?? TOKEN_PROGRAM_ID;
  const poolAddress = await canonicalPoolPda(args.mint, quoteMint);
  const [poolBaseTokenAccount, poolQuoteTokenAccount] = await Promise.all([
    findAssociatedTokenAddress(poolAddress, args.mint, args.baseTokenProgram),
    findAssociatedTokenAddress(poolAddress, quoteMint, quoteTokenProgram),
  ]);
  return {
    poolAddress,
    pool: {
      baseMint: args.mint,
      quoteMint,
      poolBaseTokenAccount,
      poolQuoteTokenAccount,
      coinCreator: args.curve.creator,
      isMayhemMode: args.curve.isMayhemMode,
      isCashbackCoin: args.curve.isCashbackCoin,
      // `migrate` creates the pool at 287 bytes, below POOL_ACCOUNT_NEW_SIZE, but buys on it execute without
      // extend_account (mainnet fork, 2026-10-03), so the snipe leaves out the prefix the SDK would add.
      dataLength: POOL_ACCOUNT_NEW_SIZE,
    },
    user: args.user,
    baseTokenProgram: args.baseTokenProgram,
    quoteTokenProgram,
    globalConfig: args.globalConfig,
    protocolFeeRecipient: args.protocolFeeRecipient,
    buybackFeeRecipient: args.buybackFeeRecipient,
  };
}

/**
 * ESTIMATE of the canonical pool's opening reserves, to centre a snipe grid: the curve sold out
 * (virtual reserves at real_token_reserves = 0 along x*y = k), its quote minus `pool_migration_fee`
 * against the unsold remainder of the supply.
 *
 * `migrate` parks a boost share of that quote (≈17.58 SOL observed) in the pool's boost vault (the wSOL
 * ATA of PumpSwap PDA ["boost_vault", pool]) instead of its real quote vault, and books the same amount
 * as signed virtual quote reserves. So the EFFECTIVE quote (real + virtual), which prices every trade
 * and sets the fee tier, is the same with or without a boost. `virtualQuoteReserves` (the
 * expected boost, unknown at arming time) only splits real from virtual, which matters for sells
 * (capped at the real vault). On a mainnet fork (2026-10-03) the base and the effective quote matched
 * the pool `migrate` created to the unit; earlier this function added the boost on top of the real
 * quote and overstated the opening price by about 20%. Exact figures arrive in
 * CompletePumpAmmMigrationEvent (`mint_amount`, `sol_amount`) and the pool account.
 */
export function estimateMigrationPoolReserves(
  curve: Pick<
    BondingCurve,
    "virtualTokenReserves" | "virtualQuoteReserves" | "realTokenReserves" | "realQuoteReserves" | "tokenTotalSupply"
  >,
  global: Pick<PumpGlobal, "poolMigrationFee" | "initialRealTokenReserves">,
  virtualQuoteReserves = 0n,
): AmmReserves {
  const k = curve.virtualQuoteReserves * curve.virtualTokenReserves;
  const vTFinal = curve.virtualTokenReserves - curve.realTokenReserves;
  if (vTFinal <= 0n) throw new RangeError("curve has no virtual tokens left after its real reserves");
  const vQFinal = (k + vTFinal - 1n) / vTFinal;
  const realQuoteFinal = curve.realQuoteReserves + (vQFinal - curve.virtualQuoteReserves);
  const quote = realQuoteFinal - global.poolMigrationFee;
  const base = curve.tokenTotalSupply - global.initialRealTokenReserves;
  if (quote <= 0n || base <= 0n) throw new RangeError("estimated migration reserves are not positive");
  if (virtualQuoteReserves < 0n || virtualQuoteReserves >= quote) throw new RangeError("the boost must be in [0, the migrated quote)");
  return { baseReserve: base, quoteVaultReserve: quote - virtualQuoteReserves, virtualQuoteReserves };
}
