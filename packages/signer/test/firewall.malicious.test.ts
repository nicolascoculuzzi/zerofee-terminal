/**
 * Malicious corpus: what a compromised backend or front end could ask the trading wallet to sign.
 * Every case must be refused, with a violation that names the reason.
 */
import { describe, expect, test } from "bun:test";
import { type AccountMeta, AccountRole, type Address, createAddressWithSeed, type Instruction } from "@solana/kit";
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
import { SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT } from "../src/firewall/programs";
import { createPumpSwapRule, findCanonicalPumpPool } from "../src/firewall/rules/pump";
import {
  DEFAULT_CAPS,
  JITO_DONT_FRONT,
  JITO_TIP_ACCOUNTS,
  LAMPORTS_PER_SOL,
  MAINNET,
  makeActors,
  makeContext,
  PROGRAMS,
  randomAddress,
  type TestActors,
} from "./helpers/fixtures";
import { ammExtendInstruction, ammInstruction, curveInstruction } from "./helpers/pump";
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

  test("allowlisted program without a firewall rule (Raydium LaunchLab today)", async () => {
    const a = makeActors();
    const ix: Instruction = {
      programAddress: PROGRAMS.raydiumLaunchLab,
      accounts: [{ address: a.signer, role: AccountRole.WRITABLE_SIGNER }],
      data: new Uint8Array(32),
    };
    await expectRefused(buildTransaction({ feePayer: a.signer, instructions: [ix] }), makeContext(a), /no firewall rule for program/);
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
