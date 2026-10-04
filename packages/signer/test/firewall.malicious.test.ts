/**
 * Malicious corpus: what a compromised backend or front end could ask the trading wallet to sign.
 * Every case must be refused, with a violation that names the reason.
 */
import { describe, expect, test } from "bun:test";
import {
  type AccountMeta,
  AccountRole,
  type Address,
  createAddressWithSeed,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Instruction,
} from "@solana/kit";
import {
  getRequestUnitsInstruction,
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import {
  getAdvanceNonceAccountInstruction,
  getAssignInstruction,
  getAuthorizeNonceAccountInstruction,
  getCreateAccountInstruction,
  getCreateAccountWithSeedInstruction,
  getInitializeNonceAccountInstruction,
  getWithdrawNonceAccountInstruction,
} from "@solana-program/system";
import {
  AuthorityType,
  getApproveCheckedInstruction,
  getApproveInstruction,
  getBurnInstruction,
  getCloseAccountInstruction,
  getFreezeAccountInstruction,
  getMintToInstruction,
  getSetAuthorityInstruction,
  getTransferCheckedInstruction,
  getTransferInstruction,
} from "@solana-program/token";
import { findAssociatedTokenAddress } from "../src/firewall/ata";
import { decodeTransaction } from "../src/firewall/decode";
import { checkTransaction } from "../src/firewall/firewall";
import { SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT } from "../src/firewall/programs";
import { JUPITER_ROUTE_INSTRUCTIONS, JUPITER_ROUTE_V2_LAYOUT, JUPITER_SHARED_ROUTE_V2_LAYOUT } from "../src/firewall/rules/jupiter-idl";
import { createPumpSwapRule, findCanonicalPumpPool } from "../src/firewall/rules/pump";
import {
  CPMM_INSTRUCTION_NAMES,
  CPMM_STATIC_POSITIONS,
  CPMM_SWAP_INSTRUCTIONS,
  LAUNCHLAB_INSTRUCTION_NAMES,
  LAUNCHLAB_STATIC_POSITIONS,
  LAUNCHLAB_SWAP_INSTRUCTIONS,
  LAUNCHLAB_SWAP_LAYOUT,
} from "../src/firewall/rules/raydium-idl";
import {
  DEFAULT_CAPS,
  JITO_DONT_FRONT,
  JITO_TIP_ACCOUNTS,
  LAMPORTS_PER_SOL,
  MAINNET,
  makeActors,
  makeContext,
  PROGRAMS,
  RAYDIUM,
  randomAddress,
  type TestActors,
} from "./helpers/fixtures";
import { compileJupiter, JUPITER_ATTACKER, type JupiterCaseLabel, jupiterActors, jupiterCase, rawJupiterRoute } from "./helpers/jupiter";
import { ammExtendInstruction, ammInstruction, curveInstruction } from "./helpers/pump";
import {
  CPMM_COIN,
  cpmmInstruction,
  cpmmParams,
  cpmmPool,
  LAUNCHLAB_COIN,
  launchLabInstruction,
  launchLabParams,
  launchLabPool,
  STONK_COIN,
  stonkParams,
} from "./helpers/raydium";
import { AMM_COIN, ammParams, curveBuyV2, curveParams, expectAllowed, expectRefused } from "./helpers/scenarios";
import { buildTransaction, computeBudget, createAtaIdempotent, noop, tipWithDontFront, transferSol, withExtraAccounts } from "./helpers/tx";

const CAP = DEFAULT_CAPS.maxBuyLamports;
const USDC_CAP = DEFAULT_CAPS.maxBuyQuote[MAINNET.usdc]!;

function rawInstruction(
  programAddress: Address,
  discriminatorHex: string,
  accounts: AccountMeta[],
  args: Uint8Array = new Uint8Array(16),
): Instruction {
  const disc = Uint8Array.from(discriminatorHex.match(/../g)!.map((h) => Number.parseInt(h, 16)));
  return { programAddress, accounts, data: Uint8Array.from([...disc, ...args]) };
}

describe("firewall: drains through the System and Token programs", () => {
  test("SOL transfer to an attacker", async () => {
    const a = makeActors();
    await expectRefused(
      buildTransaction({ feePayer: a.signer, instructions: [transferSol(a.signer, a.attacker, LAMPORTS_PER_SOL)] }),
      makeContext(a),
      /not a tip account/,
    );
  });

  test("TransferChecked to an attacker's associated token account", async () => {
    const a = makeActors();
    const mint = MAINNET.curveMint;
    const ix = getTransferCheckedInstruction(
      {
        source: await findAssociatedTokenAddress(a.signer, mint, TOKEN_2022_PROGRAM),
        mint,
        destination: await findAssociatedTokenAddress(a.attacker, mint, TOKEN_2022_PROGRAM),
        authority: noop(a.signer),
        amount: 1_000_000n,
        decimals: 6,
      },
      { programAddress: TOKEN_2022_PROGRAM },
    );
    await expectRefused(
      buildTransaction({ feePayer: a.signer, instructions: [ix] }),
      makeContext(a),
      /not the associated token account of the trading wallet or the connected wallet/,
    );
  });

  test("TransferChecked to the connected wallet's ATA under the wrong token program", async () => {
    const a = makeActors();
    const mint = MAINNET.curveMint;
    const ix = getTransferCheckedInstruction(
      {
        source: await findAssociatedTokenAddress(a.signer, mint, TOKEN_2022_PROGRAM),
        mint,
        destination: await findAssociatedTokenAddress(a.connected, mint, TOKEN_PROGRAM),
        authority: noop(a.signer),
        amount: 1n,
        decimals: 6,
      },
      { programAddress: TOKEN_2022_PROGRAM },
    );
    await expectRefused(buildTransaction({ feePayer: a.signer, instructions: [ix] }), makeContext(a), /not the associated token account/);
  });

  test("Approve and ApproveChecked a delegate", async () => {
    const a = makeActors();
    const source = await findAssociatedTokenAddress(a.signer, MAINNET.curveMint, TOKEN_PROGRAM);
    const approve = getApproveInstruction({ source, delegate: a.attacker, owner: noop(a.signer), amount: 2n ** 64n - 1n });
    await expectRefused(buildTransaction({ feePayer: a.signer, instructions: [approve] }), makeContext(a), /Approve is not allowed/);
    const checked = getApproveCheckedInstruction({
      source,
      mint: MAINNET.curveMint,
      delegate: a.attacker,
      owner: noop(a.signer),
      amount: 1n,
      decimals: 6,
    });
    await expectRefused(buildTransaction({ feePayer: a.signer, instructions: [checked] }), makeContext(a), /ApproveChecked is not allowed/);
  });

  test("SetAuthority on the user's token account", async () => {
    const a = makeActors();
    const owned = await findAssociatedTokenAddress(a.signer, MAINNET.curveMint, TOKEN_2022_PROGRAM);
    const ix = getSetAuthorityInstruction(
      { owned, owner: noop(a.signer), authorityType: AuthorityType.AccountOwner, newAuthority: a.attacker },
      { programAddress: TOKEN_2022_PROGRAM },
    );
    await expectRefused(buildTransaction({ feePayer: a.signer, instructions: [ix] }), makeContext(a), /SetAuthority is not allowed/);
  });

  test("unchecked Transfer, Burn, MintTo and FreezeAccount", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const account = await findAssociatedTokenAddress(a.signer, MAINNET.curveMint, TOKEN_PROGRAM);
    const cases: [Instruction, RegExp][] = [
      [
        getTransferInstruction({ source: account, destination: account, authority: noop(a.signer), amount: 1n }),
        /Transfer \(unchecked\) is not allowed/,
      ],
      [getBurnInstruction({ account, mint: MAINNET.curveMint, authority: noop(a.signer), amount: 1n }), /Burn is not allowed/],
      [
        getMintToInstruction({ mint: MAINNET.curveMint, token: account, mintAuthority: noop(a.signer), amount: 1n }),
        /MintTo is not allowed/,
      ],
      [getFreezeAccountInstruction({ account, mint: MAINNET.curveMint, owner: noop(a.signer) }), /FreezeAccount is not allowed/],
    ];
    for (const [ix, pattern] of cases) await expectRefused(buildTransaction({ feePayer: a.signer, instructions: [ix] }), ctx, pattern);
  });

  test("CloseAccount sending the rent (or wrapped SOL) to an attacker", async () => {
    const a = makeActors();
    const ix = getCloseAccountInstruction({
      account: await findAssociatedTokenAddress(a.signer, WSOL_MINT, TOKEN_PROGRAM),
      destination: a.attacker,
      owner: noop(a.signer),
    });
    await expectRefused(
      buildTransaction({ feePayer: a.signer, instructions: [ix] }),
      makeContext(a),
      /rent may only go to the trading wallet or the connected wallet/,
    );
  });

  test("ATA creation funded by the trading wallet for an attacker", async () => {
    const a = makeActors();
    const ix = await createAtaIdempotent(a.signer, a.attacker, MAINNET.curveMint, TOKEN_2022_PROGRAM);
    await expectRefused(
      buildTransaction({ feePayer: a.signer, instructions: [ix] }),
      makeContext(a),
      /owner must be the trading wallet or the connected wallet/,
    );
  });

  test("System Assign, AuthorizeNonceAccount, and non-nonce CreateAccount", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const assign = getAssignInstruction({ account: noop(a.signer), programAddress: a.attacker });
    await expectRefused(buildTransaction({ feePayer: a.signer, instructions: [assign] }), ctx, /Assign is not allowed/);
    const authorize = getAuthorizeNonceAccountInstruction({
      nonceAccount: a.nonceAccount,
      nonceAuthority: noop(a.signer),
      newNonceAuthority: a.attacker,
    });
    await expectRefused(buildTransaction({ feePayer: a.signer, instructions: [authorize] }), ctx, /AuthorizeNonceAccount is not allowed/);
    const seed = "x";
    const newAccount = await createAddressWithSeed({ baseAddress: a.signer, programAddress: TOKEN_PROGRAM, seed });
    const createToken = getCreateAccountWithSeedInstruction({
      payer: noop(a.signer),
      newAccount,
      base: a.signer,
      seed,
      amount: 2_000_000n,
      space: 165n,
      programAddress: TOKEN_PROGRAM,
    });
    await expectRefused(buildTransaction({ feePayer: a.signer, instructions: [createToken] }), ctx, /only be created as nonce accounts/);
    // CreateAccount needs the new account's signature: refused as an extra signer, and as a non-nonce account.
    const create = getCreateAccountInstruction({
      payer: noop(a.signer),
      newAccount: noop(a.attacker),
      lamports: 1n,
      space: 0n,
      programAddress: a.attacker,
    });
    await expectRefused(
      buildTransaction({ feePayer: a.signer, instructions: [create] }),
      ctx,
      /only the trading wallet may sign[\s\S]*only be created as nonce accounts/,
    );
  });

  test("nonce misuse: foreign nonce, withdrawal to an attacker, uninitialized or orphan nonce creation", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const foreign = getAdvanceNonceAccountInstruction({ nonceAccount: randomAddress(), nonceAuthority: noop(a.signer) });
    await expectRefused(
      buildTransaction({ feePayer: a.signer, instructions: [foreign] }),
      ctx,
      /is not one of the trading wallet's nonce accounts/,
    );
    const withdraw = getWithdrawNonceAccountInstruction({
      nonceAccount: a.nonceAccount,
      recipientAccount: a.attacker,
      nonceAuthority: noop(a.signer),
      withdrawAmount: 1n,
    });
    await expectRefused(
      buildTransaction({ feePayer: a.signer, instructions: [withdraw] }),
      ctx,
      /withdrawals may only go to the trading wallet or the connected wallet/,
    );
    const seed = "nonce-1";
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
    await expectRefused(
      buildTransaction({ feePayer: a.signer, instructions: [create] }),
      ctx,
      /must be followed by InitializeNonceAccount/,
    );
    const initForAttacker = getInitializeNonceAccountInstruction({ nonceAccount, nonceAuthority: a.attacker });
    await expectRefused(
      buildTransaction({ feePayer: a.signer, instructions: [create, initForAttacker] }),
      ctx,
      /must be followed by InitializeNonceAccount|nonce authority must be the trading wallet/,
    );
    const orphanInit = getInitializeNonceAccountInstruction({ nonceAccount: a.nonceAccount, nonceAuthority: a.signer });
    await expectRefused(
      buildTransaction({ feePayer: a.signer, instructions: [orphanInit] }),
      ctx,
      /only allowed right after the instruction that creates this nonce account/,
    );
  });
});

describe("firewall: signatures, programs and fees", () => {
  test("program that is not allowlisted", async () => {
    const a = makeActors();
    const evil: Instruction = {
      programAddress: randomAddress(),
      accounts: [{ address: a.signer, role: AccountRole.WRITABLE_SIGNER }],
      data: new Uint8Array([1]),
    };
    await expectRefused(buildTransaction({ feePayer: a.signer, instructions: [evil] }), makeContext(a), /is not allowlisted/);
  });

  test("allowlisted program without a firewall rule (Jupiter allowlisted, its rule left out)", async () => {
    const a = makeActors();
    const ix: Instruction = {
      programAddress: PROGRAMS.jupiter,
      accounts: [{ address: a.signer, role: AccountRole.WRITABLE_SIGNER }],
      data: new Uint8Array(32),
    };
    const ctx = makeContext(a);
    const withoutRule = { ...ctx, venueRules: ctx.venueRules!.filter((r) => r.programId !== PROGRAMS.jupiter) };
    expect(withoutRule.allowedPrograms).toContain(PROGRAMS.jupiter);
    await expectRefused(buildTransaction({ feePayer: a.signer, instructions: [ix] }), withoutRule, /no firewall rule for program/);
  });

  test("fee-payer swap", async () => {
    const a = makeActors();
    const instructions = [await curveInstruction("buy_exact_quote_in_v2", curveParams(a), { spendable_quote_in: 1n, min_tokens_out: 1n })];
    const tx = buildTransaction({ feePayer: a.attacker, instructions });
    await expectRefused(tx, makeContext(a), /fee payer .* is not the trading wallet[\s\S]*requires 2 signatures/);
  });

  test("extra signer", async () => {
    const a = makeActors();
    const tip = withExtraAccounts(transferSol(a.signer, JITO_TIP_ACCOUNTS[0]!, 1_000n), {
      address: a.attacker,
      role: AccountRole.READONLY_SIGNER,
    });
    await expectRefused(buildTransaction({ feePayer: a.signer, instructions: [tip] }), makeContext(a), /requires 2 signatures/);
    // Funds sent from another signer's account: still a second signature.
    await expectRefused(
      buildTransaction({ feePayer: a.signer, instructions: [transferSol(a.attacker, a.connected, 1n)] }),
      makeContext(a),
      /only the trading wallet may sign[\s\S]*may only be sent from the trading wallet/,
    );
  });

  test("oversized tip, and tips that only exceed the cap together", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const max = DEFAULT_CAPS.maxTipLamports;
    await expectRefused(
      buildTransaction({ feePayer: a.signer, instructions: [transferSol(a.signer, JITO_TIP_ACCOUNTS[2]!, max + 1n)] }),
      ctx,
      /exceeds the cap/,
    );
    const split = [transferSol(a.signer, JITO_TIP_ACCOUNTS[2]!, max), transferSol(a.signer, JITO_TIP_ACCOUNTS[3]!, max)];
    await expectRefused(buildTransaction({ feePayer: a.signer, instructions: split }), ctx, /tips total/);
  });

  test("oversized priority fee, compute limit above the cap, duplicates and RequestUnits", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const tip = transferSol(a.signer, JITO_TIP_ACCOUNTS[0]!, 1_000n);
    // 400,000 CU x 12,500,001 micro-lamports = 5,000,000.4 lamports > 0.005 SOL cap
    await expectRefused(
      buildTransaction({ feePayer: a.signer, instructions: [...computeBudget(400_000, 12_500_001n), tip] }),
      ctx,
      /priority fee 5000001 lamports exceeds/,
    );
    // No explicit limit: priced at the 1.4M CU maximum.
    await expectRefused(
      buildTransaction({ feePayer: a.signer, instructions: [getSetComputeUnitPriceInstruction({ microLamports: 3_600_000n }), tip] }),
      ctx,
      /priority fee 5040000 lamports exceeds/,
    );
    await expectRefused(
      buildTransaction({ feePayer: a.signer, instructions: [...computeBudget(500_000, 1n), tip] }),
      ctx,
      /compute unit limit 500000 exceeds the cap/,
    );
    const dup = [getSetComputeUnitLimitInstruction({ units: 1000 }), getSetComputeUnitLimitInstruction({ units: 2000 }), tip];
    await expectRefused(buildTransaction({ feePayer: a.signer, instructions: dup }), ctx, /duplicate SetComputeUnitLimit/);
    await expectRefused(
      buildTransaction({ feePayer: a.signer, instructions: [getRequestUnitsInstruction({ units: 1, additionalFee: 1 }), tip] }),
      ctx,
      /RequestUnits/,
    );
  });

  test("a venue rule may not override a built-in program", async () => {
    const a = makeActors();
    const ctx = makeContext(a, { venueRules: [createPumpSwapRule({ programId: SYSTEM_PROGRAM, pumpProgramId: PROGRAMS.pump })] });
    await expectRefused(
      buildTransaction({ feePayer: a.signer, instructions: [transferSol(a.signer, a.connected, 1n)] }),
      ctx,
      /may not override built-in program/,
    );
  });
});

describe("firewall: pump.fun and PumpSwap", () => {
  test("pump buy with user != signer", async () => {
    const a = makeActors();
    const ix = await curveInstruction("buy_v2", curveParams(a, { user: a.connected }), { amount: 1n, max_sol_cost: 1n });
    await expectRefused(buildTransaction({ feePayer: a.signer, instructions: [ix] }), makeContext(a), /user must be the trading wallet/);
  });

  test("every buy variant above the per-trade cap", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const legacy = { ...curveParams(a), baseTokenProgram: TOKEN_PROGRAM };
    const usdc = { ...curveParams(a), quoteMint: MAINNET.usdc, quoteTokenProgram: TOKEN_PROGRAM };
    const variants: [string, Instruction][] = [
      ["curve buy.max_sol_cost", await curveInstruction("buy", legacy, { amount: 1n, max_sol_cost: CAP + 1n, track_volume: true })],
      [
        "curve buy_exact_sol_in.spendable_sol_in",
        await curveInstruction("buy_exact_sol_in", legacy, { spendable_sol_in: CAP + 1n, min_tokens_out: 1n }),
      ],
      ["curve buy_v2.max_sol_cost", await curveInstruction("buy_v2", curveParams(a), { amount: 1n, max_sol_cost: CAP + 1n })],
      [
        "curve buy_exact_quote_in_v2.spendable_quote_in",
        await curveInstruction("buy_exact_quote_in_v2", curveParams(a), { spendable_quote_in: CAP + 1n, min_tokens_out: 1n }),
      ],
      ["curve buy_v2 (USDC)", await curveInstruction("buy_v2", usdc, { amount: 1n, max_sol_cost: USDC_CAP + 1n })],
      [
        "curve buy_exact_quote_in_v2 (USDC)",
        await curveInstruction("buy_exact_quote_in_v2", usdc, { spendable_quote_in: USDC_CAP + 1n, min_tokens_out: 1n }),
      ],
      [
        "PumpSwap buy.max_quote_amount_in",
        await ammInstruction("buy", ammParams(a), { base_amount_out: 1n, max_quote_amount_in: CAP + 1n, track_volume: true }),
      ],
      [
        "PumpSwap buy_exact_quote_in.spendable_quote_in",
        await ammInstruction("buy_exact_quote_in", ammParams(a), {
          spendable_quote_in: CAP + 1n,
          min_base_amount_out: 1n,
          track_volume: false,
        }),
      ],
    ];
    for (const [name, ix] of variants) {
      const violations = await expectRefused(buildTransaction({ feePayer: a.signer, instructions: [ix] }), ctx, /above the per-trade cap/);
      expect({ name, refused: violations.length > 0 }).toEqual({ name, refused: true });
    }
    // At the cap exactly: allowed.
    await expectAllowed(
      buildTransaction({
        feePayer: a.signer,
        instructions: [await curveInstruction("buy_v2", curveParams(a), { amount: 1n, max_sol_cost: CAP })],
      }),
      ctx,
    );
  });

  test("zero minimum output on every sell variant and every exact-quote-in buy (minimum of 1 passes)", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const legacy = { ...curveParams(a), baseTokenProgram: TOKEN_PROGRAM };
    const variants: [string, (min: bigint) => Promise<Instruction>, RegExp][] = [
      ["curve sell", (min) => curveInstruction("sell", legacy, { amount: 10n ** 9n, min_sol_output: min }), /sells need a minimum/],
      ["curve sell_v2", (min) => curveInstruction("sell_v2", curveParams(a), { amount: 10n ** 9n, min_sol_output: min }), /sells need/],
      [
        "PumpSwap sell",
        (min) => ammInstruction("sell", ammParams(a), { base_amount_in: 10n ** 9n, min_quote_amount_out: min }),
        /sells need a minimum/,
      ],
      [
        "curve buy_exact_sol_in",
        (min) => curveInstruction("buy_exact_sol_in", legacy, { spendable_sol_in: 10n ** 8n, min_tokens_out: min }),
        /minimum tokens out is 0/,
      ],
      [
        "curve buy_exact_quote_in_v2",
        (min) => curveInstruction("buy_exact_quote_in_v2", curveParams(a), { spendable_quote_in: 10n ** 8n, min_tokens_out: min }),
        /minimum tokens out is 0/,
      ],
      [
        "PumpSwap buy_exact_quote_in",
        (min) =>
          ammInstruction("buy_exact_quote_in", ammParams(a), {
            spendable_quote_in: 10n ** 8n,
            min_base_amount_out: min,
            track_volume: true,
          }),
        /minimum tokens out is 0/,
      ],
    ];
    for (const [name, build, pattern] of variants) {
      const violations = await expectRefused(buildTransaction({ feePayer: a.signer, instructions: [await build(0n)] }), ctx, pattern);
      expect({ name, violations }).toEqual({ name, violations: [expect.stringContaining(`#0 `)] });
      await expectAllowed(buildTransaction({ feePayer: a.signer, instructions: [await build(1n)] }), ctx);
    }
  });

  test("two buys that each fit but together exceed the per-trade cap", async () => {
    const a = makeActors();
    const half = CAP / 2n + 1n;
    const ixs = [
      await curveInstruction("buy_v2", curveParams(a), { amount: 1n, max_sol_cost: half }),
      await curveInstruction("buy_exact_quote_in_v2", curveParams(a), { spendable_quote_in: half, min_tokens_out: 1n }),
    ];
    await expectRefused(buildTransaction({ feePayer: a.signer, instructions: ixs }), makeContext(a), /in total, above the per-trade cap/);
  });

  test("PumpSwap trades whose user token accounts are not the signer's ATAs", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const attackerBase = await findAssociatedTokenAddress(a.attacker, AMM_COIN, TOKEN_PROGRAM);
    const buy = await ammInstruction("buy", ammParams(a, { overrides: { user_base_token_account: attackerBase } }), {
      base_amount_out: 1n,
      max_quote_amount_in: 1n,
      track_volume: true,
    });
    await expectRefused(
      buildTransaction({ feePayer: a.signer, instructions: [buy] }),
      ctx,
      /token account at position 5 must be the trading wallet's associated token account/,
    );
    const attackerWsol = await findAssociatedTokenAddress(a.attacker, WSOL_MINT, TOKEN_PROGRAM);
    const sell = await ammInstruction("sell", ammParams(a, { overrides: { user_quote_token_account: attackerWsol } }), {
      base_amount_in: 1n,
      min_quote_amount_out: 1n,
    });
    await expectRefused(buildTransaction({ feePayer: a.signer, instructions: [sell] }), ctx, /token account at position 6/);
  });

  test("curve trades that redirect bought tokens or proceeds", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const attackerAta = await findAssociatedTokenAddress(a.attacker, MAINNET.curveMint, TOKEN_2022_PROGRAM);
    const buy = await curveInstruction("buy_v2", curveParams(a, { associated_base_user: attackerAta }), { amount: 1n, max_sol_cost: 1n });
    await expectRefused(buildTransaction({ feePayer: a.signer, instructions: [buy] }), ctx, /position 14/);
    const usdcProceeds = await findAssociatedTokenAddress(a.attacker, MAINNET.usdc, TOKEN_PROGRAM);
    const sell = await curveInstruction(
      "sell_v2",
      { ...curveParams(a, { associated_quote_user: usdcProceeds }), quoteMint: MAINNET.usdc, quoteTokenProgram: TOKEN_PROGRAM },
      { amount: 1n, min_sol_output: 0n },
    );
    await expectRefused(buildTransaction({ feePayer: a.signer, instructions: [sell] }), ctx, /position 15/);
    // The signer's own ATA, but under the wrong token program (SPL Token for a Token-2022 coin).
    const wrongProgram = await curveInstruction("buy_v2", curveParams(a, { base_token_program: TOKEN_PROGRAM }), {
      amount: 1n,
      max_sol_cost: 1n,
    });
    await expectRefused(buildTransaction({ feePayer: a.signer, instructions: [wrongProgram] }), ctx, /position 14/);
  });

  test("venue token program replaced by an arbitrary program (CPI with the user's signature)", async () => {
    const a = makeActors();
    const fake = randomAddress();
    const ix = await curveInstruction("buy_v2", curveParams(a, { base_token_program: fake }), { amount: 1n, max_sol_cost: 1n });
    await expectRefused(
      buildTransaction({ feePayer: a.signer, instructions: [ix] }),
      makeContext(a),
      /token program at position 3 must be SPL Token or Token-2022/,
    );
  });

  test("trading wallet smuggled into another account slot", async () => {
    const a = makeActors();
    const ix = await curveInstruction("buy_v2", curveParams(a, { fee_recipient: a.signer }), { amount: 1n, max_sol_cost: 1n });
    await expectRefused(buildTransaction({ feePayer: a.signer, instructions: [ix] }), makeContext(a), /unexpected position \(6\)/);
  });

  test("PumpSwap trades on a non-canonical (attacker-owned) pool, or a canonical pool from an ALT", async () => {
    const a = makeActors();
    // Anyone can create_pool a second pool for the same pair with themselves as LP; selling into it
    // at min_quote_amount_out = 0 would give them the tokens.
    const sell = await ammInstruction("sell", ammParams(a, { pool: MAINNET.ammPool }), {
      base_amount_in: 10n ** 15n,
      min_quote_amount_out: 0n,
    });
    await expectRefused(buildTransaction({ feePayer: a.signer, instructions: [sell] }), makeContext(a), /is not the canonical pool/);
    const buy = await ammInstruction("buy", ammParams(a, { pool: randomAddress() }), {
      base_amount_out: 1n,
      max_quote_amount_in: 1n,
      track_volume: true,
    });
    await expectRefused(buildTransaction({ feePayer: a.signer, instructions: [buy] }), makeContext(a), /is not the canonical pool/);
    const canonical = await findCanonicalPumpPool(PROGRAMS.pump, PROGRAMS.pumpAmm, AMM_COIN, WSOL_MINT);
    const alt = randomAddress();
    const tables = { [alt]: [canonical] };
    const viaAlt = buildTransaction({
      feePayer: a.signer,
      instructions: [await ammInstruction("sell", ammParams(a), { base_amount_in: 1n, min_quote_amount_out: 1n })],
      lookupTables: tables,
    });
    await expectRefused(viaAlt, makeContext(a, { addressLookupTables: tables }), /is not the canonical pool/);
  });

  test("PumpSwap pool with wSOL as the base asset (a 'sell' that spends SOL uncapped)", async () => {
    const a = makeActors();
    const junk = randomAddress();
    const ctx = makeContext(a, { caps: { ...DEFAULT_CAPS, maxBuyQuote: { ...DEFAULT_CAPS.maxBuyQuote, [junk]: 10n ** 30n } } });
    const sell = await ammInstruction("sell", ammParams(a, { baseMint: WSOL_MINT, quoteMint: junk }), {
      base_amount_in: 50n * LAMPORTS_PER_SOL,
      min_quote_amount_out: 0n,
    });
    await expectRefused(buildTransaction({ feePayer: a.signer, instructions: [sell] }), ctx, /is a quote asset/);
  });

  test("buy quoted in a mint with no configured cap", async () => {
    const a = makeActors();
    const quote = randomAddress();
    const ix = await ammInstruction("buy_exact_quote_in", ammParams(a, { quoteMint: quote }), {
      spendable_quote_in: 1n,
      min_base_amount_out: 1n,
      track_volume: true,
    });
    await expectRefused(
      buildTransaction({ feePayer: a.signer, instructions: [ix] }),
      makeContext(a),
      /no per-trade cap is configured for quote mint/,
    );
  });

  test("unknown pump.fun / PumpSwap instructions (migrate, collect_creator_fee, withdraw, curve extend_account)", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const signerMeta: AccountMeta = { address: a.signer, role: AccountRole.WRITABLE_SIGNER };
    const cases: [Address, string, RegExp][] = [
      [PROGRAMS.pump, "9beae792ec9ea21e", /"migrate" is not allowed/],
      [PROGRAMS.pump, "1416567bc61cdb84", /"collect_creator_fee" is not allowed/],
      [PROGRAMS.pump, "d6904cec5f8b31b4", /"create_v2" is not allowed/],
      // Same discriminator as PumpSwap's, but the curve's extend_account has no use in a trade.
      [PROGRAMS.pump, "ea66c2cb96483ee5", /"extend_account" is not allowed/],
      [PROGRAMS.pumpAmm, "b712469c946da122", /"withdraw" is not allowed \(only buy, buy_exact_quote_in, sell, extend_account\)/],
      [PROGRAMS.pumpAmm, "0102030405060708", /"unknown 0102030405060708" is not allowed/],
    ];
    for (const [program, disc, pattern] of cases) {
      await expectRefused(
        buildTransaction({
          feePayer: a.signer,
          instructions: [rawInstruction(program, disc, [signerMeta, { address: a.attacker, role: AccountRole.WRITABLE }])],
        }),
        ctx,
        pattern,
      );
    }
  });

  test("malformed venue data: bad track_volume flag, truncated arguments, missing remaining accounts", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const ix = await ammInstruction("buy", ammParams(a), { base_amount_out: 1n, max_quote_amount_in: 1n, track_volume: true });
    const badFlag = { ...ix, data: Uint8Array.from([...(ix.data ?? []).slice(0, 24), 2]) };
    await expectRefused(buildTransaction({ feePayer: a.signer, instructions: [badFlag] }), ctx, /invalid track_volume flag/);
    const truncated = { ...ix, data: (ix.data ?? new Uint8Array()).slice(0, 20) };
    await expectRefused(buildTransaction({ feePayer: a.signer, instructions: [truncated] }), ctx, /data must be 24 or 25 bytes/);
    const preUpgrade = { ...ix, accounts: (ix.accounts ?? []).slice(0, 23) }; // no buyback remaining accounts (pre 2026-04-28)
    await expectRefused(buildTransaction({ feePayer: a.signer, instructions: [preUpgrade] }), ctx, /expected 25 or 26 or 27 accounts/);
  });
});

describe("firewall: extra accounts and lookup tables", () => {
  test("non-jitodontfront extra accounts are refused", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const tip = withExtraAccounts(transferSol(a.signer, JITO_TIP_ACCOUNTS[0]!, 1_000n), {
      address: randomAddress(),
      role: AccountRole.WRITABLE,
    });
    await expectRefused(buildTransaction({ feePayer: a.signer, instructions: [tip] }), ctx, /expected 2 accounts/);
    const buy = await curveInstruction(
      "buy_v2",
      curveParams(a),
      { amount: 1n, max_sol_cost: 1n },
      { extraAccounts: [{ address: randomAddress(), role: AccountRole.READONLY }] },
    );
    await expectRefused(buildTransaction({ feePayer: a.signer, instructions: [buy] }), ctx, /expected 27 accounts/);
  });

  test("jitodontfront marker that is writable, or loaded from a lookup table", async () => {
    const a = makeActors();
    const writable = tipWithDontFront(a.signer, JITO_TIP_ACCOUNTS[0]!, 1_000n, { address: JITO_DONT_FRONT, role: AccountRole.WRITABLE });
    await expectRefused(
      buildTransaction({ feePayer: a.signer, instructions: [writable] }),
      makeContext(a),
      /must be read-only, non-signer and not loaded from a lookup table/,
    );
    const alt = randomAddress();
    const tables = { [alt]: [JITO_DONT_FRONT] };
    const loaded = buildTransaction({
      feePayer: a.signer,
      instructions: [tipWithDontFront(a.signer, JITO_TIP_ACCOUNTS[0]!, 1_000n)],
      lookupTables: tables,
    });
    await expectRefused(loaded, makeContext(a, { addressLookupTables: tables }), /not loaded from a lookup table/);
  });

  test("missing address lookup table", async () => {
    const a = makeActors();
    const alt = randomAddress();
    const tables = { [alt]: [MAINNET.pumpGlobal, MAINNET.pumpFeeConfig] };
    const tx = buildTransaction({ feePayer: a.signer, instructions: await curveBuyV2(a), lookupTables: tables });
    await expectRefused(tx, makeContext(a), /address lookup table .* was not provided/);
    await expectRefused(tx, makeContext(a, { addressLookupTables: { [alt]: [MAINNET.pumpGlobal] } }), /has no entry 1/);
  });

  test("fund destinations and user token accounts cannot come from lookup tables (ALT contents are untrusted)", async () => {
    const a = makeActors();
    const alt = randomAddress();
    // A lying ALT could claim this index is the connected wallet while the chain loads the attacker.
    const tables = { [alt]: [a.connected] };
    const withdraw = buildTransaction({
      feePayer: a.signer,
      instructions: [transferSol(a.signer, a.connected, LAMPORTS_PER_SOL)],
      lookupTables: tables,
    });
    await expectRefused(withdraw, makeContext(a, { addressLookupTables: tables }), /destination must be a static account key/);
    const userAta = await findAssociatedTokenAddress(a.signer, MAINNET.curveMint, TOKEN_2022_PROGRAM);
    const ataTables = { [alt]: [userAta] };
    const buy = buildTransaction({
      feePayer: a.signer,
      instructions: [await curveInstruction("buy_v2", curveParams(a), { amount: 1n, max_sol_cost: 1n })],
      lookupTables: ataTables,
    });
    await expectRefused(
      buy,
      makeContext(a, { addressLookupTables: ataTables }),
      /position 14 must be the trading wallet's associated token account/,
    );
  });
});

describe("firewall: mints from lookup tables, rent and nonce funding", () => {
  test("a curve quote mint claimed through an ALT cannot steer which cap applies", async () => {
    // Caller claims ALT entry 0 is USDC (so max_sol_cost would be checked against the USDC cap);
    // on chain the table could hold wSOL and the program would run an uncapped SOL buy.
    const a = makeActors();
    const userUsdcAta = await findAssociatedTokenAddress(a.signer, MAINNET.usdc, TOKEN_PROGRAM);
    const ix = await curveInstruction("buy_v2", curveParams(a, { quote_mint: MAINNET.usdc, associated_quote_user: userUsdcAta }), {
      amount: 1n,
      max_sol_cost: 400_000_000n,
    });
    const alt = randomAddress();
    const tables = { [alt]: [MAINNET.usdc] };
    const tx = buildTransaction({ feePayer: a.signer, instructions: [ix], lookupTables: tables });
    await expectRefused(tx, makeContext(a, { addressLookupTables: tables }), /quote mint must be a static account key/);
  });

  test("TransferChecked and ATA creation refuse mints loaded from lookup tables", async () => {
    const a = makeActors();
    const mint = MAINNET.curveMint;
    const alt = randomAddress();
    const tables = { [alt]: [mint] };
    const transfer = getTransferCheckedInstruction(
      {
        source: await findAssociatedTokenAddress(a.signer, mint, TOKEN_2022_PROGRAM),
        mint,
        destination: await findAssociatedTokenAddress(a.connected, mint, TOKEN_2022_PROGRAM),
        authority: noop(a.signer),
        amount: 1n,
        decimals: 6,
      },
      { programAddress: TOKEN_2022_PROGRAM },
    );
    const create = await createAtaIdempotent(a.signer, a.connected, mint, TOKEN_2022_PROGRAM);
    const tx = buildTransaction({ feePayer: a.signer, instructions: [create, transfer], lookupTables: tables });
    const violations = await expectRefused(tx, makeContext(a, { addressLookupTables: tables }), /mint must be a static account key/);
    expect(violations.filter((v) => /mint must be a static account key/.test(v))).toHaveLength(2);
  });

  test("token accounts may only be created for mints the transaction trades or transfers", async () => {
    const a = makeActors();
    const griefing: Instruction[] = [];
    for (let i = 0; i < 3; i++) griefing.push(await createAtaIdempotent(a.signer, a.signer, randomAddress(), TOKEN_PROGRAM));
    await expectRefused(buildTransaction({ feePayer: a.signer, instructions: griefing }), makeContext(a), /neither trades nor transfers/);
    // Creating the ATA of the coin being bought (and wSOL) stays allowed.
    await expectAllowed(buildTransaction({ feePayer: a.signer, instructions: await curveBuyV2(a) }), makeContext(a));
  });

  test("nonce accounts cannot be funded beyond the cap", async () => {
    const a = makeActors();
    const seed = "nonce-9";
    const nonceAccount = await createAddressWithSeed({ baseAddress: a.signer, programAddress: SYSTEM_PROGRAM, seed });
    const create = (amount: bigint) =>
      getCreateAccountWithSeedInstruction({
        payer: noop(a.signer),
        newAccount: nonceAccount,
        base: a.signer,
        seed,
        amount,
        space: 80n,
        programAddress: SYSTEM_PROGRAM,
      });
    const init = getInitializeNonceAccountInstruction({ nonceAccount, nonceAuthority: a.signer });
    const tx = (amount: bigint) => buildTransaction({ feePayer: a.signer, instructions: [create(amount), init] });
    await expectRefused(tx(50n * LAMPORTS_PER_SOL), makeContext(a), /above the cap of 2000000/);
    const strict = makeContext(a, { caps: { ...DEFAULT_CAPS, maxNonceAccountLamports: 1_000_000n } });
    await expectRefused(tx(1_500_000n), strict, /above the cap of 1000000/);
    await expectAllowed(tx(1_500_000n), makeContext(a));
  });
});

describe("firewall: PumpSwap extend_account (the trading wallet pays the rent)", () => {
  const canonicalPool = () => findCanonicalPumpPool(PROGRAMS.pump, PROGRAMS.pumpAmm, AMM_COIN, WSOL_MINT);
  const sell = (a: TestActors, extra: Partial<Parameters<typeof ammParams>[1]> = {}) =>
    ammInstruction("sell", ammParams(a, extra), { base_amount_in: 1n, min_quote_amount_out: 1n });
  const tx = (a: TestActors, instructions: Instruction[]) => buildTransaction({ feePayer: a.signer, instructions });

  test("on an account that is not the pool of a trade in the transaction", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const pool = await canonicalPool();
    const extend = (account: Address) => ammExtendInstruction({ user: a.signer, account });
    const notTraded = /is not the pool of a PumpSwap trade in this transaction/;
    await expectRefused(tx(a, [await extend(pool)]), ctx, notTraded);
    const curveBuy = await curveInstruction("buy_v2", curveParams(a), { amount: 1n, max_sol_cost: 1n });
    await expectRefused(tx(a, [await extend(pool), curveBuy]), ctx, notTraded);
    // While trading AMM_COIN: another coin's canonical pool, the AMM's GlobalConfig, any other account.
    const otherCoinPool = await findCanonicalPumpPool(PROGRAMS.pump, PROGRAMS.pumpAmm, randomAddress(), WSOL_MINT);
    for (const account of [otherCoinPool, MAINNET.ammGlobalConfig, randomAddress()]) {
      await expectRefused(tx(a, [await extend(account), await sell(a)]), ctx, notTraded);
    }
  });

  test("on a non-canonical pool, even when the opt-out lets the trade itself through", async () => {
    const a = makeActors();
    const attackerPool = randomAddress();
    const instructions = [await ammExtendInstruction({ user: a.signer, account: attackerPool }), await sell(a, { pool: attackerPool })];
    await expectRefused(tx(a, instructions), makeContext(a), /is not the canonical pool[\s\S]*only that pool may be extended/);
    const optOut = createPumpSwapRule({ programId: PROGRAMS.pumpAmm, pumpProgramId: PROGRAMS.pump, allowNonCanonicalPools: true });
    const violations = await expectRefused(tx(a, instructions), makeContext(a, { venueRules: [optOut] }), /only that pool may be extended/);
    expect(violations).toHaveLength(1);
  });

  test("rent paid by an account other than the trading wallet", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const pool = await canonicalPool();
    // An attacker as payer must co-sign; the connected wallet named as payer without a signature.
    await expectRefused(
      tx(a, [await ammExtendInstruction({ user: a.attacker, account: pool }), await sell(a)]),
      ctx,
      /requires 2 signatures[\s\S]*rent payer \(user\) must be the trading wallet/,
    );
    const viaConnected = await ammExtendInstruction({ user: a.connected, account: pool });
    const unsigned: Instruction = {
      ...viaConnected,
      accounts: (viaConnected.accounts ?? []).map((m, i) => (i === 1 ? { address: a.connected, role: AccountRole.WRITABLE } : m)),
    };
    await expectRefused(tx(a, [unsigned, await sell(a)]), ctx, /rent payer \(user\) must be the trading wallet/);
  });

  test("a program other than System in the system_program slot (it runs with the wallet's signature)", async () => {
    const a = makeActors();
    const ix = await ammExtendInstruction({
      user: a.signer,
      account: await canonicalPool(),
      overrides: { system_program: randomAddress() },
    });
    await expectRefused(tx(a, [ix, await sell(a)]), makeContext(a), /position 2 must be the System program/);
  });

  test("twice in one transaction, malformed, or with the pool loaded from a lookup table", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const pool = await canonicalPool();
    const extend = await ammExtendInstruction({ user: a.signer, account: pool });
    const trade = await sell(a);
    await expectRefused(tx(a, [extend, extend, trade]), ctx, /only one extend_account per transaction/);
    await expectRefused(tx(a, [{ ...extend, data: Uint8Array.from([...(extend.data ?? []), 0]) }, trade]), ctx, /data must be 8 bytes/);
    const extra = await ammExtendInstruction(
      { user: a.signer, account: pool },
      { extraAccounts: [{ address: randomAddress(), role: AccountRole.WRITABLE }] },
    );
    await expectRefused(tx(a, [extra, trade]), ctx, /expected 5 accounts/);
    const alt = randomAddress();
    const tables = { [alt]: [pool] };
    const viaAlt = buildTransaction({ feePayer: a.signer, instructions: [extend, trade], lookupTables: tables });
    await expectRefused(viaAlt, makeContext(a, { addressLookupTables: tables }), /extended account must be a static account key/);
  });
});

// ---------------------------------------------------------------------------------------------
// Raydium LaunchLab and CPMM
// ---------------------------------------------------------------------------------------------

const tx1 = (a: TestActors, ...instructions: Instruction[]) => buildTransaction({ feePayer: a.signer, instructions });
const signerMeta = (a: TestActors): AccountMeta => ({ address: a.signer, role: AccountRole.WRITABLE_SIGNER });
const attackerMeta = (a: TestActors): AccountMeta => ({ address: a.attacker, role: AccountRole.WRITABLE });
/** A cap configured for the xStock quote, as a user would set one in their caps. */
const withXStockCap = (a: TestActors, cap = 10n ** 9n) =>
  makeContext(a, { caps: { ...DEFAULT_CAPS, maxBuyQuote: { ...DEFAULT_CAPS.maxBuyQuote, [RAYDIUM.xStock]: cap } } });
const xStockQuote = { quoteMint: RAYDIUM.xStock, quoteTokenProgram: TOKEN_2022_PROGRAM, platformConfig: RAYDIUM.stonkPlatform };

/**
 * Moves the account at each position into an address lookup table (one at a time) and checks that the
 * firewall refuses exactly the positions it documents as static.
 */
async function expectStaticPositions(a: TestActors, ix: Instruction, staticPositions: readonly number[], skip: readonly number[]) {
  const accounts = ix.accounts ?? [];
  const outcomes: { position: number; refused: boolean }[] = [];
  for (let i = 1; i < accounts.length; i++) {
    if (skip.includes(i)) continue;
    const alt = randomAddress();
    const tables = { [alt]: [accounts[i]!.address] };
    const tx = buildTransaction({ feePayer: a.signer, instructions: [ix], lookupTables: tables });
    const decoded = decodeTransaction(tx, tables);
    if (!decoded.ok) throw new Error(decoded.violations.join("; "));
    expect({ position: i, loaded: decoded.tx.accounts.find((x) => x.address === accounts[i]!.address)?.isStatic === false }).toEqual({
      position: i,
      loaded: true,
    });
    const result = await checkTransaction(tx, makeContext(a, { addressLookupTables: tables }));
    outcomes.push({ position: i, refused: !result.ok });
  }
  expect(outcomes).toEqual(outcomes.map(({ position }) => ({ position, refused: staticPositions.includes(position) })));
}

describe("firewall: Raydium LaunchLab", () => {
  const buy = (a: TestActors, extra: Partial<Parameters<typeof launchLabParams>[1]> = {}, args: Record<string, bigint> = {}) =>
    launchLabInstruction("buy_exact_in", launchLabParams(a, extra), { amount_in: 10n ** 8n, minimum_amount_out: 1n, ...args });
  const sell = (a: TestActors, extra: Partial<Parameters<typeof launchLabParams>[1]> = {}, args: Record<string, bigint> = {}) =>
    launchLabInstruction("sell_exact_in", launchLabParams(a, extra), { amount_in: 10n ** 9n, minimum_amount_out: 1n, ...args });

  test("every instruction but the four swaps is refused by name (claims, migrations, launches, admin)", async () => {
    const a = makeActors();
    const swaps = new Set(LAUNCHLAB_SWAP_INSTRUCTIONS.map((d) => d.name));
    const others = Object.entries(LAUNCHLAB_INSTRUCTION_NAMES).filter(([, name]) => !swaps.has(name));
    expect(others.map(([, name]) => name)).toContain("migrate_to_cpswap");
    expect(others).toHaveLength(21);
    for (const [hex, name] of [...others, ["0102030405060708", "unknown 0102030405060708"]] as const) {
      const ix = rawInstruction(PROGRAMS.raydiumLaunchLab, hex, [signerMeta(a), attackerMeta(a)], new Uint8Array(24));
      await expectRefused(
        tx1(a, ix),
        makeContext(a),
        new RegExp(
          `#0 Raydium LaunchLab: instruction "${name}" is not allowed \\(only buy_exact_in, buy_exact_out, sell_exact_in, sell_exact_out\\)`,
        ),
      );
    }
  });

  test("a referral share fee: share_fee_rate > 0, with or without the share_fee_receiver it pays", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const attackerWsol = await findAssociatedTokenAddress(a.attacker, WSOL_MINT, TOKEN_PROGRAM);
    // 18 accounts and a 1% share fee: refused on the argument alone.
    const alone = await expectRefused(
      tx1(a, await buy(a, {}, { share_fee_rate: 10_000n })),
      ctx,
      /#0 Raydium LaunchLab buy_exact_in: share_fee_rate must be 0, got 10000/,
    );
    expect(alone).toHaveLength(1);
    // What a share fee really needs: the receiver goes before the remaining accounts (19 accounts).
    const withReceiver = await expectRefused(
      tx1(a, await sell(a, { shareFeeReceiver: attackerWsol }, { share_fee_rate: 10_000n })),
      ctx,
      /#0 Raydium LaunchLab sell_exact_in: share_fee_rate must be 0, got 10000/,
    );
    expect(withReceiver.join("\n")).toMatch(/expected 18 accounts \(plus optional trailing jitodontfront markers\), got 19/);
    // A receiver with share_fee_rate 0 is still one account too many.
    await expectRefused(tx1(a, await sell(a, { shareFeeReceiver: attackerWsol })), ctx, /sell_exact_in: expected 18 accounts .*got 19/);
    for (const d of LAUNCHLAB_SWAP_INSTRUCTIONS) {
      const ix = await launchLabInstruction(d.name as "buy_exact_in", launchLabParams(a), {
        amount_in: 1n,
        amount_out: 1n,
        minimum_amount_out: 1n,
        maximum_amount_in: 1n,
        share_fee_rate: 1n,
      });
      await expectRefused(tx1(a, ix), ctx, new RegExp(`${d.name}: share_fee_rate must be 0, got 1 `));
    }
  });

  test("a payer other than the trading wallet, or the trading wallet in another position", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    await expectRefused(
      tx1(a, await buy(a, { user: a.connected })),
      ctx,
      /requires 2 signatures[\s\S]*buy_exact_in: user must be the trading wallet/,
    );
    const unsigned = await buy(a);
    const asConnected: Instruction = {
      ...unsigned,
      accounts: (unsigned.accounts ?? []).map((m, i) => (i === 0 ? { address: a.connected, role: AccountRole.WRITABLE } : m)),
    };
    await expectRefused(tx1(a, asConnected), ctx, /user must be the trading wallet/);
    await expectRefused(tx1(a, await buy(a, { remaining: { creatorFeeVault: a.signer } })), ctx, /unexpected position \(17\)/);
    await expectRefused(tx1(a, await sell(a, { overrides: { global_config: a.signer } })), ctx, /unexpected position \(2\)/);
  });

  test("bought tokens or sale proceeds paid to anything but the trading wallet's own ATA", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const position5 = /buy_exact_in: token account at position 5 must be the trading wallet's associated token account for /;
    const position6 = /sell_exact_in: token account at position 6 must be the trading wallet's associated token account for /;
    const attackerCoin = await findAssociatedTokenAddress(a.attacker, LAUNCHLAB_COIN, TOKEN_PROGRAM);
    await expectRefused(tx1(a, await buy(a, { overrides: { user_base_token: attackerCoin } })), ctx, position5);
    for (const owner of [a.attacker, a.connected]) {
      const proceeds = await findAssociatedTokenAddress(owner, WSOL_MINT, TOKEN_PROGRAM);
      await expectRefused(tx1(a, await sell(a, { overrides: { user_quote_token: proceeds } })), ctx, position6);
    }
    // A wSOL account the trading wallet controls but that is not its ATA (as some bots use).
    const temporary = await createAddressWithSeed({ baseAddress: a.signer, programAddress: TOKEN_PROGRAM, seed: "wsol" });
    await expectRefused(tx1(a, await sell(a, { overrides: { user_quote_token: temporary } })), ctx, position6);
    // The trading wallet's ATA under the wrong token program (SPL Token for a Token-2022 coin).
    const wrongProgram = await launchLabInstruction("buy_exact_in", stonkParams(a, { overrides: { base_token_program: TOKEN_PROGRAM } }), {
      amount_in: 1n,
      minimum_amount_out: 1n,
    });
    await expectRefused(tx1(a, wrongProgram), ctx, position5);
  });

  test("token programs replaced by an arbitrary program (the venue CPIs into them with the payer's signature)", async () => {
    const a = makeActors();
    const fake = randomAddress();
    await expectRefused(
      tx1(a, await buy(a, { overrides: { base_token_program: fake } })),
      makeContext(a),
      /token program at position 11 must be SPL Token or Token-2022 \(static key\)/,
    );
    await expectRefused(
      tx1(a, await sell(a, { overrides: { quote_token_program: fake } })),
      makeContext(a),
      /token program at position 12 must be SPL Token or Token-2022 \(static key\)/,
    );
  });

  test("wrong fixed accounts: vault authority, event authority, System program", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const cases: [Partial<Parameters<typeof launchLabParams>[1]>, RegExp][] = [
      [
        { overrides: { authority: a.attacker } },
        /position 1 must be the vault authority WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh, not /,
      ],
      [
        { overrides: { event_authority: a.attacker } },
        /position 13 must be the event authority 2DPAtwB8L12vrMRExbLuyGnC7n2J5LNoZQSejeQGpwkr, not /,
      ],
      [
        { remaining: { systemProgram: randomAddress() } },
        /position 15 must be the System program, not \w+ \(it is invoked with the trading wallet's signature\)/,
      ],
    ];
    for (const [extra, pattern] of cases) {
      const violations = await expectRefused(tx1(a, await buy(a, extra)), ctx, pattern);
      expect(violations).toHaveLength(1);
    }
  });

  test('a pool that is not PDA["pool", base, quote], and a platform fee vault that is not PDA[platform_config, quote]', async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const notPool = new RegExp(`pool \\w+ at position 4 is not the LaunchLab pool for ${LAUNCHLAB_COIN} / ${WSOL_MINT}`);
    for (const pool of [await launchLabPool(STONK_COIN), await launchLabPool(LAUNCHLAB_COIN, MAINNET.usdc), randomAddress()]) {
      await expectRefused(tx1(a, await sell(a, { overrides: { pool_state: pool } })), ctx, notPool);
    }
    const notVault = /platform fee vault \w+ at position 16 is not the PDA \[platform_config /;
    const attackerWsol = await findAssociatedTokenAddress(a.attacker, WSOL_MINT, TOKEN_PROGRAM);
    await expectRefused(tx1(a, await sell(a, { remaining: { platformFeeVault: attackerWsol } })), ctx, notVault);
    // Another launchpad's fee vault, or the platform config swapped without its vault.
    const stonkVault = (
      await getProgramDerivedAddress({
        programAddress: PROGRAMS.raydiumLaunchLab,
        seeds: [getAddressEncoder().encode(RAYDIUM.stonkPlatform), getAddressEncoder().encode(WSOL_MINT)],
      })
    )[0];
    await expectRefused(tx1(a, await buy(a, { remaining: { platformFeeVault: stonkVault } })), ctx, notVault);
    await expectRefused(tx1(a, await buy(a, { overrides: { platform_config: RAYDIUM.stonkPlatform } })), ctx, notVault);
  });

  test("lookup tables: every checked account must be a static key; the venue-validated ones may be loaded", async () => {
    const a = makeActors();
    // A Token-2022 coin, so that both token programs are distinct accounts. Position 14 is the invoked program.
    const ix = await launchLabInstruction("sell_exact_in", stonkParams(a), { amount_in: 1n, minimum_amount_out: 1n });
    await expectStaticPositions(a, ix, LAUNCHLAB_STATIC_POSITIONS, [LAUNCHLAB_SWAP_LAYOUT.program]);
  });

  test("every buy above the per-trade cap (buy_exact_in amount_in, buy_exact_out maximum_amount_in), at the cap passes", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const usdc = { quoteMint: MAINNET.usdc };
    const variants: [string, Instruction][] = [
      ["buy_exact_in", await buy(a, {}, { amount_in: CAP + 1n })],
      ["buy_exact_out", await launchLabInstruction("buy_exact_out", launchLabParams(a), { amount_out: 1n, maximum_amount_in: CAP + 1n })],
      ["buy_exact_in (USDC)", await buy(a, usdc, { amount_in: USDC_CAP + 1n })],
      [
        "buy_exact_out (USDC)",
        await launchLabInstruction("buy_exact_out", launchLabParams(a, usdc), { amount_out: 1n, maximum_amount_in: USDC_CAP + 1n }),
      ],
    ];
    for (const [name, ix] of variants) {
      const violations = await expectRefused(
        tx1(a, ix),
        ctx,
        /#0 Raydium LaunchLab buy_exact_(in|out): spends up to .* above the per-trade cap/,
      );
      expect({ name, refused: violations.length > 0 }).toEqual({ name, refused: true });
    }
    await expectAllowed(tx1(a, await buy(a, {}, { amount_in: CAP })), ctx);
    await expectAllowed(
      tx1(a, await launchLabInstruction("buy_exact_out", launchLabParams(a, usdc), { amount_out: 1n, maximum_amount_in: USDC_CAP })),
      ctx,
    );
  });

  test("a quote mint without a configured cap (an xStock, a USD1-style stable) is refused for buys and sells until one is set", async () => {
    const a = makeActors();
    const usd1Style = { quoteMint: randomAddress() };
    for (const quote of [xStockQuote, usd1Style]) {
      const noCap = new RegExp(`no per-trade cap is configured for quote mint ${quote.quoteMint}`);
      await expectRefused(tx1(a, await buy(a, quote, { amount_in: 1n })), makeContext(a), noCap);
      await expectRefused(tx1(a, await sell(a, quote)), makeContext(a), noCap);
    }
    // With a cap for the xStock: both pass, and buys count against that cap.
    const summary = await expectAllowed(tx1(a, await buy(a, xStockQuote, { amount_in: 5_000_000n })), withXStockCap(a));
    expect(summary.maxBuyQuote).toEqual({ [RAYDIUM.xStock]: 5_000_000n });
    expect(summary.maxBuyLamports).toBe(0n);
    await expectAllowed(tx1(a, await sell(a, xStockQuote)), withXStockCap(a));
    await expectRefused(
      tx1(a, await buy(a, xStockQuote, { amount_in: 5_000_001n })),
      withXStockCap(a, 5_000_000n),
      /above the per-trade cap/,
    );
  });

  test("the coin is itself a quote asset (a sell of wSOL would be an uncapped buy of the quote)", async () => {
    const a = makeActors();
    const ix = await sell(a, { baseMint: WSOL_MINT, quoteMint: MAINNET.usdc }, { amount_in: 50n * LAMPORTS_PER_SOL });
    await expectRefused(tx1(a, ix), makeContext(a), new RegExp(`base mint ${WSOL_MINT} is a quote asset`));
  });

  test("zero minimum output on sell_exact_in, sell_exact_out (amount_out 0) and buy_exact_in; a minimum of 1 passes", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const variants: [string, (min: bigint) => Promise<Instruction>, RegExp][] = [
      ["sell_exact_in", (min) => sell(a, {}, { minimum_amount_out: min }), /sells need a minimum above zero/],
      [
        "sell_exact_out",
        (min) => launchLabInstruction("sell_exact_out", launchLabParams(a), { amount_out: min, maximum_amount_in: 10n ** 12n }),
        /sells need a minimum above zero/,
      ],
      ["buy_exact_in", (min) => buy(a, {}, { minimum_amount_out: min }), /minimum tokens out is 0/],
    ];
    for (const [name, build, pattern] of variants) {
      const violations = await expectRefused(tx1(a, await build(0n)), ctx, pattern);
      expect({ name, violations }).toEqual({ name, violations: [expect.stringContaining(`#0 Raydium LaunchLab ${name}: `)] });
      await expectAllowed(tx1(a, await build(1n)), ctx);
    }
  });

  test("malformed: wrong data length, the 15 IDL accounts without the fee-vault accounts, an extra account", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const ix = await buy(a);
    await expectRefused(tx1(a, { ...ix, data: Uint8Array.from([...(ix.data ?? []), 0]) }), ctx, /buy_exact_in: data must be 32 bytes/);
    await expectRefused(tx1(a, { ...ix, data: (ix.data ?? new Uint8Array()).slice(0, 24) }), ctx, /data must be 32 bytes/);
    await expectRefused(tx1(a, { ...ix, accounts: (ix.accounts ?? []).slice(0, 15) }), ctx, /expected 18 accounts .*got 15/);
    const extra = await buy(a, {}, {});
    await expectRefused(tx1(a, withExtraAccounts(extra, { address: randomAddress(), role: AccountRole.READONLY })), ctx, /got 19/);
    // A trailing read-only jitodontfront marker is fine, as on every other instruction.
    await expectAllowed(tx1(a, withExtraAccounts(extra, { address: JITO_DONT_FRONT, role: AccountRole.READONLY })), ctx);
  });
});

describe("firewall: Raydium CPMM", () => {
  const swap = (
    a: TestActors,
    side: "buy" | "sell",
    extra: Partial<Parameters<typeof cpmmParams>[2]> = {},
    args: Record<string, bigint> = {},
  ) => cpmmInstruction("swap_base_input", cpmmParams(a, side, extra), { amount_in: 10n ** 8n, minimum_amount_out: 1n, ...args });

  test("every instruction but the two swaps is refused by name (deposit, withdraw, initialize, fee collection, admin)", async () => {
    const a = makeActors();
    const swaps = new Set(CPMM_SWAP_INSTRUCTIONS.map((d) => d.name));
    const others = Object.entries(CPMM_INSTRUCTION_NAMES).filter(([, name]) => !swaps.has(name));
    expect(others.map(([, name]) => name)).toEqual(expect.arrayContaining(["deposit", "withdraw", "initialize"]));
    expect(others).toHaveLength(12);
    for (const [hex, name] of [...others, ["0102030405060708", "unknown 0102030405060708"]] as const) {
      const ix = rawInstruction(PROGRAMS.raydiumCpmm, hex, [signerMeta(a), attackerMeta(a)]);
      await expectRefused(
        tx1(a, ix),
        makeContext(a),
        new RegExp(`#0 Raydium CPMM: instruction "${name}" is not allowed \\(only swap_base_input, swap_base_output\\)`),
      );
    }
  });

  test("a payer other than the trading wallet, or the trading wallet in another position", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    await expectRefused(
      tx1(a, await swap(a, "buy", { user: a.connected })),
      ctx,
      /requires 2 signatures[\s\S]*user must be the trading wallet/,
    );
    await expectRefused(tx1(a, await swap(a, "sell", { overrides: { amm_config: a.signer } })), ctx, /unexpected position \(2\)/);
  });

  test("bought tokens or sale proceeds paid to anything but the trading wallet's own ATA", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const position = (i: number) =>
      new RegExp(`swap_base_input: token account at position ${i} must be the trading wallet's associated token account`);
    const attackerCoin = await findAssociatedTokenAddress(a.attacker, CPMM_COIN, TOKEN_PROGRAM);
    await expectRefused(tx1(a, await swap(a, "buy", { overrides: { output_token_account: attackerCoin } })), ctx, position(5));
    for (const owner of [a.attacker, a.connected]) {
      const proceeds = await findAssociatedTokenAddress(owner, WSOL_MINT, TOKEN_PROGRAM);
      await expectRefused(tx1(a, await swap(a, "sell", { overrides: { output_token_account: proceeds } })), ctx, position(5));
    }
    await expectRefused(tx1(a, await swap(a, "sell", { overrides: { input_token_account: attackerCoin } })), ctx, position(4));
    // A Token-2022 coin's ATA derived under SPL Token.
    const t22 = await cpmmInstruction(
      "swap_base_input",
      cpmmParams(a, "buy", { outputTokenProgram: TOKEN_2022_PROGRAM, overrides: { output_token_program: TOKEN_PROGRAM } }),
      { amount_in: 1n, minimum_amount_out: 1n },
    );
    await expectRefused(tx1(a, t22), ctx, position(5));
  });

  test("token programs replaced by an arbitrary program", async () => {
    const a = makeActors();
    const fake = randomAddress();
    for (const [account, index] of [
      ["input_token_program", 8],
      ["output_token_program", 9],
    ] as const) {
      await expectRefused(
        tx1(a, await swap(a, "sell", { overrides: { [account]: fake } })),
        makeContext(a),
        new RegExp(`token program at position ${index} must be SPL Token or Token-2022 \\(static key\\)`),
      );
    }
  });

  test('a wrong authority, vaults that are not PDA["pool_vault", pool, mint], an observation that is not PDA["observation", pool]', async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const otherPool = await cpmmPool(randomAddress(), WSOL_MINT);
    const otherVault = (
      await getProgramDerivedAddress({
        programAddress: PROGRAMS.raydiumCpmm,
        seeds: [new TextEncoder().encode("pool_vault"), getAddressEncoder().encode(otherPool), getAddressEncoder().encode(WSOL_MINT)],
      })
    )[0];
    const attackerWsol = await findAssociatedTokenAddress(a.attacker, WSOL_MINT, TOKEN_PROGRAM);
    const cases: [Record<string, Address>, RegExp][] = [
      [{ authority: a.attacker }, /position 1 must be the CPMM authority GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL, not /],
      [
        { input_vault: otherVault },
        /input vault \w+ at position 6 is not the PDA \["pool_vault", pool, So11111111111111111111111111111111111111112\]/,
      ],
      [{ output_vault: attackerWsol }, /output vault \w+ at position 7 is not the PDA \["pool_vault", pool, /],
      [{ observation_state: randomAddress() }, /observation \w+ at position 12 is not the PDA \["observation", pool /],
    ];
    for (const [overrides, pattern] of cases) {
      const violations = await expectRefused(tx1(a, await swap(a, "buy", { overrides })), ctx, pattern);
      expect(violations).toHaveLength(1);
    }
    // The vaults swapped with each other: both refused.
    const ix = await swap(a, "sell");
    const swapped = { ...ix, accounts: (ix.accounts ?? []).map((m, i, all) => (i === 6 ? all[7]! : i === 7 ? all[6]! : m)) };
    const violations = await expectRefused(tx1(a, swapped), ctx, /input vault/);
    expect(violations.join("\n")).toMatch(/output vault/);
  });

  test("lookup tables: every checked account must be a static key; only the AMM config may be loaded", async () => {
    const a = makeActors();
    const ix = await cpmmInstruction("swap_base_input", cpmmParams(a, "sell", { inputTokenProgram: TOKEN_2022_PROGRAM }), {
      amount_in: 1n,
      minimum_amount_out: 1n,
    });
    await expectStaticPositions(a, ix, CPMM_STATIC_POSITIONS, []);
  });

  test("buys above the per-trade cap: arg 1 of either swap when it spends wSOL or a capped quote mint; at the cap passes", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const usdcIn = { inputMint: MAINNET.usdc };
    const variants: Instruction[] = [
      await swap(a, "buy", {}, { amount_in: CAP + 1n }),
      await cpmmInstruction("swap_base_output", cpmmParams(a, "buy"), { max_amount_in: CAP + 1n, amount_out: 1n }),
      await swap(a, "buy", usdcIn, { amount_in: USDC_CAP + 1n }),
      await cpmmInstruction("swap_base_output", cpmmParams(a, "buy", usdcIn), { max_amount_in: USDC_CAP + 1n, amount_out: 1n }),
    ];
    for (const ix of variants) {
      await expectRefused(tx1(a, ix), ctx, /#0 Raydium CPMM swap_base_(input|output): spends up to .* above the per-trade cap/);
    }
    const summary = await expectAllowed(tx1(a, await swap(a, "buy", {}, { amount_in: CAP })), ctx);
    expect(summary.maxBuyLamports).toBe(CAP);
    const usdc = await expectAllowed(
      tx1(a, await cpmmInstruction("swap_base_output", cpmmParams(a, "buy", usdcIn), { max_amount_in: USDC_CAP, amount_out: 1n })),
      ctx,
    );
    expect(usdc.maxBuyQuote).toEqual({ [MAINNET.usdc]: USDC_CAP });
  });

  test("swaps with no quote asset, or between two quote assets, are refused; a configured cap makes an xStock pair tradable", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const pair = (inputMint: Address, outputMint: Address) =>
      cpmmInstruction("swap_base_input", { user: a.signer, inputMint, outputMint }, { amount_in: 10n ** 6n, minimum_amount_out: 1n });
    const noQuote = /no per-trade cap is configured for either mint/;
    await expectRefused(tx1(a, await pair(CPMM_COIN, RAYDIUM.xStock)), ctx, noQuote);
    await expectRefused(tx1(a, await pair(RAYDIUM.xStock, CPMM_COIN)), ctx, noQuote);
    await expectRefused(tx1(a, await pair(CPMM_COIN, STONK_COIN)), ctx, noQuote);
    const usdcIsQuote = new RegExp(`base mint ${MAINNET.usdc} is a quote asset`);
    await expectRefused(tx1(a, await pair(WSOL_MINT, MAINNET.usdc)), ctx, usdcIsQuote);
    await expectRefused(tx1(a, await pair(MAINNET.usdc, WSOL_MINT)), ctx, usdcIsQuote);
    await expectRefused(tx1(a, await pair(WSOL_MINT, WSOL_MINT)), ctx, new RegExp(`base mint ${WSOL_MINT} is a quote asset`));

    const capped = withXStockCap(a, 10n ** 6n);
    const buySummary = await expectAllowed(tx1(a, await pair(RAYDIUM.xStock, CPMM_COIN)), capped);
    expect(buySummary.actions.find((x) => x.kind === "trade")).toMatchObject({
      side: "buy",
      baseMint: CPMM_COIN,
      quoteMint: RAYDIUM.xStock,
    });
    expect(buySummary.maxBuyQuote).toEqual({ [RAYDIUM.xStock]: 10n ** 6n });
    const sellSummary = await expectAllowed(tx1(a, await pair(CPMM_COIN, RAYDIUM.xStock)), capped);
    expect(sellSummary.actions.find((x) => x.kind === "trade")).toMatchObject({
      side: "sell",
      baseMint: CPMM_COIN,
      quoteMint: RAYDIUM.xStock,
    });
    await expectRefused(tx1(a, await pair(RAYDIUM.xStock, CPMM_COIN)), withXStockCap(a, 10n ** 6n - 1n), /above the per-trade cap/);
  });

  test("zero minimum output on swap_base_input sells and buys and swap_base_output sells; a minimum of 1 passes", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const variants: [string, (min: bigint) => Promise<Instruction>, RegExp][] = [
      ["swap_base_input", (min) => swap(a, "sell", {}, { minimum_amount_out: min }), /sells need a minimum above zero/],
      ["swap_base_input", (min) => swap(a, "buy", {}, { minimum_amount_out: min }), /minimum tokens out is 0/],
      [
        "swap_base_output",
        (min) => cpmmInstruction("swap_base_output", cpmmParams(a, "sell"), { max_amount_in: 10n ** 12n, amount_out: min }),
        /sells need a minimum above zero/,
      ],
    ];
    for (const [name, build, pattern] of variants) {
      const violations = await expectRefused(tx1(a, await build(0n)), ctx, pattern);
      expect({ name, violations }).toEqual({ name, violations: [expect.stringContaining(`#0 Raydium CPMM ${name}: `)] });
      await expectAllowed(tx1(a, await build(1n)), ctx);
    }
    // An exact-out buy of 0 tokens moves nothing worth protecting: it pays at most its capped max_amount_in.
    await expectAllowed(
      tx1(a, await cpmmInstruction("swap_base_output", cpmmParams(a, "buy"), { max_amount_in: 1_000n, amount_out: 0n })),
      ctx,
    );
  });

  test("malformed: wrong data length, missing or extra accounts", async () => {
    const a = makeActors();
    const ctx = makeContext(a);
    const ix = await swap(a, "sell");
    await expectRefused(tx1(a, { ...ix, data: Uint8Array.from([...(ix.data ?? []), 1]) }), ctx, /swap_base_input: data must be 24 bytes/);
    await expectRefused(tx1(a, { ...ix, accounts: (ix.accounts ?? []).slice(0, 12) }), ctx, /expected 13 accounts .*got 12/);
    await expectRefused(tx1(a, withExtraAccounts(ix, { address: randomAddress(), role: AccountRole.WRITABLE })), ctx, /got 14/);
  });
});

describe("firewall: Raydium buys share the per-trade cap with every other venue", () => {
  test("a LaunchLab buy and a CPMM buy that each fit but together exceed the cap", async () => {
    const a = makeActors();
    const half = CAP / 2n + 1n;
    const instructions = [
      await launchLabInstruction("buy_exact_in", launchLabParams(a), { amount_in: half, minimum_amount_out: 1n }),
      await cpmmInstruction("swap_base_output", cpmmParams(a, "buy"), { max_amount_in: half, amount_out: 1n }),
    ];
    await expectRefused(tx1(a, ...instructions), makeContext(a), /in total, above the per-trade cap/);
  });
});

describe("firewall: Jupiter routes (real /build responses, tampered)", () => {
  // The captures embed the taker's token accounts, so the trading wallet is the taker.
  const BUDGET = computeBudget(300_000, 50_000n);
  /** [CU limit, CU price, ...the route as /build returned it, Jito tip], with the route's lookup tables. */
  function routeTx(a: TestActors, label: JupiterCaseLabel, tamper: (swap: Instruction) => Instruction = (s) => s) {
    const { instructions, tables } = rawJupiterRoute(label);
    const swapAt = instructions.findIndex((ix) => ix.programAddress === PROGRAMS.jupiter);
    const route = instructions.map((ix, i) => (i === swapAt ? tamper(ix) : ix));
    const full = [...BUDGET, ...route, tipWithDontFront(a.signer, JITO_TIP_ACCOUNTS[0]!, 10_000n)];
    return { full, tables, swap: BUDGET.length + swapAt, ctx: makeContext(a, { addressLookupTables: tables }) };
  }
  const setMeta = (ix: Instruction, index: number, meta: AccountMeta): Instruction => {
    const accounts = [...(ix.accounts ?? [])];
    accounts[index] = meta;
    return { ...ix, accounts };
  };
  const patch = (ix: Instruction, write: (v: DataView) => void): Instruction => {
    const data = new Uint8Array(ix.data!);
    write(new DataView(data.buffer));
    return { ...ix, data };
  };
  const R = JUPITER_ROUTE_V2_LAYOUT;
  const ROUTE = JUPITER_ROUTE_INSTRUCTIONS.find((d) => d.name === "route_v2")!;
  const SHARED = JUPITER_ROUTE_INSTRUCTIONS.find((d) => d.name === "shared_accounts_route_v2")!;

  test("the untampered routes pass (route_v2 buys with SOL, shared-accounts sell into SOL, shared-accounts USDC buy)", async () => {
    const a = jupiterActors();
    for (const label of ["normalBuy", "normalSell", "usdcBuy", "longtailCurveBuy"] as const) {
      const { full, tables, ctx } = routeTx(a, label);
      await expectAllowed(compileJupiter(full, tables), ctx);
    }
  });

  test("destination ATA swapped to an attacker's", async () => {
    const a = jupiterActors();
    const attackerAta = await findAssociatedTokenAddress(a.attacker, jupiterCase("normalBuy").request.outputMint, TOKEN_PROGRAM);
    const buy = routeTx(a, "normalBuy", (s) => setMeta(s, R.destination, { address: attackerAta, role: AccountRole.WRITABLE }));
    await expectRefused(
      compileJupiter(buy.full, buy.tables),
      buy.ctx,
      new RegExp(`#${buy.swap} Jupiter route_v2: token account at position 2 must be the trading wallet's associated token account`),
    );
    // Same on a shared-accounts sell: the wSOL account receiving the proceeds swapped for the attacker's.
    const attackerWsol = await findAssociatedTokenAddress(a.attacker, WSOL_MINT, TOKEN_PROGRAM);
    const sell = routeTx(a, "normalSell", (s) =>
      setMeta(s, JUPITER_SHARED_ROUTE_V2_LAYOUT.destination, { address: attackerWsol, role: AccountRole.WRITABLE }),
    );
    await expectRefused(
      compileJupiter(sell.full, sell.tables),
      sell.ctx,
      /Jupiter shared_accounts_route_v2: token account at position 5 must be the trading wallet's associated token account/,
    );
  });

  test("platform fee set: the BONK buy /build returned for platformFeeBps=50 and an attacker's feeAccount, untouched", async () => {
    const a = jupiterActors();
    const { full, tables, swap, ctx } = routeTx(a, "platformFeeBuy");
    // The capture really carries the fee: 50 bps, the attacker's account as the first hop account.
    expect(new DataView(full[swap]!.data!.buffer).getUint16(ROUTE.platformFeeOffset, true)).toBe(50);
    expect(full[swap]!.accounts![ROUTE.layout.fixedAccounts]!.address).toBe(JUPITER_ATTACKER);
    const violations = await expectRefused(
      compileJupiter(full, tables),
      ctx,
      new RegExp(`#${swap} Jupiter route_v2: platform_fee_bps must be 0, got 50`),
    );
    // The only other violation: the ATA creation for the bought mint, refused because the trade is.
    expect(violations.filter((v) => !v.includes("neither trades nor transfers"))).toHaveLength(1);
  });

  test("authority != signer: another wallet as user_transfer_authority (it signs), or the connected wallet (it does not)", async () => {
    const a = jupiterActors();
    const signing = routeTx(a, "normalBuy", (s) => setMeta(s, R.authority, { address: a.attacker, role: AccountRole.READONLY_SIGNER }));
    const violations = await expectRefused(compileJupiter(signing.full, signing.tables), signing.ctx, /requires 2 signatures/);
    expect(violations.join("\n")).toMatch(/route_v2: user_transfer_authority must be the trading wallet/);
    const silent = routeTx(a, "normalBuy", (s) => setMeta(s, R.authority, { address: a.connected, role: AccountRole.READONLY }));
    await expectRefused(
      compileJupiter(silent.full, silent.tables),
      silent.ctx,
      /route_v2: user_transfer_authority must be the trading wallet/,
    );
  });

  test("min-out 0: quoted_out_amount 0, or slippage_bps of 10,000 and above", async () => {
    const a = jupiterActors();
    const zero = routeTx(a, "longtailCurveBuy", (s) => patch(s, (v) => v.setBigUint64(ROUTE.quotedOutOffset, 0n, true)));
    await expectRefused(compileJupiter(zero.full, zero.tables), zero.ctx, /quoted_out_amount is 0, so the minimum output is 0/);
    const all = routeTx(a, "longtailCurveSell", (s) => patch(s, (v) => v.setUint16(ROUTE.slippageOffset, 10_000, true)));
    await expectRefused(compileJupiter(all.full, all.tables), all.ctx, /slippage_bps 10000 leaves no minimum output/);
    const over = routeTx(a, "longtailCurveSell", (s) => patch(s, (v) => v.setUint16(ROUTE.slippageOffset, 65_535, true)));
    await expectRefused(compileJupiter(over.full, over.tables), over.ctx, /slippage_bps 65535 leaves no minimum output/);
  });

  test("over cap: a 1.5 SOL in_amount (cap 1 SOL), and a USDC buy above the USDC cap", async () => {
    const a = jupiterActors();
    const sol = routeTx(a, "normalBuy", (s) => patch(s, (v) => v.setBigUint64(ROUTE.inAmountOffset, (CAP * 3n) / 2n, true)));
    await expectRefused(compileJupiter(sol.full, sol.tables), sol.ctx, /route_v2: spends up to 1\.5 SOL, above the per-trade cap of 1 SOL/);
    const usdc = routeTx(a, "usdcBuy", (s) => patch(s, (v) => v.setBigUint64(SHARED.inAmountOffset, USDC_CAP + 1n, true)));
    await expectRefused(
      compileJupiter(usdc.full, usdc.tables),
      usdc.ctx,
      /shared_accounts_route_v2: spends up to .* above the per-trade cap/,
    );
  });

  test("destination loaded from an ALT (the runtime resolves whatever the real table holds)", async () => {
    const a = jupiterActors();
    const { full, tables, ctx } = routeTx(a, "normalBuy");
    const destination = full.find((ix) => ix.programAddress === PROGRAMS.jupiter)!.accounts![R.destination]!.address;
    const table = randomAddress();
    const withDestination = { ...tables, [table]: [destination] };
    await expectRefused(
      compileJupiter(full, withDestination, [destination]),
      { ...ctx, addressLookupTables: withDestination },
      /route_v2: token account at position 2 must be the trading wallet's associated token account for .* as a static key, not loaded from a lookup table/,
    );
  });

  test("unknown Jupiter instruction, and the named ones that are not fee-free exact-in v2 routes", async () => {
    const a = jupiterActors();
    const withDisc = (hex: string) => (s: Instruction) =>
      ({ ...s, data: Uint8Array.from([...hex.match(/../g)!.map((h) => Number.parseInt(h, 16)), ...s.data!.subarray(8)]) }) as Instruction;
    const cases: [string, RegExp][] = [
      ["00112233445566ff", /instruction "unknown 00112233445566ff" is refused \(only route_v2, shared_accounts_route_v2 are allowed\)/],
      ["9d8ab85215f4f324", /instruction "exact_out_route_v2" is refused \(exact-out routes/],
      ["e6798f50779f6aaa", /instruction "shared_accounts_route_with_token_ledger" is refused \(token-ledger routes/],
      ["e517cb977ae3ad2a", /instruction "route" is refused \(v1 routes/],
      ["3ec6d6c1d59f6cd2", /instruction "claim" is refused/],
    ];
    for (const [hex, pattern] of cases) {
      const { full, tables, ctx } = routeTx(a, "normalBuy", withDisc(hex));
      await expectRefused(compileJupiter(full, tables), ctx, pattern);
    }
  });

  test("a route with no hop accounts, a truncated route plan, and a fee on the surplus (positive_slippage_bps)", async () => {
    const a = jupiterActors();
    const bare = routeTx(a, "normalBuy", (s) => ({ ...s, accounts: s.accounts!.slice(0, R.fixedAccounts) }));
    await expectRefused(
      compileJupiter(bare.full, bare.tables),
      bare.ctx,
      /route_v2: expected 10 accounts plus the route's hop accounts, got 10/,
    );
    const cut = routeTx(a, "normalBuy", (s) => ({ ...s, data: s.data!.subarray(0, s.data!.length - 2) }));
    await expectRefused(
      compileJupiter(cut.full, cut.tables),
      cut.ctx,
      /route plan does not decode against the reviewed Jupiter IDL \(route plan length 1 exceeds the data\)/,
    );
    const surplus = routeTx(a, "normalBuy", (s) => patch(s, (v) => v.setUint16(ROUTE.positiveSlippageOffset, 1, true)));
    await expectRefused(compileJupiter(surplus.full, surplus.tables), surplus.ctx, /positive_slippage_bps must be 0, got 1/);
  });
});
