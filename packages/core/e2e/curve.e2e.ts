/**
 * pump.fun bonding-curve trades on the local mainnet fork (`bun run fork:start`, then `bun run e2e`).
 * Real pump program code and cloned mainnet state, real landed transactions, no real money.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import type { Address } from "@solana/kit";
import type { ForkTarget } from "../scripts/fork/env";
import {
  bytesEqual,
  findAssociatedTokenAddress,
  globalFeeRecipients,
  PUMP_IX,
  PUMP_PROGRAM_ID,
  type PumpCurveState,
  pumpUserVolumeAccumulatorPda,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "../src";
import { expectCurveFill, expectFee, expectLatencyThroughLanded, expectTipsLanded, venueInstruction } from "./expect";
import {
  connectFork,
  type Fork,
  missingTarget,
  newWallet,
  runTrade,
  type TradeRun,
  targetOf,
  type Wallet,
  withSkipReason,
} from "./harness";

const disc = (run: TradeRun) => venueInstruction(run, PUMP_PROGRAM_ID).data?.subarray(0, 8) ?? new Uint8Array();

const noCurve2022 = missingTarget("curve2022");

describe.skipIf(noCurve2022 !== null)(withSkipReason("pump curve - Token-2022 (create_v2) coin", noCurve2022), () => {
  let fork: Fork;
  let wallet: Wallet;
  let target: ForkTarget;
  let ata: Address;
  let buy: TradeRun;

  beforeAll(async () => {
    fork = await connectFork();
    target = targetOf("curve2022") as ForkTarget;
    wallet = await newWallet(fork);
    ata = await findAssociatedTokenAddress(wallet.address, target.mint, TOKEN_2022_PROGRAM_ID);
  });

  test("buy_exact_quote_in_v2 0.01 SOL creates the Token-2022 ATA and fills exactly the local quote", async () => {
    buy = await runTrade(fork, wallet, { label: "curve buy 0.01 SOL (Token-2022, new ATA)", mint: target.mint, side: "buy", sol: "0.01" });
    expect(bytesEqual(disc(buy), PUMP_IX.buyExactQuoteInV2)).toBe(true);
    const s = buy.state as PumpCurveState;
    expect(s.mintInfo.tokenProgram).toBe(TOKEN_2022_PROGRAM_ID);
    expect(s.curve.isMayhemMode).toBe(false);
    expect(globalFeeRecipients(s.global)).toContain(venueInstruction(buy, PUMP_PROGRAM_ID).accounts?.[6]?.address as Address);
    expect(s.userBaseBalance).toBe(0n);
    const uva = await pumpUserVolumeAccumulatorPda(wallet.address);
    await expectCurveFill(fork, buy, { created: [ata, uva] });
    const info = await fork.rpc.getAccountInfo(ata, { encoding: "base64" }).send();
    expect(info.value?.owner).toBe(TOKEN_2022_PROGRAM_ID);
    expectFee(buy);
  });

  test("standard-mode tips land in the cloned Helius Sender and Jito tip accounts", () => {
    expect(buy).toBeDefined();
    expectTipsLanded(buy);
  });

  test("latency record is populated through landed", () => {
    expect(buy).toBeDefined();
    expectLatencyThroughLanded(buy);
  });

  test("sell_v2 50% fills exactly the local quote", async () => {
    const run = await runTrade(fork, wallet, { label: "curve sell 50% (Token-2022)", mint: target.mint, side: "sell", percent: "50" });
    expect(bytesEqual(disc(run), PUMP_IX.sellV2)).toBe(true);
    expect(run.trade.quote.amountIn).toBe(run.state.userBaseBalance / 2n);
    expect(run.trade.instructions.some((i) => i.data?.[0] === 9 && i.programAddress === TOKEN_2022_PROGRAM_ID)).toBe(false);
    await expectCurveFill(fork, run);
    expectFee(run);
    expectTipsLanded(run);
    expectLatencyThroughLanded(run);
  });

  test("full exit sells 100% and closes the Token-2022 ATA, refunding its rent", async () => {
    const run = await runTrade(fork, wallet, {
      label: "curve full exit + close (Token-2022)",
      mint: target.mint,
      side: "sell",
      percent: "100",
    });
    expect(bytesEqual(disc(run), PUMP_IX.sellV2)).toBe(true);
    expect(run.trade.quote.amountIn).toBe(run.state.userBaseBalance);
    const last = run.trade.instructions.at(-1);
    expect(last?.programAddress).toBe(TOKEN_2022_PROGRAM_ID);
    expect(last?.data).toEqual(new Uint8Array([9]));
    await expectCurveFill(fork, run, { closed: [ata] });
    expect((await fork.rpc.getAccountInfo(ata, { encoding: "base64" }).send()).value).toBeNull();
    expectFee(run);
    expectTipsLanded(run);
    expectLatencyThroughLanded(run);
  });
});

// Legacy `create` (SPL Token) coins are rare on the curve since create_v2; covered when the fork has one.
const noCurveSpl = missingTarget("curveSpl");

describe.skipIf(noCurveSpl !== null)(withSkipReason("pump curve - legacy SPL Token coin", noCurveSpl), () => {
  let fork: Fork;
  let wallet: Wallet;
  let target: ForkTarget;

  beforeAll(async () => {
    fork = await connectFork();
    target = fork.manifest.targets.find((x) => x.kind === "curveSpl") as ForkTarget;
    wallet = await newWallet(fork);
  });

  test("buy 0.01 SOL then full exit + close, both exact", async () => {
    const ata = await findAssociatedTokenAddress(wallet.address, target.mint, TOKEN_PROGRAM_ID);
    const b = await runTrade(fork, wallet, { label: "curve buy 0.01 SOL (SPL Token)", mint: target.mint, side: "buy", sol: "0.01" });
    expect(b.state.mintInfo.tokenProgram).toBe(TOKEN_PROGRAM_ID);
    await expectCurveFill(fork, b, { created: [ata, await pumpUserVolumeAccumulatorPda(wallet.address)] });
    expectFee(b);
    expectTipsLanded(b);
    const s = await runTrade(fork, wallet, {
      label: "curve full exit + close (SPL Token)",
      mint: target.mint,
      side: "sell",
      percent: "100",
    });
    await expectCurveFill(fork, s, { closed: [ata] });
    expectFee(s);
    expectTipsLanded(s);
    expectLatencyThroughLanded(s);
  });
});
