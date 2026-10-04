/**
 * The firewall policy the signer ships: its own reviewed program allowlist, landing tip accounts and
 * venue rules, plus default per-trade caps. Only the caps are host-configurable (user settings).
 *
 * Tip accounts are embedded, never read live: a backend that could add a "tip account" could drain up
 * to the tip cap per trade (SPEC "Verify before you code"). Jito's live getTipAccounts only feeds the
 * backend's drift alarm, and SignerService refuses a policy whose tip accounts are not listed here.
 * test/constants-crosscheck.test.ts fails when these lists drift from packages/core/src/constants.ts.
 *
 *   startSignerWorker({ policy: createSignerPolicy({ caps: userCaps }), dailyCaps });
 */
import { type Address, address } from "@solana/kit";
import {
  ASSOCIATED_TOKEN_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  DEFAULT_MAX_NONCE_ACCOUNT_LAMPORTS,
  PUMP_AMM_PROGRAM,
  PUMP_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  USDC_MINT,
} from "./firewall/programs";
import { createPumpBondingCurveRule, createPumpSwapRule } from "./firewall/rules/pump";
import type { FirewallCaps } from "./firewall/types";
import type { SignerPolicy } from "./service";

const addresses = (list: readonly string[]): readonly Address[] => Object.freeze(list.map((a) => address(a)));

/** Jito's 8 tip accounts (getTipAccounts, 2026-10-03). https://docs.jito.wtf/lowlatencytxnsend/ */
export const JITO_TIP_ACCOUNTS: readonly Address[] = addresses([
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
]);

/** Helius Sender's 10 tip accounts (no RPC lookup exists). https://www.helius.dev/docs/sending-transactions/sender */
export const HELIUS_SENDER_TIP_ACCOUNTS: readonly Address[] = addresses([
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
  "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
  "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
  "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
]);

/** Every tip account the firewall accepts (both landing lanes). */
export const SIGNER_TIP_ACCOUNTS: readonly Address[] = Object.freeze([...JITO_TIP_ACCOUNTS, ...HELIUS_SENDER_TIP_ACCOUNTS]);

/**
 * Programs a signed transaction may invoke: the built-ins (System also covers durable nonces) and the
 * venues that have a firewall rule. Raydium LaunchLab / CPMM and Jupiter join only with their rules.
 */
export const SIGNER_ALLOWED_PROGRAMS: readonly Address[] = Object.freeze([
  SYSTEM_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  ASSOCIATED_TOKEN_PROGRAM,
  PUMP_PROGRAM,
  PUMP_AMM_PROGRAM,
]);

/**
 * Default per-transaction caps. They bound what one signature can cost even when the app is
 * compromised; the user's own presets (core's FeeCaps) should sit at or below them.
 */
export const DEFAULT_FIREWALL_CAPS: FirewallCaps = Object.freeze({
  /** 1 SOL per trade (SPEC "Limits": per-user max SOL per trade). */
  maxBuyLamports: 1_000_000_000n,
  /** 100 USDC per trade on USDC-quoted coins. */
  maxBuyQuote: Object.freeze({ [USDC_MINT]: 100_000_000n }),
  /** 0.01 SOL of tips per transaction: Sender Max (Fast preset) needs at least 0.001 SOL; room for Jito p95 spikes. */
  maxTipLamports: 10_000_000n,
  /** 0.005 SOL priority fee per transaction. */
  maxPriorityFeeLamports: 5_000_000n,
  /** Well above core's static per-route limits (DEFAULT_CU_LIMITS, ~1.3x the measured worst case); cross-checked in tests. */
  maxComputeUnitLimit: 400_000,
  /** 0.002 SOL per new nonce slot (SPEC "Money movement"). */
  maxNonceAccountLamports: DEFAULT_MAX_NONCE_ACCOUNT_LAMPORTS,
});

export interface SignerPolicyOptions {
  /** Overrides for DEFAULT_FIREWALL_CAPS (a maxBuyQuote override replaces the whole map). */
  readonly caps?: Partial<FirewallCaps>;
}

/** The shipped policy: embedded allowlist, tip accounts and pump.fun / PumpSwap rules (canonical pools only). */
export function createSignerPolicy(options: SignerPolicyOptions = {}): SignerPolicy {
  return {
    allowedPrograms: SIGNER_ALLOWED_PROGRAMS,
    tipAccounts: SIGNER_TIP_ACCOUNTS,
    caps: Object.freeze({ ...DEFAULT_FIREWALL_CAPS, ...options.caps }),
    venueRules: Object.freeze([
      createPumpBondingCurveRule({ programId: PUMP_PROGRAM }),
      createPumpSwapRule({ programId: PUMP_AMM_PROGRAM, pumpProgramId: PUMP_PROGRAM }),
    ]),
  };
}
