/**
 * Engine <-> firewall integration. Every transaction here is built by @zerofee/core exactly as the
 * CLI and the web app build it: loadTokenState over core's mainnet snapshot, buildTrade (or the venue
 * builders for exact-out buys), planFees, assembleTransaction. Each must pass the policy the signer
 * ships (createSignerPolicy: embedded allowlist and tip accounts, default caps) in every landing mode
 *   standard   Helius SWQoS tip + Jito tip
 *   turbo      Helius Sender Max tip (at least 0.001 SOL)
 *   protected  Jito bundle-only tip carrying the read-only jitodontfront marker
 * and each one, tampered with the way a compromised backend or app would, must be refused for the
 * right reason. A legitimate core transaction the firewall refuses is a bug in one of the two.
 */
import { describe, expect, test } from "bun:test";
import { type AccountMeta, AccountRole, type Address, type Instruction, isSignerRole } from "@solana/kit";
import {
  ammFeeRates,
  ammPoolPda,
  applySlippageUp,
  buildAmmBuyInstructions,
  buildPumpBuyInstructions,
  buildTrade,
  curveFeeRates,
  DEFAULT_CU_LIMITS,
  DEFAULT_PUBKEY,
  type FeeCaps,
  type LandingMode,
  minOutForTrade,
  PUMP_AMM_IX,
  type PumpSwapState,
  quoteAmmBuyExactBase,
  quoteAmmBuyExactQuoteIn,
  quoteBuyExactQuoteIn,
  quoteBuyExactTokens,
  type TipFloor,
} from "@zerofee/core";
import { readU32LE, startsWith } from "../src/bytes";
import { findAssociatedTokenAddress as ata } from "../src/firewall/ata";
import { decodeTransaction } from "../src/firewall/decode";
import {
  ASSOCIATED_TOKEN_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  JITO_DONT_FRONT_PREFIX,
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
import type { FirewallContext, TradeExpectation } from "../src/firewall/types";
import { createSignerPolicy, HELIUS_SENDER_TIP_ACCOUNTS, JITO_TIP_ACCOUNTS, SIGNER_TIP_ACCOUNTS } from "../src/policy";
import {
  ammContext,
  assemble,
  CLI_SLIPPAGE_BPS,
  CURVE_MINT,
  compileLikeCore,
  coreInstructionList,
  curveContext,
  loadCurveState,
  loadPoolState,
  MAYHEM_MINT,
  POOL,
  POOL_BASE_MINT,
  planFor,
  TIP_FLOOR,
  tokenProgramOf,
} from "./helpers/engine";
import { makeActors, randomAddress, type TestActors } from "./helpers/fixtures";
import { expectAllowed, expectRefused } from "./helpers/scenarios";
import { buildTransaction, randomBlockhash } from "./helpers/tx";

const POLICY = createSignerPolicy();
const CAPS = POLICY.caps;
/** The user's fee presets at the firewall's ceiling: core clamps priority fees and tips to these. */
const FEE_CAPS: FeeCaps = { maxPriorityFeeLamports: CAPS.maxPriorityFeeLamports, maxTipLamports: CAPS.maxTipLamports };
const MODES: readonly LandingMode[] = ["standard", "turbo", "protected"];
const SOL = 1_000_000_000n;
/** Default buy budget: 0.1 SOL, or 10 USDC on a USDC-quoted coin. */
const spendFor = (quote: Address) => (quote === WSOL_MINT ? SOL / 10n : 10_000_000n);
/** The shipped per-trade cap for a quote mint. */
const capFor = (quote: Address) => (quote === WSOL_MINT ? CAPS.maxBuyLamports : CAPS.maxBuyQuote[quote]!);
/** Token balance (base units) of the trading wallet for sells. */
const BALANCE = 3_000_000_000_000n;
/** core's layout: [SetComputeUnitLimit, SetComputeUnitPrice, ...trade instructions, ...tips]. */
const BUDGET_IXS = 2;
const CURVE = "pump.fun bonding curve";
const AMM = "PumpSwap";

/** The context the shipped signer builds for a request (SignerService: policy + vault header). */
function shippedContext(a: TestActors, extra: Partial<FirewallContext> = {}): FirewallContext {
  return { signer: a.signer, connectedWallet: a.connected, ownedNonceAccounts: [], ...POLICY, ...extra };
}

// ---------------------------------------------------------------------------------------------
// Trades, built by core
// ---------------------------------------------------------------------------------------------

interface BuildOptions {
  /** Wallet the trade is built for (default: the trading wallet). */
  user?: Address;
  /** Buys: the quote budget in quote base units (default spendFor(quote)). */
  spend?: bigint;
  /** Default: the CLI's 1,500 bps. */
  slippageBps?: number;
  /** PumpSwap: trade against this pool (and vaults) instead of the canonical one. */
  pool?: { address: Address; baseVault: Address; quoteVault: Address };
  /** Halve the guaranteed output while keeping core's quote (a tampered minimum out). */
  shrinkOut?: boolean;
}

interface Built {
  instructions: Instruction[];
  cuLimit: number;
  venue: string;
  instructionName: string;
  side: "buy" | "sell";
  baseMint: Address;
  quoteMint: Address;
  /** core's quote of the output (tokens for buys, quote after fees for sells), before slippage. */
  expectedOut: bigint;
  /** Buys: the capped amount argument in quote base units; sells: 0. */
  maxBuy: bigint;
  /** Position of the trade instruction in `instructions`. */
  tradeIndex: number;
}

const isExtend = (ix: Instruction) =>
  ix.programAddress === PUMP_AMM_PROGRAM && ix.data !== undefined && startsWith(ix.data, PUMP_AMM_IX.extendAccount);

function tradeIndexOf(instructions: readonly Instruction[]): number {
  const i = instructions.findIndex((ix) => (ix.programAddress === PUMP_PROGRAM || ix.programAddress === PUMP_AMM_PROGRAM) && !isExtend(ix));
  if (i < 0) throw new Error("core built no trade instruction");
  return i;
}

/** Zero the u64 argument holding `value` (after the 8-byte discriminator): a tampered minimum out. */
function zeroU64Arg(data: ArrayLike<number>, value: bigint): Uint8Array {
  const needle = new Uint8Array(8);
  new DataView(needle.buffer).setBigUint64(0, value, true);
  const out = new Uint8Array(data);
  for (let i = 8; i + 8 <= out.length; i++) {
    if (needle.every((b, k) => out[i + k] === b)) {
      out.fill(0, i, i + 8);
      return out;
    }
  }
  throw new Error(`minimum out ${value} not found in the instruction data`);
}

const slippage = (o: BuildOptions) => (o.shrinkOut ? 5_000 : (o.slippageBps ?? CLI_SLIPPAGE_BPS));

async function curveBuyExactQuoteIn(a: TestActors, o: BuildOptions, mint: Address, quoteMint: Address = WSOL_MINT): Promise<Built> {
  const state = await loadCurveState({ user: o.user ?? a.signer }, mint, { quoteMint });
  const spend = o.spend ?? spendFor(quoteMint);
  const trade = await buildTrade(state, { side: "buy", amount: spend, slippageBps: slippage(o) });
  return {
    instructions: trade.instructions,
    cuLimit: trade.defaultCuLimit,
    venue: CURVE,
    instructionName: "buy_exact_quote_in_v2",
    side: "buy",
    baseMint: mint,
    quoteMint,
    expectedOut: trade.quote.expectedOut,
    maxBuy: spend,
    tradeIndex: tradeIndexOf(trade.instructions),
  };
}

async function curveBuyExactTokens(a: TestActors, o: BuildOptions): Promise<Built> {
  const state = await loadCurveState({ user: o.user ?? a.signer });
  const rates = curveFeeRates({ curve: state.curve, global: state.global, feeConfig: state.feeConfig, mintSupply: state.mintInfo.supply });
  const tokens = quoteBuyExactQuoteIn(state.curve, o.spend ?? spendFor(WSOL_MINT), rates).tokenAmount;
  const amount = o.shrinkOut ? tokens / 2n : tokens;
  const limit = applySlippageUp(quoteBuyExactTokens(state.curve, amount, rates).totalQuote, o.slippageBps ?? CLI_SLIPPAGE_BPS);
  const { instructions } = await buildPumpBuyInstructions(curveContext(state), { mode: "exactTokens", amount, limit });
  return {
    instructions,
    cuLimit: DEFAULT_CU_LIMITS.pumpBuy,
    venue: CURVE,
    instructionName: "buy_v2",
    side: "buy",
    baseMint: CURVE_MINT,
    quoteMint: WSOL_MINT,
    expectedOut: tokens,
    maxBuy: limit,
    tradeIndex: tradeIndexOf(instructions),
  };
}

async function curveSell(a: TestActors, o: BuildOptions, fullExit: boolean, quoteMint: Address = WSOL_MINT): Promise<Built> {
  const state = await loadCurveState({ user: o.user ?? a.signer, baseBalance: BALANCE }, CURVE_MINT, { quoteMint });
  const trade = await buildTrade(state, { side: "sell", amount: fullExit ? BALANCE : BALANCE / 3n, slippageBps: slippage(o) });
  return {
    instructions: trade.instructions,
    cuLimit: trade.defaultCuLimit,
    venue: CURVE,
    instructionName: "sell_v2",
    side: "sell",
    baseMint: CURVE_MINT,
    quoteMint,
    expectedOut: trade.quote.expectedOut,
    maxBuy: 0n,
    tradeIndex: tradeIndexOf(trade.instructions),
  };
}

async function poolState(a: TestActors, o: BuildOptions, baseBalance: bigint, pool: Partial<PumpSwapState["pool"]>) {
  const state = await loadPoolState({ user: o.user ?? a.signer, baseBalance }, { pool });
  if (!o.pool) return state;
  return {
    ...state,
    poolAddress: o.pool.address,
    pool: { ...state.pool, poolBaseTokenAccount: o.pool.baseVault, poolQuoteTokenAccount: o.pool.quoteVault },
  };
}

async function ammBuyExactQuoteIn(a: TestActors, o: BuildOptions, pool: Partial<PumpSwapState["pool"]> = {}): Promise<Built> {
  const state = await poolState(a, o, 0n, pool);
  const spend = o.spend ?? spendFor(WSOL_MINT);
  const trade = await buildTrade(state, { side: "buy", amount: spend, slippageBps: slippage(o) });
  return {
    instructions: trade.instructions,
    cuLimit: trade.defaultCuLimit,
    venue: AMM,
    instructionName: "buy_exact_quote_in",
    side: "buy",
    baseMint: POOL_BASE_MINT,
    quoteMint: WSOL_MINT,
    expectedOut: trade.quote.expectedOut,
    maxBuy: spend,
    tradeIndex: tradeIndexOf(trade.instructions),
  };
}

async function ammBuyExactBase(a: TestActors, o: BuildOptions): Promise<Built> {
  const state = await poolState(a, o, 0n, {});
  const rates = ammFeeRates({
    pool: state.pool,
    isCanonical: state.isCanonical,
    reserves: state.reserves,
    baseMintSupply: state.mintInfo.supply,
    feeConfig: state.feeConfig,
    globalConfig: state.globalConfig,
  });
  const base = quoteAmmBuyExactQuoteIn(state.reserves, o.spend ?? spendFor(WSOL_MINT), rates).baseOut;
  const amount = o.shrinkOut ? base / 2n : base;
  const limit = applySlippageUp(quoteAmmBuyExactBase(state.reserves, amount, rates).totalQuote, o.slippageBps ?? CLI_SLIPPAGE_BPS);
  const { instructions } = await buildAmmBuyInstructions(ammContext(state), { mode: "exactBase", amount, limit });
  return {
    instructions,
    cuLimit: DEFAULT_CU_LIMITS.ammBuy,
    venue: AMM,
    instructionName: "buy",
    side: "buy",
    baseMint: POOL_BASE_MINT,
    quoteMint: WSOL_MINT,
    expectedOut: base,
    maxBuy: limit,
    tradeIndex: tradeIndexOf(instructions),
  };
}

async function ammSell(a: TestActors, o: BuildOptions, fullExit: boolean, pool: Partial<PumpSwapState["pool"]> = {}): Promise<Built> {
  const state = await poolState(a, o, BALANCE, pool);
  const trade = await buildTrade(state, { side: "sell", amount: fullExit ? BALANCE : BALANCE / 3n, slippageBps: slippage(o) });
  return {
    instructions: trade.instructions,
    cuLimit: trade.defaultCuLimit,
    venue: AMM,
    instructionName: "sell",
    side: "sell",
    baseMint: POOL_BASE_MINT,
    quoteMint: WSOL_MINT,
    expectedOut: trade.quote.expectedOut,
    maxBuy: 0n,
    tradeIndex: tradeIndexOf(trade.instructions),
  };
}

interface Case {
  name: string;
  venue: "curve" | "pumpswap";
  side: "buy" | "sell";
  /** Default wSOL. */
  quoteMint?: Address;
  /** Buys that receive an exact token amount (no minimum-out argument). */
  exactOut?: boolean;
  /** Moves SOL between the wallet's own accounts (wSOL wrap/unwrap or a rent-reclaiming close). */
  ownFunds?: boolean;
  /** core prepends extend_account (pre-upgrade pool). */
  extendsPool?: boolean;
  /** Instructions core must emit, in order (program-level shape check). */
  shape: readonly string[];
  build(a: TestActors, o?: BuildOptions): Promise<Built>;
}

const CASES: readonly Case[] = [
  {
    name: "curve buy_exact_quote_in_v2 creating the Token-2022 ATA",
    venue: "curve",
    side: "buy",
    shape: ["ata", "pump"],
    build: (a, o = {}) => curveBuyExactQuoteIn(a, o, CURVE_MINT),
  },
  {
    name: "curve buy_v2 (exact tokens)",
    venue: "curve",
    side: "buy",
    exactOut: true,
    shape: ["ata", "pump"],
    build: (a, o = {}) => curveBuyExactTokens(a, o),
  },
  {
    name: "mayhem-mode curve buy (reserved fee recipients)",
    venue: "curve",
    side: "buy",
    shape: ["ata", "pump"],
    build: (a, o = {}) => curveBuyExactQuoteIn(a, o, MAYHEM_MINT),
  },
  {
    name: "curve sell_v2, partial",
    venue: "curve",
    side: "sell",
    shape: ["pump"],
    build: (a, o = {}) => curveSell(a, o, false),
  },
  {
    name: "curve sell_v2, full exit + CloseAccount",
    venue: "curve",
    side: "sell",
    ownFunds: true,
    shape: ["pump", "close"],
    build: (a, o = {}) => curveSell(a, o, true),
  },
  {
    name: "USDC-quoted curve buy_exact_quote_in_v2 (per-quote-mint cap)",
    venue: "curve",
    side: "buy",
    quoteMint: USDC_MINT,
    shape: ["ata", "pump"],
    build: (a, o = {}) => curveBuyExactQuoteIn(a, o, CURVE_MINT, USDC_MINT),
  },
  {
    name: "USDC-quoted curve sell_v2, full exit (creates the USDC account, closes the coin account)",
    venue: "curve",
    side: "sell",
    quoteMint: USDC_MINT,
    ownFunds: true,
    shape: ["ata", "pump", "close"],
    build: (a, o = {}) => curveSell(a, o, true, USDC_MINT),
  },
  {
    name: "PumpSwap buy_exact_quote_in with wSOL wrap, SyncNative and unwrap",
    venue: "pumpswap",
    side: "buy",
    ownFunds: true,
    shape: ["ata", "transfer", "sync", "ata", "pumpswap", "close"],
    build: (a, o = {}) => ammBuyExactQuoteIn(a, o),
  },
  {
    name: "PumpSwap buy (exact base out) with wSOL wrap and unwrap",
    venue: "pumpswap",
    side: "buy",
    exactOut: true,
    ownFunds: true,
    shape: ["ata", "transfer", "sync", "ata", "pumpswap", "close"],
    build: (a, o = {}) => ammBuyExactBase(a, o),
  },
  {
    name: "PumpSwap buy on a cashback pool (27 accounts)",
    venue: "pumpswap",
    side: "buy",
    ownFunds: true,
    shape: ["ata", "transfer", "sync", "ata", "pumpswap", "close"],
    build: (a, o = {}) => ammBuyExactQuoteIn(a, o, { isCashbackCoin: true }),
  },
  {
    name: "PumpSwap sell, partial, with unwrap",
    venue: "pumpswap",
    side: "sell",
    ownFunds: true,
    shape: ["ata", "pumpswap", "close"],
    build: (a, o = {}) => ammSell(a, o, false),
  },
  {
    name: "PumpSwap sell, full exit, with unwrap and CloseAccount",
    venue: "pumpswap",
    side: "sell",
    ownFunds: true,
    shape: ["ata", "pumpswap", "close", "close"],
    build: (a, o = {}) => ammSell(a, o, true),
  },
  {
    name: "PumpSwap sell on a pool without a coin creator (23 accounts)",
    venue: "pumpswap",
    side: "sell",
    ownFunds: true,
    shape: ["ata", "pumpswap", "close"],
    build: (a, o = {}) => ammSell(a, o, false, { coinCreator: DEFAULT_PUBKEY }),
  },
  {
    name: "PumpSwap buy on a pre-upgrade pool (extend_account first)",
    venue: "pumpswap",
    side: "buy",
    ownFunds: true,
    extendsPool: true,
    shape: ["extend", "ata", "transfer", "sync", "ata", "pumpswap", "close"],
    build: (a, o = {}) => ammBuyExactQuoteIn(a, o, { dataLength: 261 }),
  },
  {
    name: "PumpSwap full-exit sell on a pre-upgrade pool (extend_account first)",
    venue: "pumpswap",
    side: "sell",
    ownFunds: true,
    extendsPool: true,
    shape: ["extend", "ata", "pumpswap", "close", "close"],
    build: (a, o = {}) => ammSell(a, o, true, { dataLength: 261 }),
  },
];

// ---------------------------------------------------------------------------------------------
// Instruction helpers for tampering with core's list
// ---------------------------------------------------------------------------------------------

const isSystemTransfer = (ix: Instruction) => ix.programAddress === SYSTEM_PROGRAM && ix.data?.length === 12 && readU32LE(ix.data, 0) === 2;
const isCloseAccount = (ix: Instruction) =>
  (ix.programAddress === TOKEN_PROGRAM || ix.programAddress === TOKEN_2022_PROGRAM) && ix.data?.length === 1 && ix.data[0] === 9;

function shapeOf(ix: Instruction): string {
  if (isExtend(ix)) return "extend";
  if (ix.programAddress === PUMP_PROGRAM) return "pump";
  if (ix.programAddress === PUMP_AMM_PROGRAM) return "pumpswap";
  if (isSystemTransfer(ix)) return "transfer";
  if (isCloseAccount(ix)) return "close";
  if ((ix.programAddress === TOKEN_PROGRAM || ix.programAddress === TOKEN_2022_PROGRAM) && ix.data?.[0] === 17) return "sync";
  if (ix.programAddress === ASSOCIATED_TOKEN_PROGRAM) return "ata";
  return `other ${ix.programAddress}`;
}

function setAccount(ix: Instruction, index: number, meta: AccountMeta): Instruction {
  const accounts = [...(ix.accounts ?? [])];
  accounts[index] = meta;
  return { ...ix, accounts };
}

/** Replaces every meta for `from` in one instruction; returns the instruction and how many were replaced. */
function swapAccount(ix: Instruction, from: Address, to: AccountMeta): [Instruction, number] {
  let count = 0;
  const accounts = (ix.accounts ?? []).map((m) => {
    if (m.address !== from) return m;
    count++;
    return to;
  });
  return [{ ...ix, accounts }, count];
}

const writable = (address: Address): AccountMeta => ({ address, role: AccountRole.WRITABLE });

/** core's build for one case and wallet set, memoized per options (see the matrix below). */
type Build = (o?: BuildOptions) => Promise<Built>;

/** core's build plus the exact instruction list it compiles; the list is a fresh array, safe to tamper with. */
async function builtAndList(build: Build, mode: LandingMode, a: TestActors, o: BuildOptions = {}) {
  const built = await build(o);
  return { built, full: coreInstructionList(a.signer, built.instructions, planFor(mode, built.cuLimit, FEE_CAPS)) };
}

const keepCache = new Map<string, Promise<Set<string>>>();

/** Accounts the firewall requires as static keys (or that must stay static to compile): never moved into a lookup table. */
function fundRelevant(a: TestActors, built: Built): Promise<Set<string>> {
  const key = `${a.signer}|${built.baseMint}|${built.quoteMint}`;
  let keep = keepCache.get(key);
  if (!keep) {
    keep = deriveFundRelevant(a, built);
    keepCache.set(key, keep);
  }
  return keep;
}

async function deriveFundRelevant(a: TestActors, built: Built): Promise<Set<string>> {
  const keep = new Set<string>([
    built.baseMint,
    built.quoteMint,
    WSOL_MINT,
    TOKEN_PROGRAM,
    TOKEN_2022_PROGRAM,
    SYSTEM_PROGRAM,
    ASSOCIATED_TOKEN_PROGRAM,
    COMPUTE_BUDGET_PROGRAM,
    PUMP_PROGRAM,
    PUMP_AMM_PROGRAM,
    POOL,
    a.signer,
    a.connected,
    a.attacker,
    ...SIGNER_TIP_ACCOUNTS,
  ]);
  for (const owner of [a.signer, a.connected, a.attacker]) {
    for (const mint of [built.baseMint, built.quoteMint, WSOL_MINT]) {
      for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) keep.add(await ata(owner, mint, program));
    }
  }
  return keep;
}

/**
 * Compiles a tampered copy of core's instruction list. Core's transactions use up to 1,205 of the
 * 1,232 bytes, so a tamper that adds an account or a signature may no longer fit one packet; the
 * firewall would then refuse it for size alone. An attacker would move venue-internal accounts (fee
 * recipients, PDAs, vaults) into an address lookup table instead, so this does the same and supplies
 * the table, keeping every fund-relevant account static, so the refusal is for the rule under test.
 */
async function compileTampered(a: TestActors, built: Built, full: readonly Instruction[]) {
  const plain = compileLikeCore(a.signer, full);
  if (plain.length <= PACKET_DATA_SIZE) return { tx: plain, ctx: shippedContext(a) };
  const keep = await fundRelevant(a, built);
  const movable = (m: AccountMeta) => !isSignerRole(m.role) && !keep.has(m.address) && !m.address.startsWith(JITO_DONT_FRONT_PREFIX);
  const shared = [...new Set(full.flatMap((ix) => (ix.accounts ?? []).filter(movable).map((m) => m.address)))];
  const table = randomAddress();
  const tx = buildTransaction({ feePayer: a.signer, instructions: full, lookupTables: { [table]: shared } });
  expect(tx.length).toBeLessThanOrEqual(PACKET_DATA_SIZE);
  return { tx, ctx: shippedContext(a, { addressLookupTables: { [table]: shared } }) };
}

// ---------------------------------------------------------------------------------------------
// Tampering: what a compromised backend or app would ask the trading wallet to sign
// ---------------------------------------------------------------------------------------------

/** One case in one landing mode: its wallet set and core's memoized build. */
interface Group {
  c: Case;
  mode: LandingMode;
  a: TestActors;
  build: Build;
}

interface Mutation {
  name: string;
  applies(c: Case): boolean;
  run(g: Group): Promise<void>;
}

const SPIKE: TipFloor = { ...TIP_FLOOR, p25: SOL, p50: SOL, p75: SOL, p95: SOL, p99: SOL, emaP50: SOL };

const MUTATIONS: readonly Mutation[] = [
  {
    name: "a tip sent to the attacker instead of a tip account",
    applies: () => true,
    async run({ mode, a, build }) {
      const { built, full } = await builtAndList(build, mode, a);
      const i = full.findIndex((ix) => isSystemTransfer(ix) && SIGNER_TIP_ACCOUNTS.includes(ix.accounts?.[1]?.address as Address));
      expect(i).toBeGreaterThan(BUDGET_IXS);
      full[i] = setAccount(full[i]!, 1, writable(a.attacker));
      const { tx, ctx } = await compileTampered(a, built, full);
      await expectRefused(tx, ctx, new RegExp(`#${i} System Transfer: destination ${a.attacker} is not a tip account`));
    },
  },
  {
    name: "bought tokens or sale proceeds sent to the attacker's token account",
    applies: () => true,
    async run({ mode, a, build }) {
      const { built, full } = await builtAndList(build, mode, a);
      // Buys receive the coin; sells receive the quote (wSOL and USDC are both SPL Token mints).
      const [mint, program] = built.side === "buy" ? [built.baseMint, tokenProgramOf(built.baseMint)] : [built.quoteMint, TOKEN_PROGRAM];
      const t = BUDGET_IXS + built.tradeIndex;
      const [tampered, replaced] = swapAccount(
        full[t]!,
        await ata(a.signer, mint, program),
        writable(await ata(a.attacker, mint, program)),
      );
      expect(replaced).toBe(1);
      full[t] = tampered;
      const { tx, ctx } = await compileTampered(a, built, full);
      await expectRefused(
        tx,
        ctx,
        new RegExp(
          `#${t} ${built.venue} ${built.instructionName}: token account at position \\d+ must be the trading wallet's associated token account for ${mint}`,
        ),
      );
    },
  },
  {
    name: "the wSOL wrap transfer and every CloseAccount paying the attacker",
    applies: (c) => c.ownFunds === true,
    async run({ mode, a, build }) {
      const { built, full } = await builtAndList(build, mode, a);
      const wsol = await ata(a.signer, WSOL_MINT, TOKEN_PROGRAM);
      const changed: number[] = [];
      full.forEach((ix, i) => {
        if ((isSystemTransfer(ix) && ix.accounts?.[1]?.address === wsol) || isCloseAccount(ix)) {
          full[i] = setAccount(ix, 1, writable(a.attacker));
          changed.push(i);
        }
      });
      expect(changed.length).toBeGreaterThan(0);
      const { tx, ctx } = await compileTampered(a, built, full);
      const violations = await expectRefused(tx, ctx, /./);
      for (const i of changed) {
        const pattern = isCloseAccount(full[i]!)
          ? /CloseAccount: rent may only go to the trading wallet or the connected wallet/
          : /Transfer: destination .* is not a tip account, the trading wallet's wSOL account or the connected wallet/;
        expect(violations.filter((v) => v.startsWith(`#${i} `) && pattern.test(v))).toHaveLength(1);
      }
    },
  },
  {
    name: "the trade built by core for another wallet (user != signer)",
    applies: () => true,
    async run({ mode, a, build }) {
      // The trading wallet pays and signs; core built everything else for the attacker's wallet.
      const { built, full } = await builtAndList(build, mode, a, { user: a.attacker });
      const { tx, ctx } = await compileTampered(a, built, full);
      const violations = await expectRefused(tx, ctx, /requires 2 signatures .*only the trading wallet may sign/);
      expect(violations.join("\n")).toMatch(
        new RegExp(`#${BUDGET_IXS + built.tradeIndex} ${built.venue} ${built.instructionName}: user must be the trading wallet`),
      );
    },
  },
  {
    name: "the user slot holding the connected wallet (no extra signature)",
    applies: () => true,
    async run({ mode, a, build }) {
      const { built, full } = await builtAndList(build, mode, a);
      const t = BUDGET_IXS + built.tradeIndex;
      const [tampered, replaced] = swapAccount(full[t]!, a.signer, writable(a.connected));
      expect(replaced).toBe(1);
      full[t] = tampered;
      const { tx, ctx } = await compileTampered(a, built, full);
      // Once the trade is refused, an ATA created for its mint is refused too ("neither trades nor transfers").
      const violations = await expectRefused(
        tx,
        ctx,
        new RegExp(`#${t} ${built.venue} ${built.instructionName}: user must be the trading wallet`),
      );
      expect(violations.filter((v) => !/user must be the trading wallet|neither trades nor transfers/.test(v))).toEqual([]);
    },
  },
  {
    name: "a buy over the per-trade cap",
    applies: (c) => c.side === "buy",
    async run({ c, mode, a, build }) {
      const cap = capFor(c.quoteMint ?? WSOL_MINT);
      const built = await build({ spend: cap + 1n });
      expect(built.maxBuy).toBeGreaterThan(cap);
      await expectRefused(
        assemble(a.signer, built.instructions, planFor(mode, built.cuLimit, FEE_CAPS)),
        shippedContext(a),
        new RegExp(
          `#${BUDGET_IXS + built.tradeIndex} ${built.venue} ${built.instructionName}: spends up to .* above the per-trade cap of ${
            built.quoteMint === WSOL_MINT ? "1 SOL" : "100,000,000 base units of EPjF…Dt1v"
          }`,
        ),
      );
    },
  },
  {
    name: "tips over the cap (a tip-floor spike clamps to the shipped cap and passes)",
    applies: () => true,
    async run({ mode, a, build }) {
      const built = await build();
      const clamped = planFor(mode, built.cuLimit, FEE_CAPS, { tipFloor: SPIKE });
      expect(clamped.totalTipLamports).toBe(CAPS.maxTipLamports);
      await expectAllowed(assemble(a.signer, built.instructions, clamped), shippedContext(a));
      const over = planFor(mode, built.cuLimit, { ...FEE_CAPS, maxTipLamports: CAPS.maxTipLamports + 1n }, { tipFloor: SPIKE });
      expect(over.totalTipLamports).toBe(CAPS.maxTipLamports + 1n);
      await expectRefused(
        assemble(a.signer, built.instructions, over),
        shippedContext(a),
        new RegExp(`tips total ${CAPS.maxTipLamports + 1n} lamports, above the cap of ${CAPS.maxTipLamports}`),
      );
    },
  },
  {
    name: "a priority fee over the cap (a fee spike clamps to the shipped cap and passes)",
    applies: () => true,
    async run({ mode, a, build }) {
      const built = await build();
      const spike = { prioritySamples: [10n ** 12n] };
      const clamped = planFor(mode, built.cuLimit, FEE_CAPS, spike);
      expect(clamped.priorityFeeLamports).toBeLessThanOrEqual(CAPS.maxPriorityFeeLamports);
      await expectAllowed(assemble(a.signer, built.instructions, clamped), shippedContext(a));
      const over = planFor(mode, built.cuLimit, { ...FEE_CAPS, maxPriorityFeeLamports: 2n * CAPS.maxPriorityFeeLamports }, spike);
      expect(over.priorityFeeLamports).toBeGreaterThan(CAPS.maxPriorityFeeLamports);
      await expectRefused(
        assemble(a.signer, built.instructions, over),
        shippedContext(a),
        new RegExp(`priority fee ${over.priorityFeeLamports} lamports exceeds the cap of ${CAPS.maxPriorityFeeLamports} lamports`),
      );
    },
  },
  {
    name: "a second, attacker-created pool for the same pair (non-canonical)",
    applies: (c) => c.venue === "pumpswap",
    async run({ c, mode, a, build }) {
      const pool = await ammPoolPda(1, a.attacker, POOL_BASE_MINT, WSOL_MINT);
      const built = await build({
        pool: {
          address: pool,
          baseVault: await ata(pool, POOL_BASE_MINT, tokenProgramOf(POOL_BASE_MINT)),
          quoteVault: await ata(pool, WSOL_MINT, TOKEN_PROGRAM),
        },
      });
      const violations = await expectRefused(
        assemble(a.signer, built.instructions, planFor(mode, built.cuLimit, FEE_CAPS)),
        shippedContext(a),
        new RegExp(`pool ${pool} is not the canonical pool for ${POOL_BASE_MINT}`),
      );
      if (c.extendsPool) expect(violations.join("\n")).toMatch(/extend_account: .* only that pool may be extended/);
    },
  },
  {
    name: "an extra signer on the trade instruction",
    applies: () => true,
    async run({ mode, a, build }) {
      const { built, full } = await builtAndList(build, mode, a);
      const t = BUDGET_IXS + built.tradeIndex;
      full[t] = { ...full[t]!, accounts: [...(full[t]!.accounts ?? []), { address: a.attacker, role: AccountRole.READONLY_SIGNER }] };
      const { tx, ctx } = await compileTampered(a, built, full);
      await expectRefused(
        tx,
        ctx,
        new RegExp(`transaction requires 2 signatures \\(${a.signer}, ${a.attacker}\\); only the trading wallet may sign`),
      );
    },
  },
  {
    name: "a zero minimum out (planted in core's instruction bytes; core itself refuses to build one)",
    applies: (c) => !c.exactOut,
    async run({ mode, a, build }) {
      const built = await build({});
      const minOut = minOutForTrade(built.expectedOut, CLI_SLIPPAGE_BPS);
      const instructions = built.instructions.map((ix, i) =>
        i === built.tradeIndex && ix.data ? { ...ix, data: zeroU64Arg(ix.data, minOut) } : ix,
      );
      await expectRefused(
        assemble(a.signer, instructions, planFor(mode, built.cuLimit, FEE_CAPS)),
        shippedContext(a),
        new RegExp(`#${BUDGET_IXS + built.tradeIndex} ${built.venue} ${built.instructionName}: minimum (output|tokens out) is 0`),
      );
    },
  },
  {
    name: "a minimum out below the quote less the user's slippage (only caught with expectations)",
    applies: () => true,
    async run({ mode, a, build }) {
      const built = await build({ shrinkOut: true });
      const tx = assemble(a.signer, built.instructions, planFor(mode, built.cuLimit, FEE_CAPS));
      await expectAllowed(tx, shippedContext(a));
      const expectations: TradeExpectation[] = [
        { instruction: BUDGET_IXS + built.tradeIndex, expectedOut: built.expectedOut, slippageBps: CLI_SLIPPAGE_BPS },
      ];
      await expectRefused(
        tx,
        shippedContext(a, { expectations }),
        new RegExp(`#${BUDGET_IXS + built.tradeIndex} ${built.venue} ${built.instructionName}: minimum output .* is below your quote`),
      );
    },
  },
];

// ---------------------------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------------------------

describe("engine <-> firewall: the test harness reproduces core exactly", () => {
  test("compileLikeCore(coreInstructionList(...)) is byte-identical to core's assembleTransaction", async () => {
    const a = makeActors();
    for (const c of CASES) {
      const built = await c.build(a);
      for (const mode of MODES) {
        const plan = planFor(mode, built.cuLimit, FEE_CAPS);
        const blockhash = randomBlockhash();
        // Pin the tip accounts so both builds pick the same ones.
        const pinned = {
          ...plan,
          tips: plan.tips.map((t, i) => ({ ...t, tipAccount: (t.lane === "jito" ? JITO_TIP_ACCOUNTS : HELIUS_SENDER_TIP_ACCOUNTS)[i]! })),
        };
        expect(compileLikeCore(a.signer, coreInstructionList(a.signer, built.instructions, pinned), blockhash)).toEqual(
          assemble(a.signer, built.instructions, pinned, blockhash),
        );
      }
    }
  });

  test("the snapshot pool is the canonical pool core resolves, and every case has the expected instruction shape", async () => {
    expect(await findCanonicalPumpPool(PUMP_PROGRAM, PUMP_AMM_PROGRAM, POOL_BASE_MINT, WSOL_MINT)).toBe(POOL);
    const a = makeActors();
    for (const c of CASES) {
      const built = await c.build(a);
      expect({ name: c.name, shape: built.instructions.map(shapeOf) }).toEqual({ name: c.name, shape: [...c.shape] });
    }
  });
});

for (const c of CASES) {
  describe(`engine <-> firewall: ${c.name}`, () => {
    for (const mode of MODES) {
      describe(`${mode} mode`, () => {
        // One wallet set per case and mode, with core's build memoized per options: tampering always
        // copies core's instructions, and any of core's random fee-recipient picks is a legitimate build.
        const a = makeActors();
        const builds = new Map<string, Promise<Built>>();
        const build: Build = (o = {}) => {
          const key = JSON.stringify(o, (_k, v: unknown) => (typeof v === "bigint" ? `${v}n` : v));
          let built = builds.get(key);
          if (!built) {
            built = c.build(a, o);
            builds.set(key, built);
          }
          return built;
        };

        test("core's transaction passes the shipped policy, also with core's own quote as the expectation", async () => {
          const built = await build();
          const plan = planFor(mode, built.cuLimit, FEE_CAPS);
          const tx = assemble(a.signer, built.instructions, plan);
          const summary = await expectAllowed(tx, shippedContext(a));

          expect(summary.version).toBe(0);
          if (built.quoteMint === WSOL_MINT) {
            expect(summary.maxBuyLamports).toBe(built.maxBuy);
            expect(summary.maxBuyQuote).toEqual({});
          } else {
            expect(summary.maxBuyLamports).toBe(0n);
            expect(summary.maxBuyQuote).toEqual(built.maxBuy > 0n ? { [built.quoteMint]: built.maxBuy } : {});
          }
          expect(summary.tipLamports).toBe(plan.totalTipLamports);
          expect(summary.priorityFeeLamports).toBe(plan.priorityFeeLamports);
          expect(summary.computeUnitLimit).toBe(built.cuLimit);
          expect(summary.actions.filter((x) => x.kind === "trade")).toEqual([
            expect.objectContaining({
              venue: built.venue,
              instruction: built.instructionName,
              side: built.side,
              baseMint: built.baseMint,
              quoteMint: built.quoteMint,
            }),
          ]);
          if (c.extendsPool) expect(summary.actions).toContainEqual({ kind: "extend_account", venue: AMM, account: POOL });

          // The landing mode's tips, exactly as SPEC's presets describe them.
          const tips = summary.actions.flatMap((x) => (x.kind === "tip" ? [x] : []));
          const lanes = tips.map((t) =>
            JITO_TIP_ACCOUNTS.includes(t.to) ? "jito" : HELIUS_SENDER_TIP_ACCOUNTS.includes(t.to) ? "helius" : "?",
          );
          const decoded = decodeTransaction(tx);
          if (!decoded.ok) throw new Error(decoded.violations.join("; "));
          const markers = decoded.tx.accounts.filter((acc) => acc.address.startsWith(JITO_DONT_FRONT_PREFIX));
          if (mode === "standard") {
            expect(lanes).toEqual(["helius", "jito"]);
            expect(markers).toHaveLength(0);
          } else if (mode === "turbo") {
            expect(lanes).toEqual(["helius"]);
            expect(tips[0]!.lamports).toBeGreaterThanOrEqual(1_000_000n);
            expect(markers).toHaveLength(0);
          } else {
            expect(lanes).toEqual(["jito"]);
            expect(markers.map((m) => [m.isSigner, m.isWritable, m.isStatic])).toEqual([[false, false, true]]);
          }

          const expectations: TradeExpectation[] = [
            { instruction: BUDGET_IXS + built.tradeIndex, expectedOut: built.expectedOut, slippageBps: CLI_SLIPPAGE_BPS },
          ];
          const checked = await expectAllowed(tx, shippedContext(a, { expectations }));
          expect(checked.text).toContain("Checked against your own quote");
        });

        for (const m of MUTATIONS) {
          if (m.applies(c)) test(`refused: ${m.name}`, () => m.run({ c, mode, a, build }));
        }
      });
    }
  });
}
