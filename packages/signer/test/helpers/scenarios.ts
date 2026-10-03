/** Realistic transactions shaped like @zerofee/core's output: [CU limit, CU price, ...trade, tip (+ jitodontfront)]. */
import { expect } from "bun:test";
import type { Address, Instruction } from "@solana/kit";
import { getCloseAccountInstruction } from "@solana-program/token";
import { findAssociatedTokenAddress } from "../../src/firewall/ata";
import { checkTransaction } from "../../src/firewall/firewall";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT } from "../../src/firewall/programs";
import type { FirewallContext, FirewallResult, TransactionSummary } from "../../src/firewall/types";
import { HELIUS_TIP_ACCOUNTS, JITO_TIP_ACCOUNTS, LAMPORTS_PER_SOL, MAINNET, randomAddress, type TestActors } from "./fixtures";
import { ammInstruction, curveInstruction } from "./pump";
import { computeBudget, createAtaIdempotent, noop, tipWithDontFront, transferSol, unwrapSol, wrapSol } from "./tx";

export const CREATOR = randomAddress();
/** A migrated (SPL Token) coin traded on PumpSwap in these tests. */
export const AMM_COIN = randomAddress();
export const COIN_CREATOR = randomAddress();

export function curveParams(a: TestActors, overrides?: Record<string, Address>) {
  return {
    user: a.signer,
    mint: MAINNET.curveMint,
    baseTokenProgram: TOKEN_2022_PROGRAM,
    creator: CREATOR,
    ...(overrides ? { overrides } : {}),
  };
}

export function ammParams(a: TestActors, extra: Partial<Parameters<typeof ammInstruction>[1]> = {}) {
  return { user: a.signer, baseMint: AMM_COIN, baseTokenProgram: TOKEN_PROGRAM, coinCreator: COIN_CREATOR, ...extra };
}

/** Curve buy_v2 for up to 0.5 SOL, Jito tip with jitodontfront. */
export async function curveBuyV2(a: TestActors, maxSolCost = LAMPORTS_PER_SOL / 2n): Promise<Instruction[]> {
  return [
    ...computeBudget(120_000, 50_000n),
    await createAtaIdempotent(a.signer, a.signer, MAINNET.curveMint, TOKEN_2022_PROGRAM),
    await curveInstruction("buy_v2", curveParams(a), { amount: 1_234_567_890_000n, max_sol_cost: maxSolCost }),
    tipWithDontFront(a.signer, JITO_TIP_ACCOUNTS[0]!, 10_000n),
  ];
}

/** Curve sell_v2 of a full position with base ATA close and a Helius tip. */
export async function curveSellV2(a: TestActors): Promise<Instruction[]> {
  return [
    ...computeBudget(80_000, 20_000n),
    await curveInstruction("sell_v2", curveParams(a), { amount: 1_234_567_890_000n, min_sol_output: 400_000_000n }),
    await closeAta(a.signer, MAINNET.curveMint, TOKEN_2022_PROGRAM),
    transferSol(a.signer, HELIUS_TIP_ACCOUNTS[3]!, 5_000n),
  ];
}

export async function closeAta(owner: Address, mint: Address, tokenProgram: Address): Promise<Instruction> {
  return getCloseAccountInstruction(
    { account: await findAssociatedTokenAddress(owner, mint, tokenProgram), destination: owner, owner: noop(owner) },
    { programAddress: tokenProgram },
  );
}

/** PumpSwap buy: wrap max quote, base ATA, buy, unwrap remainder, tip. */
export async function ammBuy(a: TestActors, maxQuoteIn = LAMPORTS_PER_SOL / 4n): Promise<Instruction[]> {
  return [
    ...computeBudget(150_000, 30_000n),
    ...(await wrapSol(a.signer, maxQuoteIn)),
    await createAtaIdempotent(a.signer, a.signer, AMM_COIN, TOKEN_PROGRAM),
    await ammInstruction("buy", ammParams(a), { base_amount_out: 5_000_000_000n, max_quote_amount_in: maxQuoteIn, track_volume: true }),
    await unwrapSol(a.signer),
    tipWithDontFront(a.signer, JITO_TIP_ACCOUNTS[5]!, 25_000n),
  ];
}

/** PumpSwap sell: proceeds into a temporary wSOL ATA, then unwrap; Helius tip. */
export async function ammSell(a: TestActors): Promise<Instruction[]> {
  return [
    ...computeBudget(120_000, 30_000n),
    await createAtaIdempotent(a.signer, a.signer, WSOL_MINT, TOKEN_PROGRAM),
    await ammInstruction("sell", ammParams(a), { base_amount_in: 5_000_000_000n, min_quote_amount_out: 200_000_000n }),
    await unwrapSol(a.signer),
    transferSol(a.signer, HELIUS_TIP_ACCOUNTS[0]!, 5_000n),
  ];
}

export async function expectAllowed(tx: Uint8Array, ctx: FirewallContext): Promise<TransactionSummary> {
  const result = await checkTransaction(tx, ctx);
  if (!result.ok) throw new Error(`expected the firewall to allow, got:\n  ${result.violations.join("\n  ")}`);
  return result.summary;
}

export async function expectRefused(tx: Uint8Array, ctx: FirewallContext, pattern: RegExp): Promise<string[]> {
  const result: FirewallResult = await checkTransaction(tx, ctx);
  expect(result.ok).toBe(false);
  const violations = result.ok ? [] : result.violations;
  expect(violations.join("\n")).toMatch(pattern);
  return violations;
}
