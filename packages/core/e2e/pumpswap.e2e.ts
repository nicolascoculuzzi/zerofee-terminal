/**
 * PumpSwap (canonical pool) trades on the local mainnet fork (`bun run fork:start`, then `bun run e2e`).
 * Real PumpSwap program code and cloned mainnet pool state (incl. boost virtual quote reserves), real landed
 * transactions, no real money.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import type { Address } from "@solana/kit";
import type { ForkTarget } from "../scripts/fork/env";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ammUserVolumeAccumulatorPda,
  bytesEqual,
  findAssociatedTokenAddress,
  PUMP_AMM_IX,
  PUMP_AMM_PROGRAM_ID,
  type PumpSwapState,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from "../src";
import { expectAmmFill, expectFee, expectLatencyThroughLanded, expectTipsLanded, venueInstruction } from "./expect";
import { connectFork, type Fork, newWallet, runTrade, type TradeRun, type Wallet } from "./harness";

const disc = (run: TradeRun) => venueInstruction(run, PUMP_AMM_PROGRAM_ID).data?.subarray(0, 8) ?? new Uint8Array();

describe("PumpSwap - canonical wSOL pool", () => {
  let fork: Fork;
  let wallet: Wallet;
  let target: ForkTarget;
  let baseAta: Address;
  let wsolAta: Address;

  beforeAll(async () => {
    fork = await connectFork();
    const t = fork.manifest.targets.find((x) => x.kind === "pumpswap");
    if (!t) throw new Error("the fork has no pumpswap target; pass a migrated (PumpSwap) mint to fork:start");
    target = t;
    wallet = await newWallet(fork);
    baseAta = await findAssociatedTokenAddress(wallet.address, target.mint, target.tokenProgram);
    wsolAta = await findAssociatedTokenAddress(wallet.address, WSOL_MINT, TOKEN_PROGRAM_ID);
  });

  test("buy_exact_quote_in 0.01 SOL wraps wSOL, creates the base ATA and fills exactly the local quote", async () => {
    const run = await runTrade(fork, wallet, { label: "PumpSwap buy 0.01 SOL (wSOL wrap)", mint: target.mint, side: "buy", sol: "0.01" });
    expect(bytesEqual(disc(run), PUMP_AMM_IX.buyExactQuoteIn)).toBe(true);
    const s = run.state as PumpSwapState;
    expect(s.isCanonical).toBe(true);
    expect(s.poolAddress).toBe(target.market);
    // wrap: create wSOL ATA, fund it with the full budget, SyncNative ... swap ... CloseAccount (unwrap)
    const [createWsol, fund, sync] = run.trade.instructions;
    expect(createWsol?.programAddress).toBe(ASSOCIATED_TOKEN_PROGRAM_ID);
    expect(createWsol?.accounts?.[1]?.address).toBe(wsolAta);
    expect(fund?.programAddress).toBe(SYSTEM_PROGRAM_ID);
    expect(fund?.accounts?.[1]?.address).toBe(wsolAta);
    expect(sync?.data).toEqual(new Uint8Array([17]));
    const unwrap = run.trade.instructions.at(-1);
    expect(unwrap?.data).toEqual(new Uint8Array([9]));
    expect(unwrap?.accounts?.[0]?.address).toBe(wsolAta);
    await expectAmmFill(fork, run, { created: [baseAta, await ammUserVolumeAccumulatorPda(wallet.address)] });
    expectFee(run);
    expectTipsLanded(run);
    expectLatencyThroughLanded(run);
  });

  test("sell 50% unwraps the proceeds to native SOL and fills exactly the local quote", async () => {
    const run = await runTrade(fork, wallet, { label: "PumpSwap sell 50% (wSOL unwrap)", mint: target.mint, side: "sell", percent: "50" });
    expect(bytesEqual(disc(run), PUMP_AMM_IX.sell)).toBe(true);
    expect(run.trade.quote.amountIn).toBe(run.state.userBaseBalance / 2n);
    await expectAmmFill(fork, run);
    expectFee(run);
    expectTipsLanded(run);
    expectLatencyThroughLanded(run);
  });

  test("full exit sells 100% and closes the base ATA, refunding its rent", async () => {
    const run = await runTrade(fork, wallet, { label: "PumpSwap full exit + close", mint: target.mint, side: "sell", percent: "100" });
    expect(bytesEqual(disc(run), PUMP_AMM_IX.sell)).toBe(true);
    expect(run.trade.quote.amountIn).toBe(run.state.userBaseBalance);
    const last = run.trade.instructions.at(-1);
    expect(last?.programAddress).toBe(target.tokenProgram);
    expect(last?.accounts?.[0]?.address).toBe(baseAta);
    await expectAmmFill(fork, run, { closed: [baseAta] });
    expect((await fork.rpc.getAccountInfo(baseAta, { encoding: "base64" }).send()).value).toBeNull();
    expectFee(run);
    expectTipsLanded(run);
    expectLatencyThroughLanded(run);
  });
});
