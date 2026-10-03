/**
 * Compute Budget program instructions. The priority fee is
 * ceil(cu_price * cu_limit / 1e6) lamports, charged on the REQUESTED limit (https://solana.com/docs/core/fees),
 * so keep limits tight. Put these instructions first.
 */
import type { Instruction } from "@solana/kit";
import { COMPUTE_BUDGET_PROGRAM_ID, MAX_COMPUTE_UNIT_LIMIT, MICRO_LAMPORTS_PER_LAMPORT } from "../constants";
import { concatBytes, u8, u32le, u64le } from "../util/bytes";
import { ceilDiv } from "../util/math";

export function setComputeUnitLimitInstruction(units: number): Instruction {
  if (!Number.isInteger(units) || units <= 0 || units > MAX_COMPUTE_UNIT_LIMIT) {
    throw new RangeError(`compute unit limit out of range: ${units}`);
  }
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ID, data: concatBytes(u8(2), u32le(units)) };
}

export function setComputeUnitPriceInstruction(microLamports: bigint): Instruction {
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ID, data: concatBytes(u8(3), u64le(microLamports)) };
}

/** Optional: cap loaded account data (too small fails with MaxLoadedAccountsDataSizeExceeded - calibrate by simulation). */
export function setLoadedAccountsDataSizeLimitInstruction(bytes: number): Instruction {
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ID, data: concatBytes(u8(4), u32le(bytes)) };
}

/** Priority fee in lamports for a given price and limit. */
export function priorityFeeLamports(microLamportsPerCu: bigint, cuLimit: number): bigint {
  return ceilDiv(microLamportsPerCu * BigInt(cuLimit), MICRO_LAMPORTS_PER_LAMPORT);
}
