/**
 * Native and SPL program addresses whose instructions the firewall decodes with built-in rules.
 * These are protocol constants that have never changed; venue programs (pump, PumpSwap), tip
 * accounts and caps are NOT here: they are injected through FirewallContext / venue rules.
 * Whether any of these may be invoked at all is still decided by ctx.allowedPrograms.
 */
import { type Address, address } from "@solana/kit";

/** https://docs.solanalabs.com/runtime/programs#system-program */
export const SYSTEM_PROGRAM: Address = address("11111111111111111111111111111111");
/** https://docs.solanalabs.com/runtime/programs#compute-budget-program */
export const COMPUTE_BUDGET_PROGRAM: Address = address("ComputeBudget111111111111111111111111111111");
/** https://github.com/solana-program/token (SPL Token) */
export const TOKEN_PROGRAM: Address = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/** https://github.com/solana-program/token-2022 */
export const TOKEN_2022_PROGRAM: Address = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
/** https://github.com/solana-program/associated-token-account (also in pump's IDL) */
export const ASSOCIATED_TOKEN_PROGRAM: Address = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/** Wrapped SOL mint (SPL Token). */
export const WSOL_MINT: Address = address("So11111111111111111111111111111111111111112");
/** Sysvars referenced by nonce instructions. */
export const SYSVAR_RECENT_BLOCKHASHES: Address = address("SysvarRecentB1ockHashes11111111111111111111");
export const SYSVAR_RENT: Address = address("SysvarRent111111111111111111111111111111111");

export const TOKEN_PROGRAMS: readonly Address[] = [TOKEN_PROGRAM, TOKEN_2022_PROGRAM];

export const BUILTIN_PROGRAMS: readonly Address[] = [
  SYSTEM_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  ASSOCIATED_TOKEN_PROGRAM,
];

/** Jito's anti-front-running marker: any read-only account whose base58 starts with this. https://docs.jito.wtf/lowlatencytxnsend/ */
export const JITO_DONT_FRONT_PREFIX = "jitodontfront";

/** Max compute units per transaction (runtime constant). */
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;

/** Legacy and v0 transactions are limited to one packet. */
export const PACKET_DATA_SIZE = 1232;
