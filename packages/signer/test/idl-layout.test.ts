/**
 * Cross-checks the firewall's hardcoded pump layouts against the official IDLs
 * (test/fixtures/pump-idl-subset.json, trimmed from pump-public-docs idl/pump.json and idl/pump_amm.json),
 * and the fixture IDs against PDA derivations.
 */
import { describe, expect, test } from "bun:test";
import { type Address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { toHex } from "../src/bytes";
import {
  PUMP_AMM_INSTRUCTION_NAMES,
  PUMP_AMM_INSTRUCTIONS,
  PUMP_CURVE_INSTRUCTIONS,
  PUMP_INSTRUCTION_NAMES,
  type VenueInstruction,
} from "../src/firewall/rules/pump-idl";
import subset from "./fixtures/pump-idl-subset.json";
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
describe("PumpSwap layouts match idl/pump_amm.json", () => check("pump_amm", PUMP_AMM_INSTRUCTIONS));

describe("fixtures", () => {
  test("IDL fixture is for the injected program IDs and name tables are complete", () => {
    expect(subset._source.pump.address).toBe(PROGRAMS.pump);
    expect(subset._source.pump_amm.address).toBe(PROGRAMS.pumpAmm);
    expect(Object.keys(PUMP_INSTRUCTION_NAMES)).toHaveLength(47);
    expect(Object.keys(PUMP_AMM_INSTRUCTION_NAMES)).toHaveLength(32);
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
