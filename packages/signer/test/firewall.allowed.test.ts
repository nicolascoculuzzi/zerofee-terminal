import { describe, expect, test } from "bun:test";
import { createAddressWithSeed } from "@solana/kit";
import {
  getAdvanceNonceAccountInstruction,
  getCreateAccountWithSeedInstruction,
  getInitializeNonceAccountInstruction,
  getWithdrawNonceAccountInstruction,
} from "@solana-program/system";
import { getTransferCheckedInstruction } from "@solana-program/token";
import { findAssociatedTokenAddress } from "../src/firewall/ata";
import { decodeTransaction } from "../src/firewall/decode";
import { SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT } from "../src/firewall/programs";
import { createPumpSwapRule } from "../src/firewall/rules/pump";
import {
  HELIUS_TIP_ACCOUNTS,
  JITO_TIP_ACCOUNTS,
  LAMPORTS_PER_SOL,
  MAINNET,
  makeActors,
  makeContext,
  PROGRAMS,
  randomAddress,
} from "./helpers/fixtures";
import { ammInstruction, curveInstruction } from "./helpers/pump";
import { ammBuy, ammParams, ammSell, curveBuyV2, curveParams, curveSellV2, expectAllowed } from "./helpers/scenarios";
import {
  buildTransaction,
  computeBudget,
  createAtaIdempotent,
  noop,
  tipWithDontFront,
  transferSol,
  unwrapSol,
  wrapSol,
} from "./helpers/tx";

describe("firewall: allowed transactions", () => {
  test("realistic pump.fun buy_v2 (v0) with Jito tip + jitodontfront", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const summary = await expectAllowed(buildTransaction({ feePayer: a.signer, instructions: await curveBuyV2(a) }), ctx);
    expect(summary.version).toBe(0);
    expect(summary.maxBuyLamports).toBe(500_000_000n);
    expect(summary.tipLamports).toBe(10_000n);
    expect(summary.priorityFeeLamports).toBe(6_000n); // 120,000 CU x 50,000 micro-lamports
    expect(summary.networkFeeLamports).toBe(5_000n);
    expect(summary.maxSolOutLamports).toBe(500_021_000n); // buy + tip + priority fee + base fee
    expect(summary.text).toContain("Buy on pump.fun bonding curve (buy_v2): spend up to 0.5 SOL");
    expect(summary.text).toContain("3Z16…pump");
    expect(summary.text).toContain("Tip 0.00001 SOL");
    expect(summary.actions.find((x) => x.kind === "trade")).toMatchObject({
      side: "buy",
      baseMint: MAINNET.curveMint,
      quoteMint: WSOL_MINT,
    });
  });

  test("realistic pump.fun sell_v2 (legacy message) with ATA close and Helius tip", async () => {
    const a = makeActors();
    const summary = await expectAllowed(
      buildTransaction({ feePayer: a.signer, instructions: await curveSellV2(a), version: "legacy" }),
      makeContext(a),
    );
    expect(summary.version).toBe("legacy");
    expect(summary.maxBuyLamports).toBe(0n);
    expect(summary.text).toContain("Sell 1,234,567,890,000 base units");
    expect(summary.text).toContain("for at least 0.4 SOL");
    expect(summary.text).toContain("its SOL goes to the trading wallet");
  });

  test("USDC-quoted buy_exact_quote_in_v2 within the USDC cap", async () => {
    const a = makeActors();
    const params = { ...curveParams(a), quoteMint: MAINNET.usdc, quoteTokenProgram: TOKEN_PROGRAM };
    const ix = await curveInstruction("buy_exact_quote_in_v2", params, { spendable_quote_in: 250_000_000n, min_tokens_out: 1n });
    const summary = await expectAllowed(
      buildTransaction({ feePayer: a.signer, instructions: [...computeBudget(100_000, 1_000n), ix] }),
      makeContext(a),
    );
    expect(summary.maxBuyQuote).toEqual({ [MAINNET.usdc]: 250_000_000n });
    expect(summary.maxBuyLamports).toBe(0n);
  });

  test("legacy curve instructions with the 2026-04-28 remaining accounts", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const legacy = { ...curveParams(a), baseTokenProgram: TOKEN_PROGRAM };
    for (const ix of [
      await curveInstruction("buy", legacy, { amount: 10n ** 12n, max_sol_cost: 300_000_000n, track_volume: true }),
      await curveInstruction("buy", legacy, { amount: 10n ** 12n, max_sol_cost: 300_000_000n }), // OptionBool omitted (24 bytes)
      await curveInstruction("buy_exact_sol_in", legacy, { spendable_sol_in: 100_000_000n, min_tokens_out: 1n, track_volume: false }),
      await curveInstruction("sell", legacy, { amount: 10n ** 12n, min_sol_output: 1n }),
      await curveInstruction("sell", legacy, { amount: 10n ** 12n, min_sol_output: 1n }, { cashback: true }),
    ]) {
      await expectAllowed(buildTransaction({ feePayer: a.signer, instructions: [ix] }), ctx);
    }
  });

  test("PumpSwap buy (v0): wrap, buy, unwrap, tip", async () => {
    const a = makeActors();
    const summary = await expectAllowed(buildTransaction({ feePayer: a.signer, instructions: await ammBuy(a) }), makeContext(a));
    expect(summary.maxBuyLamports).toBe(250_000_000n);
    expect(summary.text).toContain("Buy on PumpSwap (buy): spend up to 0.25 SOL");
    expect(summary.text).toContain("Move 0.25 SOL into the trading wallet's wSOL account (wrap).");
  });

  test("PumpSwap sell (v0) with shared accounts loaded from an address lookup table", async () => {
    const a = makeActors();
    const ix = await ammInstruction("sell", ammParams(a), { base_amount_in: 1n, min_quote_amount_out: 1n });
    const altAddress = randomAddress();
    // Operator-style ALT: only shared, venue-validated accounts (never the user's own accounts).
    const shared = [
      MAINNET.ammGlobalConfig,
      MAINNET.ammFeeConfig,
      PROGRAMS.pumpFees,
      MAINNET.ammProtocolFeeRecipient,
      MAINNET.buybackFeeRecipient,
    ];
    const tx = buildTransaction({
      feePayer: a.signer,
      instructions: [...(await ammSell(a)).slice(0, 3), ix],
      lookupTables: { [altAddress]: shared },
    });
    const decoded = decodeTransaction(tx, { [altAddress]: shared });
    expect(decoded.ok && decoded.tx.accounts.some((acc) => !acc.isStatic)).toBe(true);
    await expectAllowed(tx, makeContext(a, { addressLookupTables: { [altAddress]: shared } }));
    await expectAllowed(buildTransaction({ feePayer: a.signer, instructions: await ammSell(a) }), makeContext(a));
  });

  test("PumpSwap buy_exact_quote_in on a cashback pool (27 accounts) and a pool without coin creator (25)", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const args = { spendable_quote_in: 100_000_000n, min_base_amount_out: 1n, track_volume: true };
    await expectAllowed(
      buildTransaction({
        feePayer: a.signer,
        instructions: [await ammInstruction("buy_exact_quote_in", ammParams(a, { cashback: true }), args)],
      }),
      ctx,
    );
    await expectAllowed(
      buildTransaction({
        feePayer: a.signer,
        instructions: [await ammInstruction("buy_exact_quote_in", ammParams(a, { coinCreator: undefined }), args)],
      }),
      ctx,
    );
    await expectAllowed(
      buildTransaction({
        feePayer: a.signer,
        instructions: [await ammInstruction("sell", ammParams(a, { cashback: true }), { base_amount_in: 1n, min_quote_amount_out: 1n })],
      }),
      ctx,
    );
  });

  test("non-canonical PumpSwap pools pass only with the explicit opt-out", async () => {
    const a = makeActors();
    const ix = await ammInstruction("buy", ammParams(a, { pool: MAINNET.ammPool }), {
      base_amount_out: 1n,
      max_quote_amount_in: 1n,
      track_volume: true,
    });
    const optOut = createPumpSwapRule({ programId: PROGRAMS.pumpAmm, pumpProgramId: PROGRAMS.pump, allowNonCanonicalPools: true });
    await expectAllowed(buildTransaction({ feePayer: a.signer, instructions: [ix] }), makeContext(a, { venueRules: [optOut] }));
  });

  test("tips to Jito and to Helius Sender", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    for (const tipAccount of [JITO_TIP_ACCOUNTS[7]!, HELIUS_TIP_ACCOUNTS[9]!]) {
      const summary = await expectAllowed(
        buildTransaction({
          feePayer: a.signer,
          instructions: [...computeBudget(1_000, 1n), transferSol(a.signer, tipAccount, 1_000_000n)],
        }),
        ctx,
      );
      expect(summary.tipLamports).toBe(1_000_000n);
    }
  });

  test("durable nonce: AdvanceNonceAccount first, then a buy (v0 + operator ALT, as armed orders must be)", async () => {
    const a = makeActors();
    const nonce = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
    const instructions = await curveBuyV2(a);
    const durableNonce = { nonceAccount: a.nonceAccount, authority: a.signer, nonce };
    // Without an ALT the armed buy is 1,240 bytes: over PACKET_DATA_SIZE, as SPEC warns. The firewall refuses it.
    await expect(expectAllowed(buildTransaction({ feePayer: a.signer, instructions, durableNonce }), makeContext(a))).rejects.toThrow(
      /limited to 1232/,
    );
    const alt = randomAddress();
    const shared = [
      MAINNET.pumpGlobal,
      MAINNET.pumpFeeConfig,
      PROGRAMS.pumpFees,
      MAINNET.pumpFeeRecipient,
      MAINNET.buybackFeeRecipient,
      SYSTEM_PROGRAM,
    ];
    const tx = buildTransaction({ feePayer: a.signer, instructions, durableNonce, lookupTables: { [alt]: shared } });
    const summary = await expectAllowed(tx, makeContext(a, { addressLookupTables: { [alt]: shared } }));
    expect(summary.durableNonce).toEqual({ nonceAccount: a.nonceAccount, nonceValue: nonce });
    expect(summary.text).toContain("it stays valid until that nonce advances");
    // A pre-signed cancel is just the nonce advance.
    await expectAllowed(
      buildTransaction({
        feePayer: a.signer,
        instructions: [getAdvanceNonceAccountInstruction({ nonceAccount: a.nonceAccount, nonceAuthority: noop(a.signer) })],
      }),
      makeContext(a),
    );
  });

  test("wSOL wrap (transfer + SyncNative) and unwrap (CloseAccount)", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    await expectAllowed(buildTransaction({ feePayer: a.signer, instructions: await wrapSol(a.signer, 2n * LAMPORTS_PER_SOL) }), ctx);
    await expectAllowed(buildTransaction({ feePayer: a.signer, instructions: [await unwrapSol(a.signer)] }), ctx);
  });

  test("withdrawals to the connected wallet: SOL, tokens to its ATA, ATA creation for it", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const summary = await expectAllowed(
      buildTransaction({ feePayer: a.signer, instructions: [transferSol(a.signer, a.connected, 5n * LAMPORTS_PER_SOL)] }),
      ctx,
    );
    expect(summary.text).toContain("Send 5 SOL to your connected wallet");
    const mint = MAINNET.curveMint;
    const transfer = getTransferCheckedInstruction(
      {
        source: await findAssociatedTokenAddress(a.signer, mint, TOKEN_2022_PROGRAM),
        mint,
        destination: await findAssociatedTokenAddress(a.connected, mint, TOKEN_2022_PROGRAM),
        authority: noop(a.signer),
        amount: 42n,
        decimals: 6,
      },
      { programAddress: TOKEN_2022_PROGRAM },
    );
    await expectAllowed(
      buildTransaction({
        feePayer: a.signer,
        instructions: [await createAtaIdempotent(a.signer, a.connected, mint, TOKEN_2022_PROGRAM), transfer],
      }),
      ctx,
    );
  });

  test("nonce slot creation (CreateAccountWithSeed + InitializeNonceAccount) and nonce withdrawal", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const seed = "zerofee-nonce-0";
    const nonceAccount = await createAddressWithSeed({ baseAddress: a.signer, programAddress: SYSTEM_PROGRAM, seed });
    const create = getCreateAccountWithSeedInstruction({
      payer: noop(a.signer),
      newAccount: nonceAccount,
      base: a.signer,
      seed,
      amount: 1_500_000n,
      space: 80n,
      programAddress: SYSTEM_PROGRAM,
    });
    const init = getInitializeNonceAccountInstruction({ nonceAccount, nonceAuthority: a.signer });
    const summary = await expectAllowed(buildTransaction({ feePayer: a.signer, instructions: [create, init] }), ctx);
    expect(summary.text).toContain("controlled by the trading wallet");
    const withdraw = getWithdrawNonceAccountInstruction({
      nonceAccount: a.nonceAccount,
      recipientAccount: a.connected,
      nonceAuthority: noop(a.signer),
      withdrawAmount: 1_500_000n,
    });
    await expectAllowed(buildTransaction({ feePayer: a.signer, instructions: [withdraw] }), ctx);
  });

  test("the same trade passes as legacy and as v0", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const instructions = [
      ...computeBudget(100_000, 10_000n),
      await curveInstruction("buy_exact_quote_in_v2", curveParams(a), { spendable_quote_in: 100_000_000n, min_tokens_out: 1n }),
      tipWithDontFront(a.signer, JITO_TIP_ACCOUNTS[1]!, 2_000n),
    ];
    for (const version of ["legacy", 0] as const) {
      const summary = await expectAllowed(buildTransaction({ feePayer: a.signer, instructions, version }), ctx);
      expect(summary.version).toBe(version);
    }
  });
});
