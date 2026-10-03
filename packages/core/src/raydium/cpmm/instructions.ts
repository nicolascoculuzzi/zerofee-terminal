/**
 * Raydium CPMM swap_base_input / swap_base_output builders. Account order from the program's `Swap`
 * context (programs/cp-swap/src/instructions/swap_base_input.rs, b3187ae) and the SDK's
 * makeSwapCpmmBaseInInstruction (raydium-sdk-V2 cc33ec2 src/raydium/cpmm/instruction.ts):
 *
 *   0 payer (S, not writable in the ix)  1 authority  2 amm_config  3 pool_state (W)
 *   4 input_token_account (W)  5 output_token_account (W)  6 input_vault (W)  7 output_vault (W)
 *   8 input_token_program  9 output_token_program  10 input_token_mint  11 output_token_mint
 *   12 observation_state (W)
 *
 * Token programs come from the pool (token_0_program / token_1_program). wSOL legs are wrapped and
 * unwrapped around the swap like the PumpSwap builders.
 */
import { type AccountMeta, AccountRole, type Address, type Instruction } from "@solana/kit";
import { EXPECTED_ACCOUNT_COUNTS, RAYDIUM_CPMM_IX, RAYDIUM_CPMM_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from "../../constants";
import {
  closeAccountInstruction,
  createAtaIdempotentInstruction,
  findAssociatedTokenAddress,
  syncNativeInstruction,
  systemTransferInstruction,
} from "../../token";
import { concatBytes, u64le } from "../../util/bytes";
import { type CpmmPool, cpmmAuthorityPda } from "./accounts";

const ro = (address: Address): AccountMeta => ({ address, role: AccountRole.READONLY });
const w = (address: Address): AccountMeta => ({ address, role: AccountRole.WRITABLE });
const rs = (address: Address): AccountMeta => ({ address, role: AccountRole.READONLY_SIGNER });

let authority: Promise<Address> | undefined;
const getAuthority = () => {
  authority ??= cpmmAuthorityPda();
  return authority;
};

export type CpmmPoolKeys = Pick<
  CpmmPool,
  "ammConfig" | "token0Mint" | "token1Mint" | "token0Vault" | "token1Vault" | "token0Program" | "token1Program" | "observationKey"
>;

export interface CpmmTradeContext {
  poolAddress: Address;
  pool: CpmmPoolKeys;
  user: Address;
  /** Mint the user pays with; the other pool mint is received. */
  inputMint: Address;
  /** Default to the user's ATAs (the wSOL ATA for SOL legs). */
  userInputToken?: Address;
  userOutputToken?: Address;
}

export interface CpmmSwapAccounts {
  payer: Address;
  authority: Address;
  ammConfig: Address;
  poolState: Address;
  inputTokenAccount: Address;
  outputTokenAccount: Address;
  inputVault: Address;
  outputVault: Address;
  inputTokenProgram: Address;
  outputTokenProgram: Address;
  inputTokenMint: Address;
  outputTokenMint: Address;
  observationState: Address;
}

export async function resolveCpmmSwapAccounts(ctx: CpmmTradeContext): Promise<CpmmSwapAccounts> {
  const { pool } = ctx;
  let zeroForOne: boolean;
  if (ctx.inputMint === pool.token0Mint) zeroForOne = true;
  else if (ctx.inputMint === pool.token1Mint) zeroForOne = false;
  else throw new Error(`${ctx.inputMint} is not in this CPMM pool`);
  const [inputMint, outputMint] = zeroForOne ? [pool.token0Mint, pool.token1Mint] : [pool.token1Mint, pool.token0Mint];
  const [inputVault, outputVault] = zeroForOne ? [pool.token0Vault, pool.token1Vault] : [pool.token1Vault, pool.token0Vault];
  const [inputTokenProgram, outputTokenProgram] = zeroForOne
    ? [pool.token0Program, pool.token1Program]
    : [pool.token1Program, pool.token0Program];
  const [auth, inputTokenAccount, outputTokenAccount] = await Promise.all([
    getAuthority(),
    ctx.userInputToken ?? findAssociatedTokenAddress(ctx.user, inputMint, inputTokenProgram),
    ctx.userOutputToken ?? findAssociatedTokenAddress(ctx.user, outputMint, outputTokenProgram),
  ]);
  return {
    payer: ctx.user,
    authority: auth,
    ammConfig: pool.ammConfig,
    poolState: ctx.poolAddress,
    inputTokenAccount,
    outputTokenAccount,
    inputVault,
    outputVault,
    inputTokenProgram,
    outputTokenProgram,
    inputTokenMint: inputMint,
    outputTokenMint: outputMint,
    observationState: pool.observationKey,
  };
}

export function cpmmSwapAccountMetas(a: CpmmSwapAccounts): AccountMeta[] {
  const metas = [
    rs(a.payer),
    ro(a.authority),
    ro(a.ammConfig),
    w(a.poolState),
    w(a.inputTokenAccount),
    w(a.outputTokenAccount),
    w(a.inputVault),
    w(a.outputVault),
    ro(a.inputTokenProgram),
    ro(a.outputTokenProgram),
    ro(a.inputTokenMint),
    ro(a.outputTokenMint),
    w(a.observationState),
  ];
  if (metas.length !== EXPECTED_ACCOUNT_COUNTS.cpmmSwap) throw new Error("CPMM swap account count mismatch");
  return metas;
}

/** swap_base_input(amount_in, minimum_amount_out): `minimumAmountOut` is checked against what the user receives. */
export function cpmmSwapBaseInputInstruction(a: CpmmSwapAccounts, amountIn: bigint, minimumAmountOut: bigint): Instruction {
  return {
    programAddress: RAYDIUM_CPMM_PROGRAM_ID,
    accounts: cpmmSwapAccountMetas(a),
    data: concatBytes(RAYDIUM_CPMM_IX.swapBaseInput, u64le(amountIn), u64le(minimumAmountOut)),
  };
}

/** swap_base_output(max_amount_in, amount_out): note the argument order (max first). */
export function cpmmSwapBaseOutputInstruction(a: CpmmSwapAccounts, maxAmountIn: bigint, amountOut: bigint): Instruction {
  return {
    programAddress: RAYDIUM_CPMM_PROGRAM_ID,
    accounts: cpmmSwapAccountMetas(a),
    data: concatBytes(RAYDIUM_CPMM_IX.swapBaseOutput, u64le(maxAmountIn), u64le(amountOut)),
  };
}

/**
 * Swap on a CPMM pool with idempotent ATA creation for the output and wSOL wrap/unwrap.
 *   mode "baseInput":  send `amount` of the input mint, receive >= `limit`.
 *   mode "baseOutput": receive exactly `amount`, send <= `limit`.
 * `closeInputAccount` closes the (non-wSOL) input token account afterwards (full exits; the caller must
 * not set it for Token-2022 accounts holding withheld transfer fees).
 */
export async function buildCpmmSwapInstructions(
  ctx: CpmmTradeContext,
  order: { mode: "baseInput" | "baseOutput"; amount: bigint; limit: bigint; closeInputAccount?: boolean },
): Promise<{ instructions: Instruction[]; accounts: CpmmSwapAccounts }> {
  const a = await resolveCpmmSwapAccounts(ctx);
  const inputIsWsol = a.inputTokenMint === WSOL_MINT;
  const outputIsWsol = a.outputTokenMint === WSOL_MINT;
  const ixs: Instruction[] = [];
  if (inputIsWsol) {
    const lamports = order.mode === "baseInput" ? order.amount : order.limit;
    ixs.push(
      createAtaIdempotentInstruction({
        payer: ctx.user,
        ata: a.inputTokenAccount,
        owner: ctx.user,
        mint: WSOL_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
      }),
      systemTransferInstruction({ from: ctx.user, to: a.inputTokenAccount, lamports }),
      syncNativeInstruction(a.inputTokenAccount),
    );
  }
  ixs.push(
    createAtaIdempotentInstruction({
      payer: ctx.user,
      ata: a.outputTokenAccount,
      owner: ctx.user,
      mint: a.outputTokenMint,
      tokenProgram: a.outputTokenProgram,
    }),
    order.mode === "baseInput"
      ? cpmmSwapBaseInputInstruction(a, order.amount, order.limit)
      : cpmmSwapBaseOutputInstruction(a, order.limit, order.amount),
  );
  if (inputIsWsol) ixs.push(closeAccountInstruction({ account: a.inputTokenAccount, destination: ctx.user, owner: ctx.user }));
  if (outputIsWsol) ixs.push(closeAccountInstruction({ account: a.outputTokenAccount, destination: ctx.user, owner: ctx.user }));
  if (order.closeInputAccount && !inputIsWsol) {
    ixs.push(
      closeAccountInstruction({ account: a.inputTokenAccount, destination: ctx.user, owner: ctx.user, tokenProgram: a.inputTokenProgram }),
    );
  }
  return { instructions: ixs, accounts: a };
}
