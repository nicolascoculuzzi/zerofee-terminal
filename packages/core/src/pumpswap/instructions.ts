/**
 * PumpSwap buy / buy_exact_quote_in / sell builders with the mandatory remaining accounts, in the
 * exact order of pump-swap-sdk 1.20.0 src/sdk/offlinePumpAmm.ts:
 *   buy:  [cashback: UVA quote ATA (W)] -> [coin_creator != default: pool-v2 (R)] -> buyback (R) -> buyback quote ATA (W)
 *   sell: [cashback: UVA quote ATA (W), UVA (W)] -> [pool-v2 (R)] -> buyback (R) -> buyback quote ATA (W)
 * The buyback pair is required even for non-bonding-curve pools (BREAKING_FEE_RECIPIENT.md).
 * PumpSwap trades wSOL (SPL), so SOL legs are wrapped/unwrapped around the swap like the SDK does.
 */
import { type AccountMeta, AccountRole, type Address, type Instruction } from "@solana/kit";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  DEFAULT_PUBKEY,
  MAYHEM_FEE_RECIPIENTS,
  POOL_ACCOUNT_NEW_SIZE,
  PUMP_AMM_IX,
  PUMP_AMM_PROGRAM_ID,
  PUMP_AMM_PROTOCOL_FEE_RECIPIENTS_FALLBACK,
  PUMP_FEE_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from "../constants";
import { pickBuybackFeeRecipient } from "../pump/instructions";
import {
  closeAccountInstruction,
  createAtaIdempotentInstruction,
  findAssociatedTokenAddress,
  syncNativeInstruction,
  systemTransferInstruction,
} from "../token";
import { concatBytes, u8, u64le } from "../util/bytes";
import { pickRandom } from "../util/random";
import {
  type AmmGlobalConfig,
  ammEventAuthorityPda,
  ammFeeConfigPda,
  ammGlobalConfigPda,
  ammGlobalVolumeAccumulatorPda,
  ammUserVolumeAccumulatorPda,
  coinCreatorVaultAuthorityPda,
  type Pool,
  poolV2Pda,
} from "./accounts";

let staticPdas: Promise<{ globalConfig: Address; eventAuthority: Address; gva: Address; feeConfig: Address }> | undefined;
function getStaticPdas() {
  staticPdas ??= Promise.all([ammGlobalConfigPda(), ammEventAuthorityPda(), ammGlobalVolumeAccumulatorPda(), ammFeeConfigPda()]).then(
    ([globalConfig, eventAuthority, gva, feeConfig]) => ({ globalConfig, eventAuthority, gva, feeConfig }),
  );
  return staticPdas;
}

const ro = (address: Address): AccountMeta => ({ address, role: AccountRole.READONLY });
const w = (address: Address): AccountMeta => ({ address, role: AccountRole.WRITABLE });
const ws = (address: Address): AccountMeta => ({ address, role: AccountRole.WRITABLE_SIGNER });

/** Protocol fee recipient: reserved list for mayhem pools, else GlobalConfig.protocol_fee_recipients. */
export function pickAmmProtocolFeeRecipient(isMayhemMode: boolean, gc?: AmmGlobalConfig | null): Address {
  if (isMayhemMode) {
    const live = gc ? [gc.reservedFeeRecipient, ...gc.reservedFeeRecipients].filter((a) => a !== DEFAULT_PUBKEY) : [];
    return pickRandom(live.length ? live : MAYHEM_FEE_RECIPIENTS);
  }
  const live = gc?.protocolFeeRecipients ?? [];
  return pickRandom(live.length ? live : PUMP_AMM_PROTOCOL_FEE_RECIPIENTS_FALLBACK);
}

export interface AmmTradeContext {
  poolAddress: Address;
  pool: Pick<
    Pool,
    | "baseMint"
    | "quoteMint"
    | "poolBaseTokenAccount"
    | "poolQuoteTokenAccount"
    | "coinCreator"
    | "isMayhemMode"
    | "isCashbackCoin"
    | "dataLength"
  >;
  user: Address;
  baseTokenProgram: Address;
  quoteTokenProgram?: Address;
  globalConfig?: AmmGlobalConfig | null;
  /** Overrides for deterministic builds/tests. */
  protocolFeeRecipient?: Address;
  buybackFeeRecipient?: Address;
}

export interface AmmSwapAccounts {
  pool: Address;
  user: Address;
  globalConfig: Address;
  baseMint: Address;
  quoteMint: Address;
  userBaseTokenAccount: Address;
  userQuoteTokenAccount: Address;
  poolBaseTokenAccount: Address;
  poolQuoteTokenAccount: Address;
  protocolFeeRecipient: Address;
  protocolFeeRecipientTokenAccount: Address;
  baseTokenProgram: Address;
  quoteTokenProgram: Address;
  systemProgram: Address;
  associatedTokenProgram: Address;
  eventAuthority: Address;
  program: Address;
  coinCreatorVaultAta: Address;
  coinCreatorVaultAuthority: Address;
  globalVolumeAccumulator: Address;
  userVolumeAccumulator: Address;
  feeConfig: Address;
  feeProgram: Address;
  // remaining-account inputs
  poolV2: Address;
  buybackFeeRecipient: Address;
  buybackFeeRecipientTokenAccount: Address;
  userVolumeAccumulatorQuoteAta: Address;
}

export async function resolveAmmSwapAccounts(ctx: AmmTradeContext): Promise<AmmSwapAccounts> {
  const s = await getStaticPdas();
  const { pool } = ctx;
  const quoteTokenProgram = ctx.quoteTokenProgram ?? TOKEN_PROGRAM_ID;
  const protocolFeeRecipient = ctx.protocolFeeRecipient ?? pickAmmProtocolFeeRecipient(pool.isMayhemMode, ctx.globalConfig);
  const buybackFeeRecipient = ctx.buybackFeeRecipient ?? pickBuybackFeeRecipient(ctx.globalConfig?.buybackFeeRecipients);
  const qAta = (owner: Address) => findAssociatedTokenAddress(owner, pool.quoteMint, quoteTokenProgram);
  const [coinCreatorVaultAuthority, userVolumeAccumulator, poolV2] = await Promise.all([
    coinCreatorVaultAuthorityPda(pool.coinCreator),
    ammUserVolumeAccumulatorPda(ctx.user),
    poolV2Pda(pool.baseMint),
  ]);
  const [
    userBaseTokenAccount,
    userQuoteTokenAccount,
    protocolFeeRecipientTokenAccount,
    coinCreatorVaultAta,
    buybackFeeRecipientTokenAccount,
    userVolumeAccumulatorQuoteAta,
  ] = await Promise.all([
    findAssociatedTokenAddress(ctx.user, pool.baseMint, ctx.baseTokenProgram),
    qAta(ctx.user),
    qAta(protocolFeeRecipient),
    qAta(coinCreatorVaultAuthority),
    qAta(buybackFeeRecipient),
    qAta(userVolumeAccumulator),
  ]);
  return {
    pool: ctx.poolAddress,
    user: ctx.user,
    globalConfig: s.globalConfig,
    baseMint: pool.baseMint,
    quoteMint: pool.quoteMint,
    userBaseTokenAccount,
    userQuoteTokenAccount,
    poolBaseTokenAccount: pool.poolBaseTokenAccount,
    poolQuoteTokenAccount: pool.poolQuoteTokenAccount,
    protocolFeeRecipient,
    protocolFeeRecipientTokenAccount,
    baseTokenProgram: ctx.baseTokenProgram,
    quoteTokenProgram,
    systemProgram: SYSTEM_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    eventAuthority: s.eventAuthority,
    program: PUMP_AMM_PROGRAM_ID,
    coinCreatorVaultAta,
    coinCreatorVaultAuthority,
    globalVolumeAccumulator: s.gva,
    userVolumeAccumulator,
    feeConfig: s.feeConfig,
    feeProgram: PUMP_FEE_PROGRAM_ID,
    poolV2,
    buybackFeeRecipient,
    buybackFeeRecipientTokenAccount,
    userVolumeAccumulatorQuoteAta,
  };
}

/** Full ordered account list (IDL accounts + remaining accounts) for buy / buy_exact_quote_in / sell. */
export function ammSwapAccountMetas(
  a: AmmSwapAccounts,
  pool: Pick<Pool, "coinCreator" | "isCashbackCoin">,
  kind: "buy" | "sell",
): AccountMeta[] {
  const metas: AccountMeta[] = [
    w(a.pool),
    ws(a.user),
    ro(a.globalConfig),
    ro(a.baseMint),
    ro(a.quoteMint),
    w(a.userBaseTokenAccount),
    w(a.userQuoteTokenAccount),
    w(a.poolBaseTokenAccount),
    w(a.poolQuoteTokenAccount),
    ro(a.protocolFeeRecipient),
    w(a.protocolFeeRecipientTokenAccount),
    ro(a.baseTokenProgram),
    ro(a.quoteTokenProgram),
    ro(a.systemProgram),
    ro(a.associatedTokenProgram),
    ro(a.eventAuthority),
    ro(a.program),
    w(a.coinCreatorVaultAta),
    ro(a.coinCreatorVaultAuthority),
  ];
  if (kind === "buy") metas.push(ro(a.globalVolumeAccumulator), w(a.userVolumeAccumulator));
  metas.push(ro(a.feeConfig), ro(a.feeProgram));
  // remaining accounts
  if (pool.isCashbackCoin) {
    metas.push(w(a.userVolumeAccumulatorQuoteAta));
    if (kind === "sell") metas.push(w(a.userVolumeAccumulator));
  }
  if (pool.coinCreator !== DEFAULT_PUBKEY) metas.push(ro(a.poolV2));
  metas.push(ro(a.buybackFeeRecipient), w(a.buybackFeeRecipientTokenAccount));
  return metas;
}

/** OptionBool is a 1-byte struct; the SDK always sends track_volume = true. */
const TRACK_VOLUME = u8(1);

export function ammBuyInstruction(
  a: AmmSwapAccounts,
  pool: Pick<Pool, "coinCreator" | "isCashbackCoin">,
  baseAmountOut: bigint,
  maxQuoteAmountIn: bigint,
): Instruction {
  return {
    programAddress: PUMP_AMM_PROGRAM_ID,
    accounts: ammSwapAccountMetas(a, pool, "buy"),
    data: concatBytes(PUMP_AMM_IX.buy, u64le(baseAmountOut), u64le(maxQuoteAmountIn), TRACK_VOLUME),
  };
}

export function ammBuyExactQuoteInInstruction(
  a: AmmSwapAccounts,
  pool: Pick<Pool, "coinCreator" | "isCashbackCoin">,
  spendableQuoteIn: bigint,
  minBaseAmountOut: bigint,
): Instruction {
  return {
    programAddress: PUMP_AMM_PROGRAM_ID,
    accounts: ammSwapAccountMetas(a, pool, "buy"),
    data: concatBytes(PUMP_AMM_IX.buyExactQuoteIn, u64le(spendableQuoteIn), u64le(minBaseAmountOut), TRACK_VOLUME),
  };
}

export function ammSellInstruction(
  a: AmmSwapAccounts,
  pool: Pick<Pool, "coinCreator" | "isCashbackCoin">,
  baseAmountIn: bigint,
  minQuoteAmountOut: bigint,
): Instruction {
  return {
    programAddress: PUMP_AMM_PROGRAM_ID,
    accounts: ammSwapAccountMetas(a, pool, "sell"),
    data: concatBytes(PUMP_AMM_IX.sell, u64le(baseAmountIn), u64le(minQuoteAmountOut)),
  };
}

/** extend_account for pools shorter than POOL_ACCOUNT_NEW_SIZE (SDK withFixPoolInstructions). */
export async function ammExtendAccountInstruction(account: Address, user: Address): Promise<Instruction> {
  const s = await getStaticPdas();
  return {
    programAddress: PUMP_AMM_PROGRAM_ID,
    accounts: [w(account), ws(user), ro(SYSTEM_PROGRAM_ID), ro(s.eventAuthority), ro(PUMP_AMM_PROGRAM_ID)],
    data: PUMP_AMM_IX.extendAccount,
  };
}

async function maybeExtend(ctx: AmmTradeContext): Promise<Instruction[]> {
  return ctx.pool.dataLength < POOL_ACCOUNT_NEW_SIZE ? [await ammExtendAccountInstruction(ctx.poolAddress, ctx.user)] : [];
}

/**
 * Buy on PumpSwap. For wSOL-quoted pools: create wSOL ATA (idempotent), fund it with the max quote
 * spend, SyncNative, create base ATA (idempotent), swap, close wSOL ATA (unwraps the remainder).
 *   mode "exactQuoteIn": spend `amount` (fees included) for >= `limit` base.
 *   mode "exactBase":    receive `amount` base for <= `limit` quote.
 */
export async function buildAmmBuyInstructions(
  ctx: AmmTradeContext,
  order: { mode: "exactQuoteIn" | "exactBase"; amount: bigint; limit: bigint },
): Promise<{ instructions: Instruction[]; accounts: AmmSwapAccounts }> {
  const a = await resolveAmmSwapAccounts(ctx);
  const wrapLamports = order.mode === "exactQuoteIn" ? order.amount : order.limit;
  const isWsol = ctx.pool.quoteMint === WSOL_MINT;
  const ixs: Instruction[] = [...(await maybeExtend(ctx))];
  if (isWsol) {
    ixs.push(
      createAtaIdempotentInstruction({
        payer: ctx.user,
        ata: a.userQuoteTokenAccount,
        owner: ctx.user,
        mint: WSOL_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
      }),
      systemTransferInstruction({ from: ctx.user, to: a.userQuoteTokenAccount, lamports: wrapLamports }),
      syncNativeInstruction(a.userQuoteTokenAccount),
    );
  }
  ixs.push(
    createAtaIdempotentInstruction({
      payer: ctx.user,
      ata: a.userBaseTokenAccount,
      owner: ctx.user,
      mint: ctx.pool.baseMint,
      tokenProgram: ctx.baseTokenProgram,
    }),
    order.mode === "exactQuoteIn"
      ? ammBuyExactQuoteInInstruction(a, ctx.pool, order.amount, order.limit)
      : ammBuyInstruction(a, ctx.pool, order.amount, order.limit),
  );
  if (isWsol) ixs.push(closeAccountInstruction({ account: a.userQuoteTokenAccount, destination: ctx.user, owner: ctx.user }));
  return { instructions: ixs, accounts: a };
}

/**
 * Sell on PumpSwap. For wSOL-quoted pools the proceeds land in a temporary wSOL ATA (created
 * idempotently) that is closed afterwards to unwrap to native SOL.
 * `closeBaseAccount` appends CloseAccount on the base ATA for full exits (rent reclaim; Token-2022
 * accounts can only be closed at zero balance).
 */
export async function buildAmmSellInstructions(
  ctx: AmmTradeContext,
  order: { baseAmountIn: bigint; minQuoteOut: bigint; closeBaseAccount?: boolean },
): Promise<{ instructions: Instruction[]; accounts: AmmSwapAccounts }> {
  const a = await resolveAmmSwapAccounts(ctx);
  const quoteTokenProgram = ctx.quoteTokenProgram ?? TOKEN_PROGRAM_ID;
  const isWsol = ctx.pool.quoteMint === WSOL_MINT;
  const ixs: Instruction[] = [
    ...(await maybeExtend(ctx)),
    createAtaIdempotentInstruction({
      payer: ctx.user,
      ata: a.userQuoteTokenAccount,
      owner: ctx.user,
      mint: ctx.pool.quoteMint,
      tokenProgram: quoteTokenProgram,
    }),
    ammSellInstruction(a, ctx.pool, order.baseAmountIn, order.minQuoteOut),
  ];
  if (isWsol) ixs.push(closeAccountInstruction({ account: a.userQuoteTokenAccount, destination: ctx.user, owner: ctx.user }));
  if (order.closeBaseAccount) {
    ixs.push(
      closeAccountInstruction({
        account: a.userBaseTokenAccount,
        destination: ctx.user,
        owner: ctx.user,
        tokenProgram: ctx.baseTokenProgram,
      }),
    );
  }
  return { instructions: ixs, accounts: a };
}
