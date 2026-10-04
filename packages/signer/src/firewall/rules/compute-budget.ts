/**
 * Compute Budget program. Allowed: SetComputeUnitLimit (<= cap), SetComputeUnitPrice (priority fee
 * <= cap), SetLoadedAccountsDataSizeLimit, RequestHeapFrame; each at most once (the runtime rejects
 * duplicates too). Everything else, including the deprecated RequestUnits, is refused.
 * Layout: u8 discriminator + LE argument. https://github.com/solana-program/compute-budget
 *
 * priority fee (lamports) = ceil(micro_lamports_per_cu * cu_limit / 1_000_000), charged on the
 * requested limit. Without an explicit limit we assume the maximum (1.4M CU): conservative.
 */
import { readU32LE, readU64LE } from "../../bytes";
import { MAX_COMPUTE_UNIT_LIMIT } from "../programs";
import type { DecodedInstruction, FirewallCaps } from "../types";
import { splitTrailingDontFront, where } from "./common";

const REQUEST_HEAP_FRAME = 1;
const SET_COMPUTE_UNIT_LIMIT = 2;
const SET_COMPUTE_UNIT_PRICE = 3;
const SET_LOADED_ACCOUNTS_DATA_SIZE_LIMIT = 4;

const NAMES: Readonly<Record<number, string>> = {
  0: "RequestUnits (deprecated)",
  [REQUEST_HEAP_FRAME]: "RequestHeapFrame",
  [SET_COMPUTE_UNIT_LIMIT]: "SetComputeUnitLimit",
  [SET_COMPUTE_UNIT_PRICE]: "SetComputeUnitPrice",
  [SET_LOADED_ACCOUNTS_DATA_SIZE_LIMIT]: "SetLoadedAccountsDataSizeLimit",
};

export interface ComputeBudgetOutcome {
  readonly violations: string[];
  readonly computeUnitLimit?: number;
  readonly computeUnitPriceMicroLamports?: bigint;
  readonly priorityFeeLamports: bigint;
}

export function priorityFeeLamports(microLamportsPerCu: bigint, computeUnitLimit: number): bigint {
  const product = microLamportsPerCu * BigInt(computeUnitLimit);
  return (product + 999_999n) / 1_000_000n;
}

export function checkComputeBudget(instructions: readonly DecodedInstruction[], caps: FirewallCaps): ComputeBudgetOutcome {
  const violations: string[] = [];
  const seen = new Set<number>();
  let limit: number | undefined;
  let price: bigint | undefined;

  for (const ix of instructions) {
    const label = where(ix, "ComputeBudget");
    const { core, violations: extra } = splitTrailingDontFront(ix, label);
    violations.push(...extra);
    if (core.length !== 0) violations.push(`${label}: compute budget instructions take no accounts`);
    const kind = ix.data[0];
    if (kind === undefined) {
      violations.push(`${label}: empty instruction data`);
      continue;
    }
    const name = NAMES[kind] ?? `instruction ${kind}`;
    if (
      kind !== REQUEST_HEAP_FRAME &&
      kind !== SET_COMPUTE_UNIT_LIMIT &&
      kind !== SET_COMPUTE_UNIT_PRICE &&
      kind !== SET_LOADED_ACCOUNTS_DATA_SIZE_LIMIT
    ) {
      violations.push(`${label}: ${name} is not allowed`);
      continue;
    }
    if (seen.has(kind)) {
      violations.push(`${label}: duplicate ${name}`);
      continue;
    }
    seen.add(kind);
    const expectedLength = kind === SET_COMPUTE_UNIT_PRICE ? 9 : 5;
    if (ix.data.length !== expectedLength) {
      violations.push(`${label}: ${name} data must be ${expectedLength} bytes`);
      continue;
    }
    if (kind === SET_COMPUTE_UNIT_LIMIT) {
      limit = readU32LE(ix.data, 1);
      if (limit > caps.maxComputeUnitLimit)
        violations.push(`${label}: compute unit limit ${limit} exceeds the cap of ${caps.maxComputeUnitLimit}`);
      if (limit > MAX_COMPUTE_UNIT_LIMIT) violations.push(`${label}: compute unit limit ${limit} exceeds the runtime maximum`);
    } else if (kind === SET_COMPUTE_UNIT_PRICE) {
      price = readU64LE(ix.data, 1);
    }
  }

  let fee = 0n;
  if (price !== undefined && price > 0n) {
    fee = priorityFeeLamports(price, limit ?? MAX_COMPUTE_UNIT_LIMIT);
    if (fee > caps.maxPriorityFeeLamports) {
      violations.push(`priority fee ${fee} lamports exceeds the cap of ${caps.maxPriorityFeeLamports} lamports`);
    }
  }
  return {
    violations,
    ...(limit !== undefined ? { computeUnitLimit: limit } : {}),
    ...(price !== undefined ? { computeUnitPriceMicroLamports: price } : {}),
    priorityFeeLamports: fee,
  };
}
