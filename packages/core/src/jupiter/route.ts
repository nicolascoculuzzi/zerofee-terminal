/**
 * `/build` response -> our instruction list + address lookup tables, checked against what we asked for.
 *
 * Kept: setup (idempotent ATA creation, wSOL wrap), the swap, cleanup (wSOL unwrap) and "other"
 * instructions, in Jupiter's documented order (https://developers.jup.ag/docs/swap/build/common-instructions).
 * Dropped: `computeBudgetInstructions` (our fee policy sets the CU limit and price) and `tipInstruction`
 * (only present when `tipAmount` is requested, which we never do: tips go to our landing lanes).
 *
 * Refused (throws JupiterRouteError) rather than passed on for the signer firewall to refuse:
 *   - a quote for anything other than the request (mints, exact-in amount, slippage, exact-in mode);
 *   - a swap that is not a Jupiter v6 `route_v2` / `shared_accounts_route_v2`, or whose arguments
 *     disagree with the quote, or that carries a platform fee or a positive-slippage fee;
 *   - user token accounts that are not the taker's own ATAs, or an output redirected elsewhere;
 *   - setup / cleanup / other instructions outside System, SPL Token, Token-2022 and the ATA program,
 *     or any signer other than the taker.
 */
import { AccountRole, type Address, type AddressesByLookupTableAddress, type Instruction } from "@solana/kit";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  JUPITER_CU_SIMULATION_MARGIN,
  JUPITER_EVENT_AUTHORITY,
  JUPITER_IX,
  JUPITER_PROGRAM_ID,
  JUPITER_REVIEWED_HOPS,
  MAX_COMPUTE_UNIT_LIMIT,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "../constants";
import { findAssociatedTokenAddress, isTokenProgram } from "../token";
import { Reader, startsWith } from "../util/bytes";
import { applySlippageDown } from "../util/math";
import type { JupiterApiInstruction, JupiterBuildResponse } from "./client";

export class JupiterRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JupiterRouteError";
  }
}

export type JupiterRouteInstruction = "route_v2" | "shared_accounts_route_v2";

/** The fixed arguments of a v2 route instruction (route_plan follows them and is opaque here). */
export interface JupiterRouteArgs {
  instruction: JupiterRouteInstruction;
  /** shared_accounts_route_v2 only: the program authority id. */
  id?: number;
  inAmount: bigint;
  quotedOutAmount: bigint;
  slippageBps: number;
  platformFeeBps: number;
  positiveSlippageBps: number;
}

/**
 * Account positions of the two v2 routes (idl/jupiter.json). route_v2:
 *   0 user_transfer_authority (s), 1 user_source_token_account, 2 user_destination_token_account,
 *   3 source_mint, 4 destination_mint, 5 source_token_program, 6 destination_token_program,
 *   7 destination_token_account (optional; the program id = None), 8 event_authority, 9 program, hops...
 * shared_accounts_route_v2:
 *   0 program_authority, 1 user_transfer_authority (s), 2 source_token_account,
 *   3 program_source_token_account, 4 program_destination_token_account, 5 destination_token_account,
 *   6 source_mint, 7 destination_mint, 8 source_token_program, 9 destination_token_program,
 *   10 event_authority, 11 program, hops...
 */
export const JUPITER_ROUTE_LAYOUTS = {
  route_v2: {
    fixedAccounts: 10,
    authority: 0,
    source: 1,
    destination: 2,
    sourceMint: 3,
    destinationMint: 4,
    sourceTokenProgram: 5,
    destinationTokenProgram: 6,
    optionalDestination: 7,
    eventAuthority: 8,
    program: 9,
  },
  shared_accounts_route_v2: {
    fixedAccounts: 12,
    programAuthority: 0,
    authority: 1,
    source: 2,
    programSource: 3,
    programDestination: 4,
    destination: 5,
    sourceMint: 6,
    destinationMint: 7,
    sourceTokenProgram: 8,
    destinationTokenProgram: 9,
    eventAuthority: 10,
    program: 11,
  },
} as const;

/** Positions the signer firewall requires as static keys (who signs, where funds come from and go, which cap applies). */
export const JUPITER_STATIC_POSITIONS: Readonly<Record<JupiterRouteInstruction, readonly number[]>> = {
  route_v2: [0, 1, 2, 3, 4, 5, 6],
  shared_accounts_route_v2: [1, 2, 5, 6, 7, 8, 9],
};

/** Decodes the discriminator and fixed arguments of a v2 route; null for any other instruction. */
export function decodeJupiterRouteArgs(data: Uint8Array): JupiterRouteArgs | null {
  const shared = startsWith(data, JUPITER_IX.sharedAccountsRouteV2);
  if (!shared && !startsWith(data, JUPITER_IX.routeV2)) return null;
  const fixed = 8 + (shared ? 1 : 0) + 8 + 8 + 2 + 2 + 2;
  if (data.length < fixed + 4) return null;
  const r = new Reader(data, 8);
  const id = shared ? r.u8() : undefined;
  return {
    instruction: shared ? "shared_accounts_route_v2" : "route_v2",
    ...(id !== undefined ? { id } : {}),
    inAmount: r.u64(),
    quotedOutAmount: r.u64(),
    slippageBps: r.u16(),
    platformFeeBps: r.u16(),
    positiveSlippageBps: r.u16(),
  };
}

/** What the conversion was asked to produce. */
export interface JupiterRouteExpectation {
  user: Address;
  inputMint: Address;
  outputMint: Address;
  amount: bigint;
  slippageBps: number;
}

export interface JupiterRoute {
  /** setup, swap, cleanup, other (no compute budget, no tip). */
  instructions: Instruction[];
  lookupTables: AddressesByLookupTableAddress;
  instruction: JupiterRouteInstruction;
  inAmount: bigint;
  outAmount: bigint;
  /** Jupiter's minimum output (otherAmountThreshold), never below floor(outAmount x (1 - slippage)). */
  minOut: bigint;
  slippageBps: number;
  /** Venue labels per hop, e.g. ["Meteora DAMM v2"]. */
  labels: string[];
  /** Pools the route trades against (priority-fee sampling). */
  ammKeys: Address[];
  priceImpactPct: string | null;
  sourceTokenProgram: Address;
  destinationTokenProgram: Address;
}

const AUX_PROGRAMS: readonly Address[] = [SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID];

function toInstruction(ix: JupiterApiInstruction, user: Address, where: string): Instruction {
  return {
    programAddress: ix.programId,
    accounts: ix.accounts.map((a, i) => {
      if (a.isSigner && a.pubkey !== user)
        throw new JupiterRouteError(`${where}: account ${i} (${a.pubkey}) must sign; only the taker may`);
      const role = a.isSigner
        ? a.isWritable
          ? AccountRole.WRITABLE_SIGNER
          : AccountRole.READONLY_SIGNER
        : a.isWritable
          ? AccountRole.WRITABLE
          : AccountRole.READONLY;
      return { address: a.pubkey, role };
    }),
    data: ix.data,
  };
}

function auxInstruction(ix: JupiterApiInstruction, user: Address, where: string): Instruction {
  if (!AUX_PROGRAMS.includes(ix.programId)) {
    throw new JupiterRouteError(
      `${where}: unexpected program ${ix.programId} (only System, Token, Token-2022 and ATA instructions are kept)`,
    );
  }
  return toInstruction(ix, user, where);
}

/** Converts and checks a `/build` response. Throws JupiterRouteError on anything unexpected. */
export async function jupiterRouteFromBuild(resp: JupiterBuildResponse, want: JupiterRouteExpectation): Promise<JupiterRoute> {
  const bad = (msg: string): never => {
    throw new JupiterRouteError(`Jupiter /build: ${msg}`);
  };
  if (resp.inputMint !== want.inputMint || resp.outputMint !== want.outputMint) {
    bad(`quote is for ${resp.inputMint} -> ${resp.outputMint}, not ${want.inputMint} -> ${want.outputMint}`);
  }
  if (resp.swapMode !== "ExactIn") bad(`swapMode ${resp.swapMode} (only ExactIn is requested)`);
  if (resp.inAmount !== want.amount) bad(`inAmount ${resp.inAmount} != requested ${want.amount}`);
  if (resp.slippageBps !== want.slippageBps) bad(`slippageBps ${resp.slippageBps} != requested ${want.slippageBps}`);
  if (resp.outAmount <= 0n) bad("quoted output is 0");
  if (resp.tipInstruction) bad("response carries a tip instruction (tipAmount is never requested)");
  for (const ix of resp.computeBudgetInstructions) {
    if (ix.programId !== COMPUTE_BUDGET_PROGRAM_ID) bad(`computeBudgetInstructions holds a ${ix.programId} instruction`);
  }

  const swap = resp.swapInstruction;
  if (swap.programId !== JUPITER_PROGRAM_ID) bad(`swap instruction program ${swap.programId} is not Jupiter v6 ${JUPITER_PROGRAM_ID}`);
  const args = decodeJupiterRouteArgs(swap.data);
  if (!args) bad("swap instruction is not route_v2 or shared_accounts_route_v2");
  const a = args as JupiterRouteArgs;
  if (a.inAmount !== want.amount) bad(`route in_amount ${a.inAmount} != requested ${want.amount}`);
  if (a.quotedOutAmount !== resp.outAmount) bad(`route quoted_out_amount ${a.quotedOutAmount} != outAmount ${resp.outAmount}`);
  if (a.slippageBps !== want.slippageBps) bad(`route slippage_bps ${a.slippageBps} != requested ${want.slippageBps}`);
  if (a.platformFeeBps !== 0) bad(`route charges a platform fee of ${a.platformFeeBps} bps`);
  if (a.positiveSlippageBps !== 0) bad(`route takes ${a.positiveSlippageBps} bps of positive slippage`);

  const floor = applySlippageDown(resp.outAmount, want.slippageBps);
  if (resp.otherAmountThreshold <= 0n || resp.otherAmountThreshold < floor || resp.otherAmountThreshold > resp.outAmount) {
    bad(`otherAmountThreshold ${resp.otherAmountThreshold} is outside [${floor}, ${resp.outAmount}]`);
  }

  // The user's side of the route: the taker signs, its own ATAs send and receive, output is not redirected.
  const L = JUPITER_ROUTE_LAYOUTS[a.instruction];
  const acc = swap.accounts;
  if (acc.length <= L.fixedAccounts) bad(`${a.instruction} has ${acc.length} accounts (no route hops)`);
  const at = (i: number) => acc[i]!.pubkey;
  if (at(L.authority) !== want.user || !acc[L.authority]!.isSigner) bad("user_transfer_authority is not the taker");
  if (at(L.sourceMint) !== want.inputMint || at(L.destinationMint) !== want.outputMint) bad("route mints do not match the quote");
  const sourceTokenProgram = at(L.sourceTokenProgram);
  const destinationTokenProgram = at(L.destinationTokenProgram);
  if (!isTokenProgram(sourceTokenProgram) || !isTokenProgram(destinationTokenProgram))
    bad("route token programs are not SPL Token / Token-2022");
  const [sourceAta, destinationAta] = await Promise.all([
    findAssociatedTokenAddress(want.user, want.inputMint, sourceTokenProgram),
    findAssociatedTokenAddress(want.user, want.outputMint, destinationTokenProgram),
  ]);
  if (at(L.source) !== sourceAta) bad(`source token account ${at(L.source)} is not the taker's ATA ${sourceAta}`);
  if (at(L.destination) !== destinationAta) bad(`destination token account ${at(L.destination)} is not the taker's ATA ${destinationAta}`);
  if (a.instruction === "route_v2" && at(JUPITER_ROUTE_LAYOUTS.route_v2.optionalDestination) !== JUPITER_PROGRAM_ID) {
    bad("route_v2 redirects the output to a destination_token_account");
  }
  if (at(L.eventAuthority) !== JUPITER_EVENT_AUTHORITY || at(L.program) !== JUPITER_PROGRAM_ID)
    bad("unexpected event authority / program account");

  const instructions = [
    ...resp.setupInstructions.map((ix, i) => auxInstruction(ix, want.user, `setupInstructions[${i}]`)),
    toInstruction(swap, want.user, "swapInstruction"),
    ...(resp.cleanupInstruction ? [auxInstruction(resp.cleanupInstruction, want.user, "cleanupInstruction")] : []),
    ...resp.otherInstructions.map((ix, i) => auxInstruction(ix, want.user, `otherInstructions[${i}]`)),
  ];
  return {
    instructions,
    lookupTables: resp.addressesByLookupTableAddress,
    instruction: a.instruction,
    inAmount: resp.inAmount,
    outAmount: resp.outAmount,
    minOut: resp.otherAmountThreshold,
    slippageBps: want.slippageBps,
    labels: resp.routePlan.map((s) => s.label),
    ammKeys: [...new Set(resp.routePlan.map((s) => s.ammKey))],
    priceImpactPct: resp.priceImpactPct,
    sourceTokenProgram,
    destinationTokenProgram,
  };
}

/**
 * CU limit for a Jupiter route from a simulation of the whole transaction: simulated units x 1.2
 * (Jupiter's recommendation; routes vary too much for a static limit), capped at `max`.
 */
export function jupiterCuLimitFromSimulation(unitsConsumed: number | bigint, max: number = MAX_COMPUTE_UNIT_LIMIT): number {
  const units = Number(unitsConsumed);
  if (!Number.isFinite(units) || units <= 0) throw new RangeError(`simulated units must be > 0, got ${unitsConsumed}`);
  return Math.min(Math.ceil(units * JUPITER_CU_SIMULATION_MARGIN), max);
}

/**
 * Why the signer firewall would refuse this route's hops, or null (see JUPITER_REVIEWED_HOPS):
 *   - shared_accounts_route_v2: no hop may name the user's wallet or its source / destination ATA;
 *   - route_v2: exactly one hop of the whole input, through a reviewed venue, with the hop's input,
 *     output and authority slots on the user's source ATA, destination ATA and wallet.
 * buildTrade re-quotes a refused route over the reviewed venues.
 */
export function jupiterRouteProblem(route: Pick<JupiterRoute, "instructions" | "instruction">, user: Address): string | null {
  const swap = route.instructions.find((ix) => ix.programAddress === JUPITER_PROGRAM_ID);
  if (!swap?.data || !swap.accounts) return "no Jupiter route instruction";
  const data = new Uint8Array(swap.data);
  const accounts = swap.accounts.map((a) => a.address);
  const L = JUPITER_ROUTE_LAYOUTS[route.instruction];
  const source = accounts[L.source];
  const destination = accounts[L.destination];
  const userSide = new Set([user, source, destination]);
  if (route.instruction === "shared_accounts_route_v2") {
    const i = accounts.findIndex((a, j) => j >= L.fixedAccounts && userSide.has(a));
    return i < 0 ? null : `a shared-accounts hop names the user's wallet or token account (position ${i})`;
  }
  // route_v2 data: ... route_plan at 30: u32 steps, then (one step) variant u8, fields, bps u16, input u8, output u8.
  const r = new Reader(data, 30);
  const steps = r.u32();
  const variant = r.u8();
  if (steps !== 1) return `route_v2 with ${steps} hops (only single-hop route_v2 can be verified)`;
  const hop = JUPITER_REVIEWED_HOPS[variant];
  if (!hop) return `route_v2 through Swap variant ${variant}, a venue whose hop layout is not reviewed`;
  const fields = hop.aToB ? 1 : 0;
  const aToB = hop.aToB ? data[35] === 1 : true;
  r.skip(fields);
  const bps = r.u16();
  const input = r.u8();
  const output = r.u8();
  if (data.length !== 35 + fields + 4 || bps !== 10_000 || input !== 0 || output !== 1)
    return "the route_v2 hop does not spend the whole input";
  const hopAccounts = accounts.slice(L.fixedAccounts);
  if (hop.remaining ? hopAccounts.length < hop.accounts : hopAccounts.length !== hop.accounts) {
    return `${hop.name} hop has ${hopAccounts.length} accounts`;
  }
  if (hopAccounts[0] !== hop.program) return `${hop.name} hop does not invoke ${hop.program}`;
  const [inSlot, outSlot] = aToB ? [hop.input, hop.output] : [hop.output, hop.input];
  const pinned = new Map([
    [inSlot, source],
    [outSlot, destination],
    [hop.authority, user],
  ]);
  for (const [slot, want] of pinned) if (hopAccounts[slot] !== want) return `${hop.name} hop slot ${slot} is not the user's account`;
  const stray = hopAccounts.findIndex((a, slot) => !pinned.has(slot) && userSide.has(a));
  return stray < 0 ? null : `${hop.name} hop names the user's wallet or token account in slot ${stray}`;
}
