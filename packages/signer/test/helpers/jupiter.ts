/**
 * Jupiter routes for the firewall tests, from real `/build` responses captured on 2026-10-03
 * (packages/core/test/fixtures/jupiter-build.json, built for a synthetic taker). Instructions are
 * produced by core exactly as the CLI and the web app produce them: loadTokenState (Jupiter fallback)
 * -> buildTrade (/build served from the capture) -> planFees -> assembleTransaction with the route's
 * lookup tables. Tampered lists compile the same way (core keeps the firewall's static keys static), so
 * a refusal is for the rule under test, not for a key that moved into a table.
 *
 * Test-only: @zerofee/core is a devDependency of the signer and must never be imported from src/.
 */
import {
  AccountRole,
  type Address,
  type AddressesByLookupTableAddress,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  createTransactionMessage,
  getTransactionEncoder,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import {
  assembleTransaction,
  type BuiltTrade,
  buildTrade,
  compressKeepingStatic,
  type FeePlan,
  firewallStaticAccounts,
  type JupiterState,
  loadTokenState,
} from "@zerofee/core";
import {
  JUPITER_ATTACKER,
  JUPITER_TAKER,
  type JupiterCaseLabel,
  jupiterCase,
  jupiterFetch,
  jupiterRpc,
  type RpcAccount,
  tokenAccountData,
} from "../../../core/test/jupiter-fixtures";
import { findAssociatedTokenAddress } from "../../src/firewall/ata";
import { JUPITER_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, USDC_MINT, WSOL_MINT } from "../../src/firewall/programs";
import { randomAddress, type TestActors } from "./fixtures";
import { randomBlockhash } from "./tx";

export { JUPITER_ATTACKER, JUPITER_TAKER, type JupiterCaseLabel, jupiterCase };

/** The captures the engine can build (the platform-fee capture is malicious). */
export const JUPITER_TRADES = [
  "longtailCurveBuy",
  "longtailCurveSell",
  "longtail2022Buy",
  "longtail2022Sell",
  "normalBuy",
  "normalSell",
  "usdcBuy",
] as const satisfies readonly JupiterCaseLabel[];
export type JupiterTrade = (typeof JUPITER_TRADES)[number];

/** The captures embed the taker's ATAs, so the trading wallet is the taker; everyone else is random. */
export function jupiterActors(): TestActors {
  return { signer: JUPITER_TAKER, connected: randomAddress(), attacker: randomAddress(), nonceAccount: randomAddress() };
}

export interface JupiterBuilt {
  label: JupiterTrade;
  state: JupiterState;
  trade: BuiltTrade;
  side: "buy" | "sell";
  /** The token (bought or sold) and the quote asset (spent or received). */
  baseMint: Address;
  quoteMint: Address;
  /** Lookup-table contents for the firewall context (the same map core compressed with). */
  tables: Record<string, Address[]>;
  /** Position of the Jupiter instruction in trade.instructions. */
  swapIndex: number;
}

/**
 * core's build of a captured trade for the taker. Sells hold exactly the sold amount (a full exit, so
 * core appends the token-account close) unless `partial`.
 */
export async function buildJupiter(label: JupiterTrade, options: { partial?: boolean } = {}): Promise<JupiterBuilt> {
  const { request } = jupiterCase(label);
  const side = request.inputMint === WSOL_MINT || request.inputMint === USDC_MINT ? "buy" : "sell";
  const baseMint = side === "buy" ? request.outputMint : request.inputMint;
  const quoteMint = side === "buy" ? request.inputMint : request.outputMint;
  const extra: Record<string, RpcAccount> = {};
  if (side === "sell") {
    const program = label === "longtail2022Sell" ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
    const balance = options.partial ? request.amount * 2n : request.amount;
    extra[await findAssociatedTokenAddress(JUPITER_TAKER, baseMint, program)] = {
      owner: program,
      data: tokenAccountData(baseMint, JUPITER_TAKER, balance),
    };
  }
  const state = await loadTokenState(jupiterRpc(JUPITER_TAKER, extra), { mint: baseMint, user: JUPITER_TAKER, quoteMint });
  if (state.venue !== "jupiter") throw new Error(`${label}: ${baseMint} resolved to ${state.venue}, not the Jupiter fallback`);
  const trade = await buildTrade(
    state,
    { side, amount: request.amount, slippageBps: request.slippageBps },
    { jupiter: { fetchFn: jupiterFetch().fetch } },
  );
  const swapIndex = trade.instructions.findIndex((ix) => ix.programAddress === JUPITER_PROGRAM);
  return { label, state, trade, side, baseMint, quoteMint, tables: tablesOf(trade.lookupTables), swapIndex };
}

export function tablesOf(tables: AddressesByLookupTableAddress | undefined): Record<string, Address[]> {
  return Object.fromEntries(Object.entries(tables ?? {}).map(([k, v]) => [k, [...v]]));
}

/** core's assembleTransaction with the route's tables, as wire bytes (empty signature slot). */
export function assembleJupiter(
  built: JupiterBuilt,
  plan: FeePlan,
  instructions: readonly Instruction[] = built.trade.instructions,
): Uint8Array {
  const tx = assembleTransaction({
    feePayer: JUPITER_TAKER,
    instructions,
    blockhash: { blockhash: randomBlockhash(), lastValidBlockHeight: 1_000n },
    fees: plan,
    lookupTables: built.trade.lookupTables,
  });
  return new Uint8Array(getTransactionEncoder().encode(tx));
}

/**
 * Compiles a full (possibly tampered) instruction list like assembleTransaction: v0, the given tables,
 * every account the firewall requires static kept static, except `forceLookup` (to model an attacker
 * who loads a fund-relevant account from a table).
 */
export function compileJupiter(
  full: readonly Instruction[],
  tables: AddressesByLookupTableAddress,
  forceLookup: readonly Address[] = [],
  blockhash: Blockhash = randomBlockhash(),
): Uint8Array {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(JUPITER_TAKER, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: 1_000n }, m),
    (m) => appendTransactionMessageInstructions(full, m),
  );
  const keep = firewallStaticAccounts(JUPITER_TAKER, full);
  for (const a of forceLookup) keep.delete(a);
  return new Uint8Array(getTransactionEncoder().encode(compileTransaction(compressKeepingStatic(message, tables, keep))));
}

interface RawInstruction {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
}

interface RawBuild {
  setupInstructions: RawInstruction[];
  swapInstruction: RawInstruction;
  cleanupInstruction: RawInstruction | null;
  otherInstructions: RawInstruction[];
  addressesByLookupTableAddress: Record<string, string[]> | null;
}

const roleOf = (m: RawInstruction["accounts"][number]) =>
  m.isSigner
    ? m.isWritable
      ? AccountRole.WRITABLE_SIGNER
      : AccountRole.READONLY_SIGNER
    : m.isWritable
      ? AccountRole.WRITABLE
      : AccountRole.READONLY;

/**
 * The captured response's setup, swap, cleanup and other instructions exactly as /build returned them,
 * with its lookup tables. No checks: the malicious platform-fee capture goes through this.
 */
export function rawJupiterRoute(label: JupiterCaseLabel): { instructions: Instruction[]; tables: AddressesByLookupTableAddress } {
  const body = jupiterCase(label).response as unknown as RawBuild;
  const toIx = (ix: RawInstruction): Instruction => ({
    programAddress: ix.programId as Address,
    accounts: ix.accounts.map((m) => ({ address: m.pubkey as Address, role: roleOf(m) })),
    data: new Uint8Array(Buffer.from(ix.data, "base64")),
  });
  const tables: AddressesByLookupTableAddress = {};
  for (const [k, v] of Object.entries(body.addressesByLookupTableAddress ?? {})) tables[k as Address] = v.map((x) => x as Address);
  return {
    instructions: [
      ...body.setupInstructions.map(toIx),
      toIx(body.swapInstruction),
      ...(body.cleanupInstruction ? [toIx(body.cleanupInstruction)] : []),
      ...body.otherInstructions.map(toIx),
    ],
    tables,
  };
}
