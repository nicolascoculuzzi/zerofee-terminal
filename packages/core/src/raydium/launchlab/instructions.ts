/**
 * Raydium LaunchLab swap instruction builders: buy_exact_in / buy_exact_out / sell_exact_in /
 * sell_exact_out with the full account list, in the order of the official SDK
 * (raydium-sdk-V2 cc33ec2 src/raydium/launchpad/instrument.ts) and the CPI crate's `Swap` context:
 *
 *   0 payer (S,W)  1 authority  2 global_config  3 platform_config  4 pool_state (W)
 *   5 user_base_token (W)  6 user_quote_token (W)  7 base_vault (W)  8 quote_vault (W)
 *   9 base_token_mint  10 quote_token_mint  11 base_token_program  12 quote_token_program
 *   13 event_authority  14 program
 *   remaining: [share_fee_receiver (W), only if share_fee_rate > 0], system_program,
 *              platform_fee_vault (W) = PDA[platform_config, quote_mint],
 *              creator_fee_vault (W)  = PDA[creator, quote_mint]
 *
 * The fee vaults are quote token accounts the program creates on first use (rent paid by the payer).
 * Token programs come from the pool's token_program_flag (Token-2022 for StonkFun coins and xStock
 * quotes). SOL-quoted pools trade wSOL, so buys wrap and both sides unwrap like the PumpSwap path.
 */
import { type AccountMeta, AccountRole, type Address, type Instruction } from "@solana/kit";
import {
  EXPECTED_ACCOUNT_COUNTS,
  RAYDIUM_LAUNCHLAB_IX,
  RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from "../../constants";
import {
  closeAccountInstruction,
  createAtaIdempotentInstruction,
  findAssociatedTokenAddress,
  syncNativeInstruction,
  systemTransferInstruction,
} from "../../token";
import { concatBytes, u64le } from "../../util/bytes";
import {
  type LaunchLabPool,
  launchLabAuthorityPda,
  launchLabBaseTokenProgram,
  launchLabCreatorFeeVaultPda,
  launchLabEventAuthorityPda,
  launchLabPlatformFeeVaultPda,
  launchLabQuoteTokenProgram,
} from "./accounts";

const ro = (address: Address): AccountMeta => ({ address, role: AccountRole.READONLY });
const w = (address: Address): AccountMeta => ({ address, role: AccountRole.WRITABLE });
const ws = (address: Address): AccountMeta => ({ address, role: AccountRole.WRITABLE_SIGNER });

let staticPdas: Promise<{ authority: Address; eventAuthority: Address }> | undefined;
function getStaticPdas() {
  staticPdas ??= Promise.all([launchLabAuthorityPda(), launchLabEventAuthorityPda()]).then(([authority, eventAuthority]) => ({
    authority,
    eventAuthority,
  }));
  return staticPdas;
}

export type LaunchLabPoolKeys = Pick<
  LaunchLabPool,
  "globalConfig" | "platformConfig" | "baseMint" | "quoteMint" | "baseVault" | "quoteVault" | "creator" | "tokenProgramFlag"
>;

export interface LaunchLabTradeContext {
  poolAddress: Address;
  pool: LaunchLabPoolKeys;
  user: Address;
  /** Defaults to the user's ATA for the base mint (with the pool's base token program). */
  userBaseToken?: Address;
  /** Defaults to the user's ATA for the pool's quote mint (the wSOL ATA for SOL pairs). */
  userQuoteToken?: Address;
  /** Referral receiver token account (quote mint); only with a non-zero share fee. We never set it. */
  shareFeeReceiver?: Address;
}

export interface LaunchLabSwapAccounts {
  payer: Address;
  authority: Address;
  globalConfig: Address;
  platformConfig: Address;
  poolState: Address;
  userBaseToken: Address;
  userQuoteToken: Address;
  baseVault: Address;
  quoteVault: Address;
  baseTokenMint: Address;
  quoteTokenMint: Address;
  baseTokenProgram: Address;
  quoteTokenProgram: Address;
  eventAuthority: Address;
  program: Address;
  shareFeeReceiver?: Address;
  systemProgram: Address;
  platformFeeVault: Address;
  creatorFeeVault: Address;
}

export async function resolveLaunchLabSwapAccounts(ctx: LaunchLabTradeContext): Promise<LaunchLabSwapAccounts> {
  const s = await getStaticPdas();
  const { pool } = ctx;
  const baseTokenProgram = launchLabBaseTokenProgram(pool);
  const quoteTokenProgram = launchLabQuoteTokenProgram(pool);
  const [userBaseToken, userQuoteToken, platformFeeVault, creatorFeeVault] = await Promise.all([
    ctx.userBaseToken ?? findAssociatedTokenAddress(ctx.user, pool.baseMint, baseTokenProgram),
    ctx.userQuoteToken ?? findAssociatedTokenAddress(ctx.user, pool.quoteMint, quoteTokenProgram),
    launchLabPlatformFeeVaultPda(pool.platformConfig, pool.quoteMint),
    launchLabCreatorFeeVaultPda(pool.creator, pool.quoteMint),
  ]);
  return {
    payer: ctx.user,
    authority: s.authority,
    globalConfig: pool.globalConfig,
    platformConfig: pool.platformConfig,
    poolState: ctx.poolAddress,
    userBaseToken,
    userQuoteToken,
    baseVault: pool.baseVault,
    quoteVault: pool.quoteVault,
    baseTokenMint: pool.baseMint,
    quoteTokenMint: pool.quoteMint,
    baseTokenProgram,
    quoteTokenProgram,
    eventAuthority: s.eventAuthority,
    program: RAYDIUM_LAUNCHLAB_PROGRAM_ID,
    shareFeeReceiver: ctx.shareFeeReceiver,
    systemProgram: SYSTEM_PROGRAM_ID,
    platformFeeVault,
    creatorFeeVault,
  };
}

/** Ordered metas (18, or 19 with a share fee receiver). */
export function launchLabSwapAccountMetas(a: LaunchLabSwapAccounts): AccountMeta[] {
  const metas: AccountMeta[] = [
    ws(a.payer),
    ro(a.authority),
    ro(a.globalConfig),
    ro(a.platformConfig),
    w(a.poolState),
    w(a.userBaseToken),
    w(a.userQuoteToken),
    w(a.baseVault),
    w(a.quoteVault),
    ro(a.baseTokenMint),
    ro(a.quoteTokenMint),
    ro(a.baseTokenProgram),
    ro(a.quoteTokenProgram),
    ro(a.eventAuthority),
    ro(a.program),
  ];
  if (a.shareFeeReceiver) metas.push(w(a.shareFeeReceiver));
  metas.push(ro(a.systemProgram), w(a.platformFeeVault), w(a.creatorFeeVault));
  const expected = EXPECTED_ACCOUNT_COUNTS.launchLabSwap + (a.shareFeeReceiver ? 1 : 0);
  if (metas.length !== expected) throw new Error(`LaunchLab swap: expected ${expected} accounts, got ${metas.length}`);
  return metas;
}

function swapIx(disc: Uint8Array, a: LaunchLabSwapAccounts, amount: bigint, limit: bigint, shareFeeRate: bigint): Instruction {
  if (shareFeeRate > 0n && !a.shareFeeReceiver) throw new Error("share_fee_rate > 0 requires a share fee receiver account");
  return {
    programAddress: RAYDIUM_LAUNCHLAB_PROGRAM_ID,
    accounts: launchLabSwapAccountMetas(a),
    data: concatBytes(disc, u64le(amount), u64le(limit), u64le(shareFeeRate)),
  };
}

/** buy_exact_in(amount_in, minimum_amount_out, share_fee_rate): spend `amountIn` quote. */
export function launchLabBuyExactInInstruction(a: LaunchLabSwapAccounts, amountIn: bigint, minimumAmountOut: bigint, shareFeeRate = 0n) {
  return swapIx(RAYDIUM_LAUNCHLAB_IX.buyExactIn, a, amountIn, minimumAmountOut, shareFeeRate);
}

/** buy_exact_out(amount_out, maximum_amount_in, share_fee_rate): receive `amountOut` base. */
export function launchLabBuyExactOutInstruction(a: LaunchLabSwapAccounts, amountOut: bigint, maximumAmountIn: bigint, shareFeeRate = 0n) {
  return swapIx(RAYDIUM_LAUNCHLAB_IX.buyExactOut, a, amountOut, maximumAmountIn, shareFeeRate);
}

/** sell_exact_in(amount_in, minimum_amount_out, share_fee_rate): sell `amountIn` base. */
export function launchLabSellExactInInstruction(a: LaunchLabSwapAccounts, amountIn: bigint, minimumAmountOut: bigint, shareFeeRate = 0n) {
  return swapIx(RAYDIUM_LAUNCHLAB_IX.sellExactIn, a, amountIn, minimumAmountOut, shareFeeRate);
}

/** sell_exact_out(amount_out, maximum_amount_in, share_fee_rate): receive `amountOut` quote. */
export function launchLabSellExactOutInstruction(a: LaunchLabSwapAccounts, amountOut: bigint, maximumAmountIn: bigint, shareFeeRate = 0n) {
  return swapIx(RAYDIUM_LAUNCHLAB_IX.sellExactOut, a, amountOut, maximumAmountIn, shareFeeRate);
}

/**
 * Buy on a LaunchLab curve. SOL pairs: create the wSOL ATA (idempotent), fund it with the max quote
 * spend, SyncNative, create the base ATA (idempotent, Token/Token-2022 aware), swap, close the wSOL
 * ATA (unwraps any remainder). Other quote mints spend from the user's existing quote ATA.
 *   mode "exactIn":  spend `amount` quote (fees included) for >= `limit` base.
 *   mode "exactOut": receive `amount` base for <= `limit` quote.
 */
export async function buildLaunchLabBuyInstructions(
  ctx: LaunchLabTradeContext,
  order: { mode: "exactIn" | "exactOut"; amount: bigint; limit: bigint; shareFeeRate?: bigint },
): Promise<{ instructions: Instruction[]; accounts: LaunchLabSwapAccounts }> {
  const a = await resolveLaunchLabSwapAccounts(ctx);
  const isWsol = ctx.pool.quoteMint === WSOL_MINT;
  const ixs: Instruction[] = [];
  if (isWsol) {
    const lamports = order.mode === "exactIn" ? order.amount : order.limit;
    ixs.push(
      createAtaIdempotentInstruction({
        payer: ctx.user,
        ata: a.userQuoteToken,
        owner: ctx.user,
        mint: WSOL_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
      }),
      systemTransferInstruction({ from: ctx.user, to: a.userQuoteToken, lamports }),
      syncNativeInstruction(a.userQuoteToken),
    );
  }
  ixs.push(
    createAtaIdempotentInstruction({
      payer: ctx.user,
      ata: a.userBaseToken,
      owner: ctx.user,
      mint: ctx.pool.baseMint,
      tokenProgram: a.baseTokenProgram,
    }),
    order.mode === "exactIn"
      ? launchLabBuyExactInInstruction(a, order.amount, order.limit, order.shareFeeRate)
      : launchLabBuyExactOutInstruction(a, order.amount, order.limit, order.shareFeeRate),
  );
  if (isWsol) ixs.push(closeAccountInstruction({ account: a.userQuoteToken, destination: ctx.user, owner: ctx.user }));
  return { instructions: ixs, accounts: a };
}

/**
 * Sell on a LaunchLab curve. Proceeds land in the user's quote ATA (created idempotently); for SOL
 * pairs that is a temporary wSOL ATA closed afterwards. `closeBaseAccount` reclaims the base ATA
 * rent on full exits - the caller must not set it for Token-2022 accounts holding withheld fees.
 *   mode "exactIn":  sell `amount` base for >= `limit` quote.
 *   mode "exactOut": receive `amount` quote for <= `limit` base.
 */
export async function buildLaunchLabSellInstructions(
  ctx: LaunchLabTradeContext,
  order: { mode: "exactIn" | "exactOut"; amount: bigint; limit: bigint; closeBaseAccount?: boolean; shareFeeRate?: bigint },
): Promise<{ instructions: Instruction[]; accounts: LaunchLabSwapAccounts }> {
  const a = await resolveLaunchLabSwapAccounts(ctx);
  const isWsol = ctx.pool.quoteMint === WSOL_MINT;
  const ixs: Instruction[] = [
    createAtaIdempotentInstruction({
      payer: ctx.user,
      ata: a.userQuoteToken,
      owner: ctx.user,
      mint: ctx.pool.quoteMint,
      tokenProgram: a.quoteTokenProgram,
    }),
    order.mode === "exactIn"
      ? launchLabSellExactInInstruction(a, order.amount, order.limit, order.shareFeeRate)
      : launchLabSellExactOutInstruction(a, order.amount, order.limit, order.shareFeeRate),
  ];
  if (isWsol) ixs.push(closeAccountInstruction({ account: a.userQuoteToken, destination: ctx.user, owner: ctx.user }));
  if (order.closeBaseAccount) {
    ixs.push(
      closeAccountInstruction({ account: a.userBaseToken, destination: ctx.user, owner: ctx.user, tokenProgram: a.baseTokenProgram }),
    );
  }
  return { instructions: ixs, accounts: a };
}
