/**
 * The Jupiter rule's embedded IDL copy (rules/jupiter-idl.ts) against the program's on-chain IDL that
 * core vendors (packages/core/idl/jupiter.json, pinned in JUPITER_SOURCE.json), and the route-plan
 * decoder against every captured /build route plus malformed plans.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { address, getProgramDerivedAddress } from "@solana/kit";
import idlSource from "../../core/idl/JUPITER_SOURCE.json";
import capture from "../../core/test/fixtures/jupiter-build.json";
import { toHex } from "../src/bytes";
import { JUPITER_PROGRAM } from "../src/firewall/programs";
import { findJupiterEventAuthority, findJupiterProgramAuthority } from "../src/firewall/rules/jupiter";
import {
  decodeJupiterRoutePlan,
  JUPITER_INSTRUCTION_NAMES,
  JUPITER_REFUSAL_REASONS,
  JUPITER_REVIEWED_HOPS,
  JUPITER_ROUTE_INSTRUCTIONS,
  JUPITER_SEEDS,
  JUPITER_SWAP_TYPES,
  JUPITER_SWAP_VARIANTS,
  JupiterRoutePlanError,
  type JupiterType,
} from "../src/firewall/rules/jupiter-idl";

const IDL_BYTES = readFileSync(new URL("../../core/idl/jupiter.json", import.meta.url));

interface IdlField {
  name: string;
  type: unknown;
}
interface IdlAccount {
  name: string;
  writable?: boolean;
  signer?: boolean;
  optional?: boolean;
  address?: string;
}
interface IdlInstruction {
  name: string;
  discriminator: number[];
  accounts: IdlAccount[];
  args: IdlField[];
}
interface IdlTypeDef {
  name: string;
  type: { kind: "enum"; variants: { name: string; fields?: (IdlField | unknown)[] }[] } | { kind: "struct"; fields: IdlField[] };
}
const IDL = JSON.parse(IDL_BYTES.toString("utf8")) as { address: string; instructions: IdlInstruction[]; types: IdlTypeDef[] };
const ix = (name: string) => {
  const found = IDL.instructions.find((i) => i.name === name);
  if (!found) throw new Error(`IDL has no ${name}`);
  return found;
};
const typeDef = (name: string) => {
  const found = IDL.types.find((t) => t.name === name);
  if (!found) throw new Error(`IDL has no type ${name}`);
  return found;
};

/** The IDL's type JSON in the signer's representation ({ defined: { name } } -> { defined: name }). */
function convert(t: unknown): JupiterType {
  if (typeof t === "string") return t as JupiterType;
  const o = t as Record<string, unknown>;
  if ("option" in o) return { option: convert(o.option) };
  if ("vec" in o) return { vec: convert(o.vec) };
  if ("array" in o) {
    const [inner, n] = o.array as [unknown, number];
    return { array: [convert(inner), n] };
  }
  if ("defined" in o) return { defined: (o.defined as { name: string }).name };
  throw new Error(`unexpected IDL type ${JSON.stringify(t)}`);
}
const fieldType = (f: IdlField | unknown) => convert(typeof f === "object" && f !== null && "type" in f ? (f as IdlField).type : f);

describe("the vendored Jupiter IDL", () => {
  test("is the pinned on-chain IDL of the program the signer allowlists", () => {
    expect(createHash("sha256").update(IDL_BYTES).digest("hex")).toBe(idlSource.sha256);
    expect(IDL.address).toBe(JUPITER_PROGRAM);
    expect(idlSource.program).toBe(JUPITER_PROGRAM);
  });

  test("the signer's instruction-name table is the IDL's (19 instructions)", () => {
    expect(JUPITER_INSTRUCTION_NAMES).toEqual(
      Object.fromEntries(IDL.instructions.map((i) => [toHex(Uint8Array.from(i.discriminator)), i.name])),
    );
    expect(Object.keys(JUPITER_INSTRUCTION_NAMES)).toHaveLength(19);
  });

  test("every other route instruction has a stated refusal reason, and the accepted ones have none", () => {
    const routes = IDL.instructions.map((i) => i.name).filter((n) => /route/.test(n) && n !== "set_token_ledger");
    const accepted = JUPITER_ROUTE_INSTRUCTIONS.map((d) => d.name as string);
    expect(Object.keys(JUPITER_REFUSAL_REASONS).sort()).toEqual(routes.filter((n) => !accepted.includes(n)).sort());
  });
});

describe("route_v2 / shared_accounts_route_v2 layouts equal the IDL", () => {
  const ACCOUNT_NAMES: Record<string, Record<string, string>> = {
    route_v2: {
      authority: "user_transfer_authority",
      source: "user_source_token_account",
      destination: "user_destination_token_account",
      sourceMint: "source_mint",
      destinationMint: "destination_mint",
      sourceTokenProgram: "source_token_program",
      destinationTokenProgram: "destination_token_program",
      optionalDestination: "destination_token_account",
      eventAuthority: "event_authority",
      program: "program",
    },
    shared_accounts_route_v2: {
      programAuthority: "program_authority",
      authority: "user_transfer_authority",
      source: "source_token_account",
      programSource: "program_source_token_account",
      programDestination: "program_destination_token_account",
      destination: "destination_token_account",
      sourceMint: "source_mint",
      destinationMint: "destination_mint",
      sourceTokenProgram: "source_token_program",
      destinationTokenProgram: "destination_token_program",
      eventAuthority: "event_authority",
      program: "program",
    },
  };
  const SIZES: Record<string, number> = { u8: 1, u16: 2, u64: 8 };

  test.each(JUPITER_ROUTE_INSTRUCTIONS.map((d) => [d.name, d] as const))("%s: discriminator, accounts, argument offsets", (name, def) => {
    const idl = ix(name);
    expect(def.discriminator).toEqual(idl.discriminator);
    const { fixedAccounts, ...positions } = def.layout;
    expect(fixedAccounts as number).toBe(idl.accounts.length);
    expect(Object.fromEntries(Object.entries(positions).map(([k, i]) => [k, idl.accounts[i]!.name]))).toEqual(ACCOUNT_NAMES[name]!);
    const authority = idl.accounts[def.layout.authority]!;
    expect(authority.signer).toBe(true);
    if (name === "route_v2") expect(idl.accounts[7]!.optional).toBe(true);
    // Arguments in IDL order: [id u8], in_amount, quoted_out_amount, slippage_bps, platform_fee_bps, positive_slippage_bps, route_plan.
    const offsets: Record<string, number> = {};
    let at = 8;
    for (const arg of idl.args) {
      offsets[arg.name] = at;
      if (arg.name !== "route_plan") at += SIZES[arg.type as string]!;
    }
    expect(idl.args.at(-1)).toEqual({ name: "route_plan", type: { vec: { defined: { name: "RoutePlanStepV2" } } } });
    expect(idl.args.find((a) => a.name === "platform_fee_bps")?.type).toBe("u16");
    expect({
      id: offsets.id,
      inAmount: offsets.in_amount,
      quotedOut: offsets.quoted_out_amount,
      slippage: offsets.slippage_bps,
      platformFee: offsets.platform_fee_bps,
      positiveSlippage: offsets.positive_slippage_bps,
      routePlan: offsets.route_plan,
    }).toEqual({
      id: def.idOffset,
      inAmount: def.inAmountOffset,
      quotedOut: def.quotedOutOffset,
      slippage: def.slippageOffset,
      platformFee: def.platformFeeOffset,
      positiveSlippage: def.positiveSlippageOffset,
      routePlan: def.routePlanOffset,
    });
  });

  test("RoutePlanStepV2 is (swap: Swap, bps: u16, input_index: u8, output_index: u8)", () => {
    const step = typeDef("RoutePlanStepV2").type;
    expect(step.kind).toBe("struct");
    expect((step as { fields: IdlField[] }).fields.map((f) => [f.name, convert(f.type)])).toEqual([
      ["swap", { defined: "Swap" }],
      ["bps", "u16"],
      ["input_index", "u8"],
      ["output_index", "u8"],
    ]);
  });

  test("the embedded Swap enum (every variant, in order) and the types its fields use equal the IDL", () => {
    const swap = typeDef("Swap").type as { kind: "enum"; variants: { name: string; fields?: unknown[] }[] };
    expect(JUPITER_SWAP_VARIANTS.map((v) => [v[0], v[1] ?? []])).toEqual(
      swap.variants.map((v) => [v.name, (v.fields ?? []).map(fieldType)]),
    );
    expect(JUPITER_SWAP_VARIANTS.length).toBe(191);
    for (const [name, def] of Object.entries(JUPITER_SWAP_TYPES)) {
      const idl = typeDef(name).type;
      if (idl.kind === "enum") {
        expect(def).toEqual({
          kind: "enum",
          variants: idl.variants.map((v) => (v.fields?.length ? [v.name, v.fields.map(fieldType)] : [v.name])),
        });
      } else {
        expect(def).toEqual({ kind: "struct", fields: idl.fields.map((f) => convert(f.type)) });
      }
    }
    // Every type the variants reference is embedded.
    const referenced = new Set<string>();
    const walk = (t: JupiterType) => {
      if (typeof t === "string") return;
      if ("option" in t) walk(t.option);
      else if ("vec" in t) walk(t.vec);
      else if ("array" in t) walk(t.array[0]);
      else if (!referenced.has(t.defined)) {
        referenced.add(t.defined);
        const d = JUPITER_SWAP_TYPES[t.defined];
        if (!d) throw new Error(`type ${t.defined} is not embedded`);
        if (d.kind === "struct") d.fields.forEach(walk);
        else for (const v of d.variants) (v[1] ?? []).forEach(walk);
      }
    };
    for (const v of JUPITER_SWAP_VARIANTS) (v[1] ?? []).forEach(walk);
    expect([...referenced].sort()).toEqual(Object.keys(JUPITER_SWAP_TYPES).sort());
  });

  test('event authority: the IDL\'s pinned address is the PDA ["__event_authority"]', async () => {
    const pinned = ix("route_v2").accounts.find((a) => a.name === "event_authority")!.address!;
    expect(await findJupiterEventAuthority(JUPITER_PROGRAM)).toBe(address(pinned));
    expect(JUPITER_SEEDS.eventAuthority).toBe("__event_authority");
  });

  test("reviewed route_v2 hops are IDL Swap variants with the fields the rule reads (Whirlpool: a_to_b first)", () => {
    const swap = typeDef("Swap").type as { kind: "enum"; variants: { name: string; fields?: IdlField[] }[] };
    for (const [name, hop] of Object.entries(JUPITER_REVIEWED_HOPS)) {
      const variant = swap.variants.find((v) => v.name === name);
      expect(variant).toBeDefined();
      expect((variant!.fields ?? []).map((f) => [f.name, f.type])).toEqual(hop.aToB ? [["a_to_b", "bool"]] : []);
      expect(name.endsWith("WithRemainingAccounts")).toBe(hop.remaining);
    }
  });
});

describe("route-plan decoding", () => {
  const swapData = (label: keyof typeof capture.cases) =>
    new Uint8Array(Buffer.from(capture.cases[label].response.swapInstruction.data, "base64"));
  const defOf = (data: Uint8Array) => JUPITER_ROUTE_INSTRUCTIONS.find((d) => d.discriminator.every((b, i) => data[i] === b))!;

  test.each(Object.keys(capture.cases) as (keyof typeof capture.cases)[])("%s: decodes to exactly the hops /build reported", (label) => {
    const data = swapData(label);
    const def = defOf(data);
    const steps = decodeJupiterRoutePlan(data, def.routePlanOffset);
    const plan = capture.cases[label].response.routePlan;
    expect(steps).toHaveLength(plan.length);
    // Hop i of a single-path route spends the whole input of its token index.
    for (const s of steps) expect(s.bps).toBeGreaterThan(0);
    expect(steps[0]!.inputIndex).toBe(0);
  });

  test("the captured shared-accounts routes use program authorities that exist (ids 0-7)", async () => {
    for (const label of ["normalSell", "usdcBuy"] as const) {
      const data = swapData(label);
      const def = defOf(data);
      expect(def.name).toBe("shared_accounts_route_v2");
      const id = data[def.idOffset!]!;
      expect(id).toBeLessThan(8);
      const pinned = capture.cases[label].response.swapInstruction.accounts[0]!.pubkey;
      expect(await findJupiterProgramAuthority(JUPITER_PROGRAM, id)).toBe(address(pinned));
      const [viaKit] = await getProgramDerivedAddress({
        programAddress: JUPITER_PROGRAM,
        seeds: [new TextEncoder().encode("authority"), Uint8Array.of(id)],
      });
      expect(viaKit).toBe(address(pinned));
    }
  });

  const step = (variant: number, fields: number[] = [], bps = 10_000) => [variant, ...fields, bps & 0xff, bps >> 8, 0, 1];
  const plan = (...steps: number[][]) => {
    const n = steps.length;
    return Uint8Array.from([n & 0xff, (n >> 8) & 0xff, 0, 0, ...steps.flat()]);
  };
  const decode = (bytes: Uint8Array) => decodeJupiterRoutePlan(bytes, 0);

  test("decodes variants with fields of every kind (bool, enum, Option, Vec, arrays, bytes)", () => {
    const whirlpool = JUPITER_SWAP_VARIANTS.findIndex((v) => v[0] === "Whirlpool"); // a_to_b: bool
    const serum = JUPITER_SWAP_VARIANTS.findIndex((v) => v[0] === "Serum"); // side: Side
    const whirlpoolV2 = JUPITER_SWAP_VARIANTS.findIndex((v) => v[0] === "WhirlpoolSwapV2"); // bool, Option<RemainingAccountsInfo>
    const rfq = JUPITER_SWAP_VARIANTS.findIndex((v) => v[0] === "JupiterRfqV2"); // Side, bytes
    const humidifi = JUPITER_SWAP_VARIANTS.findIndex((v) => v[0] === "HumidiFiRouter"); // u64, [u8; 32], [u8; 16], bool
    const steps = decode(
      plan(
        step(whirlpool, [1]),
        step(serum, [1]),
        step(whirlpoolV2, [0, 1, 2, 0, 0, 0, 0, 3, 1, 4]),
        step(rfq, [0, 3, 0, 0, 0, 9, 9, 9]),
        step(humidifi, [...new Array(8 + 32 + 16).fill(7), 1]),
      ),
    );
    expect(steps.map((s) => s.venue)).toEqual(["Whirlpool", "Serum", "WhirlpoolSwapV2", "JupiterRfqV2", "HumidiFiRouter"]);
  });

  test.each([
    ["an empty route plan", plan(), /route plan is empty/],
    [
      "a Swap variant the reviewed IDL does not know",
      plan(step(JUPITER_SWAP_VARIANTS.length)),
      /Swap variant 191 is not in the reviewed IDL/,
    ],
    ["a bool that is neither 0 nor 1", plan(step(17, [2])), /bool byte 2/],
    ["an enum variant out of range (Side 2)", plan(step(12, [2])), /Side variant 2 does not exist/],
    ["an Option tag of 2", plan(step(47, [0, 2])), /option tag 2/],
    ["a Vec longer than the data", plan(step(47, [0, 1, 255, 255, 0, 0])), /vec length 65535/],
    [
      "a step cut short inside its fields (HumidiFiRouter, 57 field bytes)",
      plan(step(185, new Array(57).fill(0))).subarray(0, 24),
      /truncated/,
    ],
    ["a route plan longer than the data", Uint8Array.from([3, 0, 0, 0, ...step(0)]), /route plan length 3 exceeds the data/],
    ["trailing bytes", Uint8Array.from([...plan(step(0)), 0]), /1 trailing bytes after the route plan/],
  ] as const)("refuses %s", (_name, bytes, pattern) => {
    expect(() => decode(bytes)).toThrow(JupiterRoutePlanError);
    expect(() => decode(bytes)).toThrow(pattern);
  });
});
