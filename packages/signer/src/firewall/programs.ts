/**
 * The signer's own reviewed copy of the program and mint addresses it relies on. The signer must not
 * trust @zerofee/core or the backend at runtime (SPEC "Verify before you code"), so nothing here is
 * read live; test/constants-crosscheck.test.ts fails when a value drifts from packages/core.
 *
 * Built-in rules decode System, Compute Budget, SPL Token, Token-2022 and ATA instructions; venue
 * programs (pump.fun, PumpSwap, Raydium LaunchLab, Raydium CPMM, Jupiter v6) are handled by venue rules. Whether
 * any program may be invoked at all is still decided by ctx.allowedPrograms. Tip accounts live in
 * ../policy.ts.
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
/** USDC, the only non-SOL quote mint pump.fun supports. https://github.com/pump-fun/pump-public-docs/blob/main/README.md */
export const USDC_MINT: Address = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
/** pump.fun bonding-curve program. https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md */
export const PUMP_PROGRAM: Address = address("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
/** PumpSwap (pump AMM) program. https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump_amm.json */
export const PUMP_AMM_PROGRAM: Address = address("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
/**
 * Raydium LaunchLab (the bonding curves behind BONK.fun / letsbonk, StonkFun, TRiX).
 * https://github.com/raydium-io/raydium-idl/blob/e7e0c96fe77bcf6a020b84a44c47a722aac8e359/raydium_launchpad/raydium_launchpad.json
 */
export const RAYDIUM_LAUNCHLAB_PROGRAM: Address = address("LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj");
/**
 * Raydium CPMM (cp-swap), where LaunchLab coins graduate.
 * https://github.com/raydium-io/raydium-idl/blob/e7e0c96fe77bcf6a020b84a44c47a722aac8e359/raydium_cpmm/raydium_cp_swap.json
 */
export const RAYDIUM_CPMM_PROGRAM: Address = address("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
/**
 * Jupiter aggregator v6, the long-tail fallback (Swap API V2 `/build` routes). Verified 2026-10-03: every
 * captured /build response routes through it, its on-chain IDL account names it, and jupiter-cpi declares it.
 * https://github.com/jup-ag/jupiter-cpi/blob/12bc5f67b94a2c3edc74d6e721a19442124a0bad/src/lib.rs
 */
export const JUPITER_PROGRAM: Address = address("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
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

/** Network base fee per signature (lamports_per_signature). https://solana.com/docs/core/fees */
export const BASE_FEE_LAMPORTS_PER_SIGNATURE = 5_000n;

/**
 * Default cap on the lamports a new nonce account may be funded with: comfortably above the
 * rent-exempt minimum for 80 bytes (208 bytes x 5,080 lamports/byte = 1,056,640 at 2026-10 rent;
 * 1,447,680 at the pre-2026 rate), far below anything worth parking there.
 */
export const DEFAULT_MAX_NONCE_ACCOUNT_LAMPORTS = 2_000_000n;

/** Legacy and v0 transactions are limited to one packet. */
export const PACKET_DATA_SIZE = 1232;
