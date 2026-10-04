/**
 * Builds transactions with @zerofee/core exactly as the CLI and the web app do:
 *   loadTokenState -> buildTrade (or the venue builders) -> planFees -> assembleTransaction -> wire bytes
 * from core's offline mainnet snapshots (packages/core/test/fixtures/mainnet-accounts.json for pump
 * and PumpSwap, raydium-mainnet.json for Raydium LaunchLab and CPMM), served through a stub RPC.
 * Only the trading wallet's own accounts (SOL balance, token balance), the wSOL mint and, for
 * re-quoted curves, the quote mint are synthesized.
 *
 * Test-only: @zerofee/core is a devDependency of the signer and must never be imported from src/
 * (test/constants-crosscheck.test.ts enforces that).
 */
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  createTransactionMessage,
  getAddressEncoder,
  getBase64Decoder,
  getBase64Encoder,
  getTransactionEncoder,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import {
  type AmmTradeContext,
  assembleTransaction,
  bondingCurvePda,
  type CpmmState,
  decodePool,
  type FeeCaps,
  type FeePlan,
  type LandingMode,
  type LaunchLabState,
  loadTokenState,
  type Pool,
  type PumpCurveState,
  type PumpSwapState,
  type PumpTradeContext,
  parseJitoTipFloor,
  planFees,
  type SpeedPreset,
  type StateRpc,
  SYSTEM_PROGRAM_ID,
  type TipFloor,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
  withBudgetAndTips,
} from "@zerofee/core";
import snapshot from "../../../core/test/fixtures/mainnet-accounts.json";
import raydiumSnapshot from "../../../core/test/fixtures/raydium-mainnet.json";
import { findAssociatedTokenAddress } from "../../src/firewall/ata";
import { randomBlockhash } from "./tx";

/** Create_v2 (Token-2022) coin on the bonding curve, from core's snapshot. */
export const CURVE_MINT: Address = address(snapshot.curveMint);
/** Mayhem-mode coin on the bonding curve (reserved fee recipients). */
export const MAYHEM_MINT: Address = address(snapshot.mayhemMint);
/** Canonical PumpSwap boost pool (301 bytes, already extended). */
export const POOL: Address = address(snapshot.pool);

interface JsonAccount {
  owner: string;
  lamports: string;
  data: string;
}

const SNAPSHOT = snapshot.accounts as Readonly<Record<string, JsonAccount>>;

function snapshotAccount(a: Address): JsonAccount {
  const acc = SNAPSHOT[a];
  if (!acc) throw new Error(`${a} is missing from core's snapshot`);
  return acc;
}

/** The pool's base mint (a migrated Token-2022 coin). */
export const POOL_BASE_MINT: Address = decodePool(new Uint8Array(getBase64Encoder().encode(snapshotAccount(POOL).data))).baseMint;

/** Jito tip_floor snapshot from tx_landing_and_mev.md §2 (as in core's tx tests): p75 67,913, p95 128,750 lamports. */
export const TIP_FLOOR: TipFloor = parseJitoTipFloor([
  {
    time: "2026-10-03T15:34:59+00:00",
    landed_tips_25th_percentile: 1.0000000000000002e-6,
    landed_tips_50th_percentile: 6.145500000000001e-6,
    landed_tips_75th_percentile: 0.000067913,
    landed_tips_95th_percentile: 0.0001287499999999998,
    landed_tips_99th_percentile: 0.0002643690299999999,
    ema_landed_tips_50th_percentile: 5.021080713564013e-6,
  },
]);

/** The CLI's default priority-fee floor (PRIORITY_FEE_FLOOR_MICROLAMPORTS) and default slippage (SLIPPAGE_BPS). */
export const CLI_MIN_CU_PRICE = 100_000n;
export const CLI_SLIPPAGE_BPS = 1500;

const b64 = getBase64Decoder();
const addressEncoder = getAddressEncoder();

function u64le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

/** 82-byte SPL mint (no authorities). */
function mintAccount(supply: bigint, decimals: number): JsonAccount {
  const data = new Uint8Array(82);
  data.set(u64le(supply), 36);
  data[44] = decimals;
  data[45] = 1; // is_initialized
  return { owner: TOKEN_PROGRAM_ID, lamports: "1461600", data: b64.decode(data) };
}

/** 165-byte initialized token account (Token and Token-2022 share the base layout). */
function tokenAccount(mint: Address, owner: Address, amount: bigint, tokenProgram: Address): JsonAccount {
  const data = new Uint8Array(165);
  data.set(addressEncoder.encode(mint), 0);
  data.set(addressEncoder.encode(owner), 32);
  data.set(u64le(amount), 64);
  data[108] = 1; // AccountState::Initialized
  return { owner: tokenProgram, lamports: "2039280", data: b64.decode(data) };
}

/** getMultipleAccounts over a fixed account map: all core's state loader needs. */
function stubRpc(accounts: Readonly<Record<string, JsonAccount>>): StateRpc {
  const rpc = {
    getMultipleAccounts: (addresses: readonly Address[]) => ({
      send: async () => ({
        context: { slot: 0n },
        value: addresses.map((a) => {
          const acc = accounts[a];
          return acc
            ? { owner: acc.owner, lamports: BigInt(acc.lamports), data: [acc.data, "base64"], executable: false, space: 0n }
            : null;
        }),
      }),
    }),
    getRecentPrioritizationFees: () => ({ send: async () => [] }),
  };
  return rpc as unknown as StateRpc;
}

export interface WalletFixture {
  user: Address;
  /** Lamports held by the trading wallet. Default 10 SOL. */
  lamports?: bigint;
  /** Token balance of `mint` in the wallet's ATA (0: no ATA yet, so buys create it). */
  baseBalance?: bigint;
}

async function walletAccounts(
  w: WalletFixture,
  mint: Address,
  accounts: Readonly<Record<string, JsonAccount>> = SNAPSHOT,
): Promise<Record<string, JsonAccount>> {
  const out: Record<string, JsonAccount> = {
    [w.user]: { owner: SYSTEM_PROGRAM_ID, lamports: (w.lamports ?? 10_000_000_000n).toString(), data: "" },
    [WSOL_MINT]: mintAccount(0n, 9),
  };
  if (w.baseBalance) {
    const owner = accounts[mint]?.owner;
    if (!owner) throw new Error(`${mint} is missing from core's snapshot`);
    const tokenProgram = address(owner);
    out[await findAssociatedTokenAddress(w.user, mint, tokenProgram)] = tokenAccount(mint, w.user, w.baseBalance, tokenProgram);
  }
  return out;
}

async function load(mint: Address, w: WalletFixture, patch: Readonly<Record<string, JsonAccount>> = {}) {
  return loadTokenState(stubRpc({ ...SNAPSHOT, ...(await walletAccounts(w, mint)), ...patch }), { mint, user: w.user });
}

/** BondingCurve.quote_mint: discriminator 8 + five u64 reserves 40 + complete 1 + creator 32 + two flags 2. */
const CURVE_QUOTE_MINT_OFFSET = 83;

/**
 * Live-equivalent curve state for `mint` (core's loadTokenState over the snapshot). `quoteMint`
 * re-quotes the snapshot curve (e.g. USDC, which pump.fun supports but the snapshot has no coin for):
 * its quote_mint field is patched and a 6-decimal mint account is served for it.
 */
export async function loadCurveState(
  w: WalletFixture,
  mint: Address = CURVE_MINT,
  options: { quoteMint?: Address } = {},
): Promise<PumpCurveState> {
  const patch: Record<string, JsonAccount> = {};
  if (options.quoteMint && options.quoteMint !== WSOL_MINT) {
    const curve = await bondingCurvePda(mint);
    const data = new Uint8Array(getBase64Encoder().encode(snapshotAccount(curve).data));
    data.set(addressEncoder.encode(options.quoteMint), CURVE_QUOTE_MINT_OFFSET);
    patch[curve] = { ...snapshotAccount(curve), data: b64.decode(data) };
    patch[options.quoteMint] = mintAccount(10n ** 15n, 6);
  }
  const state = await load(mint, w, patch);
  if (state.venue !== "pump") throw new Error(`${mint} is not on the bonding curve in the snapshot`);
  if (state.quoteMint !== (options.quoteMint ?? WSOL_MINT)) throw new Error(`curve quote mint is ${state.quoteMint}`);
  return state;
}

/**
 * Live-equivalent PumpSwap state for the snapshot's canonical pool. `pool` overrides decoded Pool
 * fields to model other live pools: dataLength below 300 is a pre-upgrade pool (core prepends
 * extend_account, as pump-swap-sdk does), isCashbackCoin / coinCreator change the remaining accounts.
 */
export async function loadPoolState(w: WalletFixture, options: { pool?: Partial<Pool> } = {}): Promise<PumpSwapState> {
  const state = await load(POOL_BASE_MINT, w);
  if (state.venue !== "pumpswap" || state.poolAddress !== POOL) throw new Error("snapshot pool did not resolve as the canonical pool");
  return options.pool ? { ...state, pool: { ...state.pool, ...options.pool } } : state;
}

/** The token program that owns a snapshot mint (both snapshot coins are Token-2022). */
export function tokenProgramOf(mint: Address): Address {
  return address(snapshotAccount(mint).owner);
}

// ---------------------------------------------------------------------------------------------
// Raydium LaunchLab and CPMM (core's raydium-mainnet.json snapshot, 2026-10-03)
// ---------------------------------------------------------------------------------------------

const RAYDIUM_SNAPSHOT = raydiumSnapshot.accounts as Readonly<Record<string, JsonAccount>>;

/** BONK.fun coin (SPL Token) on its SOL-quoted LaunchLab curve (letsbonk.fun platform). */
export const LAUNCHLAB_BONK_MINT: Address = address("5ojxCYwee4AgDRH4NxwCEXCGiMiKiYYB5r4Ycdo6bonk");
/** StonkFun coin (Token-2022 with a 3% transfer fee) on its SOL-quoted LaunchLab curve. */
export const LAUNCHLAB_STONK_MINT: Address = address("9RAPesjvcxKjGXn7QXvRaNPQ9HhhTZoqBqeZmqEuN1fK");
/** StonkFun coin (Token-2022, 1% fee) quoted in METAx, and its LaunchLab pool. */
export const LAUNCHLAB_XSTOCK_MINT: Address = address("GY5YxnQxPB6pPSryEEy9n6vUjJEow341edR5VVj8L2Pd");
export const LAUNCHLAB_XSTOCK_POOL: Address = address("EkvuyEhr2JHmgMnoNQGzBYw8mAAqgB7W6BBQAkpVTnBS");
/** METAx: a Token-2022 xStock (8 decimals), the quote of that pool. */
export const METAX_MINT: Address = address("Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu");
/** A TRiX LaunchLab pool: another pair's pool, for tampering. */
export const LAUNCHLAB_TRIX_POOL: Address = address("G5WBxuD4cEjRSVvbxodNtJ7ruDatqwSQwNCMxdFdozZY");
/** Graduated BONK.fun coin (SPL Token): core resolves it through its LaunchLab pool to the canonical CPMM pool. */
export const CPMM_BONK_MINT: Address = address("7dmcQ9TyPDcfTTjfCfcZhuwK79FThVuKqmzVM9uKpRhK");
/** Graduated StonkFun coin (Token-2022, 3% transfer fee) and its CPMM pool. */
export const CPMM_STONK_MINT: Address = address("9RcvjFss6ePC2gtnmCZ84nCbWydTF7Dux2oJk5gCck8N");
export const CPMM_STONK_POOL: Address = address("F5MuM3C8PanScX296quAoNcLYGjtt8pN7JkBM3qsiK6Z");
/** Another CPMM pool (wSOL / an SPL coin), for tampering. */
export const CPMM_OTHER_POOL: Address = address("9nxAnMD7K78a9RMd2L3w8kQT5u9i7gsvV5aHiZ78sCC2");

async function loadRaydium(w: WalletFixture, mint: Address, poolAddress?: Address) {
  const accounts = { ...RAYDIUM_SNAPSHOT, ...(await walletAccounts(w, mint, RAYDIUM_SNAPSHOT)) };
  return loadTokenState(stubRpc(accounts), { mint, user: w.user, ...(poolAddress ? { poolAddress } : {}) });
}

/** Live-equivalent LaunchLab state for `mint` (core's loadTokenState over the Raydium snapshot). */
export async function loadLaunchLabState(w: WalletFixture, mint: Address, poolAddress?: Address): Promise<LaunchLabState> {
  const state = await loadRaydium(w, mint, poolAddress);
  if (state.venue !== "launchlab") throw new Error(`${mint} is not on a LaunchLab curve in the snapshot (${state.venue})`);
  return state;
}

/** Live-equivalent CPMM state for `mint`: through its LaunchLab pool when graduated, or an explicit pool. */
export async function loadCpmmState(w: WalletFixture, mint: Address, poolAddress?: Address): Promise<CpmmState> {
  const state = await loadRaydium(w, mint, poolAddress);
  if (state.venue !== "cpmm") throw new Error(`${mint} did not resolve to a CPMM pool in the snapshot (${state.venue})`);
  return state;
}

/** The context buildTrade passes to the curve builders. */
export function curveContext(state: PumpCurveState): PumpTradeContext {
  return {
    mint: state.mint,
    baseTokenProgram: state.mintInfo.tokenProgram,
    quoteTokenProgram: state.quoteTokenProgram,
    user: state.user,
    curve: state.curve,
    global: state.global,
  };
}

/** The context buildTrade passes to the PumpSwap builders. */
export function ammContext(state: PumpSwapState): AmmTradeContext {
  return {
    poolAddress: state.poolAddress,
    pool: state.pool,
    user: state.user,
    baseTokenProgram: state.mintInfo.tokenProgram,
    quoteTokenProgram: state.quoteTokenProgram,
    globalConfig: state.globalConfig,
  };
}

export interface PlanOptions {
  preset?: SpeedPreset;
  tipFloor?: TipFloor | null;
  prioritySamples?: readonly (number | bigint)[];
}

/** core's fee plan with the CLI defaults (fast preset, 100,000 µL/CU floor, live tip floor snapshot). */
export function planFor(mode: LandingMode, cuLimit: number, caps: FeeCaps, options: PlanOptions = {}): FeePlan {
  return planFees({
    mode,
    preset: options.preset ?? "fast",
    cuLimit,
    prioritySamples: options.prioritySamples ?? [],
    tipFloor: options.tipFloor === undefined ? TIP_FLOOR : options.tipFloor,
    caps,
    minCuPriceMicroLamports: CLI_MIN_CU_PRICE,
  });
}

/** core's assembleTransaction (CU limit, CU price, trade, tips; v0), encoded with an empty signature slot. */
export function assemble(feePayer: Address, instructions: readonly Instruction[], plan: FeePlan, blockhash?: Blockhash): Uint8Array {
  const tx = assembleTransaction({
    feePayer,
    instructions,
    blockhash: { blockhash: blockhash ?? randomBlockhash(), lastValidBlockHeight: 1_000n },
    fees: plan,
  });
  return new Uint8Array(getTransactionEncoder().encode(tx));
}

/** The exact instruction list core's assembleTransaction compiles: [CU limit, CU price, ...trade, ...tips]. */
export function coreInstructionList(feePayer: Address, instructions: readonly Instruction[], plan: FeePlan): Instruction[] {
  return withBudgetAndTips({ feePayer, instructions, fees: plan });
}

/**
 * Compiles a full instruction list the way core's assembleTransaction does (v0, fee payer, blockhash
 * lifetime), so a test can tamper with core's list before compiling. Equivalence with
 * assembleTransaction is asserted in engine.integration.test.ts.
 */
export function compileLikeCore(feePayer: Address, fullInstructions: readonly Instruction[], blockhash?: Blockhash): Uint8Array {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash ?? randomBlockhash(), lastValidBlockHeight: 1_000n }, m),
    (m) => appendTransactionMessageInstructions(fullInstructions, m),
  );
  return new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
}
