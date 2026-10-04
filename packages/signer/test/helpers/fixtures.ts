/**
 * Mainnet IDs for tests. Program IDs and tip accounts are the signer's embedded copies (what ships;
 * test/constants-crosscheck.test.ts compares them with @zerofee/core). Global, FeeConfig and fee
 * recipients come from the pump.fun research note (verified as PDAs in idl-layout.test.ts).
 */
import { type Address, address, getAddressDecoder } from "@solana/kit";
import { randomBytes } from "../../src/bytes";
import {
  ASSOCIATED_TOKEN_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  PUMP_AMM_PROGRAM,
  PUMP_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  USDC_MINT,
} from "../../src/firewall/programs";
import { createPumpBondingCurveRule, createPumpSwapRule } from "../../src/firewall/rules/pump";
import type { FirewallCaps, FirewallContext } from "../../src/firewall/types";
import { HELIUS_SENDER_TIP_ACCOUNTS, JITO_TIP_ACCOUNTS } from "../../src/policy";

export const PROGRAMS = {
  pump: PUMP_PROGRAM,
  pumpAmm: PUMP_AMM_PROGRAM,
  pumpFees: address("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ"),
  raydiumLaunchLab: address("LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj"),
} as const;

export { JITO_TIP_ACCOUNTS };
export const HELIUS_TIP_ACCOUNTS = HELIUS_SENDER_TIP_ACCOUNTS;

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
  usdc: USDC_MINT,
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
