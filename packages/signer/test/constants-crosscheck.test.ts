/**
 * The signer embeds its own reviewed copy of program IDs, mints, discriminators, account layouts and
 * tip accounts (SPEC "Verify before you code"), so it never trusts @zerofee/core or the backend at
 * runtime. This suite fails loudly when that copy drifts from core: every value is compared one by
 * one, layouts are checked against the instructions core actually builds, derivations against core's
 * PDAs and its mainnet snapshots, and the trimmed IDLs the layout tests use against core's vendored
 * IDLs (pump and Raydium, which the daily interface-watch job diffs).
 *
 * @zerofee/core is a test-only devDependency; the last block makes sure it stays that way.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AccountRole, type Address, address, type Instruction } from "@solana/kit";
import * as core from "@zerofee/core";
import raydiumSnapshot from "../../core/test/fixtures/raydium-mainnet.json";
import { readU64LE, toHex } from "../src/bytes";
import { findAssociatedTokenAddress } from "../src/firewall/ata";
import {
  ASSOCIATED_TOKEN_PROGRAM,
  BASE_FEE_LAMPORTS_PER_SIGNATURE,
  COMPUTE_BUDGET_PROGRAM,
  JITO_DONT_FRONT_PREFIX,
  MAX_COMPUTE_UNIT_LIMIT,
  PACKET_DATA_SIZE,
  PUMP_AMM_PROGRAM,
  PUMP_PROGRAM,
  RAYDIUM_CPMM_PROGRAM,
  RAYDIUM_LAUNCHLAB_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  USDC_MINT,
  WSOL_MINT,
} from "../src/firewall/programs";
import { findCanonicalPumpPool } from "../src/firewall/rules/pump";
import {
  PUMP_AMM_EXTEND_ACCOUNT,
  PUMP_AMM_INSTRUCTION_NAMES,
  PUMP_AMM_INSTRUCTIONS,
  PUMP_CURVE_INSTRUCTIONS,
  PUMP_INSTRUCTION_NAMES,
  type VenueInstruction,
} from "../src/firewall/rules/pump-idl";
import {
  findCpmmAuthority,
  findCpmmObservation,
  findCpmmVault,
  findLaunchLabAuthority,
  findLaunchLabEventAuthority,
  findLaunchLabPlatformFeeVault,
  findLaunchLabPool,
} from "../src/firewall/rules/raydium";
import {
  CPMM_DATA_LENGTH,
  CPMM_INSTRUCTION_NAMES,
  CPMM_SWAP_INSTRUCTIONS,
  CPMM_SWAP_LAYOUT,
  type CpmmSwapInstruction,
  LAUNCHLAB_DATA_LENGTH,
  LAUNCHLAB_INSTRUCTION_NAMES,
  LAUNCHLAB_SHARE_FEE_RATE_OFFSET,
  LAUNCHLAB_SWAP_INSTRUCTIONS,
  LAUNCHLAB_SWAP_LAYOUT,
  type LaunchLabSwapInstruction,
  RAYDIUM_SEEDS,
} from "../src/firewall/rules/raydium-idl";
import {
  DEFAULT_FIREWALL_CAPS,
  HELIUS_SENDER_TIP_ACCOUNTS,
  JITO_TIP_ACCOUNTS,
  SIGNER_ALLOWED_PROGRAMS,
  SIGNER_TIP_ACCOUNTS,
} from "../src/policy";
import subset from "./fixtures/pump-idl-subset.json";
import raydiumSubset from "./fixtures/raydium-idl-subset.json";
import { randomAddress } from "./helpers/fixtures";

const def = (defs: readonly VenueInstruction[], name: string): VenueInstruction => {
  const found = defs.find((d) => d.name === name);
  if (!found) throw new Error(`signer has no layout for ${name}`);
  return found;
};
const launchLabDef = (name: string): LaunchLabSwapInstruction => {
  const found = LAUNCHLAB_SWAP_INSTRUCTIONS.find((d) => d.name === name);
  if (!found) throw new Error(`signer has no LaunchLab layout for ${name}`);
  return found;
};
const cpmmDef = (name: string): CpmmSwapInstruction => {
  const found = CPMM_SWAP_INSTRUCTIONS.find((d) => d.name === name);
  if (!found) throw new Error(`signer has no CPMM layout for ${name}`);
  return found;
};

describe("addresses and runtime constants equal core's", () => {
  test.each([
    ["System program", SYSTEM_PROGRAM, core.SYSTEM_PROGRAM_ID],
    ["Compute Budget program", COMPUTE_BUDGET_PROGRAM, core.COMPUTE_BUDGET_PROGRAM_ID],
    ["SPL Token program", TOKEN_PROGRAM, core.TOKEN_PROGRAM_ID],
    ["Token-2022 program", TOKEN_2022_PROGRAM, core.TOKEN_2022_PROGRAM_ID],
    ["Associated Token program", ASSOCIATED_TOKEN_PROGRAM, core.ASSOCIATED_TOKEN_PROGRAM_ID],
    ["wSOL mint", WSOL_MINT, core.WSOL_MINT],
    ["USDC mint", USDC_MINT, core.USDC_MINT],
    ["pump.fun program", PUMP_PROGRAM, core.PUMP_PROGRAM_ID],
    ["PumpSwap program", PUMP_AMM_PROGRAM, core.PUMP_AMM_PROGRAM_ID],
    ["Raydium LaunchLab program", RAYDIUM_LAUNCHLAB_PROGRAM, core.RAYDIUM_LAUNCHLAB_PROGRAM_ID],
    ["Raydium CPMM program", RAYDIUM_CPMM_PROGRAM, core.RAYDIUM_CPMM_PROGRAM_ID],
  ])("%s", (_name, signer, fromCore) => {
    expect(signer).toBe(fromCore);
  });

  test("Raydium fixed accounts the rules derive equal core's constants (and SPEC's)", async () => {
    expect(await findLaunchLabAuthority(RAYDIUM_LAUNCHLAB_PROGRAM)).toBe(core.RAYDIUM_LAUNCHLAB_AUTHORITY);
    expect(await findLaunchLabEventAuthority(RAYDIUM_LAUNCHLAB_PROGRAM)).toBe(core.RAYDIUM_LAUNCHLAB_EVENT_AUTHORITY);
    expect(await findCpmmAuthority(RAYDIUM_CPMM_PROGRAM)).toBe(core.RAYDIUM_CPMM_AUTHORITY);
    expect(core.RAYDIUM_LAUNCHLAB_AUTHORITY).toBe(address("WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh"));
    expect(core.RAYDIUM_LAUNCHLAB_EVENT_AUTHORITY).toBe(address("2DPAtwB8L12vrMRExbLuyGnC7n2J5LNoZQSejeQGpwkr"));
    expect(core.RAYDIUM_CPMM_AUTHORITY).toBe(address("GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL"));
  });

  test("Raydium PDA seeds equal core's", () => {
    expect(RAYDIUM_SEEDS).toEqual({
      launchLabAuthority: core.RAYDIUM_SEEDS.launchLabAuth,
      launchLabEventAuthority: core.SEEDS.eventAuthority,
      launchLabPool: core.RAYDIUM_SEEDS.launchLabPool,
      cpmmAuthority: core.RAYDIUM_SEEDS.cpmmAuth,
      cpmmVault: core.RAYDIUM_SEEDS.cpmmVault,
      cpmmObservation: core.RAYDIUM_SEEDS.cpmmObservation,
    });
  });

  test("max compute units, base fee per signature, packet size, jitodontfront prefix", () => {
    expect(MAX_COMPUTE_UNIT_LIMIT).toBe(core.MAX_COMPUTE_UNIT_LIMIT);
    expect(BASE_FEE_LAMPORTS_PER_SIGNATURE).toBe(core.LAMPORTS_PER_SIGNATURE);
    expect(PACKET_DATA_SIZE).toBe(core.PACKET_DATA_SIZE);
    expect(core.JITO_DONT_FRONT.startsWith(JITO_DONT_FRONT_PREFIX)).toBe(true);
  });

  test("the shipped allowlist is exactly the built-ins plus the venues with rules", () => {
    expect([...SIGNER_ALLOWED_PROGRAMS].sort()).toEqual(
      [
        core.SYSTEM_PROGRAM_ID,
        core.COMPUTE_BUDGET_PROGRAM_ID,
        core.TOKEN_PROGRAM_ID,
        core.TOKEN_2022_PROGRAM_ID,
        core.ASSOCIATED_TOKEN_PROGRAM_ID,
        core.PUMP_PROGRAM_ID,
        core.PUMP_AMM_PROGRAM_ID,
        core.RAYDIUM_LAUNCHLAB_PROGRAM_ID,
        core.RAYDIUM_CPMM_PROGRAM_ID,
      ].sort(),
    );
  });
});

describe("tip accounts equal core's", () => {
  test("Jito: the signer's list is core's documented list, in order", () => {
    expect([...JITO_TIP_ACCOUNTS]).toEqual([...core.JITO_TIP_ACCOUNTS_FALLBACK]);
  });

  test("Helius Sender: the signer's list is core's list, in order", () => {
    expect([...HELIUS_SENDER_TIP_ACCOUNTS]).toEqual([...core.HELIUS_SENDER_TIP_ACCOUNTS]);
  });

  test("every account core's tip picker can return is accepted, and nothing else", () => {
    expect(new Set(SIGNER_TIP_ACCOUNTS).size).toBe(SIGNER_TIP_ACCOUNTS.length);
    expect([...SIGNER_TIP_ACCOUNTS].sort()).toEqual([...core.JITO_TIP_ACCOUNTS_FALLBACK, ...core.HELIUS_SENDER_TIP_ACCOUNTS].sort());
    for (let i = 0; i < 200; i++) {
      expect(SIGNER_TIP_ACCOUNTS).toContain(core.resolveTipAccount({ lane: i % 2 ? "jito" : "helius", lamports: 1n }));
    }
  });
});

describe("the shipped caps cover what core emits", () => {
  test.each(Object.entries(core.DEFAULT_CU_LIMITS))("compute-unit cap covers core's static %s limit (%d CU)", (_route, units) => {
    expect(units).toBeLessThanOrEqual(DEFAULT_FIREWALL_CAPS.maxComputeUnitLimit);
  });

  test("tip cap covers every landing mode's minimum (Sender Max 0.001 SOL; Helius SWQoS + Jito)", () => {
    expect(DEFAULT_FIREWALL_CAPS.maxTipLamports).toBeGreaterThanOrEqual(core.HELIUS_SENDER_MAX_MIN_TIP_LAMPORTS);
    expect(DEFAULT_FIREWALL_CAPS.maxTipLamports).toBeGreaterThanOrEqual(
      core.HELIUS_SENDER_SWQOS_MIN_TIP_LAMPORTS + core.JITO_MIN_TIP_LAMPORTS,
    );
  });
});

describe("discriminators equal core's", () => {
  test.each([
    ["pump buy", def(PUMP_CURVE_INSTRUCTIONS, "buy"), core.PUMP_IX.buy],
    ["pump buy_exact_sol_in", def(PUMP_CURVE_INSTRUCTIONS, "buy_exact_sol_in"), core.PUMP_IX.buyExactSolIn],
    ["pump buy_v2", def(PUMP_CURVE_INSTRUCTIONS, "buy_v2"), core.PUMP_IX.buyV2],
    ["pump buy_exact_quote_in_v2", def(PUMP_CURVE_INSTRUCTIONS, "buy_exact_quote_in_v2"), core.PUMP_IX.buyExactQuoteInV2],
    ["pump sell", def(PUMP_CURVE_INSTRUCTIONS, "sell"), core.PUMP_IX.sell],
    ["pump sell_v2", def(PUMP_CURVE_INSTRUCTIONS, "sell_v2"), core.PUMP_IX.sellV2],
    ["PumpSwap buy", def(PUMP_AMM_INSTRUCTIONS, "buy"), core.PUMP_AMM_IX.buy],
    ["PumpSwap buy_exact_quote_in", def(PUMP_AMM_INSTRUCTIONS, "buy_exact_quote_in"), core.PUMP_AMM_IX.buyExactQuoteIn],
    ["PumpSwap sell", def(PUMP_AMM_INSTRUCTIONS, "sell"), core.PUMP_AMM_IX.sell],
    ["PumpSwap extend_account", PUMP_AMM_EXTEND_ACCOUNT, core.PUMP_AMM_IX.extendAccount],
    ["LaunchLab buy_exact_in", launchLabDef("buy_exact_in"), core.RAYDIUM_LAUNCHLAB_IX.buyExactIn],
    ["LaunchLab buy_exact_out", launchLabDef("buy_exact_out"), core.RAYDIUM_LAUNCHLAB_IX.buyExactOut],
    ["LaunchLab sell_exact_in", launchLabDef("sell_exact_in"), core.RAYDIUM_LAUNCHLAB_IX.sellExactIn],
    ["LaunchLab sell_exact_out", launchLabDef("sell_exact_out"), core.RAYDIUM_LAUNCHLAB_IX.sellExactOut],
    ["CPMM swap_base_input", cpmmDef("swap_base_input"), core.RAYDIUM_CPMM_IX.swapBaseInput],
    ["CPMM swap_base_output", cpmmDef("swap_base_output"), core.RAYDIUM_CPMM_IX.swapBaseOutput],
  ])("%s", (_name, signer, fromCore) => {
    expect(toHex(Uint8Array.from(signer.discriminator))).toBe(toHex(fromCore));
  });
});

/** Asserts the signer's index map picks out exactly what core put at each position. */
function expectLayout(
  d: VenueInstruction,
  ix: Instruction,
  want: {
    user: Address;
    baseMint: Address;
    quoteMint: Address;
    baseTokenProgram: Address;
    quoteTokenProgram: Address;
    userBaseTokenAccount: Address;
    userQuoteTokenAccount: Address;
    pool?: Address;
  },
  args: { cap?: bigint; base: bigint; minOut?: bigint },
) {
  const metas = ix.accounts ?? [];
  const data = ix.data ?? new Uint8Array();
  const L = d.layout;
  expect(L.accountCounts).toContain(metas.length);
  expect(metas[L.user]).toEqual({ address: want.user, role: AccountRole.WRITABLE_SIGNER });
  expect(metas[L.baseMint]?.address).toBe(want.baseMint);
  expect(metas[L.quoteMint!]?.address).toBe(want.quoteMint);
  expect(metas[L.baseTokenProgram]?.address).toBe(want.baseTokenProgram);
  expect(metas[L.quoteTokenProgram!]?.address).toBe(want.quoteTokenProgram);
  expect(metas[L.userBaseTokenAccount]?.address).toBe(want.userBaseTokenAccount);
  expect(metas[L.userQuoteTokenAccount!]?.address).toBe(want.userQuoteTokenAccount);
  if (want.pool !== undefined) expect(metas[L.pool!]?.address).toBe(want.pool);
  expect(metas.filter((m) => m.role === AccountRole.WRITABLE_SIGNER || m.role === AccountRole.READONLY_SIGNER)).toHaveLength(1);
  expect(d.dataLengths).toContain(data.length);
  expect(readU64LE(data, d.baseOffset)).toBe(args.base);
  if (args.cap !== undefined) expect(readU64LE(data, d.capOffset!)).toBe(args.cap);
  if (args.minOut !== undefined) expect(readU64LE(data, d.minOutOffset!)).toBe(args.minOut);
}

describe("layouts match the instructions core builds", () => {
  test("pump buy_v2 / buy_exact_quote_in_v2 / sell_v2 (SOL and USDC quotes, SPL Token and Token-2022 coins)", async () => {
    expect(def(PUMP_CURVE_INSTRUCTIONS, "buy_v2").layout.accountCounts).toContain(core.EXPECTED_ACCOUNT_COUNTS.pumpBuyV2);
    expect(def(PUMP_CURVE_INSTRUCTIONS, "buy_exact_quote_in_v2").layout.accountCounts).toContain(
      core.EXPECTED_ACCOUNT_COUNTS.pumpBuyExactQuoteInV2,
    );
    expect(def(PUMP_CURVE_INSTRUCTIONS, "sell_v2").layout.accountCounts).toContain(core.EXPECTED_ACCOUNT_COUNTS.pumpSellV2);
    for (const [baseTokenProgram, quoteMint] of [
      [core.TOKEN_2022_PROGRAM_ID, core.WSOL_MINT],
      [core.TOKEN_PROGRAM_ID, core.WSOL_MINT],
      [core.TOKEN_2022_PROGRAM_ID, core.USDC_MINT],
    ] as const) {
      const user = randomAddress();
      const a = await core.resolvePumpV2Accounts({
        mint: randomAddress(),
        baseTokenProgram,
        quoteMint,
        quoteTokenProgram: core.TOKEN_PROGRAM_ID,
        user,
        creator: randomAddress(),
        feeRecipient: randomAddress(),
        buybackFeeRecipient: randomAddress(),
      });
      const want = {
        user,
        baseMint: a.baseMint,
        quoteMint,
        baseTokenProgram,
        quoteTokenProgram: core.TOKEN_PROGRAM_ID,
        userBaseTokenAccount: a.associatedBaseUser,
        userQuoteTokenAccount: a.associatedQuoteUser,
      };
      expectLayout(def(PUMP_CURVE_INSTRUCTIONS, "buy_v2"), core.buyV2Instruction(a, 111n, 222n), want, { base: 111n, cap: 222n });
      expectLayout(def(PUMP_CURVE_INSTRUCTIONS, "buy_exact_quote_in_v2"), core.buyExactQuoteInV2Instruction(a, 333n, 444n), want, {
        cap: 333n,
        base: 444n,
      });
      expectLayout(def(PUMP_CURVE_INSTRUCTIONS, "sell_v2"), core.sellV2Instruction(a, 555n, 666n), want, { base: 555n, minOut: 666n });
    }
  });

  test("PumpSwap buy / buy_exact_quote_in / sell for every remaining-account variant", async () => {
    const amm = (name: string) => def(PUMP_AMM_INSTRUCTIONS, name);
    for (const extra of [2, 3, 4]) expect(amm("buy").layout.accountCounts).toContain(core.EXPECTED_ACCOUNT_COUNTS.ammBuyBase + extra);
    for (const extra of [2, 3, 4, 5]) expect(amm("sell").layout.accountCounts).toContain(core.EXPECTED_ACCOUNT_COUNTS.ammSellBase + extra);
    for (const coinCreator of [core.DEFAULT_PUBKEY, randomAddress()]) {
      for (const isCashbackCoin of [false, true]) {
        const user = randomAddress();
        const poolAddress = randomAddress();
        const pool = {
          baseMint: randomAddress(),
          quoteMint: core.WSOL_MINT,
          poolBaseTokenAccount: randomAddress(),
          poolQuoteTokenAccount: randomAddress(),
          coinCreator,
          isMayhemMode: false,
          isCashbackCoin,
          dataLength: core.POOL_ACCOUNT_NEW_SIZE,
        };
        const a = await core.resolveAmmSwapAccounts({
          poolAddress,
          pool,
          user,
          baseTokenProgram: core.TOKEN_2022_PROGRAM_ID,
          quoteTokenProgram: core.TOKEN_PROGRAM_ID,
          protocolFeeRecipient: randomAddress(),
          buybackFeeRecipient: randomAddress(),
        });
        const want = {
          user,
          baseMint: pool.baseMint,
          quoteMint: pool.quoteMint,
          baseTokenProgram: core.TOKEN_2022_PROGRAM_ID,
          quoteTokenProgram: core.TOKEN_PROGRAM_ID,
          userBaseTokenAccount: a.userBaseTokenAccount,
          userQuoteTokenAccount: a.userQuoteTokenAccount,
          pool: poolAddress,
        };
        expectLayout(amm("buy"), core.ammBuyInstruction(a, pool, 11n, 22n), want, { base: 11n, cap: 22n });
        expectLayout(amm("buy_exact_quote_in"), core.ammBuyExactQuoteInInstruction(a, pool, 33n, 44n), want, { cap: 33n, base: 44n });
        expectLayout(amm("sell"), core.ammSellInstruction(a, pool, 55n, 66n), want, { base: 55n, minOut: 66n });
      }
    }
  });

  test("PumpSwap extend_account (core prepends it for pools shorter than POOL_ACCOUNT_NEW_SIZE)", async () => {
    const X = PUMP_AMM_EXTEND_ACCOUNT;
    const pool = randomAddress();
    const user = randomAddress();
    const ix = await core.ammExtendAccountInstruction(pool, user);
    expect(ix.programAddress).toBe(PUMP_AMM_PROGRAM);
    expect(ix.data).toHaveLength(X.dataLength);
    expect(ix.accounts).toHaveLength(X.accountCount);
    expect(ix.accounts?.[X.account]).toEqual({ address: pool, role: AccountRole.WRITABLE });
    expect(ix.accounts?.[X.user]).toEqual({ address: user, role: AccountRole.WRITABLE_SIGNER });
    expect(ix.accounts?.[X.systemProgram]?.address).toBe(SYSTEM_PROGRAM);
  });

  test("LaunchLab buy_exact_in / buy_exact_out / sell_exact_in / sell_exact_out for every token-program flag", async () => {
    const L = LAUNCHLAB_SWAP_LAYOUT;
    expect(L.accountCount).toBe(core.EXPECTED_ACCOUNT_COUNTS.launchLabSwap);
    for (const tokenProgramFlag of [0, 1, 2, 3]) {
      const user = randomAddress();
      const poolAddress = randomAddress();
      const pool = {
        globalConfig: randomAddress(),
        platformConfig: randomAddress(),
        baseMint: randomAddress(),
        quoteMint: tokenProgramFlag & 2 ? randomAddress() : core.WSOL_MINT,
        baseVault: randomAddress(),
        quoteVault: randomAddress(),
        creator: randomAddress(),
        tokenProgramFlag,
      };
      const a = await core.resolveLaunchLabSwapAccounts({ poolAddress, pool, user });
      const baseTokenProgram = tokenProgramFlag & 1 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
      const quoteTokenProgram = tokenProgramFlag & 2 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
      const want: [number, Address][] = [
        [L.payer, user],
        [L.authority, core.RAYDIUM_LAUNCHLAB_AUTHORITY],
        [L.globalConfig, pool.globalConfig],
        [L.platformConfig, pool.platformConfig],
        [L.pool, poolAddress],
        [L.userBaseToken, await findAssociatedTokenAddress(user, pool.baseMint, baseTokenProgram)],
        [L.userQuoteToken, await findAssociatedTokenAddress(user, pool.quoteMint, quoteTokenProgram)],
        [L.baseVault, pool.baseVault],
        [L.quoteVault, pool.quoteVault],
        [L.baseMint, pool.baseMint],
        [L.quoteMint, pool.quoteMint],
        [L.baseTokenProgram, baseTokenProgram],
        [L.quoteTokenProgram, quoteTokenProgram],
        [L.eventAuthority, core.RAYDIUM_LAUNCHLAB_EVENT_AUTHORITY],
        [L.program, core.RAYDIUM_LAUNCHLAB_PROGRAM_ID],
        [L.systemProgram, SYSTEM_PROGRAM],
        [L.platformFeeVault, await core.launchLabPlatformFeeVaultPda(pool.platformConfig, pool.quoteMint)],
        [L.creatorFeeVault, await core.launchLabCreatorFeeVaultPda(pool.creator, pool.quoteMint)],
      ];
      // core's builders take (amount, limit) in IDL order: 111 is the first u64 argument, 222 the second.
      const builders: [string, Instruction, { cap?: bigint; base: bigint; minOut?: bigint }][] = [
        ["buy_exact_in", core.launchLabBuyExactInInstruction(a, 111n, 222n), { cap: 111n, base: 222n }],
        ["buy_exact_out", core.launchLabBuyExactOutInstruction(a, 111n, 222n), { base: 111n, cap: 222n }],
        ["sell_exact_in", core.launchLabSellExactInInstruction(a, 111n, 222n), { base: 111n, minOut: 222n }],
        ["sell_exact_out", core.launchLabSellExactOutInstruction(a, 111n, 222n), { minOut: 111n, base: 222n }],
      ];
      expect(want.map(([i]) => i)).toEqual([...Array(L.accountCount).keys()]);
      for (const [name, ix, args] of builders) {
        const d = launchLabDef(name);
        const metas = ix.accounts ?? [];
        const data = ix.data ?? new Uint8Array();
        expect(ix.programAddress).toBe(RAYDIUM_LAUNCHLAB_PROGRAM);
        expect(metas.map((m) => m.address)).toEqual(want.map(([, addr]) => addr));
        expect(metas.filter((m) => m.role === AccountRole.WRITABLE_SIGNER || m.role === AccountRole.READONLY_SIGNER)).toEqual([
          { address: user, role: AccountRole.WRITABLE_SIGNER },
        ]);
        expect(data).toHaveLength(LAUNCHLAB_DATA_LENGTH);
        expect(readU64LE(data, LAUNCHLAB_SHARE_FEE_RATE_OFFSET)).toBe(0n);
        expect(readU64LE(data, d.baseOffset)).toBe(args.base);
        if (args.cap !== undefined) expect(readU64LE(data, d.capOffset!)).toBe(args.cap);
        if (args.minOut !== undefined) expect(readU64LE(data, d.minOutOffset!)).toBe(args.minOut);
      }
    }
    // A share fee needs core's share_fee_receiver: 19 accounts, which the firewall's exact 18 refuses.
    const a = await core.resolveLaunchLabSwapAccounts({
      poolAddress: randomAddress(),
      pool: {
        globalConfig: randomAddress(),
        platformConfig: randomAddress(),
        baseMint: randomAddress(),
        quoteMint: core.WSOL_MINT,
        baseVault: randomAddress(),
        quoteVault: randomAddress(),
        creator: randomAddress(),
        tokenProgramFlag: 0,
      },
      user: randomAddress(),
      shareFeeReceiver: randomAddress(),
    });
    expect(core.launchLabBuyExactInInstruction(a, 1n, 1n, 10_000n).accounts).toHaveLength(L.accountCount + 1);
  });

  test("CPMM swap_base_input / swap_base_output in both directions and for every token program", async () => {
    const C = CPMM_SWAP_LAYOUT;
    expect(C.accountCount).toBe(core.EXPECTED_ACCOUNT_COUNTS.cpmmSwap);
    for (const [token0Program, token1Program] of [
      [TOKEN_PROGRAM, TOKEN_PROGRAM],
      [TOKEN_PROGRAM, TOKEN_2022_PROGRAM],
      [TOKEN_2022_PROGRAM, TOKEN_2022_PROGRAM],
    ] as const) {
      const poolAddress = randomAddress();
      const pool = {
        ammConfig: randomAddress(),
        token0Mint: randomAddress(),
        token1Mint: randomAddress(),
        token0Vault: randomAddress(),
        token1Vault: randomAddress(),
        token0Program,
        token1Program,
        observationKey: randomAddress(),
      };
      for (const zeroForOne of [true, false]) {
        const user = randomAddress();
        const [inputMint, outputMint] = zeroForOne ? [pool.token0Mint, pool.token1Mint] : [pool.token1Mint, pool.token0Mint];
        const [inputVault, outputVault] = zeroForOne ? [pool.token0Vault, pool.token1Vault] : [pool.token1Vault, pool.token0Vault];
        const [inputProgram, outputProgram] = zeroForOne ? [token0Program, token1Program] : [token1Program, token0Program];
        const a = await core.resolveCpmmSwapAccounts({ poolAddress, pool, user, inputMint });
        const want: [number, Address][] = [
          [C.payer, user],
          [C.authority, core.RAYDIUM_CPMM_AUTHORITY],
          [C.ammConfig, pool.ammConfig],
          [C.pool, poolAddress],
          [C.inputTokenAccount, await findAssociatedTokenAddress(user, inputMint, inputProgram)],
          [C.outputTokenAccount, await findAssociatedTokenAddress(user, outputMint, outputProgram)],
          [C.inputVault, inputVault],
          [C.outputVault, outputVault],
          [C.inputTokenProgram, inputProgram],
          [C.outputTokenProgram, outputProgram],
          [C.inputMint, inputMint],
          [C.outputMint, outputMint],
          [C.observation, pool.observationKey],
        ];
        expect(want.map(([i]) => i)).toEqual([...Array(C.accountCount).keys()]);
        const swaps: [CpmmSwapInstruction, Instruction, { input: bigint; output: bigint }][] = [
          [cpmmDef("swap_base_input"), core.cpmmSwapBaseInputInstruction(a, 333n, 444n), { input: 333n, output: 444n }],
          [cpmmDef("swap_base_output"), core.cpmmSwapBaseOutputInstruction(a, 555n, 666n), { input: 555n, output: 666n }],
        ];
        for (const [d, ix, args] of swaps) {
          const metas = ix.accounts ?? [];
          const data = ix.data ?? new Uint8Array();
          expect(ix.programAddress).toBe(RAYDIUM_CPMM_PROGRAM);
          expect(metas.map((m) => m.address)).toEqual(want.map(([, addr]) => addr));
          expect(metas.filter((m) => m.role === AccountRole.WRITABLE_SIGNER || m.role === AccountRole.READONLY_SIGNER)).toHaveLength(1);
          expect(metas[C.payer]?.address).toBe(user);
          expect(data).toHaveLength(CPMM_DATA_LENGTH);
          expect(readU64LE(data, d.inputOffset)).toBe(args.input);
          expect(readU64LE(data, d.outputOffset)).toBe(args.output);
        }
      }
    }
  });
});

describe("derivations equal core's", () => {
  test("canonical PumpSwap pool (incl. a live migrated coin and the snapshot pool)", async () => {
    const mints = [
      address("3nK1vwb8qWYtYVih5rfBz2FHTiVm35eLvmgjMTvkpump"),
      address("3fr6BBobNvytZQPVLj8o5o7vToBZf7E5tc9zmJvSpump"),
      randomAddress(),
    ];
    for (const mint of mints) {
      for (const quote of [WSOL_MINT, USDC_MINT]) {
        expect(await findCanonicalPumpPool(PUMP_PROGRAM, PUMP_AMM_PROGRAM, mint, quote)).toBe(await core.canonicalPoolPda(mint, quote));
      }
    }
    expect(await findCanonicalPumpPool(PUMP_PROGRAM, PUMP_AMM_PROGRAM, mints[0]!, WSOL_MINT)).toBe(
      address("DN5CZBVz9hv5upEmAvdBQ8TeCxXDL9NaHtsE6CJ4rgRM"),
    );
  });

  test("associated token accounts (SPL Token and Token-2022)", async () => {
    for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      const owner = randomAddress();
      const mint = randomAddress();
      expect(await findAssociatedTokenAddress(owner, mint, program)).toBe(await core.findAssociatedTokenAddress(owner, mint, program));
    }
  });

  test("LaunchLab pool and platform fee vault (random pairs and every pool in core's mainnet snapshot)", async () => {
    for (let i = 0; i < 4; i++) {
      const [base, quote, platform] = [randomAddress(), i % 2 ? WSOL_MINT : randomAddress(), randomAddress()];
      expect(await findLaunchLabPool(RAYDIUM_LAUNCHLAB_PROGRAM, base, quote)).toBe(await core.launchLabPoolPda(base, quote));
      expect(await findLaunchLabPlatformFeeVault(RAYDIUM_LAUNCHLAB_PROGRAM, platform, quote)).toBe(
        await core.launchLabPlatformFeeVaultPda(platform, quote),
      );
    }
    const pools = Object.entries(raydiumSnapshot.accounts).filter(([, a]) => a.owner === core.RAYDIUM_LAUNCHLAB_PROGRAM_ID);
    const launchLabPools = pools.flatMap(([addr, a]) => {
      const data = new Uint8Array(Buffer.from(a.data, "base64"));
      return core.startsWith(data, core.RAYDIUM_ACCOUNT_DISCRIMINATORS.launchLabPoolState)
        ? [[addr, core.decodeLaunchLabPool(data)] as const]
        : [];
    });
    expect(launchLabPools.length).toBeGreaterThanOrEqual(4);
    for (const [addr, pool] of launchLabPools) {
      expect(await findLaunchLabPool(RAYDIUM_LAUNCHLAB_PROGRAM, pool.baseMint, pool.quoteMint)).toBe(address(addr));
    }
  });

  test("CPMM vaults and observation (random pools and every pool in core's mainnet snapshot)", async () => {
    for (let i = 0; i < 4; i++) {
      const [pool, mint] = [randomAddress(), randomAddress()];
      expect(await findCpmmVault(RAYDIUM_CPMM_PROGRAM, pool, mint)).toBe(await core.cpmmVaultPda(pool, mint));
      expect(await findCpmmObservation(RAYDIUM_CPMM_PROGRAM, pool)).toBe(await core.cpmmObservationPda(pool));
    }
    const cpmmPools = Object.entries(raydiumSnapshot.accounts).flatMap(([addr, a]) => {
      if (a.owner !== core.RAYDIUM_CPMM_PROGRAM_ID) return [];
      const data = new Uint8Array(Buffer.from(a.data, "base64"));
      return core.startsWith(data, core.RAYDIUM_ACCOUNT_DISCRIMINATORS.cpmmPoolState)
        ? [[address(addr), core.decodeCpmmPool(data)] as const]
        : [];
    });
    expect(cpmmPools.length).toBeGreaterThanOrEqual(3);
    for (const [addr, pool] of cpmmPools) {
      expect(await findCpmmVault(RAYDIUM_CPMM_PROGRAM, addr, pool.token0Mint)).toBe(pool.token0Vault);
      expect(await findCpmmVault(RAYDIUM_CPMM_PROGRAM, addr, pool.token1Mint)).toBe(pool.token1Vault);
      expect(await findCpmmObservation(RAYDIUM_CPMM_PROGRAM, addr)).toBe(pool.observationKey);
    }
  });
});

interface IdlAccountJson {
  name: string;
  writable?: boolean;
  signer?: boolean;
  address?: string;
}
interface IdlInstructionJson {
  name: string;
  discriminator: number[];
  args: { name: string; type: string | { defined: { name: string } } }[];
  accounts: (IdlAccountJson & { pda?: { seeds: { kind: string; value?: number[] }[] } })[];
}

type CoreIdlFile = "pump.json" | "pump_amm.json" | "raydium_launchpad.json" | "raydium_cp_swap.json";

function coreIdl(file: CoreIdlFile): { address: string; instructions: IdlInstructionJson[] } {
  return JSON.parse(readFileSync(new URL(`../../core/idl/${file}`, import.meta.url), "utf8"));
}

/** The trimmed format of test/fixtures/pump-idl-subset.json. */
function trimmed(ix: IdlInstructionJson) {
  return {
    name: ix.name,
    discriminator: ix.discriminator,
    args: ix.args.map((a) => ({ name: a.name, type: typeof a.type === "string" ? a.type : a.type.defined.name })),
    accounts: ix.accounts.map((a) => ({
      name: a.name,
      writable: a.writable === true,
      signer: a.signer === true,
      ...(a.address !== undefined ? { address: a.address } : {}),
    })),
  };
}

describe("IDL copies equal core's vendored IDLs (packages/core/idl)", () => {
  const source = JSON.parse(readFileSync(new URL("../../core/idl/SOURCE.json", import.meta.url), "utf8")) as {
    files: Record<string, string>;
  };

  test.each([
    ["pump", "pump.json", PUMP_INSTRUCTION_NAMES],
    ["pump_amm", "pump_amm.json", PUMP_AMM_INSTRUCTION_NAMES],
  ] as const)("%s: same IDL version, same instruction table, subset trimmed faithfully", (program, file, names) => {
    const idl = coreIdl(file);
    expect(subset._source[program].sha256).toBe(source.files[file]!);
    expect(subset._source[program].address).toBe(idl.address);
    const table = Object.fromEntries(idl.instructions.map((ix) => [toHex(Uint8Array.from(ix.discriminator)), ix.name]));
    expect(names).toEqual(table);
    for (const ix of subset[program]) {
      const full = idl.instructions.find((i) => i.name === ix.name);
      expect(full).toBeDefined();
      expect(ix).toEqual(trimmed(full!));
    }
  });

  const raydiumSource = JSON.parse(readFileSync(new URL("../../core/idl/RAYDIUM_SOURCE.json", import.meta.url), "utf8")) as {
    idl: { commit: string; files: Record<string, { path: string; sha256: string }> };
  };

  test.each([
    ["raydium_launchpad", "raydium_launchpad.json", LAUNCHLAB_INSTRUCTION_NAMES],
    ["raydium_cp_swap", "raydium_cp_swap.json", CPMM_INSTRUCTION_NAMES],
  ] as const)("%s: pinned file hash, same instruction table, subset trimmed faithfully", (program, file, names) => {
    const bytes = readFileSync(new URL(`../../core/idl/${file}`, import.meta.url));
    const pin = raydiumSource.idl.files[file]!;
    // The vendored file is the pinned one (the daily watch diffs the pin against upstream).
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(pin.sha256);
    expect(raydiumSubset._source[program].sha256).toBe(pin.sha256);
    expect(raydiumSubset._source[program].url).toBe(
      `https://raw.githubusercontent.com/raydium-io/raydium-idl/${raydiumSource.idl.commit}/${pin.path}`,
    );
    const idl = coreIdl(file);
    expect(raydiumSubset._source[program].address).toBe(idl.address);
    const table = Object.fromEntries(idl.instructions.map((ix) => [toHex(Uint8Array.from(ix.discriminator)), ix.name]));
    expect(names).toEqual(table);
    for (const ix of raydiumSubset[program]) {
      const full = idl.instructions.find((i) => i.name === ix.name);
      expect(full).toBeDefined();
      expect(ix).toEqual(trimmed(full!));
    }
  });

  test("Raydium authority seeds equal the IDL's PDA seeds", () => {
    const constSeed = (file: CoreIdlFile, ixName: string, account: string) => {
      const acc = coreIdl(file)
        .instructions.find((i) => i.name === ixName)
        ?.accounts.find((a) => a.name === account);
      const seeds = acc?.pda?.seeds ?? [];
      expect(seeds.map((s) => s.kind)).toEqual(["const"]);
      return new TextDecoder().decode(Uint8Array.from(seeds[0]?.value ?? []));
    };
    for (const d of LAUNCHLAB_SWAP_INSTRUCTIONS) {
      expect(constSeed("raydium_launchpad.json", d.name, "authority")).toBe(RAYDIUM_SEEDS.launchLabAuthority);
      expect(constSeed("raydium_launchpad.json", d.name, "event_authority")).toBe(RAYDIUM_SEEDS.launchLabEventAuthority);
    }
    for (const d of CPMM_SWAP_INSTRUCTIONS)
      expect(constSeed("raydium_cp_swap.json", d.name, "authority")).toBe(RAYDIUM_SEEDS.cpmmAuthority);
  });
});

describe("@zerofee/core stays a test-only dependency", () => {
  test("no source file imports it", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(join(import.meta.dir, "../src"));
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((f) => /from\s+["'](@zerofee\/core|(\.\.\/)+core\/)/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  test("package.json lists it under devDependencies only", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")) as Record<string, Record<string, string>>;
    expect(pkg.devDependencies?.["@zerofee/core"]).toBe("workspace:*");
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) expect(pkg[field]?.["@zerofee/core"]).toBeUndefined();
  });
});
