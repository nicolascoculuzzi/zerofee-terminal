/**
 * Trade expectations: the caller's own quote per trade instruction plus the user's max slippage.
 * When supplied, every trade must carry one, and its guaranteed output (a sell's minimum quote out,
 * a buy's minimum or exact tokens out) must be at least floor(expectedOut x (10,000 - bps) / 10,000).
 */
import { describe, expect, test } from "bun:test";
import type { TradeExpectation } from "../src/firewall/types";
import { makeActors, makeContext, type TestActors } from "./helpers/fixtures";
import { curveInstruction } from "./helpers/pump";
import { curveBuyV2, curveParams, curveSellV2, expectAllowed, expectRefused } from "./helpers/scenarios";
import { buildTransaction, computeBudget, transferSol } from "./helpers/tx";

// curveSellV2: [CU limit, CU price, sell_v2 (min_sol_output 400,000,000), CloseAccount, tip]
const SELL_IX = 2;
// curveBuyV2: [CU limit, CU price, ATA create, buy_v2 (amount 1,234,567,890,000), tip]
const BUY_IX = 3;
const BUY_AMOUNT = 1_234_567_890_000n;

async function sellTx(a: TestActors) {
  return buildTransaction({ feePayer: a.signer, instructions: await curveSellV2(a) });
}

function withExpectations(a: TestActors, expectations: readonly TradeExpectation[]) {
  return makeContext(a, { expectations });
}

describe("firewall: trade expectations", () => {
  test("sell: passes up to core's applySlippageDown boundary, refused one lamport past it", async () => {
    const a = makeActors();
    const tx = await sellTx(a);
    // floor(470,588,236 x 8,500 / 10,000) = 400,000,000 = the sell's minimum: allowed.
    const summary = await expectAllowed(tx, withExpectations(a, [{ instruction: SELL_IX, expectedOut: 470_588_236n, slippageBps: 1500 }]));
    expect(summary.text).toContain("Checked against your own quote: every minimum output is within your max slippage.");
    // floor(470,588,237 x 0.85) = 400,000,001: the minimum is one lamport short.
    const violations = await expectRefused(
      tx,
      withExpectations(a, [{ instruction: SELL_IX, expectedOut: 470_588_237n, slippageBps: 1500 }]),
      /#2 pump\.fun bonding curve sell_v2: minimum output 0\.4 SOL is below your quote of 0\.470588237 SOL less your 15% max slippage \(0\.400000001 SOL\)/,
    );
    expect(violations).toHaveLength(1);
    // A tighter slippage on the same quote is refused too.
    await expectRefused(
      tx,
      withExpectations(a, [{ instruction: SELL_IX, expectedOut: 470_588_236n, slippageBps: 1499 }]),
      /below your quote/,
    );
  });

  test("exact-quote-in buy: the minimum tokens out is compared with the quote", async () => {
    const a = makeActors();
    const ix = await curveInstruction("buy_exact_quote_in_v2", curveParams(a), { spendable_quote_in: 10n ** 8n, min_tokens_out: 850_000n });
    const tx = buildTransaction({ feePayer: a.signer, instructions: [...computeBudget(100_000, 1_000n), ix] });
    await expectAllowed(tx, withExpectations(a, [{ instruction: 2, expectedOut: 1_000_000n, slippageBps: 1500 }]));
    await expectRefused(
      tx,
      withExpectations(a, [{ instruction: 2, expectedOut: 1_000_000n, slippageBps: 1000 }]),
      /minimum output 850,000 base units is below your quote of 1,000,000 base units less your 10% max slippage \(900,000 base units\)/,
    );
  });

  test("exact-out buy: the exact amount is the guaranteed output", async () => {
    const a = makeActors();
    const tx = buildTransaction({ feePayer: a.signer, instructions: await curveBuyV2(a) });
    await expectAllowed(tx, withExpectations(a, [{ instruction: BUY_IX, expectedOut: BUY_AMOUNT, slippageBps: 0 }]));
    await expectRefused(
      tx,
      withExpectations(a, [{ instruction: BUY_IX, expectedOut: BUY_AMOUNT + 1n, slippageBps: 0 }]),
      /below your quote/,
    );
  });

  test("every trade needs exactly one expectation, and expectations may only name trades", async () => {
    const a = makeActors();
    const tx = await sellTx(a);
    await expectRefused(tx, withExpectations(a, []), /#2 pump\.fun bonding curve sell_v2: no expected output was supplied/);
    await expectRefused(
      tx,
      withExpectations(a, [{ instruction: 4, expectedOut: 1n, slippageBps: 0 }]),
      /no expected output was supplied[\s\S]*expectations: instruction #4 is not a trade/,
    );
    await expectRefused(
      tx,
      withExpectations(a, [
        { instruction: SELL_IX, expectedOut: 400_000_000n, slippageBps: 0 },
        { instruction: SELL_IX, expectedOut: 1n, slippageBps: 0 },
      ]),
      /more than one for instruction #2/,
    );
    await expectRefused(
      tx,
      withExpectations(a, [
        { instruction: SELL_IX, expectedOut: 400_000_000n, slippageBps: 0 },
        { instruction: 99, expectedOut: 1n, slippageBps: 0 },
      ]),
      /instruction #99 is not a trade/,
    );
    // Two trades, one expectation: the uncovered trade is refused (a tampered build could add one).
    const two = [
      ...computeBudget(100_000, 1_000n),
      await curveInstruction("buy_exact_quote_in_v2", curveParams(a), { spendable_quote_in: 10n ** 7n, min_tokens_out: 5n }),
      await curveInstruction("sell_v2", curveParams(a), { amount: 10n, min_sol_output: 5n }),
    ];
    await expectRefused(
      buildTransaction({ feePayer: a.signer, instructions: two }),
      withExpectations(a, [{ instruction: 2, expectedOut: 5n, slippageBps: 0 }]),
      /#3 pump\.fun bonding curve sell_v2: no expected output was supplied/,
    );
  });

  test("a transaction without trades passes with an empty list, and no summary line is added", async () => {
    const a = makeActors();
    const summary = await expectAllowed(
      buildTransaction({ feePayer: a.signer, instructions: [transferSol(a.signer, a.connected, 1_000n)] }),
      withExpectations(a, []),
    );
    expect(summary.text).not.toContain("Checked against your own quote");
  });

  test("malformed expectations refuse the whole request", async () => {
    const a = makeActors();
    const tx = await sellTx(a);
    const cases: [unknown, RegExp][] = [
      ["15%", /expectations must be an array/],
      [[null], /expectations\[0\] must be an object/],
      [[{ instruction: -1, expectedOut: 1n, slippageBps: 0 }], /instruction must be a non-negative integer/],
      [[{ instruction: 2.5, expectedOut: 1n, slippageBps: 0 }], /instruction must be a non-negative integer/],
      [[{ instruction: SELL_IX, expectedOut: 400_000_000, slippageBps: 0 }], /expectedOut must be a positive bigint/],
      [[{ instruction: SELL_IX, expectedOut: 0n, slippageBps: 0 }], /expectedOut must be a positive bigint/],
      [[{ instruction: SELL_IX, expectedOut: 1n, slippageBps: -1 }], /slippageBps must be an integer from 0 to 10000/],
      [[{ instruction: SELL_IX, expectedOut: 1n, slippageBps: 10_001 }], /slippageBps must be an integer from 0 to 10000/],
      [[{ instruction: SELL_IX, expectedOut: 1n, slippageBps: 0.5 }], /slippageBps must be an integer from 0 to 10000/],
    ];
    for (const [expectations, pattern] of cases) {
      const violations = await expectRefused(tx, makeContext(a, { expectations: expectations as TradeExpectation[] }), pattern);
      expect(violations.every((v) => v.startsWith("invalid firewall context: "))).toBe(true);
    }
  });
});
