/**
 * Verified mainnet IDs from docs/reports/Solana trading terminal teardown.md (program table,
 * tip accounts) and the pump.fun research note (Global, FeeConfig, fee recipients). Tests inject
 * them the way production will inject @zerofee/core's constants.
 */
import { type Address, address, getAddressDecoder } from "@solana/kit";
import { randomBytes } from "../../src/bytes";
import {
  ASSOCIATED_TOKEN_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from "../../src/firewall/programs";
import { createPumpBondingCurveRule, createPumpSwapRule } from "../../src/firewall/rules/pump";
import type { FirewallCaps, FirewallContext } from "../../src/firewall/types";

export const PROGRAMS = {
  pump: address("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"),
  pumpAmm: address("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"),
  pumpFees: address("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ"),
  raydiumLaunchLab: address("LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj"),
} as const;

/** Jito's 8 tip accounts (report, "Fill in the tip accounts"). */
export const JITO_TIP_ACCOUNTS: readonly Address[] = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
].map((a) => address(a));

/** Helius Sender's 10 tip accounts. */
export const HELIUS_TIP_ACCOUNTS: readonly Address[] = [
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
].map((a) => address(a));

export const MAINNET = {
  pumpGlobal: address("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf"),
  pumpFeeConfig: address("8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt"),
  ammGlobalConfig: address("ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw"),
  ammFeeConfig: address("5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx"),
  pumpFeeRecipient: address("62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV"),
  buybackFeeRecipient: address("5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD"),
  ammProtocolFeeRecipient: address("JCRGumoE9Qi5BBgULTgdgTLjSgkCMSbF62ZZfGs84JeU"),
  /** A create_v2 (Token-2022) coin from the research note. */
  curveMint: address("3Z16oesTxW8exoENZTCd1ADVzFPePH3n33cTkUDLpump"),
  /** A canonical boost pool from the research note. */
  ammPool: address("5RxfsBsyA8t2Z1J21SkSq2gaNr8JvPFGPZBd8crXY9Ck"),
  usdc: address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
} as const;

/** Jito's documented example marker. */
export const JITO_DONT_FRONT = address("jitodontfront111111111111111111111111111111");

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Throwaway address (no key exists for it). */
export function randomAddress(): Address {
  return getAddressDecoder().decode(randomBytes(32));
}

export const DEFAULT_CAPS: FirewallCaps = {
  maxTipLamports: 10_000_000n, // 0.01 SOL
  maxPriorityFeeLamports: 5_000_000n, // 0.005 SOL
  maxComputeUnitLimit: 400_000,
  maxBuyLamports: LAMPORTS_PER_SOL, // 1 SOL per trade
  maxBuyQuote: { [MAINNET.usdc]: 500_000_000n }, // 500 USDC per trade
};

export interface TestActors {
  signer: Address;
  connected: Address;
  attacker: Address;
  nonceAccount: Address;
}

export function makeActors(): TestActors {
  return { signer: randomAddress(), connected: randomAddress(), attacker: randomAddress(), nonceAccount: randomAddress() };
}

export function makeContext(actors: TestActors, overrides: Partial<FirewallContext> = {}): FirewallContext {
  return {
    signer: actors.signer,
    connectedWallet: actors.connected,
    ownedNonceAccounts: [actors.nonceAccount],
    allowedPrograms: [
      SYSTEM_PROGRAM,
      COMPUTE_BUDGET_PROGRAM,
      TOKEN_PROGRAM,
      TOKEN_2022_PROGRAM,
      ASSOCIATED_TOKEN_PROGRAM,
      PROGRAMS.pump,
      PROGRAMS.pumpAmm,
      // Allowlisted by SPEC but without a firewall rule yet: must still be refused.
      PROGRAMS.raydiumLaunchLab,
    ],
    tipAccounts: [...JITO_TIP_ACCOUNTS, ...HELIUS_TIP_ACCOUNTS],
    caps: DEFAULT_CAPS,
    venueRules: [
      createPumpBondingCurveRule({ programId: PROGRAMS.pump }),
      createPumpSwapRule({ programId: PROGRAMS.pumpAmm, pumpProgramId: PROGRAMS.pump }),
    ],
    ...overrides,
  };
}
