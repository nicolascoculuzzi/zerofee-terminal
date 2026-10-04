/**
 * Mayhem-mode coin on the local mainnet fork: 2B supply, reserved fee recipients, mint-supply fee basis.
 * Skipped when fork:start found no eligible mayhem coin (it is optional).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import type { Address } from "@solana/kit";
import type { ForkTarget } from "../scripts/fork/env";
import {
  findAssociatedTokenAddress,
  globalMayhemFeeRecipients,
  ONE_BILLION_SUPPLY,
  PUMP_PROGRAM_ID,
  type PumpCurveState,
  pumpUserVolumeAccumulatorPda,
} from "../src";
import { expectCurveFill, expectFee, expectLatencyThroughLanded, expectTipsLanded, venueInstruction } from "./expect";
import { connectFork, type Fork, missingTarget, newWallet, runTrade, type Wallet, withSkipReason } from "./harness";

const noMayhem = missingTarget("mayhem");

describe.skipIf(noMayhem !== null)(withSkipReason("pump curve - mayhem-mode coin", noMayhem), () => {
  let fork: Fork;
  let wallet: Wallet;
  let target: ForkTarget;
  let ata: Address;

  beforeAll(async () => {
    fork = await connectFork();
    target = fork.manifest.targets.find((x) => x.kind === "mayhem") as ForkTarget;
    wallet = await newWallet(fork);
    ata = await findAssociatedTokenAddress(wallet.address, target.mint, target.tokenProgram);
  });

  test("buy 0.01 SOL pays a reserved fee recipient and fills exactly the local quote", async () => {
    const run = await runTrade(fork, wallet, { label: "mayhem curve buy 0.01 SOL", mint: target.mint, side: "buy", sol: "0.01" });
    const s = run.state as PumpCurveState;
    expect(s.curve.isMayhemMode).toBe(true);
    expect(s.mintInfo.supply).toBe(ONE_BILLION_SUPPLY * 2n);
    const feeRecipient = venueInstruction(run, PUMP_PROGRAM_ID).accounts?.[6]?.address as Address;
    expect(globalMayhemFeeRecipients(s.global)).toContain(feeRecipient);
    const { curveTopUp } = await expectCurveFill(fork, run, { created: [ata, await pumpUserVolumeAccumulatorPda(wallet.address)] });
    if (curveTopUp > 0n)
      console.log(`  note: the program extended the ${s.curve.dataLength}-byte curve; trader paid ${curveTopUp} lamports`);
    expectFee(run);
    expectTipsLanded(run);
    expectLatencyThroughLanded(run);
  });

  test("full exit sells 100% and closes the ATA", async () => {
    const run = await runTrade(fork, wallet, { label: "mayhem curve full exit + close", mint: target.mint, side: "sell", percent: "100" });
    await expectCurveFill(fork, run, { closed: [ata] });
    expectFee(run);
    expectTipsLanded(run);
    expectLatencyThroughLanded(run);
  });
});
