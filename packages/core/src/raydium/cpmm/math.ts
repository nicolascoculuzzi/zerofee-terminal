/**
 * Raydium CPMM swap math (pure bigint), ported from the PROGRAM source rather than the SDK:
 *   https://github.com/raydium-io/raydium-cp-swap/blob/b3187ae53a1b95a201f855a59024a12ca8f5b51a/programs/cp-swap/src/curve/calculator.rs
 *   https://github.com/raydium-io/raydium-cp-swap/blob/b3187ae53a1b95a201f855a59024a12ca8f5b51a/programs/cp-swap/src/curve/fees.rs
 *   https://github.com/raydium-io/raydium-cp-swap/blob/b3187ae53a1b95a201f855a59024a12ca8f5b51a/programs/cp-swap/src/states/pool.rs
 *
 * The SDK (0.2.73-alpha) still charges the creator fee on input as a separate ceil
 * (ceil(in*trade) + ceil(in*creator)); the program has used one combined ceil split by rate since the
 * 2025-11-04 audit fix, and mainnet agrees with the program: tx j6GMrm… has creator_fee 2,234,146
 * where the SDK formula gives 2,234,147. Everything here was replayed to the unit against mainnet
 * SwapEvents (test/raydium-cpmm.test.ts).
 *
 * Reserves are the vault balances minus the protocol, fund and creator fees still owed (the
 * SwapEvent's `*_vault_before`). Token-2022 transfer fees are taken on the user->vault leg before the
 * curve (`actual_amount_in`) and on the vault->user leg after it (`amount_received`).
 */
import type { Address } from "@solana/kit";
import { CPMM_CREATOR_FEE_ON, RAYDIUM_FEE_RATE_DENOMINATOR } from "../../constants";
import { type TransferFeeConfig, transferFeeFor, transferInverseFeeFor } from "../../token2022";
import { ceilDiv } from "../../util/math";
import { type CpmmAmmConfig, type CpmmPool, isCpmmSwapEnabled } from "./accounts";

export interface CpmmFeeRates {
  tradeFeeRate: bigint;
  protocolFeeRate: bigint;
  fundFeeRate: bigint;
  /** AmmConfig.creator_fee_rate if PoolState.enable_creator_fee, else 0 (adjust_creator_fee_rate). */
  creatorFeeRate: bigint;
}

export function cpmmFeeRates(
  config: Pick<CpmmAmmConfig, "tradeFeeRate" | "protocolFeeRate" | "fundFeeRate" | "creatorFeeRate">,
  pool: Pick<CpmmPool, "enableCreatorFee">,
): CpmmFeeRates {
  return {
    tradeFeeRate: config.tradeFeeRate,
    protocolFeeRate: config.protocolFeeRate,
    fundFeeRate: config.fundFeeRate,
    creatorFeeRate: pool.enableCreatorFee ? config.creatorFeeRate : 0n,
  };
}

export type CpmmTradeDirection = "zeroForOne" | "oneForZero";

/** PoolState::is_creator_fee_on_input. */
export function cpmmIsCreatorFeeOnInput(creatorFeeOn: number, direction: CpmmTradeDirection): boolean {
  switch (creatorFeeOn) {
    case CPMM_CREATOR_FEE_ON.bothToken:
      return true;
    case CPMM_CREATOR_FEE_ON.onlyToken0:
      return direction === "zeroForOne";
    case CPMM_CREATOR_FEE_ON.onlyToken1:
      return direction === "oneForZero";
    default:
      throw new Error(`invalid CPMM creator_fee_on ${creatorFeeOn} (InvalidFeeModel)`);
  }
}

const D = RAYDIUM_FEE_RATE_DENOMINATOR;
/** Fees::trading_fee / creator_fee: ceil(amount * rate / 1e6). */
const ceilFee = (amount: bigint, rate: bigint) => ceilDiv(amount * rate, D);
/** Fees::protocol_fee / fund_fee: floor(amount * rate / 1e6). */
const floorFee = (amount: bigint, rate: bigint) => (amount * rate) / D;

/** Fees::split_creator_fee: floor(total * creator / (trade + creator)). */
export function cpmmSplitCreatorFee(totalFee: bigint, tradeFeeRate: bigint, creatorFeeRate: bigint): bigint {
  const denom = tradeFeeRate + creatorFeeRate;
  if (denom === 0n) throw new Error("split_creator_fee with zero rates (ZeroTradingTokens)");
  return (totalFee * creatorFeeRate) / denom;
}

/** Fees::calculate_pre_fee_amount: ceil(post * 1e6 / (1e6 - rate)). */
export function cpmmPreFeeAmount(postFeeAmount: bigint, rate: bigint): bigint {
  if (rate === 0n) return postFeeAmount;
  return ceilDiv(postFeeAmount * D, D - rate);
}

/** calculator.rs SwapResult. */
export interface CpmmSwapResult {
  newInputVaultAmount: bigint;
  newOutputVaultAmount: bigint;
  /** Input including trade/creator fees, excluding transfer fees. */
  inputAmount: bigint;
  /** Output sent by the vault, including any output transfer fee. */
  outputAmount: bigint;
  /** Fee kept in input tokens (LP + protocol + fund parts). */
  tradeFee: bigint;
  protocolFee: bigint;
  fundFee: bigint;
  /** In input tokens when on input, else in output tokens. */
  creatorFee: bigint;
}

/** CurveCalculator::swap_base_input. */
export function cpmmSwapBaseInput(
  inputAmount: bigint,
  inputVaultAmount: bigint,
  outputVaultAmount: bigint,
  rates: CpmmFeeRates,
  isCreatorFeeOnInput: boolean,
): CpmmSwapResult {
  let creatorFee = 0n;
  let tradeFee: bigint;
  let inputLessFees: bigint;
  if (isCreatorFeeOnInput) {
    const totalFee = ceilFee(inputAmount, rates.tradeFeeRate + rates.creatorFeeRate);
    creatorFee = cpmmSplitCreatorFee(totalFee, rates.tradeFeeRate, rates.creatorFeeRate);
    tradeFee = totalFee - creatorFee;
    inputLessFees = inputAmount - totalFee;
  } else {
    tradeFee = ceilFee(inputAmount, rates.tradeFeeRate);
    inputLessFees = inputAmount - tradeFee;
  }
  if (inputLessFees < 0n) throw new RangeError("fees exceed the input");
  const protocolFee = floorFee(tradeFee, rates.protocolFeeRate);
  const fundFee = floorFee(tradeFee, rates.fundFeeRate);
  // ConstantProductCurve::swap_base_input_without_fees
  const swapped = (inputLessFees * outputVaultAmount) / (inputVaultAmount + inputLessFees);
  let outputAmount = swapped;
  if (!isCreatorFeeOnInput) {
    creatorFee = ceilFee(swapped, rates.creatorFeeRate);
    outputAmount = swapped - creatorFee;
    if (outputAmount < 0n) throw new RangeError("creator fee exceeds the output");
  }
  return {
    newInputVaultAmount: inputVaultAmount + inputLessFees,
    newOutputVaultAmount: outputVaultAmount - swapped,
    inputAmount,
    outputAmount,
    tradeFee,
    protocolFee,
    fundFee,
    creatorFee,
  };
}

/** CurveCalculator::swap_base_output (`outputAmount` includes any output transfer fee). */
export function cpmmSwapBaseOutput(
  outputAmount: bigint,
  inputVaultAmount: bigint,
  outputVaultAmount: bigint,
  rates: CpmmFeeRates,
  isCreatorFeeOnInput: boolean,
): CpmmSwapResult {
  let creatorFee = 0n;
  let actualOutput = outputAmount;
  if (!isCreatorFeeOnInput) {
    actualOutput = cpmmPreFeeAmount(outputAmount, rates.creatorFeeRate);
    creatorFee = actualOutput - outputAmount;
  }
  if (actualOutput >= outputVaultAmount) throw new RangeError("output exceeds the pool's reserve");
  // ConstantProductCurve::swap_base_output_without_fees (checked_ceil_div)
  const swapped = ceilDiv(inputVaultAmount * actualOutput, outputVaultAmount - actualOutput);
  let tradeFee: bigint;
  let inputAmount: bigint;
  if (isCreatorFeeOnInput) {
    inputAmount = cpmmPreFeeAmount(swapped, rates.tradeFeeRate + rates.creatorFeeRate);
    const totalFee = inputAmount - swapped;
    creatorFee = cpmmSplitCreatorFee(totalFee, rates.tradeFeeRate, rates.creatorFeeRate);
    tradeFee = totalFee - creatorFee;
  } else {
    inputAmount = cpmmPreFeeAmount(swapped, rates.tradeFeeRate);
    tradeFee = inputAmount - swapped;
  }
  return {
    newInputVaultAmount: inputVaultAmount + swapped,
    newOutputVaultAmount: outputVaultAmount - actualOutput,
    inputAmount,
    outputAmount,
    tradeFee,
    protocolFee: floorFee(tradeFee, rates.protocolFeeRate),
    fundFee: floorFee(tradeFee, rates.fundFeeRate),
    creatorFee,
  };
}

/** PoolState::vault_amount_without_fee: vault balances minus protocol + fund + creator fees owed. */
export function cpmmVaultAmountsWithoutFees(
  pool: Pick<
    CpmmPool,
    "protocolFeesToken0" | "protocolFeesToken1" | "fundFeesToken0" | "fundFeesToken1" | "creatorFeesToken0" | "creatorFeesToken1"
  >,
  vault0Amount: bigint,
  vault1Amount: bigint,
): { token0: bigint; token1: bigint } {
  const token0 = vault0Amount - pool.protocolFeesToken0 - pool.fundFeesToken0 - pool.creatorFeesToken0;
  const token1 = vault1Amount - pool.protocolFeesToken1 - pool.fundFeesToken1 - pool.creatorFeesToken1;
  if (token0 < 0n || token1 < 0n) throw new RangeError("vault below fees owed (InsufficientVault)");
  return { token0, token1 };
}

export type CpmmPoolState = Pick<
  CpmmPool,
  | "token0Mint"
  | "token1Mint"
  | "status"
  | "openTime"
  | "creatorFeeOn"
  | "protocolFeesToken0"
  | "protocolFeesToken1"
  | "fundFeesToken0"
  | "fundFeesToken1"
  | "creatorFeesToken0"
  | "creatorFeesToken1"
>;

export interface CpmmQuoteArgs {
  pool: CpmmPoolState;
  /** Raw vault token-account balances. */
  vault0Amount: bigint;
  vault1Amount: bigint;
  inputMint: Address;
  rates: CpmmFeeRates;
  /** Token-2022 transfer fees of the input/output mints and the current epoch. */
  transferFees?: { input?: TransferFeeConfig | null; output?: TransferFeeConfig | null; epoch: bigint };
  /** Current unix time; when given, quotes before `open_time` are refused like the program does. */
  unixTimestamp?: bigint;
}

export interface CpmmQuote extends CpmmSwapResult {
  direction: CpmmTradeDirection;
  isCreatorFeeOnInput: boolean;
  /** SwapEvent.input_vault_before / output_vault_before (net of fees owed). */
  inputVaultBefore: bigint;
  outputVaultBefore: bigint;
  /** What the user sends (instruction amount_in, or the minimum max_amount_in for base output). */
  amountIn: bigint;
  inputTransferFee: bigint;
  outputTransferFee: bigint;
  /** What the user receives (checked against minimum_amount_out / equal to amount_out). */
  amountReceived: bigint;
  /** Part of the trade fee left to LPs: trade - protocol - fund. */
  lpFee: bigint;
}

function prepare(args: CpmmQuoteArgs) {
  const { pool } = args;
  if (!isCpmmSwapEnabled(pool)) throw new Error("CPMM pool has swaps disabled (NotApproved)");
  if (args.unixTimestamp !== undefined && args.unixTimestamp < pool.openTime) {
    throw new Error(`CPMM pool opens at ${pool.openTime} (now ${args.unixTimestamp}) (NotApproved)`);
  }
  let direction: CpmmTradeDirection;
  if (args.inputMint === pool.token0Mint) direction = "zeroForOne";
  else if (args.inputMint === pool.token1Mint) direction = "oneForZero";
  else throw new Error(`${args.inputMint} is not in this CPMM pool`);
  const net = cpmmVaultAmountsWithoutFees(pool, args.vault0Amount, args.vault1Amount);
  const [inputVaultBefore, outputVaultBefore] = direction === "zeroForOne" ? [net.token0, net.token1] : [net.token1, net.token0];
  return { direction, inputVaultBefore, outputVaultBefore, isCreatorFeeOnInput: cpmmIsCreatorFeeOnInput(pool.creatorFeeOn, direction) };
}

/** `swap_base_input(amount_in, minimum_amount_out)`: what `amountIn` of the input mint buys. */
export function quoteCpmmSwapBaseInput(args: CpmmQuoteArgs & { amountIn: bigint }): CpmmQuote {
  if (args.amountIn <= 0n) throw new RangeError("amountIn must be > 0");
  const p = prepare(args);
  const epoch = args.transferFees?.epoch ?? 0n;
  const inputTransferFee = transferFeeFor(args.transferFees?.input, epoch, args.amountIn);
  const actualAmountIn = args.amountIn - inputTransferFee;
  if (actualAmountIn <= 0n) throw new RangeError("input is consumed by the transfer fee");
  const r = cpmmSwapBaseInput(actualAmountIn, p.inputVaultBefore, p.outputVaultBefore, args.rates, p.isCreatorFeeOnInput);
  const outputTransferFee = transferFeeFor(args.transferFees?.output, epoch, r.outputAmount);
  const amountReceived = r.outputAmount - outputTransferFee;
  if (amountReceived <= 0n) throw new RangeError("swap too small: zero output");
  return {
    ...r,
    ...p,
    amountIn: args.amountIn,
    inputTransferFee,
    outputTransferFee,
    amountReceived,
    lpFee: r.tradeFee - r.protocolFee - r.fundFee,
  };
}

/** `swap_base_output(max_amount_in, amount_out)`: input needed so the user receives `amountOut`. */
export function quoteCpmmSwapBaseOutput(args: CpmmQuoteArgs & { amountOut: bigint }): CpmmQuote {
  if (args.amountOut <= 0n) throw new RangeError("amountOut must be > 0");
  const p = prepare(args);
  const epoch = args.transferFees?.epoch ?? 0n;
  const outputTransferFee = transferInverseFeeFor(args.transferFees?.output, epoch, args.amountOut);
  const r = cpmmSwapBaseOutput(
    args.amountOut + outputTransferFee,
    p.inputVaultBefore,
    p.outputVaultBefore,
    args.rates,
    p.isCreatorFeeOnInput,
  );
  const inputTransferFee = transferInverseFeeFor(args.transferFees?.input, epoch, r.inputAmount);
  return {
    ...r,
    ...p,
    amountIn: r.inputAmount + inputTransferFee,
    inputTransferFee,
    outputTransferFee,
    amountReceived: args.amountOut,
    lpFee: r.tradeFee - r.protocolFee - r.fundFee,
  };
}

/** Display-only price of `baseMint` in the other token's UI units, from fee-net reserves. */
export function cpmmSpotPrice(
  args: Pick<CpmmQuoteArgs, "pool" | "vault0Amount" | "vault1Amount"> & { baseMint: Address; decimals0: number; decimals1: number },
): number {
  const net = cpmmVaultAmountsWithoutFees(args.pool, args.vault0Amount, args.vault1Amount);
  const ui0 = Number(net.token0) / 10 ** args.decimals0;
  const ui1 = Number(net.token1) / 10 ** args.decimals1;
  if (args.baseMint === args.pool.token0Mint) return ui0 === 0 ? 0 : ui1 / ui0;
  return ui1 === 0 ? 0 : ui0 / ui1;
}
