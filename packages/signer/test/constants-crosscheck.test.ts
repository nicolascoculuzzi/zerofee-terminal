/**
 * The signer embeds its own reviewed copy of program IDs, mints, discriminators, account layouts and
 * tip accounts (SPEC "Verify before you code"), so it never trusts @zerofee/core or the backend at
 * runtime. This suite fails loudly when that copy drifts from core: every value is compared one by
 * one, layouts are checked against the instructions core actually builds, and the trimmed IDL the
 * layout tests use is checked against core's vendored IDLs (which the daily pump-watch job diffs).
 *
 * @zerofee/core is a test-only devDependency; the last block makes sure it stays that way.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AccountRole, type Address, address, type Instruction } from "@solana/kit";
import * as core from "@zerofee/core";
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
  DEFAULT_FIREWALL_CAPS,
  HELIUS_SENDER_TIP_ACCOUNTS,
  JITO_TIP_ACCOUNTS,
  SIGNER_ALLOWED_PROGRAMS,
  SIGNER_TIP_ACCOUNTS,
} from "../src/policy";
import subset from "./fixtures/pump-idl-subset.json";
import { randomAddress } from "./helpers/fixtures";

const def = (defs: readonly VenueInstruction[], name: string): VenueInstruction => {
  const found = defs.find((d) => d.name === name);
  if (!found) throw new Error(`signer has no layout for ${name}`);
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
  ])("%s", (_name, signer, fromCore) => {
    expect(signer).toBe(fromCore);
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
  accounts: IdlAccountJson[];
}

function coreIdl(file: "pump.json" | "pump_amm.json"): { address: string; instructions: IdlInstructionJson[] } {
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
