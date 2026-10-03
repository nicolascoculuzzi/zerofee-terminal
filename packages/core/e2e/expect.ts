/**
 * Exact-fill assertions for trades landed on the fork. Expected numbers come from packages/core's quote math
 * over the pre-trade state the transaction was built from; actual numbers come from the landed transaction
 * (meta pre/post lamport and token balances) and the program's own trade event. The fork is static - nothing
 * else trades - so every comparison is exact, to the lamport and the base unit.
 */
import { expect } from "bun:test";
import type { Address, Instruction } from "@solana/kit";
import {
  type AmmSwapEvent,
  ammFeeRates,
  curveFeeRates,
  decodeBondingCurve,
  fetchRawAccounts,
  HELIUS_SENDER_TIP_ACCOUNTS,
  JITO_TIP_ACCOUNTS_FALLBACK,
  LAMPORTS_PER_SIGNATURE,
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  type PumpCurveState,
  type PumpSwapState,
  type PumpTradeEvent,
  quoteAmmBuyExactQuoteIn,
  quoteAmmSell,
  quoteBuyExactQuoteIn,
  quoteSell,
} from "../src";
import { accountDataLength, type Fork, forkRent, type TradeRun } from "./harness";

export function venueInstruction(run: TradeRun, program: Address): Instruction {
  const ix = run.trade.instructions.find((i) => i.programAddress === program);
  if (!ix?.accounts) throw new Error(`${run.label}: no ${program} instruction`);
  return ix;
}

const accountAt = (ix: Instruction, i: number): Address => {
  const a = ix.accounts?.[i]?.address;
  if (!a) throw new Error(`instruction has no account #${i}`);
  return a;
};

/** Rent-exempt check of every account the trade created, plus the exact set expected. */
async function expectCreated(fork: Fork, run: TradeRun, expected: readonly Address[]): Promise<bigint> {
  expect([...run.tx.created()].sort()).toEqual([...expected].sort());
  let rent = 0n;
  for (const a of expected) {
    const len = await accountDataLength(fork.rpc, a);
    expect(len).not.toBeNull();
    const lamports = run.tx.lamports(a).post;
    expect(lamports).toBe(await forkRent(fork.rpc, len as number));
    rent += lamports;
  }
  return rent;
}

/** Closed accounts (rent refunded to the user) must be exactly `expected`; returns the refund. */
function expectClosed(run: TradeRun, expected: readonly Address[]): bigint {
  expect([...run.tx.closed()].sort()).toEqual([...expected].sort());
  return expected.reduce((s, a) => s + run.tx.lamports(a).pre, 0n);
}

export function expectLanded(run: TradeRun): void {
  expect(run.confirm.status).toBe("confirmed");
  expect(run.tx.err).toBeNull();
}

/** Base fee (one signature) + priority fee exactly as planned. */
export function expectFee(run: TradeRun): void {
  expect(run.tx.fee).toBe(LAMPORTS_PER_SIGNATURE + run.plan.priorityFeeLamports);
}

/** Standard mode: one Helius Sender tip and one Jito tip, each landed in a pre-existing (cloned) tip account. */
export function expectTipsLanded(run: TradeRun): { helius: Address; jito: Address } {
  expect(run.plan.mode).toBe("standard");
  const heliusTip = run.plan.tips.find((t) => t.lane === "helius")?.lamports;
  const jitoTip = run.plan.tips.find((t) => t.lane === "jito")?.lamports;
  const helius = run.tx.keys.filter((k) => HELIUS_SENDER_TIP_ACCOUNTS.includes(k));
  const jito = run.tx.keys.filter((k) => JITO_TIP_ACCOUNTS_FALLBACK.includes(k));
  expect(helius.length).toBe(1);
  expect(jito.length).toBe(1);
  const h = run.tx.lamports(helius[0] as Address);
  const j = run.tx.lamports(jito[0] as Address);
  expect(h.pre).toBeGreaterThan(0n);
  expect(j.pre).toBeGreaterThan(0n);
  expect(h.delta).toBe(heliusTip as bigint);
  expect(j.delta).toBe(jitoTip as bigint);
  return { helius: helius[0] as Address, jito: jito[0] as Address };
}

/** The latency record carries every CLI stage through "landed", the lane ack and the landed slot. */
export function expectLatencyThroughLanded(run: TradeRun): void {
  const stages = run.latency.stages;
  for (const s of ["stateLoaded", "quoted", "built", "signed", "simulated", "sent", "firstAck", "landed"] as const) {
    expect(stages[s]).toBeNumber();
  }
  expect(stages.landed as number).toBeGreaterThanOrEqual(stages.sent as number);
  expect(run.latency.lanes.length).toBe(1);
  expect(run.latency.lanes[0]?.ok).toBe(true);
  expect(run.latency.lanes[0]?.lane).toStartWith("rpc-127.0.0.1:");
  expect(run.latency.landedSlot).toBe(run.tx.slot);
  expect(run.latency.slotDelta).toBeDefined();
  expect(run.latency.slotDelta as bigint).toBeGreaterThanOrEqual(0n);
  expect(run.latency.outcome).toBe("confirmed");
}

export interface CurveExpectations {
  /** Accounts the trade must create (and the user pays rent for). */
  created?: readonly Address[];
  /** Accounts the trade must close (rent refunded to the user). */
  closed?: readonly Address[];
}

/**
 * Bonding-curve trade (buy_exact_quote_in_v2 / sell_v2) against the local quote:
 * program event, user/curve token deltas, the fee split (protocol minus buyback / buyback / creator), the
 * curve's SOL delta, the user's SOL delta to the lamport, and the post-trade reserves.
 * Returns the extra lamports the user paid to extend a short (legacy-size) curve account, if any.
 */
export async function expectCurveFill(fork: Fork, run: TradeRun, exp: CurveExpectations = {}): Promise<{ curveTopUp: bigint }> {
  expectLanded(run);
  const s = run.state as PumpCurveState;
  expect(s.venue).toBe("pump");
  const rates = curveFeeRates({ curve: s.curve, global: s.global, feeConfig: s.feeConfig, mintSupply: s.mintInfo.supply });
  const ix = venueInstruction(run, PUMP_PROGRAM_ID);
  const feeRecipient = accountAt(ix, 6);
  const buyback = accountAt(ix, 8);
  const curveAddr = accountAt(ix, 10);
  const curveAta = accountAt(ix, 11);
  const user = accountAt(ix, 13);
  const userAta = accountAt(ix, 14);
  const creatorVault = accountAt(ix, 16);
  expect(user).toBe(run.wallet.address);
  expect(curveAddr).toBe(s.curveAddress);
  const ev = run.tx.events.find((e): e is PumpTradeEvent => e.kind === "pumpTrade");
  if (!ev) throw new Error(`${run.label}: no TradeEvent in the logs`);
  const q = run.trade.quote;

  const createdRent = await expectCreated(fork, run, exp.created ?? []);
  const refunded = expectClosed(run, exp.closed ?? []);
  const fixedCosts = run.tx.fee + run.plan.totalTipLamports;

  // The program's own record of the trade. ix_name carries the legacy names for the v2 instructions, and the
  // buyback share it applied is 0 on mayhem coins (core models both).
  expect(ev.ixName).toBe(q.side === "buy" ? "buy_exact_quote_in" : "sell");
  expect(ev.mayhemMode).toBe(s.curve.isMayhemMode);
  expect(ev.feeRecipient).toBe(feeRecipient);
  expect(ev.creator).toBe(s.curve.creator);
  expect(ev.buybackFeeBps).toBe(rates.buybackBps);

  // A curve shorter than the current layout is extended by the program, at the trader's expense.
  const preLen = s.curve.dataLength;
  const postLen = (await accountDataLength(fork.rpc, curveAddr)) as number;
  const curveDelta = run.tx.lamports(curveAddr).delta;

  if (q.side === "buy") {
    const x = quoteBuyExactQuoteIn(s.curve, q.amountIn, rates);
    expect(q.expectedOut).toBe(x.tokenAmount);
    expect(ev.isBuy).toBe(true);
    expect(ev.tokenAmount).toBe(x.tokenAmount);
    expect(ev.quoteAmount).toBe(x.quoteNet);
    expect(ev.fee).toBe(x.protocolFee);
    expect(ev.creatorFee).toBe(x.creatorFee);
    expect(ev.buybackFee).toBe(x.buybackFee);
    expect(run.tx.tokens(userAta).delta).toBe(x.tokenAmount);
    expect(run.tx.tokens(curveAta).delta).toBe(-x.tokenAmount);
    expect(run.tx.lamports(feeRecipient).delta).toBe(x.protocolFee - x.buybackFee);
    expect(run.tx.lamports(buyback).delta).toBe(x.buybackFee);
    expect(run.tx.lamports(creatorVault).delta).toBe(x.creatorFee);
    const curveTopUp = curveDelta - x.quoteNet;
    if (postLen === preLen) expect(curveTopUp).toBe(0n);
    else expect(curveTopUp).toBe((await forkRent(fork.rpc, postLen)) - run.tx.lamports(curveAddr).pre);
    expect(run.tx.lamports(user).delta).toBe(-(x.totalQuote + fixedCosts + createdRent + curveTopUp) + refunded);
    const after = await curveAfter(fork, curveAddr);
    expect(after.virtualTokenReserves).toBe(s.curve.virtualTokenReserves - x.tokenAmount);
    expect(after.virtualQuoteReserves).toBe(s.curve.virtualQuoteReserves + x.quoteNet);
    expect(after.realTokenReserves).toBe(s.curve.realTokenReserves - x.tokenAmount);
    expect(after.realQuoteReserves).toBe(s.curve.realQuoteReserves + x.quoteNet);
    return { curveTopUp };
  }

  const x = quoteSell(s.curve, q.amountIn, rates);
  expect(q.expectedOut).toBe(x.quoteNet);
  expect(ev.isBuy).toBe(false);
  expect(ev.tokenAmount).toBe(q.amountIn);
  expect(ev.quoteAmount).toBe(x.quoteGross);
  expect(ev.fee).toBe(x.protocolFee);
  expect(ev.creatorFee).toBe(x.creatorFee);
  expect(ev.buybackFee).toBe(x.buybackFee);
  expect(run.tx.tokens(userAta).delta).toBe(-q.amountIn);
  expect(run.tx.tokens(curveAta).delta).toBe(q.amountIn);
  expect(run.tx.lamports(feeRecipient).delta).toBe(x.protocolFee - x.buybackFee);
  expect(run.tx.lamports(buyback).delta).toBe(x.buybackFee);
  expect(run.tx.lamports(creatorVault).delta).toBe(x.creatorFee);
  expect(postLen).toBe(preLen);
  expect(curveDelta).toBe(-x.quoteGross);
  expect(run.tx.lamports(user).delta).toBe(x.quoteNet - fixedCosts - createdRent + refunded);
  const after = await curveAfter(fork, curveAddr);
  expect(after.virtualTokenReserves).toBe(s.curve.virtualTokenReserves + q.amountIn);
  expect(after.virtualQuoteReserves).toBe(s.curve.virtualQuoteReserves - x.quoteGross);
  expect(after.realTokenReserves).toBe(s.curve.realTokenReserves + q.amountIn);
  expect(after.realQuoteReserves).toBe(s.curve.realQuoteReserves - x.quoteGross);
  return { curveTopUp: 0n };
}

async function curveAfter(fork: Fork, curve: Address) {
  const [acc] = await fetchRawAccounts(fork.rpc, [curve]);
  if (!acc) throw new Error(`curve ${curve} missing after trade`);
  return decodeBondingCurve(acc.data);
}

/**
 * PumpSwap trade (buy_exact_quote_in with wSOL wrap / sell with unwrap) against the local quote:
 * program event, user and pool vault token deltas (LP fee stays in the pool), protocol / buyback / creator fee
 * ATAs, the user's SOL delta to the lamport (the temporary wSOL account nets to zero), created/closed accounts.
 */
export async function expectAmmFill(fork: Fork, run: TradeRun, exp: CurveExpectations = {}): Promise<void> {
  expectLanded(run);
  const s = run.state as PumpSwapState;
  expect(s.venue).toBe("pumpswap");
  const rates = ammFeeRates({
    pool: s.pool,
    isCanonical: s.isCanonical,
    reserves: s.reserves,
    baseMintSupply: s.mintInfo.supply,
    feeConfig: s.feeConfig,
    globalConfig: s.globalConfig,
  });
  const ix = venueInstruction(run, PUMP_AMM_PROGRAM_ID);
  const n = ix.accounts?.length ?? 0;
  const user = accountAt(ix, 1);
  const userBase = accountAt(ix, 5);
  const userQuote = accountAt(ix, 6);
  const poolBase = accountAt(ix, 7);
  const poolQuote = accountAt(ix, 8);
  const protocolAta = accountAt(ix, 10);
  const creatorAta = accountAt(ix, 17);
  const buybackAta = accountAt(ix, n - 1);
  expect(user).toBe(run.wallet.address);
  expect(poolBase).toBe(s.pool.poolBaseTokenAccount);
  expect(poolQuote).toBe(s.pool.poolQuoteTokenAccount);
  const kind = run.trade.quote.side === "buy" ? "ammBuy" : "ammSell";
  const ev = run.tx.events.find((e): e is AmmSwapEvent => e.kind === kind);
  if (!ev) throw new Error(`${run.label}: no ${kind} event in the logs`);
  const q = run.trade.quote;

  // The temporary wSOL account is created and closed inside the transaction.
  const wsol = run.tx.lamports(userQuote);
  expect(wsol.pre).toBe(0n);
  expect(wsol.post).toBe(0n);
  const createdRent = await expectCreated(fork, run, exp.created ?? []);
  const refunded = expectClosed(run, exp.closed ?? []);
  const fixedCosts = run.tx.fee + run.plan.totalTipLamports;
  // The program priced off the same boost-pool virtual reserves and paid the same fee ATA we built.
  expect(ev.virtualQuoteReserves).toBe(s.reserves.virtualQuoteReserves);
  expect(ev.protocolFeeRecipientTokenAccount).toBe(protocolAta);

  if (q.side === "buy") {
    const x = quoteAmmBuyExactQuoteIn(s.reserves, q.amountIn, rates);
    expect(q.expectedOut).toBe(x.baseOut);
    expect(ev.ixName).toBe("buy_exact_quote_in");
    expect(ev.baseAmount).toBe(x.baseOut);
    expect(ev.quoteLimit).toBe(q.amountIn);
    // buy_exact_quote_in swaps the meaning of the two quote fields relative to `buy`:
    // quote_amount_in = total paid incl. fees, user_quote_amount_in = pre-fee quote (see events/types.ts).
    expect(ev.quoteAmount).toBe(x.totalQuote);
    expect(ev.userQuoteAmount).toBe(x.quoteIn);
    expect(ev.quoteAmountVault).toBe(x.quoteIn + x.lpFee);
    expect(ev.lpFee).toBe(x.lpFee);
    expect(ev.protocolFee).toBe(x.protocolFee);
    expect(ev.coinCreatorFee).toBe(x.creatorFee);
    expect(ev.buybackFee).toBe(x.buybackFee);
    expect(ev.poolBaseReserves).toBe(s.reserves.baseReserve);
    expect(ev.poolQuoteReserves).toBe(s.reserves.quoteVaultReserve);
    expect(run.tx.tokens(userBase).delta).toBe(x.baseOut);
    expect(run.tx.tokens(poolBase).delta).toBe(-x.baseOut);
    expect(run.tx.tokens(poolQuote).delta).toBe(x.quoteIn + x.lpFee);
    expect(run.tx.tokens(protocolAta).delta).toBe(x.protocolFee - x.buybackFee);
    expect(run.tx.tokens(buybackAta).delta).toBe(x.buybackFee);
    expect(run.tx.tokens(creatorAta).delta).toBe(x.creatorFee);
    expect(run.tx.lamports(user).delta).toBe(-(x.totalQuote + fixedCosts + createdRent) + refunded);
    return;
  }

  const x = quoteAmmSell(s.reserves, q.amountIn, rates);
  expect(q.expectedOut).toBe(x.quoteOutNet);
  expect(ev.baseAmount).toBe(q.amountIn);
  expect(ev.quoteAmount).toBe(x.quoteOutGross);
  expect(ev.quoteAmountVault).toBe(x.quoteOutGross - x.lpFee);
  expect(ev.lpFee).toBe(x.lpFee);
  expect(ev.protocolFee).toBe(x.protocolFee);
  expect(ev.coinCreatorFee).toBe(x.creatorFee);
  expect(ev.buybackFee).toBe(x.buybackFee);
  expect(ev.userQuoteAmount).toBe(x.quoteOutNet);
  expect(run.tx.tokens(userBase).delta).toBe(-q.amountIn);
  expect(run.tx.tokens(poolBase).delta).toBe(q.amountIn);
  expect(run.tx.tokens(poolQuote).delta).toBe(-(x.quoteOutGross - x.lpFee));
  expect(run.tx.tokens(protocolAta).delta).toBe(x.protocolFee - x.buybackFee);
  expect(run.tx.tokens(buybackAta).delta).toBe(x.buybackFee);
  expect(run.tx.tokens(creatorAta).delta).toBe(x.creatorFee);
  expect(run.tx.lamports(user).delta).toBe(x.quoteOutNet - fixedCosts - createdRent + refunded);
}
