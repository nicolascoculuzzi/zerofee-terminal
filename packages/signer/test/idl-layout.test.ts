/**
 * Cross-checks the firewall's hardcoded venue layouts against the official IDLs
 * (test/fixtures/pump-idl-subset.json, trimmed from pump-public-docs idl/pump.json and idl/pump_amm.json;
 * test/fixtures/raydium-idl-subset.json, trimmed from raydium-idl raydium_launchpad.json and
 * raydium_cp_swap.json), and the fixture IDs against PDA derivations.
 */
import { describe, expect, test } from "bun:test";
import { type Address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { toHex } from "../src/bytes";
import { SYSTEM_PROGRAM, TOKEN_PROGRAM } from "../src/firewall/programs";
import {
  PUMP_AMM_EXTEND_ACCOUNT,
  PUMP_AMM_INSTRUCTION_NAMES,
  PUMP_AMM_INSTRUCTIONS,
  PUMP_CURVE_INSTRUCTIONS,
  PUMP_INSTRUCTION_NAMES,
  type VenueInstruction,
} from "../src/firewall/rules/pump-idl";
import {
  CPMM_DATA_LENGTH,
  CPMM_INSTRUCTION_NAMES,
  CPMM_STATIC_POSITIONS,
  CPMM_SWAP_INSTRUCTIONS,
  CPMM_SWAP_LAYOUT,
  LAUNCHLAB_DATA_LENGTH,
  LAUNCHLAB_INSTRUCTION_NAMES,
  LAUNCHLAB_SHARE_FEE_RATE_OFFSET,
  LAUNCHLAB_STATIC_POSITIONS,
  LAUNCHLAB_SWAP_INSTRUCTIONS,
  LAUNCHLAB_SWAP_LAYOUT,
} from "../src/firewall/rules/raydium-idl";
import subset from "./fixtures/pump-idl-subset.json";
import raydiumSubset from "./fixtures/raydium-idl-subset.json";
import { MAINNET, PROGRAMS } from "./helpers/fixtures";
import { type IdlInstruction, type IdlProgram, idlInstruction } from "./helpers/idl";

const ARG_SIZE: Record<string, number> = { u64: 8, OptionBool: 1 };

/** Which IDL argument each layout offset must point at. */
const ARG_ROLES: Record<string, { cap?: string; base: string; minOut?: string }> = {
  "pump.buy": { base: "amount", cap: "max_sol_cost" },
  "pump.buy_exact_sol_in": { cap: "spendable_sol_in", base: "min_tokens_out" },
  "pump.buy_v2": { base: "amount", cap: "max_sol_cost" },
  "pump.buy_exact_quote_in_v2": { cap: "spendable_quote_in", base: "min_tokens_out" },
  "pump.sell": { base: "amount", minOut: "min_sol_output" },
  "pump.sell_v2": { base: "amount", minOut: "min_sol_output" },
  "pump_amm.buy": { base: "base_amount_out", cap: "max_quote_amount_in" },
  "pump_amm.buy_exact_quote_in": { cap: "spendable_quote_in", base: "min_base_amount_out" },
  "pump_amm.sell": { base: "base_amount_in", minOut: "min_quote_amount_out" },
};

/** Required remaining accounts beyond the IDL list (BREAKING_FEE_RECIPIENT.md, pump-swap-sdk 1.20.0). */
const REMAINING: Record<string, number[]> = {
  "pump.buy": [2],
  "pump.buy_exact_sol_in": [2],
  "pump.buy_v2": [0],
  "pump.buy_exact_quote_in_v2": [0],
  "pump.sell": [2, 3],
  "pump.sell_v2": [0],
  "pump_amm.buy": [2, 3, 4],
  "pump_amm.buy_exact_quote_in": [2, 3, 4],
  "pump_amm.sell": [2, 3, 4, 5],
};

const ACCOUNT_NAMES = {
  user: ["user"],
  baseMint: ["mint", "base_mint"],
  quoteMint: ["quote_mint"],
  baseTokenProgram: ["token_program", "base_token_program"],
  quoteTokenProgram: ["quote_token_program"],
  userBaseTokenAccount: ["associated_user", "associated_base_user", "user_base_token_account"],
  userQuoteTokenAccount: ["associated_quote_user", "user_quote_token_account"],
  pool: ["pool"],
} as const;

function argOffset(ix: IdlInstruction, name: string): number {
  let offset = 8;
  for (const arg of ix.args) {
    if (arg.name === name) return offset;
    offset += ARG_SIZE[arg.type]!;
  }
  throw new Error(`no arg ${name}`);
}

function check(program: IdlProgram, defs: readonly VenueInstruction[]) {
  for (const def of defs) {
    test(`${program}.${def.name}`, () => {
      const idl = idlInstruction(program, def.name);
      const key = `${program}.${def.name}`;
      expect(def.discriminator).toEqual(idl.discriminator);

      const roles = ARG_ROLES[key]!;
      expect(def.baseOffset).toBe(argOffset(idl, roles.base));
      if (roles.cap) expect(def.capOffset).toBe(argOffset(idl, roles.cap));
      if (roles.minOut) expect(def.minOutOffset).toBe(argOffset(idl, roles.minOut));
      expect(def.side).toBe(roles.cap ? "buy" : "sell");
      for (const name of [roles.base, roles.cap, roles.minOut].filter(Boolean)) {
        expect(idl.args.find((a) => a.name === name)?.type).toBe("u64");
      }

      const full = 8 + idl.args.reduce((n, a) => n + ARG_SIZE[a.type]!, 0);
      const hasOptionBool = idl.args.at(-1)?.type === "OptionBool";
      expect([...def.dataLengths].sort()).toEqual(hasOptionBool ? [full - 1, full] : [full]);

      expect([...def.layout.accountCounts]).toEqual(REMAINING[key]!.map((n) => idl.accounts.length + n));
      for (const [field, names] of Object.entries(ACCOUNT_NAMES)) {
        const index = def.layout[field as keyof typeof ACCOUNT_NAMES];
        if (index === undefined) continue;
        expect(names as readonly string[]).toContain(idl.accounts[index]!.name);
      }
      const user = idl.accounts[def.layout.user]!;
      expect(user.signer && user.writable).toBe(true);
      expect(idl.accounts.filter((a) => a.signer).length).toBe(1);

      const names = program === "pump" ? PUMP_INSTRUCTION_NAMES : PUMP_AMM_INSTRUCTION_NAMES;
      expect(names[toHex(Uint8Array.from(def.discriminator))]).toBe(def.name);
    });
  }
}

describe("pump.fun bonding curve layouts match idl/pump.json", () => check("pump", PUMP_CURVE_INSTRUCTIONS));
describe("PumpSwap layouts match idl/pump_amm.json", () => {
  check("pump_amm", PUMP_AMM_INSTRUCTIONS);

  test("pump_amm.extend_account", () => {
    const X = PUMP_AMM_EXTEND_ACCOUNT;
    const idl = idlInstruction("pump_amm", X.name);
    expect(X.discriminator).toEqual(idl.discriminator);
    expect(idl.args).toEqual([]);
    expect(X.dataLength).toBe(8);
    expect(idl.accounts).toHaveLength(X.accountCount);
    expect(idl.accounts[X.account]).toMatchObject({ name: "account", writable: true, signer: false });
    expect(idl.accounts[X.user]).toMatchObject({ name: "user", writable: true, signer: true });
    expect(idl.accounts[X.systemProgram]).toMatchObject({ name: "system_program", address: SYSTEM_PROGRAM });
    expect(idl.accounts.filter((a) => a.signer)).toHaveLength(1);
    expect(PUMP_AMM_INSTRUCTION_NAMES[toHex(Uint8Array.from(X.discriminator))]).toBe(X.name);
  });
});

// ---------------------------------------------------------------------------------------------
// Raydium LaunchLab and CPMM
// ---------------------------------------------------------------------------------------------

/** The IDL argument each LaunchLab offset must point at, and what the base amount means. */
const LAUNCHLAB_ROLES: Record<string, { cap?: string; base: string; minOut?: string; baseAmountIs: string }> = {
  buy_exact_in: { cap: "amount_in", base: "minimum_amount_out", baseAmountIs: "min_out" },
  buy_exact_out: { base: "amount_out", cap: "maximum_amount_in", baseAmountIs: "exact_out" },
  sell_exact_in: { base: "amount_in", minOut: "minimum_amount_out", baseAmountIs: "exact_in" },
  sell_exact_out: { minOut: "amount_out", base: "maximum_amount_in", baseAmountIs: "max_in" },
};

/** IDL account names at the LaunchLab layout positions; 15..17 are required remaining accounts (not in the IDL). */
const LAUNCHLAB_ACCOUNT_NAMES: Record<string, string> = {
  payer: "payer",
  authority: "authority",
  globalConfig: "global_config",
  platformConfig: "platform_config",
  pool: "pool_state",
  userBaseToken: "user_base_token",
  userQuoteToken: "user_quote_token",
  baseVault: "base_vault",
  quoteVault: "quote_vault",
  baseMint: "base_token_mint",
  quoteMint: "quote_token_mint",
  baseTokenProgram: "base_token_program",
  quoteTokenProgram: "quote_token_program",
  eventAuthority: "event_authority",
  program: "program",
};
const LAUNCHLAB_REMAINING = ["systemProgram", "platformFeeVault", "creatorFeeVault"];

describe("Raydium LaunchLab layouts match raydium_launchpad.json", () => {
  test.each(LAUNCHLAB_SWAP_INSTRUCTIONS.map((d) => [d.name, d] as const))("%s", (_name, def) => {
    const idl = idlInstruction("raydium_launchpad", def.name);
    const roles = LAUNCHLAB_ROLES[def.name]!;
    expect(def.discriminator).toEqual(idl.discriminator);
    expect(idl.args.map((a) => a.type)).toEqual(["u64", "u64", "u64"]);
    expect(argOffset(idl, "share_fee_rate")).toBe(LAUNCHLAB_SHARE_FEE_RATE_OFFSET);
    expect(def.baseOffset).toBe(argOffset(idl, roles.base));
    if (roles.cap) expect(def.capOffset).toBe(argOffset(idl, roles.cap));
    if (roles.minOut) expect(def.minOutOffset).toBe(argOffset(idl, roles.minOut));
    expect(def.side).toBe(roles.cap ? "buy" : "sell");
    expect<string>(def.baseAmountIs).toBe(roles.baseAmountIs);
    expect(LAUNCHLAB_DATA_LENGTH).toBe(8 + 8 * idl.args.length);

    // 15 IDL accounts + system_program, platform_fee_vault, creator_fee_vault.
    expect<number>(LAUNCHLAB_SWAP_LAYOUT.accountCount).toBe(idl.accounts.length + LAUNCHLAB_REMAINING.length);
    expect(Object.keys(LAUNCHLAB_ACCOUNT_NAMES)).toHaveLength(idl.accounts.length);
    for (const [field, name] of Object.entries(LAUNCHLAB_ACCOUNT_NAMES)) {
      expect({ field, name: idl.accounts[LAUNCHLAB_SWAP_LAYOUT[field as keyof typeof LAUNCHLAB_SWAP_LAYOUT]]?.name }).toEqual({
        field,
        name,
      });
    }
    expect(LAUNCHLAB_REMAINING.map((f) => LAUNCHLAB_SWAP_LAYOUT[f as keyof typeof LAUNCHLAB_SWAP_LAYOUT])).toEqual([15, 16, 17]);
    expect(idl.accounts[LAUNCHLAB_SWAP_LAYOUT.payer]).toMatchObject({ signer: true, writable: true });
    expect(idl.accounts.filter((a) => a.signer)).toHaveLength(1);
    // The IDL pins quote_token_program to SPL Token, but the program accepts Token-2022 quotes (xStock
    // pairs, e.g. core's METAx pool) and so does the firewall. A change here needs the doc in raydium-idl.ts updated.
    expect(idl.accounts[LAUNCHLAB_SWAP_LAYOUT.quoteTokenProgram]).toMatchObject({ address: TOKEN_PROGRAM });
    expect(LAUNCHLAB_INSTRUCTION_NAMES[toHex(Uint8Array.from(def.discriminator))]).toBe(def.name);
  });
});

/** IDL account names at the CPMM layout positions. */
const CPMM_ACCOUNT_NAMES: Record<string, string> = {
  payer: "payer",
  authority: "authority",
  ammConfig: "amm_config",
  pool: "pool_state",
  inputTokenAccount: "input_token_account",
  outputTokenAccount: "output_token_account",
  inputVault: "input_vault",
  outputVault: "output_vault",
  inputTokenProgram: "input_token_program",
  outputTokenProgram: "output_token_program",
  inputMint: "input_token_mint",
  outputMint: "output_token_mint",
  observation: "observation_state",
};

const CPMM_ROLES: Record<string, { input: string; inputIs: string; output: string; outputIs: string }> = {
  swap_base_input: { input: "amount_in", inputIs: "exact", output: "minimum_amount_out", outputIs: "min" },
  swap_base_output: { input: "max_amount_in", inputIs: "max", output: "amount_out", outputIs: "exact" },
};

describe("Raydium CPMM layouts match raydium_cp_swap.json", () => {
  test.each(CPMM_SWAP_INSTRUCTIONS.map((d) => [d.name, d] as const))("%s", (_name, def) => {
    const idl = idlInstruction("raydium_cp_swap", def.name);
    const roles = CPMM_ROLES[def.name]!;
    expect(def.discriminator).toEqual(idl.discriminator);
    expect(idl.args.map((a) => a.type)).toEqual(["u64", "u64"]);
    expect(def.inputOffset).toBe(argOffset(idl, roles.input));
    expect(def.outputOffset).toBe(argOffset(idl, roles.output));
    expect<string[]>([def.inputIs, def.outputIs]).toEqual([roles.inputIs, roles.outputIs]);
    expect(CPMM_DATA_LENGTH).toBe(8 + 8 * idl.args.length);
    expect<number>(CPMM_SWAP_LAYOUT.accountCount).toBe(idl.accounts.length);
    for (const [field, name] of Object.entries(CPMM_ACCOUNT_NAMES)) {
      expect({ field, name: idl.accounts[CPMM_SWAP_LAYOUT[field as keyof typeof CPMM_SWAP_LAYOUT]]?.name }).toEqual({ field, name });
    }
    expect(Object.keys(CPMM_ACCOUNT_NAMES)).toHaveLength(idl.accounts.length);
    expect(idl.accounts[CPMM_SWAP_LAYOUT.payer]).toMatchObject({ signer: true });
    expect(idl.accounts.filter((a) => a.signer)).toHaveLength(1);
    expect(CPMM_INSTRUCTION_NAMES[toHex(Uint8Array.from(def.discriminator))]).toBe(def.name);
  });
});

describe("Raydium static positions", () => {
  test("cover the user's accounts, mints, token programs and every account checked by address or derivation", () => {
    const L = LAUNCHLAB_SWAP_LAYOUT;
    const checked = [L.payer, L.authority, L.platformConfig, L.pool, L.userBaseToken, L.userQuoteToken, L.baseMint, L.quoteMint];
    expect([...LAUNCHLAB_STATIC_POSITIONS]).toEqual(
      [...checked, L.baseTokenProgram, L.quoteTokenProgram, L.eventAuthority, L.systemProgram, L.platformFeeVault].sort((x, y) => x - y),
    );
    const C = CPMM_SWAP_LAYOUT;
    expect([...CPMM_STATIC_POSITIONS]).toEqual(
      [
        C.payer,
        C.authority,
        C.pool,
        C.inputTokenAccount,
        C.outputTokenAccount,
        C.inputVault,
        C.outputVault,
        C.inputTokenProgram,
        C.outputTokenProgram,
        C.inputMint,
        C.outputMint,
        C.observation,
      ].sort((x, y) => x - y),
    );
  });
});

describe("fixtures", () => {
  test("IDL fixture is for the injected program IDs and name tables are complete", () => {
    expect(subset._source.pump.address).toBe(PROGRAMS.pump);
    expect(subset._source.pump_amm.address).toBe(PROGRAMS.pumpAmm);
    expect(Object.keys(PUMP_INSTRUCTION_NAMES)).toHaveLength(47);
    expect(Object.keys(PUMP_AMM_INSTRUCTION_NAMES)).toHaveLength(32);
    expect(raydiumSubset._source.raydium_launchpad.address).toBe(PROGRAMS.raydiumLaunchLab);
    expect(raydiumSubset._source.raydium_cp_swap.address).toBe(PROGRAMS.raydiumCpmm);
    expect(Object.keys(LAUNCHLAB_INSTRUCTION_NAMES)).toHaveLength(25);
    expect(Object.keys(CPMM_INSTRUCTION_NAMES)).toHaveLength(14);
  });

  test("report's mainnet accounts equal their PDA derivations", async () => {
    const te = new TextEncoder();
    const enc = getAddressEncoder();
    const pda = async (program: Address, ...seeds: Uint8Array[]) => (await getProgramDerivedAddress({ programAddress: program, seeds }))[0];
    expect(await pda(PROGRAMS.pump, te.encode("global"))).toBe(MAINNET.pumpGlobal);
    expect(await pda(PROGRAMS.pumpFees, te.encode("fee_config"), new Uint8Array(enc.encode(PROGRAMS.pump)))).toBe(MAINNET.pumpFeeConfig);
    expect(await pda(PROGRAMS.pumpAmm, te.encode("global_config"))).toBe(MAINNET.ammGlobalConfig);
    expect(await pda(PROGRAMS.pumpFees, te.encode("fee_config"), new Uint8Array(enc.encode(PROGRAMS.pumpAmm)))).toBe(MAINNET.ammFeeConfig);
  });
});
