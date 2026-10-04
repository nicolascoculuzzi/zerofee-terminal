/**
 * pump.fun bonding-curve instruction builders for the unified v2 interface (SOL and USDC pairs):
 * buy_v2 / sell_v2 / buy_exact_quote_in_v2. Account lists follow the IDL exactly:
 *   https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/BUY.md
 *   https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/SELL.md
 *   https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json
 *
 * For SOL coins the associated_quote_* / associated_creator_vault / associated_user_volume_accumulator
 * accounts are only seed-constrained and need not exist (README). The base token program must be
 * the one that owns the mint (Token-2022 for create_v2 coins).
 */
import { type AccountMeta, AccountRole, type Address, type Instruction } from "@solana/kit";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  BUYBACK_FEE_RECIPIENTS,
  EXPECTED_ACCOUNT_COUNTS,
  MAYHEM_FEE_RECIPIENTS,
  PUMP_FEE_PROGRAM_ID,
  PUMP_FEE_RECIPIENTS,
  PUMP_IX,
  PUMP_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from "../constants";
import { closeAccountInstruction, createAtaIdempotentInstruction, findAssociatedTokenAddress } from "../token";
import { concatBytes, u64le } from "../util/bytes";
import { pickRandom } from "../util/random";
import {
  type BondingCurve,
  bondingCurvePda,
  creatorVaultPda,
  curveQuoteMint,
  globalFeeRecipients,
  globalMayhemFeeRecipients,
  type PumpGlobal,
  pumpEventAuthorityPda,
  pumpFeeConfigPda,
  pumpGlobalPda,
  pumpGlobalVolumeAccumulatorPda,
  pumpUserVolumeAccumulatorPda,
  sharingConfigPda,
} from "./accounts";

// Static PDAs are derived once per process (pure functions of the program ID).
let staticPdas: Promise<{ global: Address; eventAuthority: Address; gva: Address; feeConfig: Address }> | undefined;
function getStaticPdas() {
  staticPdas ??= Promise.all([pumpGlobalPda(), pumpEventAuthorityPda(), pumpGlobalVolumeAccumulatorPda(), pumpFeeConfigPda()]).then(
    ([global, eventAuthority, gva, feeConfig]) => ({ global, eventAuthority, gva, feeConfig }),
  );
  return staticPdas;
}

const ro = (address: Address): AccountMeta => ({ address, role: AccountRole.READONLY });
const w = (address: Address): AccountMeta => ({ address, role: AccountRole.WRITABLE });
const ws = (address: Address): AccountMeta => ({ address, role: AccountRole.WRITABLE_SIGNER });

/** Picks a fee recipient: reserved list for mayhem coins, normal list otherwise (live Global preferred). */
export function pickPumpFeeRecipient(isMayhemMode: boolean, global?: PumpGlobal | null): Address {
  if (isMayhemMode) {
    const live = global ? globalMayhemFeeRecipients(global) : [];
    return pickRandom(live.length ? live : MAYHEM_FEE_RECIPIENTS);
  }
  const live = global ? globalFeeRecipients(global) : [];
  return pickRandom(live.length ? live : PUMP_FEE_RECIPIENTS);
}

export function pickBuybackFeeRecipient(liveList?: readonly Address[] | null): Address {
  const live = (liveList ?? []).filter((a) => a !== SYSTEM_PROGRAM_ID);
  return pickRandom(live.length ? live : BUYBACK_FEE_RECIPIENTS);
}

export interface PumpV2AccountsParams {
  mint: Address;
  /** Owner program of the base mint (Token-2022 for create_v2 coins, SPL Token for legacy create). */
  baseTokenProgram: Address;
  /** wSOL for SOL coins (see curveQuoteMint), else the curve's quote mint. */
  quoteMint: Address;
  /** Owner program of the quote mint (SPL Token for wSOL / USDC). */
  quoteTokenProgram: Address;
  user: Address;
  /** LIVE bonding_curve.creator. */
  creator: Address;
  feeRecipient: Address;
  buybackFeeRecipient: Address;
}

export interface PumpV2Accounts {
  global: Address;
  baseMint: Address;
  quoteMint: Address;
  baseTokenProgram: Address;
  quoteTokenProgram: Address;
  associatedTokenProgram: Address;
  feeRecipient: Address;
  associatedQuoteFeeRecipient: Address;
  buybackFeeRecipient: Address;
  associatedQuoteBuybackFeeRecipient: Address;
  bondingCurve: Address;
  associatedBaseBondingCurve: Address;
  associatedQuoteBondingCurve: Address;
  user: Address;
  associatedBaseUser: Address;
  associatedQuoteUser: Address;
  creatorVault: Address;
  associatedCreatorVault: Address;
  sharingConfig: Address;
  globalVolumeAccumulator: Address;
  userVolumeAccumulator: Address;
  associatedUserVolumeAccumulator: Address;
  feeConfig: Address;
  feeProgram: Address;
  systemProgram: Address;
  eventAuthority: Address;
  program: Address;
}

/** Resolves every named account of the v2 instructions (all PDAs derived in parallel). */
export async function resolvePumpV2Accounts(p: PumpV2AccountsParams): Promise<PumpV2Accounts> {
  const s = await getStaticPdas();
  const [bondingCurve, creatorVault, userVolumeAccumulator, sharingConfig] = await Promise.all([
    bondingCurvePda(p.mint),
    creatorVaultPda(p.creator),
    pumpUserVolumeAccumulatorPda(p.user),
    sharingConfigPda(p.mint),
  ]);
  const qAta = (owner: Address) => findAssociatedTokenAddress(owner, p.quoteMint, p.quoteTokenProgram);
  const [
    associatedQuoteFeeRecipient,
    associatedQuoteBuybackFeeRecipient,
    associatedBaseBondingCurve,
    associatedQuoteBondingCurve,
    associatedBaseUser,
    associatedQuoteUser,
    associatedCreatorVault,
    associatedUserVolumeAccumulator,
  ] = await Promise.all([
    qAta(p.feeRecipient),
    qAta(p.buybackFeeRecipient),
    findAssociatedTokenAddress(bondingCurve, p.mint, p.baseTokenProgram),
    qAta(bondingCurve),
    findAssociatedTokenAddress(p.user, p.mint, p.baseTokenProgram),
    qAta(p.user),
    qAta(creatorVault),
    qAta(userVolumeAccumulator),
  ]);
  return {
    global: s.global,
    baseMint: p.mint,
    quoteMint: p.quoteMint,
    baseTokenProgram: p.baseTokenProgram,
    quoteTokenProgram: p.quoteTokenProgram,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    feeRecipient: p.feeRecipient,
    associatedQuoteFeeRecipient,
    buybackFeeRecipient: p.buybackFeeRecipient,
    associatedQuoteBuybackFeeRecipient,
    bondingCurve,
    associatedBaseBondingCurve,
    associatedQuoteBondingCurve,
    user: p.user,
    associatedBaseUser,
    associatedQuoteUser,
    creatorVault,
    associatedCreatorVault,
    sharingConfig,
    globalVolumeAccumulator: s.gva,
    userVolumeAccumulator,
    associatedUserVolumeAccumulator,
    feeConfig: s.feeConfig,
    feeProgram: PUMP_FEE_PROGRAM_ID,
    systemProgram: SYSTEM_PROGRAM_ID,
    eventAuthority: s.eventAuthority,
    program: PUMP_PROGRAM_ID,
  };
}

/** Ordered metas for buy_v2 / buy_exact_quote_in_v2 (27) or sell_v2 (26: no global_volume_accumulator). */
export function pumpV2AccountMetas(a: PumpV2Accounts, kind: "buy" | "sell"): AccountMeta[] {
  const metas: AccountMeta[] = [
    ro(a.global), //                         1
    ro(a.baseMint), //                       2
    ro(a.quoteMint), //                      3
    ro(a.baseTokenProgram), //               4
    ro(a.quoteTokenProgram), //              5
    ro(a.associatedTokenProgram), //         6
    w(a.feeRecipient), //                    7
    w(a.associatedQuoteFeeRecipient), //     8
    w(a.buybackFeeRecipient), //             9
    w(a.associatedQuoteBuybackFeeRecipient), // 10
    w(a.bondingCurve), //                    11
    w(a.associatedBaseBondingCurve), //      12
    w(a.associatedQuoteBondingCurve), //     13
    ws(a.user), //                           14
    w(a.associatedBaseUser), //              15
    w(a.associatedQuoteUser), //             16
    w(a.creatorVault), //                    17
    w(a.associatedCreatorVault), //          18
    ro(a.sharingConfig), //                  19
  ];
  if (kind === "buy") metas.push(ro(a.globalVolumeAccumulator)); // 20 (buy only)
  metas.push(
    w(a.userVolumeAccumulator),
    w(a.associatedUserVolumeAccumulator),
    ro(a.feeConfig),
    ro(a.feeProgram),
    ro(a.systemProgram),
    ro(a.eventAuthority),
    ro(a.program),
  );
  const expected = kind === "buy" ? EXPECTED_ACCOUNT_COUNTS.pumpBuyV2 : EXPECTED_ACCOUNT_COUNTS.pumpSellV2;
  if (metas.length !== expected) throw new Error(`pump v2 ${kind}: expected ${expected} accounts, got ${metas.length}`);
  return metas;
}

function ix(data: Uint8Array, accounts: AccountMeta[]): Instruction {
  return { programAddress: PUMP_PROGRAM_ID, accounts, data };
}

/** buy_v2(amount, max_sol_cost): exact base out, quote cap includes fees. */
export function buyV2Instruction(a: PumpV2Accounts, amount: bigint, maxQuoteCost: bigint): Instruction {
  return ix(concatBytes(PUMP_IX.buyV2, u64le(amount), u64le(maxQuoteCost)), pumpV2AccountMetas(a, "buy"));
}

/** buy_exact_quote_in_v2(spendable_quote_in, min_tokens_out): spend a fixed budget (fees included). */
export function buyExactQuoteInV2Instruction(a: PumpV2Accounts, spendableQuoteIn: bigint, minTokensOut: bigint): Instruction {
  return ix(concatBytes(PUMP_IX.buyExactQuoteInV2, u64le(spendableQuoteIn), u64le(minTokensOut)), pumpV2AccountMetas(a, "buy"));
}

/** sell_v2(amount, min_sol_output): min output is after fees. */
export function sellV2Instruction(a: PumpV2Accounts, amount: bigint, minQuoteOutput: bigint): Instruction {
  return ix(concatBytes(PUMP_IX.sellV2, u64le(amount), u64le(minQuoteOutput)), pumpV2AccountMetas(a, "sell"));
}

/** Everything needed to build a curve trade from cached state. */
export interface PumpTradeContext {
  mint: Address;
  baseTokenProgram: Address;
  /** Owner of the quote mint; SPL Token for wSOL/USDC. */
  quoteTokenProgram?: Address;
  user: Address;
  curve: Pick<BondingCurve, "creator" | "isMayhemMode" | "quoteMint">;
  global?: PumpGlobal | null;
  /** Override for deterministic builds/tests. */
  feeRecipient?: Address;
  buybackFeeRecipient?: Address;
}

export async function resolvePumpTradeAccounts(ctx: PumpTradeContext): Promise<PumpV2Accounts> {
  return resolvePumpV2Accounts({
    mint: ctx.mint,
    baseTokenProgram: ctx.baseTokenProgram,
    quoteMint: curveQuoteMint(ctx.curve),
    quoteTokenProgram: ctx.quoteTokenProgram ?? TOKEN_PROGRAM_ID,
    user: ctx.user,
    creator: ctx.curve.creator,
    feeRecipient: ctx.feeRecipient ?? pickPumpFeeRecipient(ctx.curve.isMayhemMode, ctx.global),
    buybackFeeRecipient: ctx.buybackFeeRecipient ?? pickBuybackFeeRecipient(ctx.global?.buybackFeeRecipients),
  });
}

/**
 * Instructions for a curve buy: idempotent base ATA creation (Token/Token-2022 aware) + the v2 buy.
 * `mode: "exactQuoteIn"` spends `amount` quote units (fees included) and requires >= `limit` tokens;
 * `mode: "exactTokens"` buys `amount` tokens paying at most `limit` quote units.
 */
export async function buildPumpBuyInstructions(
  ctx: PumpTradeContext,
  order: { mode: "exactQuoteIn" | "exactTokens"; amount: bigint; limit: bigint; createAta?: boolean },
): Promise<{ instructions: Instruction[]; accounts: PumpV2Accounts }> {
  const accounts = await resolvePumpTradeAccounts(ctx);
  const instructions: Instruction[] = [];
  if (order.createAta !== false) {
    instructions.push(
      createAtaIdempotentInstruction({
        payer: ctx.user,
        ata: accounts.associatedBaseUser,
        owner: ctx.user,
        mint: ctx.mint,
        tokenProgram: ctx.baseTokenProgram,
      }),
    );
  }
  instructions.push(
    order.mode === "exactQuoteIn"
      ? buyExactQuoteInV2Instruction(accounts, order.amount, order.limit)
      : buyV2Instruction(accounts, order.amount, order.limit),
  );
  return { instructions, accounts };
}

export async function buildPumpSellInstructions(
  ctx: PumpTradeContext,
  order: { amount: bigint; minQuoteOut: bigint; closeBaseAccount?: boolean },
): Promise<{ instructions: Instruction[]; accounts: PumpV2Accounts }> {
  const accounts = await resolvePumpTradeAccounts(ctx);
  const instructions: Instruction[] = [];
  // SOL coins settle in native SOL; non-SOL quotes (USDC) pay out to the user's quote ATA.
  if (accounts.quoteMint !== WSOL_MINT) {
    instructions.push(
      createAtaIdempotentInstruction({
        payer: ctx.user,
        ata: accounts.associatedQuoteUser,
        owner: ctx.user,
        mint: accounts.quoteMint,
        tokenProgram: accounts.quoteTokenProgram,
      }),
    );
  }
  instructions.push(sellV2Instruction(accounts, order.amount, order.minQuoteOut));
  if (order.closeBaseAccount) {
    // Full exit: reclaim the base ATA rent (Token-2022 accounts close only at zero balance).
    instructions.push(
      closeAccountInstruction({
        account: accounts.associatedBaseUser,
        destination: ctx.user,
        owner: ctx.user,
        tokenProgram: ctx.baseTokenProgram,
      }),
    );
  }
  return { instructions, accounts };
}
