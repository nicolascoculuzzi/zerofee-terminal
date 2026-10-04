/**
 * Engine <-> firewall integration for the Jupiter long-tail fallback (the matrix for the local venues
 * is engine.integration.test.ts). Every transaction is built by @zerofee/core exactly as the CLI and the
 * web app build it: loadTokenState resolves the token to the Jupiter fallback, buildTrade calls /build
 * (served from real responses captured on 2026-10-03), planFees, then assembleTransaction with the
 * route's lookup tables. Each must pass the policy the signer ships (createSignerPolicy) in every
 * landing mode, with and without core's quote as the expectation, and each one, tampered with the way
 * a compromised backend, app or Jupiter API would, must be refused for the right reason.
 * Trades: a Meteora DBC curve coin and a Token-2022 DAMM v2 coin bought and sold against SOL, BONK both
 * ways (the sell is a four-account-heavy shared-accounts route), and a two-hop USDC-funded buy.
 */
import { describe, expect, test } from "bun:test";
import { type AccountMeta, AccountRole, type Address, getTransactionEncoder, type Instruction } from "@solana/kit";
import { assembleTransaction, WSOL_MINT as CORE_WSOL, type FeeCaps, type LandingMode } from "@zerofee/core";
import { readU32LE } from "../src/bytes";
import { findAssociatedTokenAddress as ata } from "../src/firewall/ata";
import { decodeTransaction } from "../src/firewall/decode";
import {
  JITO_DONT_FRONT_PREFIX,
  JUPITER_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  WSOL_MINT,
} from "../src/firewall/programs";
import {
  JUPITER_INSTRUCTION_NAMES,
  JUPITER_ROUTE_INSTRUCTIONS,
  JUPITER_ROUTE_V2_LAYOUT,
  JUPITER_SHARED_ROUTE_V2_LAYOUT,
  type JupiterRouteInstruction,
} from "../src/firewall/rules/jupiter-idl";
import type { FirewallContext, TradeExpectation } from "../src/firewall/types";
import { createSignerPolicy, HELIUS_SENDER_TIP_ACCOUNTS, JITO_TIP_ACCOUNTS, SIGNER_TIP_ACCOUNTS } from "../src/policy";
import { CLI_SLIPPAGE_BPS, coreInstructionList, planFor } from "./helpers/engine";
import type { TestActors } from "./helpers/fixtures";
import {
  assembleJupiter,
  buildJupiter,
  compileJupiter,
  JUPITER_TRADES,
  type JupiterBuilt,
  type JupiterTrade,
  jupiterActors,
} from "./helpers/jupiter";
import { expectAllowed, expectRefused } from "./helpers/scenarios";
import { randomBlockhash } from "./helpers/tx";

const POLICY = createSignerPolicy();
const CAPS = POLICY.caps;
const FEE_CAPS: FeeCaps = { maxPriorityFeeLamports: CAPS.maxPriorityFeeLamports, maxTipLamports: CAPS.maxTipLamports };
const MODES: readonly LandingMode[] = ["standard", "turbo", "protected"];
/** core's layout: [SetComputeUnitLimit, SetComputeUnitPrice, ...trade instructions, ...tips]. */
const BUDGET_IXS = 2;
const VENUE = "Jupiter";

/** The context the shipped signer builds for a request, handed the route's lookup tables. */
function shippedContext(a: TestActors, built: JupiterBuilt, extra: Partial<FirewallContext> = {}): FirewallContext {
  return { signer: a.signer, connectedWallet: a.connected, ownedNonceAccounts: [], ...POLICY, addressLookupTables: built.tables, ...extra };
}

const routeDef = (built: JupiterBuilt): JupiterRouteInstruction => {
  const data = built.trade.instructions[built.swapIndex]!.data!;
  const def = JUPITER_ROUTE_INSTRUCTIONS.find((d) => d.discriminator.every((b, i) => data[i] === b));
  if (!def) throw new Error("core built no v2 route");
  return def;
};
const layoutOf = (built: JupiterBuilt) => routeDef(built).layout;

const writable = (address: Address): AccountMeta => ({ address, role: AccountRole.WRITABLE });
const isSystemTransfer = (ix: Instruction) => ix.programAddress === SYSTEM_PROGRAM && ix.data?.length === 12 && readU32LE(ix.data, 0) === 2;
const isCloseAccount = (ix: Instruction) =>
  (ix.programAddress === TOKEN_PROGRAM || ix.programAddress === TOKEN_2022_PROGRAM) && ix.data?.length === 1 && ix.data[0] === 9;

function shapeOf(ix: Instruction): string {
  if (ix.programAddress === JUPITER_PROGRAM) return "jupiter";
  if (isSystemTransfer(ix)) return "transfer";
  if (isCloseAccount(ix)) return "close";
  if ((ix.programAddress === TOKEN_PROGRAM || ix.programAddress === TOKEN_2022_PROGRAM) && ix.data?.[0] === 17) return "sync";
  if (ix.programAddress === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL") return "ata";
  return `other ${ix.programAddress}`;
}

function setAccount(ix: Instruction, index: number, meta: AccountMeta): Instruction {
  const accounts = [...(ix.accounts ?? [])];
  accounts[index] = meta;
  return { ...ix, accounts };
}

function patchData(ix: Instruction, patch: (view: DataView, data: Uint8Array) => void): Instruction {
  const data = new Uint8Array(ix.data!);
  patch(new DataView(data.buffer), data);
  return { ...ix, data };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One trade in one landing mode: core's memoized build and its exact instruction list (fresh copy per call). */
interface Group {
  label: JupiterTrade;
  mode: LandingMode;
  a: TestActors;
  build(): Promise<JupiterBuilt>;
}

async function listOf(g: Group) {
  const built = await g.build();
  const plan = planFor(g.mode, built.trade.defaultCuLimit, FEE_CAPS);
  const full = coreInstructionList(g.a.signer, built.trade.instructions, plan);
  const t = BUDGET_IXS + built.swapIndex;
  return { built, plan, full, t, label: `#${t} ${VENUE} ${routeDef(built).name}` };
}

/** What each capture is, known before building (the harness test checks it against core's builds). */
interface TradeInfo {
  side: "buy" | "sell";
  route: "route_v2" | "shared_accounts_route_v2";
  /** The route loads accounts from Jupiter's lookup tables. */
  tables: boolean;
}

const TRADES: Readonly<Record<JupiterTrade, TradeInfo>> = {
  longtailCurveBuy: { side: "buy", route: "route_v2", tables: false },
  longtailCurveSell: { side: "sell", route: "route_v2", tables: false },
  longtail2022Buy: { side: "buy", route: "route_v2", tables: true },
  longtail2022Sell: { side: "sell", route: "route_v2", tables: true },
  normalBuy: { side: "buy", route: "route_v2", tables: true },
  normalSell: { side: "sell", route: "shared_accounts_route_v2", tables: true },
  usdcBuy: { side: "buy", route: "shared_accounts_route_v2", tables: true },
};

interface Mutation {
  name: string;
  applies(info: TradeInfo): boolean;
  run(g: Group): Promise<void>;
}

const MUTATIONS: readonly Mutation[] = [
  {
    name: "the output sent to the attacker's token account (destination ATA swapped)",
    applies: () => true,
    async run(g) {
      const { built, full, t, label } = await listOf(g);
      const L = layoutOf(built);
      const program = full[t]!.accounts![L.destinationTokenProgram]!.address;
      const attackerAta = await ata(g.a.attacker, built.side === "buy" ? built.baseMint : built.quoteMint, program);
      full[t] = setAccount(full[t]!, L.destination, writable(attackerAta));
      await expectRefused(
        compileJupiter(full, built.trade.lookupTables!),
        shippedContext(g.a, built),
        new RegExp(
          `${escapeRegExp(label)}: token account at position ${L.destination} must be the trading wallet's associated token account`,
        ),
      );
    },
  },
  {
    name: "the input taken from another account (source swapped to the attacker's ATA)",
    applies: () => true,
    async run(g) {
      const { built, full, t, label } = await listOf(g);
      const L = layoutOf(built);
      const program = full[t]!.accounts![L.sourceTokenProgram]!.address;
      full[t] = setAccount(
        full[t]!,
        L.source,
        writable(await ata(g.a.attacker, built.side === "buy" ? built.quoteMint : built.baseMint, program)),
      );
      await expectRefused(
        compileJupiter(full, built.trade.lookupTables!),
        shippedContext(g.a, built),
        new RegExp(`${escapeRegExp(label)}: token account at position ${L.source} must be the trading wallet's associated token account`),
      );
    },
  },
  {
    name: "a platform fee (platform_fee_bps 50, the attacker's fee account inserted as the first hop account)",
    applies: () => true,
    async run(g) {
      const { built, full, t, label } = await listOf(g);
      const def = routeDef(built);
      const ix = patchData(full[t]!, (v) => v.setUint16(def.platformFeeOffset, 50, true));
      const accounts = [...ix.accounts!];
      accounts.splice(
        def.layout.fixedAccounts,
        0,
        writable(await ata(g.a.attacker, built.side === "buy" ? built.baseMint : built.quoteMint, TOKEN_PROGRAM)),
      );
      full[t] = { ...ix, accounts };
      await expectRefused(
        compileJupiter(full, built.trade.lookupTables!),
        shippedContext(g.a, built),
        new RegExp(`${escapeRegExp(label)}: platform_fee_bps must be 0, got 50`),
      );
    },
  },
  {
    name: "a fee on positive slippage (positive_slippage_bps 5,000)",
    applies: () => true,
    async run(g) {
      const { built, full, t, label } = await listOf(g);
      full[t] = patchData(full[t]!, (v) => v.setUint16(routeDef(built).positiveSlippageOffset, 5_000, true));
      await expectRefused(
        compileJupiter(full, built.trade.lookupTables!),
        shippedContext(g.a, built),
        new RegExp(`${escapeRegExp(label)}: positive_slippage_bps must be 0, got 5000`),
      );
    },
  },
  {
    name: "user_transfer_authority is another wallet (it would have to sign)",
    applies: () => true,
    async run(g) {
      const { built, full, t, label } = await listOf(g);
      full[t] = setAccount(full[t]!, layoutOf(built).authority, { address: g.a.attacker, role: AccountRole.READONLY_SIGNER });
      const violations = await expectRefused(
        compileJupiter(full, built.trade.lookupTables!),
        shippedContext(g.a, built),
        /transaction requires 2 signatures .*only the trading wallet may sign/,
      );
      expect(violations.join("\n")).toMatch(
        new RegExp(`${escapeRegExp(label)}: user_transfer_authority must be the trading wallet, not ${g.a.attacker}`),
      );
    },
  },
  {
    name: "user_transfer_authority is the connected wallet (no extra signature)",
    applies: () => true,
    async run(g) {
      const { built, full, t, label } = await listOf(g);
      full[t] = setAccount(full[t]!, layoutOf(built).authority, { address: g.a.connected, role: AccountRole.READONLY });
      await expectRefused(
        compileJupiter(full, built.trade.lookupTables!),
        shippedContext(g.a, built),
        new RegExp(`${escapeRegExp(label)}: user_transfer_authority must be the trading wallet, not ${g.a.connected}`),
      );
    },
  },
  {
    name: "a zero minimum out: quoted_out_amount 0, or slippage_bps 10,000",
    applies: () => true,
    async run(g) {
      const { built, full, t, label } = await listOf(g);
      const def = routeDef(built);
      const zeroQuote = [...full];
      zeroQuote[t] = patchData(full[t]!, (v) => v.setBigUint64(def.quotedOutOffset, 0n, true));
      await expectRefused(
        compileJupiter(zeroQuote, built.trade.lookupTables!),
        shippedContext(g.a, built),
        new RegExp(`${escapeRegExp(label)}: quoted_out_amount is 0, so the minimum output is 0`),
      );
      const allSlippage = [...full];
      allSlippage[t] = patchData(full[t]!, (v) => v.setUint16(def.slippageOffset, 10_000, true));
      await expectRefused(
        compileJupiter(allSlippage, built.trade.lookupTables!),
        shippedContext(g.a, built),
        new RegExp(`${escapeRegExp(label)}: slippage_bps 10000 leaves no minimum output`),
      );
    },
  },
  {
    name: "a buy over the per-trade cap (in_amount and the wSOL wrap raised to cap + 1)",
    applies: (t) => t.side === "buy",
    async run(g) {
      const { built, full, t, label } = await listOf(g);
      const cap = built.quoteMint === WSOL_MINT ? CAPS.maxBuyLamports : CAPS.maxBuyQuote[built.quoteMint]!;
      full[t] = patchData(full[t]!, (v) => v.setBigUint64(routeDef(built).inAmountOffset, cap + 1n, true));
      const wsol = await ata(g.a.signer, WSOL_MINT, TOKEN_PROGRAM);
      full.forEach((ix, i) => {
        if (isSystemTransfer(ix) && ix.accounts?.[1]?.address === wsol) full[i] = patchData(ix, (v) => v.setBigUint64(4, cap + 1n, true));
      });
      await expectRefused(
        compileJupiter(full, built.trade.lookupTables!),
        shippedContext(g.a, built),
        new RegExp(
          `${escapeRegExp(label)}: spends up to .* above the per-trade cap of ${built.quoteMint === WSOL_MINT ? "1 SOL" : "100,000,000 base units of EPjF…Dt1v"}`,
        ),
      );
    },
  },
  {
    name: "the destination token account loaded from a lookup table (the runtime would resolve the real table)",
    applies: () => true,
    async run(g) {
      const { built, full, t, label } = await listOf(g);
      const L = layoutOf(built);
      const destination = full[t]!.accounts![L.destination]!.address;
      const table = "AddressLookupTab1e1111111111111111111111111" as Address;
      const tables = { ...built.trade.lookupTables, [table]: [destination] };
      const tx = compileJupiter(full, tables, [destination]);
      const decoded = decodeTransaction(tx, tables);
      if (!decoded.ok) throw new Error(decoded.violations.join("; "));
      expect(decoded.tx.accounts.find((x) => x.address === destination)?.isStatic).toBe(false);
      await expectRefused(
        tx,
        shippedContext(g.a, built, { addressLookupTables: tables }),
        new RegExp(
          `${escapeRegExp(label)}: token account at position ${L.destination} must be .* as a static key, not loaded from a lookup table`,
        ),
      );
    },
  },
  {
    name: "route_v2 redirecting the output through destination_token_account (the attacker's account)",
    applies: (t) => t.route === "route_v2",
    async run(g) {
      const { built, full, t, label } = await listOf(g);
      const attackerAta = await ata(g.a.attacker, built.side === "buy" ? built.baseMint : built.quoteMint, TOKEN_PROGRAM);
      full[t] = setAccount(full[t]!, JUPITER_ROUTE_V2_LAYOUT.optionalDestination, writable(attackerAta));
      await expectRefused(
        compileJupiter(full, built.trade.lookupTables!),
        shippedContext(g.a, built),
        new RegExp(`${escapeRegExp(label)}: destination_token_account \\(position 7\\) must be None .* to ${attackerAta}`),
      );
    },
  },
  {
    name: "route_v2: the hop's own output slot credits the attacker (Jupiter does not check it; mainnet simulation, NOTES.md)",
    applies: (t) => t.route === "route_v2",
    async run(g) {
      const { built, full, t, label } = await listOf(g);
      const L = JUPITER_ROUTE_V2_LAYOUT;
      const destination = full[t]!.accounts![L.destination]!.address;
      // The hop names the destination ATA once, in its output slot; point that slot elsewhere.
      const slot = full[t]!.accounts!.findIndex((m, i) => i >= L.fixedAccounts && m.address === destination);
      expect(slot).toBeGreaterThanOrEqual(L.fixedAccounts);
      const program = full[t]!.accounts![L.destinationTokenProgram]!.address;
      const thief = await ata(g.a.attacker, built.side === "buy" ? built.baseMint : built.quoteMint, program);
      full[t] = setAccount(full[t]!, slot, writable(thief));
      await expectRefused(
        compileJupiter(full, built.trade.lookupTables!),
        shippedContext(g.a, built),
        new RegExp(
          `${escapeRegExp(label)}: \\w+ hop: the output slot must be the destination token account \\(position ${slot} is ${thief}\\)`,
        ),
      );
    },
  },
  {
    name: "shared accounts: a hop naming the trading wallet (it would receive the user's signature)",
    applies: (t) => t.route === "shared_accounts_route_v2",
    async run(g) {
      const { built, full, t, label } = await listOf(g);
      const at = JUPITER_SHARED_ROUTE_V2_LAYOUT.fixedAccounts + 2;
      full[t] = setAccount(full[t]!, at, { address: g.a.signer, role: AccountRole.READONLY });
      await expectRefused(
        compileJupiter(full, built.trade.lookupTables!),
        shippedContext(g.a, built),
        new RegExp(`${escapeRegExp(label)}: hop account at position ${at} is the trading wallet`),
      );
    },
  },
  {
    name: "shared accounts: a substituted program authority and program destination account",
    applies: (t) => t.route === "shared_accounts_route_v2",
    async run(g) {
      const { built, full, t, label } = await listOf(g);
      const S = JUPITER_SHARED_ROUTE_V2_LAYOUT;
      const fake = (await ata(g.a.attacker, built.baseMint, TOKEN_PROGRAM)) as Address;
      for (const [index, what] of [
        [S.programAuthority, "program authority"],
        [S.programDestination, "program authority's token account for the destination mint"],
      ] as const) {
        const tampered = [...full];
        tampered[t] = setAccount(full[t]!, index, writable(fake));
        await expectRefused(
          compileJupiter(tampered, built.trade.lookupTables!),
          shippedContext(g.a, built),
          new RegExp(`${escapeRegExp(label)}: position ${index} must be the ${escapeRegExp(what)}`),
        );
      }
    },
  },
  {
    name: "other Jupiter instructions on core's accounts (claim, route_with_token_ledger, exact_out_route_v2, route, a made-up one)",
    applies: () => true,
    async run(g) {
      const { built, full, t } = await listOf(g);
      const cases: [string, RegExp][] = [
        ["claim", /instruction "claim" is refused \(only route_v2, shared_accounts_route_v2 are allowed\)/],
        ["route_with_token_ledger", /instruction "route_with_token_ledger" is refused \(token-ledger routes .* cannot be capped\)/],
        ["exact_out_route_v2", /instruction "exact_out_route_v2" is refused \(exact-out routes are refused/],
        ["route", /instruction "route" is refused \(v1 routes are refused/],
        ["0102030405060708", /instruction "unknown 0102030405060708" is refused/],
      ];
      for (const [name, pattern] of cases) {
        const hex = Object.entries(JUPITER_INSTRUCTION_NAMES).find(([, n]) => n === name)?.[0] ?? name;
        const tampered = [...full];
        tampered[t] = patchData(full[t]!, (_v, d) => d.set(Uint8Array.from(hex.match(/../g)!.map((h) => Number.parseInt(h, 16))), 0));
        await expectRefused(
          compileJupiter(tampered, built.trade.lookupTables!),
          shippedContext(g.a, built),
          new RegExp(`#${t} ${VENUE}: ${pattern.source}`),
        );
      }
    },
  },
  {
    name: "a route plan the reviewed IDL cannot decode (unknown Swap variant, trailing bytes)",
    applies: () => true,
    async run(g) {
      const { built, full, t, label } = await listOf(g);
      const def = routeDef(built);
      const unknown = [...full];
      unknown[t] = patchData(full[t]!, (_v, d) => {
        d[def.routePlanOffset + 4] = 255;
      });
      await expectRefused(
        compileJupiter(unknown, built.trade.lookupTables!),
        shippedContext(g.a, built),
        new RegExp(`${escapeRegExp(label)}: route plan does not decode .*Swap variant 255 is not in the reviewed IDL`),
      );
      const trailing = [...full];
      trailing[t] = { ...full[t]!, data: Uint8Array.from([...full[t]!.data!, 0]) };
      await expectRefused(
        compileJupiter(trailing, built.trade.lookupTables!),
        shippedContext(g.a, built),
        new RegExp(`${escapeRegExp(label)}: route plan does not decode .*1 trailing bytes after the route plan`),
      );
    },
  },
  {
    name: "a tip, the wSOL unwrap or the token-account close paying the attacker",
    applies: () => true,
    async run(g) {
      const { built, full } = await listOf(g);
      const changed: number[] = [];
      full.forEach((ix, i) => {
        const tip = isSystemTransfer(ix) && SIGNER_TIP_ACCOUNTS.includes(ix.accounts?.[1]?.address as Address);
        if (tip || isCloseAccount(ix)) {
          full[i] = setAccount(ix, 1, writable(g.a.attacker));
          changed.push(i);
        }
      });
      expect(changed.length).toBeGreaterThan(0);
      const violations = await expectRefused(compileJupiter(full, built.trade.lookupTables!), shippedContext(g.a, built), /./);
      for (const i of changed) {
        const pattern = isCloseAccount(full[i]!)
          ? /CloseAccount: rent may only go to the trading wallet or the connected wallet/
          : /Transfer: destination .* is not a tip account/;
        expect(violations.filter((v) => v.startsWith(`#${i} `) && pattern.test(v))).toHaveLength(1);
      }
    },
  },
  {
    name: "a minimum out below Jupiter's quote less the user's slippage (only caught with expectations)",
    applies: () => true,
    async run(g) {
      const { built, full, t, label } = await listOf(g);
      full[t] = patchData(full[t]!, (v) => v.setBigUint64(routeDef(built).quotedOutOffset, built.trade.quote.expectedOut / 2n, true));
      const tx = compileJupiter(full, built.trade.lookupTables!);
      await expectAllowed(tx, shippedContext(g.a, built));
      const expectations: TradeExpectation[] = [
        { instruction: t, expectedOut: built.trade.quote.expectedOut, slippageBps: CLI_SLIPPAGE_BPS },
      ];
      await expectRefused(
        tx,
        shippedContext(g.a, built, { expectations }),
        new RegExp(`${escapeRegExp(label)}: minimum output .* is below your quote`),
      );
    },
  },
  {
    name: "the route's lookup tables withheld from the signer",
    applies: (t) => t.tables,
    async run(g) {
      const { built, plan } = await listOf(g);
      await expectRefused(
        assembleJupiter(built, plan),
        shippedContext(g.a, built, { addressLookupTables: {} }),
        /address lookup table \w+ was not provided/,
      );
    },
  },
];

// ---------------------------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------------------------

const EXPECTED_SHAPES: Readonly<Record<JupiterTrade, readonly string[]>> = {
  // SOL buys: Jupiter wraps (wSOL ATA, transfer, SyncNative), creates the coin ATA, swaps, unwraps.
  longtailCurveBuy: ["ata", "transfer", "sync", "ata", "jupiter", "close"],
  longtail2022Buy: ["ata", "transfer", "sync", "ata", "jupiter", "close"],
  normalBuy: ["ata", "transfer", "sync", "ata", "jupiter", "close"],
  // Full-exit sells: wSOL ATA, swap, unwrap, then core closes the sold coin's account.
  longtailCurveSell: ["ata", "jupiter", "close", "close"],
  longtail2022Sell: ["ata", "jupiter", "close", "close"],
  normalSell: ["ata", "jupiter", "close", "close"],
  // USDC buy: the coin ATA and the swap.
  usdcBuy: ["ata", "jupiter"],
};

describe("engine <-> firewall: Jupiter, the harness reproduces core exactly", () => {
  test("every capture resolves to the Jupiter fallback with the expected instruction shape, side and route", async () => {
    for (const label of JUPITER_TRADES) {
      const built = await buildJupiter(label);
      expect({ label, shape: built.trade.instructions.map(shapeOf) }).toEqual({ label, shape: [...EXPECTED_SHAPES[label]] });
      expect(built.trade.quote.venue).toBe("jupiter");
      expect({ label, side: built.side, route: routeDef(built).name, tables: Object.keys(built.tables).length > 0 }).toEqual({
        label,
        ...TRADES[label],
      });
    }
  });

  test("compileJupiter(coreInstructionList(...)) is byte-identical to core's assembleTransaction", async () => {
    for (const label of JUPITER_TRADES) {
      const built = await buildJupiter(label);
      for (const mode of MODES) {
        const plan = planFor(mode, built.trade.defaultCuLimit, FEE_CAPS);
        const pinned = {
          ...plan,
          tips: plan.tips.map((t, i) => ({ ...t, tipAccount: (t.lane === "jito" ? JITO_TIP_ACCOUNTS : HELIUS_SENDER_TIP_ACCOUNTS)[i]! })),
        };
        const blockhash = randomBlockhash();
        const viaCore = new Uint8Array(
          getTransactionEncoder().encode(
            assembleTransaction({
              feePayer: built.state.user,
              instructions: built.trade.instructions,
              blockhash: { blockhash, lastValidBlockHeight: 1_000n },
              fees: pinned,
              lookupTables: built.trade.lookupTables,
            }),
          ),
        );
        expect(
          compileJupiter(coreInstructionList(built.state.user, built.trade.instructions, pinned), built.trade.lookupTables!, [], blockhash),
        ).toEqual(viaCore);
      }
    }
  });

  test("a partial sell leaves the token account open (no close)", async () => {
    const built = await buildJupiter("longtail2022Sell", { partial: true });
    expect(built.trade.instructions.map(shapeOf)).toEqual(["ata", "jupiter", "close"]);
    const a = jupiterActors();
    await expectAllowed(assembleJupiter(built, planFor("standard", built.trade.defaultCuLimit, FEE_CAPS)), shippedContext(a, built));
  });
});

for (const label of JUPITER_TRADES) {
  describe(`engine <-> firewall: Jupiter ${label}`, () => {
    for (const mode of MODES) {
      describe(`${mode} mode`, () => {
        const a = jupiterActors();
        let cached: Promise<JupiterBuilt> | undefined;
        const build = () => {
          cached ??= buildJupiter(label);
          return cached;
        };

        test("core's transaction passes the shipped policy, also with Jupiter's quote as the expectation", async () => {
          const built = await build();
          const plan = planFor(mode, built.trade.defaultCuLimit, FEE_CAPS);
          const tx = assembleJupiter(built, plan);
          const summary = await expectAllowed(tx, shippedContext(a, built));
          const def = routeDef(built);
          const inAmount = new DataView(built.trade.instructions[built.swapIndex]!.data!.buffer).getBigUint64(def.inAmountOffset, true);

          expect(summary.version).toBe(0);
          expect(summary.computeUnitLimit).toBe(built.trade.defaultCuLimit);
          expect(summary.tipLamports).toBe(plan.totalTipLamports);
          if (built.side === "buy" && built.quoteMint === WSOL_MINT) expect(summary.maxBuyLamports).toBe(inAmount);
          else expect(summary.maxBuyLamports).toBe(0n);
          expect(summary.maxBuyQuote).toEqual(built.side === "buy" && built.quoteMint !== WSOL_MINT ? { [built.quoteMint]: inAmount } : {});
          const trades = summary.actions.filter((x) => x.kind === "trade");
          expect(trades).toEqual([
            expect.objectContaining({
              venue: VENUE,
              instruction: def.name,
              side: built.side,
              baseMint: built.baseMint,
              quoteMint: built.quoteMint,
            }),
          ]);
          const trade = trades[0]!;
          if (trade.kind !== "trade") throw new Error("unreachable");
          expect(trade.route?.length).toBe(built.trade.quote.jupiter!.labels.length);
          // The firewall's minimum is floor(quote x (1 - slippage)): never above what core reports Jupiter enforces.
          const floor = (built.trade.quote.expectedOut * BigInt(10_000 - CLI_SLIPPAGE_BPS)) / 10_000n;
          expect(built.side === "buy" ? trade.baseAmount : trade.minQuoteOut).toBe(floor);
          expect(floor).toBeLessThanOrEqual(built.trade.quote.minOut);
          expect(summary.text).toContain("Routed through");

          // The landing mode's tips and the jitodontfront marker, as for every venue.
          const tips = summary.actions.flatMap((x) => (x.kind === "tip" ? [x] : []));
          const lanes = tips.map((t) =>
            JITO_TIP_ACCOUNTS.includes(t.to) ? "jito" : HELIUS_SENDER_TIP_ACCOUNTS.includes(t.to) ? "helius" : "?",
          );
          const decoded = decodeTransaction(tx, built.tables);
          if (!decoded.ok) throw new Error(decoded.violations.join("; "));
          const markers = decoded.tx.accounts.filter((acc) => acc.address.startsWith(JITO_DONT_FRONT_PREFIX));
          expect(lanes).toEqual(mode === "standard" ? ["helius", "jito"] : mode === "turbo" ? ["helius"] : ["jito"]);
          expect(markers).toHaveLength(mode === "protected" ? 1 : 0);
          // Routes with tables really load accounts from them; the user side stays static.
          expect(decoded.tx.lookupTableAddresses.length).toBe(Object.keys(built.tables).length);
          const swap = decoded.tx.instructions[BUDGET_IXS + built.swapIndex]!;
          for (const i of [def.layout.authority, def.layout.source, def.layout.destination]) expect(swap.accounts[i]!.isStatic).toBe(true);

          const expectations: TradeExpectation[] = [
            { instruction: BUDGET_IXS + built.swapIndex, expectedOut: built.trade.quote.expectedOut, slippageBps: CLI_SLIPPAGE_BPS },
          ];
          const checked = await expectAllowed(tx, shippedContext(a, built, { expectations }));
          expect(checked.text).toContain("Checked against your own quote");
        });

        for (const m of MUTATIONS) {
          if (m.applies(TRADES[label])) test(`refused: ${m.name}`, () => m.run({ label, mode, a, build }));
        }
      });
    }
  });
}

test("core's wSOL constant is the signer's (the side detection above relies on it)", () => {
  expect(CORE_WSOL).toBe(WSOL_MINT);
});
