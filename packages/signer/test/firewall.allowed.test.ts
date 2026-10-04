import { describe, expect, test } from "bun:test";
import { type AccountMeta, AccountRole, type Address, address, createAddressWithSeed, getBase64Encoder } from "@solana/kit";
import {
  getAdvanceNonceAccountInstruction,
  getCreateAccountWithSeedInstruction,
  getInitializeNonceAccountInstruction,
  getWithdrawNonceAccountInstruction,
} from "@solana-program/system";
import { getTransferCheckedInstruction } from "@solana-program/token";
import raydiumSnapshot from "../../core/test/fixtures/raydium-mainnet.json";
import { startsWith } from "../src/bytes";
import { findAssociatedTokenAddress } from "../src/firewall/ata";
import { decodeTransaction } from "../src/firewall/decode";
import { SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT } from "../src/firewall/programs";
import { createPumpSwapRule, findCanonicalPumpPool } from "../src/firewall/rules/pump";
import { CPMM_SWAP_INSTRUCTIONS, LAUNCHLAB_SWAP_INSTRUCTIONS } from "../src/firewall/rules/raydium-idl";
import {
  DEFAULT_CAPS,
  HELIUS_TIP_ACCOUNTS,
  JITO_TIP_ACCOUNTS,
  LAMPORTS_PER_SOL,
  MAINNET,
  makeActors,
  makeContext,
  PROGRAMS,
  RAYDIUM,
  randomAddress,
} from "./helpers/fixtures";
import { compileJupiter, jupiterActors, rawJupiterRoute } from "./helpers/jupiter";
import { ammExtendInstruction, ammInstruction, curveInstruction } from "./helpers/pump";
import {
  CPMM_COIN,
  cpmmBuy,
  cpmmInstruction,
  cpmmParams,
  cpmmPool,
  cpmmSell,
  LAUNCHLAB_COIN,
  launchLabBuy,
  launchLabInstruction,
  launchLabParams,
  launchLabSellAll,
  STONK_COIN,
} from "./helpers/raydium";
import {
  AMM_COIN,
  ammBuy,
  ammParams,
  ammSell,
  curveBuyV2,
  curveParams,
  curveSellV2,
  expectAllowed,
  expectRefused,
} from "./helpers/scenarios";
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

  test("PumpSwap extend_account on the trade's canonical pool (pre-upgrade pool), before a buy and before a sell", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const pool = await findCanonicalPumpPool(PROGRAMS.pump, PROGRAMS.pumpAmm, AMM_COIN, WSOL_MINT);
    const extend = await ammExtendInstruction({ user: a.signer, account: pool });
    const [budgetLimit, budgetPrice, ...buyRest] = await ammBuy(a);
    const summary = await expectAllowed(
      buildTransaction({ feePayer: a.signer, instructions: [budgetLimit!, budgetPrice!, extend, ...buyRest] }),
      ctx,
    );
    expect(summary.actions).toContainEqual({ kind: "extend_account", venue: "PumpSwap", account: pool });
    expect(summary.text).toContain(`Pay the one-time rent to grow PumpSwap pool ${pool.slice(0, 4)}…${pool.slice(-4)}`);
    expect(summary.text).toContain("plus the pool extension rent above");
    expect(summary.maxBuyLamports).toBe(250_000_000n);
    const sell = await ammSell(a);
    await expectAllowed(buildTransaction({ feePayer: a.signer, instructions: [extend, ...sell] }), ctx);
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

describe("firewall: allowed Raydium LaunchLab and CPMM transactions", () => {
  const RENT_LINE =
    "If its platform or creator fee vault does not exist yet, Raydium LaunchLab creates it with the trading wallet paying the rent (not refundable).";
  const tradeOf = (summary: Awaited<ReturnType<typeof expectAllowed>>) => summary.actions.find((x) => x.kind === "trade");

  test("LaunchLab buy_exact_in (v0): wrap, buy, unwrap, Jito tip + jitodontfront", async () => {
    const a = makeActors();
    const summary = await expectAllowed(buildTransaction({ feePayer: a.signer, instructions: await launchLabBuy(a) }), makeContext(a));
    expect(summary.maxBuyLamports).toBe(200_000_000n);
    expect(summary.maxBuyQuote).toEqual({});
    expect(summary.text).toContain(
      `Buy on Raydium LaunchLab (buy_exact_in): spend up to 0.2 SOL for at least 1,000,000,000 base units of token ${LAUNCHLAB_COIN.slice(0, 4)}…`,
    );
    expect(summary.text).toContain(RENT_LINE);
    expect(summary.text).toContain("plus any fee-vault rent above.");
    expect(tradeOf(summary)).toEqual({
      kind: "trade",
      venue: "Raydium LaunchLab",
      instruction: "buy_exact_in",
      side: "buy",
      baseMint: LAUNCHLAB_COIN,
      quoteMint: WSOL_MINT,
      maxQuoteIn: 200_000_000n,
      baseAmount: 1_000_000_000n,
      baseAmountIs: "min_out",
      mayPayVenueRent: true,
    });
  });

  test("LaunchLab full exit of a Token-2022 coin (legacy message): sell_exact_in, unwrap, close the coin account", async () => {
    const a = makeActors();
    const summary = await expectAllowed(
      buildTransaction({ feePayer: a.signer, instructions: await launchLabSellAll(a), version: "legacy" }),
      makeContext(a),
    );
    expect(summary.maxBuyLamports).toBe(0n);
    expect(summary.text).toContain(
      `Sell 5,000,000,000,000 base units of token ${STONK_COIN.slice(0, 4)}…${STONK_COIN.slice(-4)} on Raydium LaunchLab (sell_exact_in) for at least 0.3 SOL.`,
    );
    expect(summary.actions.filter((x) => x.kind === "close_account")).toHaveLength(2);
  });

  test("LaunchLab buy_exact_out (exact tokens) and sell_exact_out (exact SOL out, base at most)", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const buy = await launchLabInstruction("buy_exact_out", launchLabParams(a), { amount_out: 123_456n, maximum_amount_in: 300_000_000n });
    const bought = await expectAllowed(buildTransaction({ feePayer: a.signer, instructions: [buy] }), ctx);
    expect(bought.maxBuyLamports).toBe(300_000_000n);
    expect(bought.text).toContain("spend up to 0.3 SOL for 123,456 base units of token");
    expect(tradeOf(bought)).toMatchObject({ side: "buy", baseAmount: 123_456n, baseAmountIs: "exact_out", maxQuoteIn: 300_000_000n });
    const sell = await launchLabInstruction("sell_exact_out", launchLabParams(a), {
      amount_out: 250_000_000n,
      maximum_amount_in: 2_000_000_000n,
    });
    const sold = await expectAllowed(buildTransaction({ feePayer: a.signer, instructions: [sell] }), ctx);
    expect(sold.maxBuyLamports).toBe(0n);
    expect(sold.text).toContain("Sell up to 2,000,000,000 base units of token");
    expect(sold.text).toContain("(sell_exact_out) for at least 0.25 SOL.");
    expect(tradeOf(sold)).toMatchObject({ side: "sell", baseAmount: 2_000_000_000n, baseAmountIs: "max_in", minQuoteOut: 250_000_000n });
  });

  test("LaunchLab pair quoted in a Token-2022 xStock, once the user has configured a cap for it", async () => {
    const a = makeActors();
    const ctx = makeContext(a, { caps: { ...DEFAULT_CAPS, maxBuyQuote: { ...DEFAULT_CAPS.maxBuyQuote, [RAYDIUM.xStock]: 10n ** 9n } } });
    const quote = { quoteMint: RAYDIUM.xStock, quoteTokenProgram: TOKEN_2022_PROGRAM, platformConfig: RAYDIUM.stonkPlatform };
    const buy = await launchLabInstruction("buy_exact_in", launchLabParams(a, { baseTokenProgram: TOKEN_2022_PROGRAM, ...quote }), {
      amount_in: 25_000_000n,
      minimum_amount_out: 10n ** 9n,
    });
    const summary = await expectAllowed(buildTransaction({ feePayer: a.signer, instructions: [buy] }), ctx);
    expect(summary.maxBuyLamports).toBe(0n);
    expect(summary.maxBuyQuote).toEqual({ [RAYDIUM.xStock]: 25_000_000n });
    expect(summary.text).toContain(`spend up to 25,000,000 base units of ${RAYDIUM.xStock.slice(0, 4)}…`);
  });

  test("CPMM buy of a Token-2022 graduate (swap_base_input, wSOL in) and sell (wSOL out)", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const bought = await expectAllowed(
      buildTransaction({ feePayer: a.signer, instructions: await cpmmBuy(a, LAMPORTS_PER_SOL / 4n, TOKEN_2022_PROGRAM) }),
      ctx,
    );
    expect(bought.maxBuyLamports).toBe(250_000_000n);
    expect(bought.text).toContain("Buy on Raydium CPMM (swap_base_input): spend up to 0.25 SOL for at least 7 base units of token");
    expect(bought.text).not.toContain("fee vault");
    expect(tradeOf(bought)).toEqual({
      kind: "trade",
      venue: "Raydium CPMM",
      instruction: "swap_base_input",
      side: "buy",
      baseMint: CPMM_COIN,
      quoteMint: WSOL_MINT,
      maxQuoteIn: 250_000_000n,
      baseAmount: 7n,
      baseAmountIs: "min_out",
    });
    const sold = await expectAllowed(buildTransaction({ feePayer: a.signer, instructions: await cpmmSell(a) }), ctx);
    expect(sold.maxBuyLamports).toBe(0n);
    expect(sold.text).toContain("Sell 1,000,000,000 base units of token");
    expect(sold.text).toContain("on Raydium CPMM (swap_base_input) for at least 0.05 SOL.");
  });

  test("CPMM swap_base_output both ways: exact tokens out for at most X SOL, exact SOL out for at most Y tokens", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const buy = await cpmmInstruction("swap_base_output", cpmmParams(a, "buy"), { max_amount_in: 300_000_000n, amount_out: 10n ** 9n });
    const bought = await expectAllowed(buildTransaction({ feePayer: a.signer, instructions: [buy] }), ctx);
    expect(bought.maxBuyLamports).toBe(300_000_000n);
    expect(tradeOf(bought)).toMatchObject({ side: "buy", baseAmount: 10n ** 9n, baseAmountIs: "exact_out", maxQuoteIn: 300_000_000n });
    const sell = await cpmmInstruction("swap_base_output", cpmmParams(a, "sell"), {
      max_amount_in: 2_000_000_000n,
      amount_out: 100_000_000n,
    });
    const sold = await expectAllowed(buildTransaction({ feePayer: a.signer, instructions: [sell] }), ctx);
    expect(sold.text).toContain("Sell up to 2,000,000,000 base units of token");
    expect(tradeOf(sold)).toMatchObject({ side: "sell", baseAmount: 2_000_000_000n, baseAmountIs: "max_in", minQuoteOut: 100_000_000n });
  });

  test("residual risk: a CPMM pool on another AmmConfig passes (no canonical CPMM pool offline); its minimum output still binds", async () => {
    const a = makeActors();
    const ammConfig = randomAddress();
    const sell = await cpmmInstruction("swap_base_input", cpmmParams(a, "sell", { ammConfig }), {
      amount_in: 10n ** 9n,
      minimum_amount_out: 10n ** 8n,
    });
    expect(sell.accounts?.[3]?.address).toBe(await cpmmPool(CPMM_COIN, WSOL_MINT, ammConfig));
    const summary = await expectAllowed(buildTransaction({ feePayer: a.signer, instructions: [sell] }), makeContext(a));
    expect(tradeOf(summary)).toMatchObject({ side: "sell", minQuoteOut: 10n ** 8n });
  });

  test("venue-validated Raydium accounts may come from an operator lookup table", async () => {
    const a = makeActors();
    const buy = await launchLabInstruction("buy_exact_in", launchLabParams(a), { amount_in: 10n ** 8n, minimum_amount_out: 1n });
    const sell = await cpmmInstruction("swap_base_input", cpmmParams(a, "sell"), { amount_in: 10n ** 9n, minimum_amount_out: 1n });
    const L = (i: number) => buy.accounts![i]!.address;
    // LaunchLab global_config, base and quote vaults, creator fee vault; CPMM amm_config.
    const shared = [L(2), L(7), L(8), L(17), sell.accounts![2]!.address];
    const alt = randomAddress();
    const tables = { [alt]: shared };
    const tx = buildTransaction({ feePayer: a.signer, instructions: [buy, sell], lookupTables: tables });
    const decoded = decodeTransaction(tx, tables);
    if (!decoded.ok) throw new Error(decoded.violations.join("; "));
    expect(
      decoded.tx.accounts
        .filter((acc) => !acc.isStatic)
        .map((acc) => acc.address)
        .sort(),
    ).toEqual([...shared].sort());
    await expectAllowed(tx, makeContext(a, { addressLookupTables: tables }));
  });
});

describe("firewall: allowed Jupiter routes (real /build responses, our compute budget and tip)", () => {
  test.each([
    "longtailCurveBuy",
    "longtailCurveSell",
    "longtail2022Buy",
    "longtail2022Sell",
    "normalBuy",
    "normalSell",
    "usdcBuy",
  ] as const)("%s as /build returned it, with its lookup tables", async (label) => {
    const a = jupiterActors();
    const { instructions, tables } = rawJupiterRoute(label);
    const full = [...computeBudget(300_000, 50_000n), ...instructions, tipWithDontFront(a.signer, JITO_TIP_ACCOUNTS[2]!, 10_000n)];
    const summary = await expectAllowed(compileJupiter(full, tables), makeContext(a, { addressLookupTables: tables }));
    const trade = summary.actions.find((x) => x.kind === "trade");
    expect(trade).toMatchObject({ kind: "trade", venue: "Jupiter" });
    expect(summary.text).toContain("every hop account that touches the trading wallet's funds is checked (the pools are not)");
  });
});

describe("firewall: real mainnet Raydium swaps (core's snapshot, each signed top-level by its own fee payer)", () => {
  type CapturedIx = { where: string; programId: string; accounts: string[]; data: string };
  const txs = raydiumSnapshot.transactions as unknown as Record<string, { feePayer: string; instructions: CapturedIx[] }>;
  const b64 = getBase64Encoder();
  // Instruction roles: LaunchLab payer (s,w) and writable pool / user accounts / vaults / fee vaults; CPMM payer (s).
  const LAUNCHLAB_WRITABLE = new Set([4, 5, 6, 7, 8, 16, 17]);
  const CPMM_WRITABLE = new Set([3, 4, 5, 6, 7, 12]);

  const SWAPS = [...LAUNCHLAB_SWAP_INSTRUCTIONS, ...CPMM_SWAP_INSTRUCTIONS].map((d) => Uint8Array.from(d.discriminator));

  /** The capture's swap instruction (top-level or a bot's CPI) as the only instruction of a transaction its fee payer signs. */
  async function replay(label: string) {
    const t = txs[label]!;
    const swaps = t.instructions.flatMap((i) => {
      const data = new Uint8Array(b64.encode(i.data));
      const venue = i.programId === PROGRAMS.raydiumLaunchLab || i.programId === PROGRAMS.raydiumCpmm;
      return venue && SWAPS.some((d) => startsWith(data, d)) ? [{ ...i, bytes: data }] : [];
    });
    expect(swaps).toHaveLength(1);
    const ix = swaps[0]!;
    const writable = ix.programId === PROGRAMS.raydiumLaunchLab ? LAUNCHLAB_WRITABLE : CPMM_WRITABLE;
    const accounts: AccountMeta[] = ix.accounts.map((acc, i) => ({
      address: address(acc),
      role: i === 0 ? AccountRole.WRITABLE_SIGNER : writable.has(i) ? AccountRole.WRITABLE : AccountRole.READONLY,
    }));
    const feePayer: Address = address(t.feePayer);
    const tx = buildTransaction({ feePayer, instructions: [{ programAddress: address(ix.programId), accounts, data: ix.bytes }] });
    return {
      tx,
      ctx: makeContext({ signer: feePayer, connected: randomAddress(), attacker: randomAddress(), nonceAccount: randomAddress() }),
    };
  }

  test.each([
    ["bonkBuy", "BONK.fun buy_exact_in from the launchpad UI (2KW4kPuc…)"],
    ["cpmmStonkSell", "graduated StonkFun coin sold on CPMM (3aMQjR9u…)"],
  ])("%s passes: %s", async (label) => {
    const { tx, ctx } = await replay(label);
    await expectAllowed(tx, ctx);
  });

  test.each([
    ["bonkSell", /sell_exact_in: token account at position 6 must be the trading wallet's associated token account/],
    ["bonkChainBuy", /buy_exact_in: token account at position 6 must be the trading wallet's associated token account/],
    ["bonkChainSell", /sell_exact_in: token account at position 6 must be the trading wallet's associated token account/],
    ["stonkFeeSell", /sell_exact_in: token account at position 6 must be the trading wallet's associated token account/],
    ["stonkFeeBuy", /buy_exact_in: minimum tokens out is 0/],
    ["trixBuy", /buy_exact_in: minimum tokens out is 0/],
    ["trixSell", /sell_exact_in: minimum output is 0/],
    ["trixSell2", /sell_exact_in: minimum output is 0/],
    ["stonkXstockSell", /no per-trade cap is configured for quote mint Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu/],
    ["create", /no per-trade cap is configured for quote mint Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump/],
    ["cpmmBonkSell", /swap_base_input: minimum output is 0/],
    ["cpmmBonkBuy", /swap_base_input: minimum tokens out is 0/],
    ["cpmmStonkBuy", /swap_base_input: token account at position 4 must be the trading wallet's associated token account/],
    ["cpmmBaseOutput", /swap_base_output: token account at position 5 must be the trading wallet's associated token account/],
  ])("%s is refused (temporary non-ATA token accounts, zero minimums from bots, uncapped quote mints)", async (label, pattern) => {
    const { tx, ctx } = await replay(label);
    await expectRefused(tx, ctx, pattern);
  });
});
