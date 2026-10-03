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
      // Pools are created at full size: no extend_account prefix.
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
 * against the unsold remainder of the supply. Boost virtual quote reserves (≈17.58 SOL observed)
 * are not known at arming time; pass `virtualQuoteReserves` to model them. Exact figures arrive in
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
  return { baseReserve: base, quoteVaultReserve: quote, virtualQuoteReserves };
}
