/**
 * The live trade engine end to end, offline: trade contexts shaped like the server's, built from core's
 * mainnet account snapshots; core builds; the shipped signer policy signs in an in-process worker (instant
 * mode) with the browser's quote as expectations; POST /api/tx is a DRY_RUN stub. The Jupiter fallback
 * runs against core's captured /build responses, with the route's lookup tables checked against a chain
 * read.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Address } from "@solana/kit";
import {
  type BuiltTrade,
  bondingCurvePda,
  buildTrade,
  type CpmmState,
  cpmmFeeRates,
  cpmmVaultAmountsWithoutFees,
  decodeBondingCurve,
  decodeMint,
  decodePool,
  findAssociatedTokenAddress,
  isCanonicalPumpPool,
  type LaunchLabState,
  type LocalTokenState,
  launchLabTradeParams,
  loadTokenState,
  MAINNET_SLOTS_PER_EPOCH,
  PUMP_AMM_FEE_CONFIG,
  PUMP_AMM_GLOBAL_CONFIG,
  PUMP_FEE_CONFIG,
  PUMP_GLOBAL,
  PUMP_PROGRAM_ID,
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_MINT,
  WSOL_MINT,
} from "@zerofee/core";
import type {
  CpmmTradeContext,
  CurveTradeContext,
  LaunchLabTradeContext,
  PoolTradeContext,
  ProgramAccountsResponse,
  TxSubmitResponse,
} from "@zerofee/protocol";
import { createSignerPolicy, decodeTransaction, type FirewallContext, type TradeExpectation } from "@zerofee/signer";
import { CURVE_MINT, fixture, POOL } from "../../../../../packages/core/test/fixtures";
import snapshot from "../../../../../packages/core/test/fixtures/mainnet-accounts.json";
import { jupiterCase, jupiterFetch, jupiterRpc, type RpcAccount } from "../../../../../packages/core/test/jupiter-fixtures";
import { assemble, loadCpmmState, loadLaunchLabState, planFor } from "../../../../../packages/signer/test/helpers/engine";
import { makeActors } from "../../../../../packages/signer/test/helpers/fixtures";
import { expectAllowed } from "../../../../../packages/signer/test/helpers/scenarios";
import { RaydiumRegistry } from "../../../../server/src/accounts/raydium";
import { setLogLevel } from "../../../../server/src/log";
import { MarketState } from "../../../../server/src/market/state";
import { FakeResolver } from "../../../../server/test/helpers";
import { FixtureFetcher, raydiumGrpc } from "../../../../server/test/raydiumFixtures";
import type { ExecutionSettings, TradeProgress } from "../tradeService";
import { setApiFetch } from "./api";
import { firstSignature, toBase64 } from "./bytes";
import { wireChain, wireToken } from "./fixtures";
import { LiveDataSource } from "./LiveDataSource";
import { LiveTradeService, tradeInstructionIndexes, verifiedLookupTables } from "./LiveTradeService";
import { planLanding } from "./landingFees";
import { ProgramAccounts } from "./programs";
import { CPMM, cpmmContext, cpmmMint, LL, launchLabContext, launchLabMint } from "./raydiumTestkit";
import { signerConfigFromSettings } from "./signerConfig";
import { SignerHost } from "./signerHost";
import { type FakeSocket, inProcessSignerFactory, ManualClock, socketFactory } from "./testkit";
import type { TradeContexts, TradeInputs } from "./tradeContexts";
import { hasLocalBuilder, NoLocalBuildError, TradeStateError, tokenStateFromContext, venueFeeBps } from "./tradeState";
import type { ConnectedSession } from "./walletStandard";

setDefaultTimeout(30_000);

const PASSWORD = "correct horse battery staple";
const CONNECTED = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const SETTINGS: ExecutionSettings = { slippagePct: 15, priorityFeeSol: 0.001, tipSol: 0.0001, landing: "reduced" };

// ---------------------------------------------------------------------------------------------
// Server-shaped inputs from core's mainnet snapshots
// ---------------------------------------------------------------------------------------------

function programAccounts(): ProgramAccountsResponse {
  const accounts: ProgramAccountsResponse["accounts"] = {};
  for (const a of [PUMP_GLOBAL, PUMP_FEE_CONFIG, PUMP_AMM_GLOBAL_CONFIG, PUMP_AMM_FEE_CONFIG]) {
    const f = fixture(a);
    accounts[a] = { owner: f.owner, lamports: f.lamports.toString(), data: toBase64(f.data) };
  }
  return { slot: 1, fetchedAt: 1, accounts };
}

async function curveContext(): Promise<CurveTradeContext> {
  const pda = await bondingCurvePda(CURVE_MINT);
  const curve = decodeBondingCurve(fixture(pda).data);
  const m = fixture(CURVE_MINT);
  const mint = decodeMint(m.data, m.owner);
  return {
    venue: "pump",
    mint: CURVE_MINT,
    tokenProgram: m.owner,
    decimals: mint.decimals,
    supply: mint.supply.toString(),
    quoteMint: WSOL_MINT,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
    quoteDecimals: 9,
    isMayhemMode: curve.isMayhemMode,
    isCashbackCoin: curve.isCashbackCoin,
    isHolderReward: curve.isHolderReward,
    creatorFeeBps: curve.creatorFeeBps.toString(),
    slot: 1,
    updatedAt: 1,
    bondingCurve: pda,
    virtualTokenReserves: curve.virtualTokenReserves.toString(),
    virtualQuoteReserves: curve.virtualQuoteReserves.toString(),
    realTokenReserves: curve.realTokenReserves.toString(),
    realQuoteReserves: curve.realQuoteReserves.toString(),
    tokenTotalSupply: curve.tokenTotalSupply.toString(),
    complete: curve.complete,
    creator: curve.creator,
    creatorVault: curve.creator,
    migrated: false,
    pool: null,
  };
}

function poolContext(): PoolTradeContext {
  const pool = decodePool(fixture(POOL).data);
  const m = fixture(pool.baseMint);
  const mint = decodeMint(m.data, m.owner);
  const amount = (a: string) => new DataView(fixture(a).data.buffer, fixture(a).data.byteOffset).getBigUint64(64, true);
  return {
    venue: "pumpswap",
    mint: pool.baseMint,
    tokenProgram: m.owner,
    decimals: mint.decimals,
    supply: mint.supply.toString(),
    quoteMint: pool.quoteMint,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
    quoteDecimals: 9,
    isMayhemMode: pool.isMayhemMode,
    isCashbackCoin: pool.isCashbackCoin,
    isHolderReward: pool.isHolderReward,
    creatorFeeBps: pool.creatorFeeBps.toString(),
    slot: 1,
    updatedAt: 1,
    pool: POOL,
    poolIndex: pool.index,
    poolCreator: pool.creator,
    isCanonical: true,
    lpMint: pool.lpMint,
    lpSupply: pool.lpSupply.toString(),
    poolBaseTokenAccount: pool.poolBaseTokenAccount,
    poolQuoteTokenAccount: pool.poolQuoteTokenAccount,
    baseReserve: amount(pool.poolBaseTokenAccount).toString(),
    quoteVaultReserve: amount(pool.poolQuoteTokenAccount).toString(),
    virtualQuoteReserves: pool.virtualQuoteReserves.toString(),
    coinCreator: pool.coinCreator,
    coinCreatorVaultAuthority: pool.coinCreator,
    canEditCreatorFee: pool.canEditCreatorFee,
    poolDataLength: pool.dataLength,
  };
}

/** Every snapshot account (plus a wSOL mint) behind core's own loadTokenState. */
function snapshotRpc(user: Address, extra: Record<string, RpcAccount> = {}) {
  const wsolMint = new Uint8Array(82);
  wsolMint[44] = 9;
  wsolMint[45] = 1;
  const accounts: Record<string, RpcAccount> = { [WSOL_MINT]: { owner: TOKEN_PROGRAM_ID, data: wsolMint } };
  for (const a of Object.keys(snapshot.accounts)) {
    const f = fixture(a);
    accounts[a] = { owner: f.owner, lamports: f.lamports, data: f.data };
  }
  return { accounts, rpc: (more: Record<string, RpcAccount>) => jupiterRpc(user, { ...accounts, ...more, ...extra }) };
}

// ---------------------------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------------------------

let ds: LiveDataSource;
let s: FakeSocket;
let host: SignerHost;
let stopSigner: () => void;
let wallet: string;

beforeEach(async () => {
  setApiFetch(async () => new Response(JSON.stringify({ error: "nope", code: "not_found" }), { status: 404 }));
  const f = socketFactory();
  ds = new LiveDataSource({
    socket: { url: "ws://gw.test/ws", createSocket: f.create, clock: new ManualClock(), random: () => 1 },
    healthPollMs: 0,
  });
  s = f.last();
  s.open();
  s.snapshot("chain", 1, wireChain());
  const signer = inProcessSignerFactory();
  stopSigner = signer.stopAll;
  host = new SignerHost(signer.factory);
  host.configure(signerConfigFromSettings({ perTradeSol: 1, dailySol: 5, autoLockMinutes: 15 }));
  await host.rpc.call("createVault", { password: PASSWORD, connectedWallet: CONNECTED });
  wallet = (await host.rpc.call("addWallet", { label: "Main" })).address;
});

afterEach(() => {
  host.stop();
  stopSigner();
  ds.close();
  setApiFetch(null);
});

interface Harness {
  svc: LiveTradeService;
  submitted: Uint8Array[];
  /** Jupiter `/build` requests the fallback made. */
  jupiterRequests: { url: string }[];
  signCalls: {
    addressLookupTables?: unknown;
    expectations?: readonly { instruction: number; expectedOut: bigint; slippageBps: number }[];
  }[];
}

function harness(
  inputs: TradeInputs,
  o: { simErr?: unknown; session?: ConnectedSession; tables?: Record<string, string[]> } = {},
): Harness {
  const submitted: Uint8Array[] = [];
  const jupiter = jupiterFetch();
  const signCalls: Harness["signCalls"] = [];
  const contexts = { get: async () => inputs, close: () => {} } as unknown as TradeContexts;
  const svc = new LiveTradeService({
    data: ds,
    signer: {
      rpc: {
        call: async (method, params) => {
          signCalls.push(params);
          return host.rpc.call(method, params);
        },
      },
    },
    wallet: { connectedSession: () => o.session ?? null, touch: () => {} },
    programs: new ProgramAccounts(async () => programAccounts()),
    contexts,
    jupiter: { fetchFn: jupiter.fetch },
    lookupTables: async (keys) => ({
      slot: 1,
      tables: Object.fromEntries(
        keys.map((k) => [k, o.tables?.[k] ? { addresses: o.tables[k], active: true, lastExtendedSlot: 1 } : null]),
      ),
    }),
    submit: async (wire, preset) => {
      submitted.push(wire);
      const res: TxSubmitResponse = {
        signature: firstSignature(wire) ?? "",
        dryRun: true,
        preset,
        lanes: [],
        simulation: {
          err: o.simErr ?? null,
          logs: o.simErr ? ["Program log: Error: insufficient lamports"] : [],
          unitsConsumed: 61_000,
          slot: 999,
        },
        receivedAt: Date.now(),
      };
      return res;
    },
  });
  return { svc, submitted, signCalls, jupiterRequests: jupiter.requests };
}

function request(mint: string, extra: Record<string, unknown> = {}) {
  return {
    clientId: "t1",
    mint,
    wallet,
    settings: SETTINGS,
    mode: "instant" as const,
    source: "token" as const,
    clickedAt: Date.now(),
    expectedPriceSol: null,
    ...extra,
  };
}

// ---------------------------------------------------------------------------------------------

describe("trade state from the server's context", () => {
  test("a curve context quotes exactly like core's own loadTokenState over the same accounts", async () => {
    const ctx = await curveContext();
    const programs = await new ProgramAccounts(async () => programAccounts()).get();
    const user = wallet as Address;
    const ours = await tokenStateFromContext(ctx, programs, { user, balance: null });
    const coreState = await loadTokenState(snapshotRpc(user).rpc({}), { mint: CURVE_MINT, user });
    expect(coreState.venue).toBe("pump");
    const req = { side: "buy" as const, amount: 100_000_000n, slippageBps: 1500 };
    const a = await buildTrade(ours, req);
    const b = await buildTrade(coreState, req);
    expect(a.quote).toEqual(b.quote);
    expect(a.instructions.map((ix) => ix.programAddress)).toEqual(b.instructions.map((ix) => ix.programAddress));
    // The fee the token page shows is the quote's total rate.
    const bps = venueFeeBps(ctx, programs);
    expect(bps).toBe(Number((a.quote.feePpm.protocol + a.quote.feePpm.creator) / 100n));
    expect(venueFeeBps(ctx, null)).toBeNull();
  });

  test("a pool context quotes like core and is canonical by derivation", async () => {
    const ctx = poolContext();
    const programs = await new ProgramAccounts(async () => programAccounts()).get();
    const user = wallet as Address;
    const ours = await tokenStateFromContext(ctx, programs, { user, balance: null });
    expect(ours.venue).toBe("pumpswap");
    if (ours.venue !== "pumpswap") return;
    expect(ours.isCanonical).toBe(await isCanonicalPumpPool(ours.pool));
    const coreState = await loadTokenState(snapshotRpc(user).rpc({}), { mint: ctx.mint as Address, user, poolAddress: POOL });
    const req = { side: "buy" as const, amount: 50_000_000n, slippageBps: 500 };
    expect((await buildTrade(ours, req)).quote).toEqual((await buildTrade(coreState, req)).quote);
  });
});

describe("landing fees", () => {
  test("lane tips, urgency percentiles and the preset's priority budget", () => {
    const chain = wireChain();
    const reduced = planLanding({ landing: "reduced", cuLimit: 150_000, chain, priorityFeeSol: 0.001, tipSol: 0 });
    expect(reduced.tips).toEqual([{ lane: "helius", lamports: 5_000n }]);
    expect(reduced.cuPriceMicroLamports).toBe(50_000n); // p75, under the 0.001 SOL budget
    expect(reduced.jitoDontFront).toBe(false);
    const secure = planLanding({ landing: "secure", cuLimit: 150_000, chain, priorityFeeSol: 0.001, tipSol: 0.0001 });
    expect(secure.tips).toEqual([{ lane: "jito", lamports: 100_000n }]);
    expect(secure.cuPriceMicroLamports).toBe(10_000n);
    expect(secure.jitoDontFront).toBe(true);
    const fast = planLanding({ landing: "fast", cuLimit: 150_000, chain, priorityFeeSol: 0.000001, tipSol: 0.0001 });
    expect(fast.tips).toEqual([{ lane: "helius", lamports: 1_000_000n }]);
    expect(fast.priorityFeeLamports).toBeLessThanOrEqual(1_000n); // held to the preset
    expect(fast.notes).toContain("priority fee held to your preset");
    const capped = planLanding({ landing: "reduced", cuLimit: 150_000, chain: null, priorityFeeSol: 1, tipSol: 1 });
    expect(capped.tips[0]?.lamports).toBe(10_000_000n); // the signer's tip cap
    expect(capped.cuPriceMicroLamports).toBe(1n); // no estimate: Sender's floor
  });
});

describe("instant trades through the signer worker (dry run)", () => {
  test("pump buy: built, signed with expectations, simulated; stages in order", async () => {
    const ctx = await curveContext();
    const h = harness({ ctx, token: wireToken({ mint: ctx.mint }) });
    const stages: TradeProgress[] = [];
    const r = await h.svc.buy({ ...request(ctx.mint), solAmount: 0.1 }, (p) => stages.push(p));
    expect(r.error).toBeNull();
    expect(r.status).toBe("confirmed");
    expect(r.simulated).toBe(true);
    expect(stages.map((p) => p.stage)).toEqual(["built", "signed", "received", "sent", "landed"]);
    for (let i = 1; i < stages.length; i++) expect(stages[i]?.atMs).toBeGreaterThanOrEqual(stages[i - 1]?.atMs ?? 0);
    expect(r.signature).toBe(firstSignature(h.submitted[0] as Uint8Array));
    expect(r.latency.slot).toBe(999);
    expect(r.fill?.solAmount).toBeCloseTo(0.1, 9);
    expect(r.fill?.tokenAmount).toBeGreaterThan(0);
    expect(r.fill?.fees.tipSol).toBeCloseTo(0.0001, 9);
    // The browser's own quote went to the firewall for the pump instruction.
    const call = h.signCalls[0];
    expect(call?.expectations).toHaveLength(1);
    expect(call?.expectations?.[0]?.slippageBps).toBe(1500);
    expect(call?.expectations?.[0]?.instruction).toBeGreaterThanOrEqual(2);
  });

  test("pump sell of half the balance held in the ATA", async () => {
    const ctx = await curveContext();
    const ata = await findAssociatedTokenAddress(wallet as Address, CURVE_MINT, ctx.tokenProgram as Address);
    ds.subscribe(`wallet:${wallet}`, () => {});
    s.snapshot(`wallet:${wallet}`, 1, {
      address: wallet,
      lamports: "2000000000",
      tokens: [{ mint: CURVE_MINT, account: ata, amount: "2000000000", decimals: 6, tokenProgram: ctx.tokenProgram }],
      fills: [],
      slot: 1,
    });
    const h = harness({ ctx, token: wireToken({ mint: ctx.mint }) });
    const r = await h.svc.sell({ ...request(ctx.mint), pct: 50 });
    expect(r.error).toBeNull();
    expect(r.status).toBe("confirmed");
    expect(r.fill?.tokenAmount).toBe(1_000);
    expect(r.fill?.solAmount).toBeGreaterThan(0);
  });

  test("a sell with nothing in the ATA fails before signing", async () => {
    const ctx = await curveContext();
    const h = harness({ ctx, token: wireToken({ mint: ctx.mint }) });
    const r = await h.svc.sell({ ...request(ctx.mint), pct: 100 });
    expect(r.status).toBe("failed");
    expect(r.error).toContain("Nothing to sell");
    expect(h.signCalls).toHaveLength(0);
  });

  test("PumpSwap buy passes the firewall", async () => {
    const ctx = poolContext();
    const h = harness({ ctx, token: wireToken({ mint: ctx.mint }) });
    const r = await h.svc.buy({ ...request(ctx.mint), solAmount: 0.05 });
    expect(r.error).toBeNull();
    expect(r.status).toBe("confirmed");
  });

  test("a failed simulation is a failed, simulated receipt with the reason", async () => {
    const ctx = await curveContext();
    const h = harness({ ctx, token: wireToken({ mint: ctx.mint }) }, { simErr: { InstructionError: [2, { Custom: 1 }] } });
    const r = await h.svc.buy({ ...request(ctx.mint), solAmount: 0.1 });
    expect(r.status).toBe("failed");
    expect(r.simulated).toBe(true);
    expect(r.error).toContain("Simulation failed");
  });

  test("the kill switch refuses before building", async () => {
    s.delta("chain", 2, { halt: { halted: true, reason: "maintenance", since: 1 } });
    const ctx = await curveContext();
    const h = harness({ ctx, token: wireToken({ mint: ctx.mint }) });
    const r = await h.svc.buy({ ...request(ctx.mint), solAmount: 0.1 });
    expect(r.status).toBe("failed");
    expect(r.error).toBe("Trading is halted: maintenance");
    expect(h.submitted).toHaveLength(0);
  });

  test("copy buys: never priced above maxPriceSol (refused when the quote is past it; min-out raised to it)", async () => {
    const ctx = await curveContext();
    const h = harness({ ctx, token: wireToken({ mint: ctx.mint }) });
    const price = Number(BigInt(ctx.virtualQuoteReserves)) / 1e9 / (Number(BigInt(ctx.virtualTokenReserves)) / 1e6);
    const refused = await h.svc.buy({ ...request(ctx.mint), solAmount: 0.1, maxPriceSol: price * 0.5 });
    expect(refused.status).toBe("failed");
    expect(refused.error).toContain("Price moved");
    expect(h.signCalls).toHaveLength(0);
    // Just above the current price (fees included): slippage tightened so min-out >= spend / maxPrice.
    const limit = price * 1.03;
    const ok = await h.svc.buy({ ...request(ctx.mint), solAmount: 0.1, maxPriceSol: limit });
    expect(ok.error).toBeNull();
    const exp = h.signCalls[0]?.expectations?.[0];
    expect(exp?.slippageBps).toBeLessThan(1500);
    const minOut = ((exp?.expectedOut ?? 0n) * BigInt(10_000 - (exp?.slippageBps ?? 0))) / 10_000n;
    expect(Number(minOut) / 1e6).toBeGreaterThanOrEqual((0.1 / limit) * 0.9999);
  });

  test("a buy over the per-trade cap is refused by the signer firewall", async () => {
    const ctx = await curveContext();
    const h = harness({ ctx, token: wireToken({ mint: ctx.mint }) });
    const r = await h.svc.buy({ ...request(ctx.mint), solAmount: 1.5 });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/signer/i);
    expect(h.submitted).toHaveLength(0);
  });
});

describe("Jupiter fallback (direct mode, captured /build)", () => {
  const c = jupiterCase("longtail2022Buy");
  const claimed = (c.response.addressesByLookupTableAddress ?? {}) as Record<string, string[]>;
  const session = (): { session: ConnectedSession; signed: Uint8Array[] } => {
    const signed: Uint8Array[] = [];
    const sessionLike = {
      address: c.request.taker,
      signTransaction: async (wire: Uint8Array) => {
        signed.push(wire);
        const out = wire.slice();
        out.fill(7, 1, 65);
        return out;
      },
    };
    return { session: sessionLike as unknown as ConnectedSession, signed };
  };
  const token = () => wireToken({ mint: c.request.outputMint, tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", decimals: 6 });

  test("no trade context: core's /build route, lookup tables verified on chain, route shown", async () => {
    const { session: conn, signed } = session();
    const h = harness({ ctx: null, token: token() }, { session: conn, tables: claimed });
    const settings = { ...SETTINGS, slippagePct: c.request.slippageBps / 100 };
    const r = await h.svc.buy({
      ...request(c.request.outputMint, { mode: "direct", settings }),
      solAmount: Number(c.request.amount) / 1e9,
    });
    expect(r.error).toBeNull();
    expect(r.status).toBe("confirmed");
    expect(r.route).toEqual(["Meteora DAMM v2"]);
    expect(signed).toHaveLength(1);
    expect(ds.route(c.request.outputMint)?.labels).toEqual(["Meteora DAMM v2"]);
  });

  test("Jupiter's table contents must match the chain", async () => {
    const [table, list] = Object.entries(claimed)[0] as [string, string[]];
    const tampered = { [table]: [...list.slice(0, -1), CONNECTED] };
    const { session: conn, signed } = session();
    const h = harness({ ctx: null, token: token() }, { session: conn, tables: tampered });
    const settings = { ...SETTINGS, slippagePct: c.request.slippageBps / 100 };
    const r = await h.svc.buy({
      ...request(c.request.outputMint, { mode: "direct", settings }),
      solAmount: Number(c.request.amount) / 1e9,
    });
    expect(r.status).toBe("failed");
    expect(r.error).toContain("doesn't match the chain");
    expect(signed).toHaveLength(0);
    expect(() => verifiedLookupTables({ [table]: list as Address[] }, { slot: 1, tables: { [table]: null } })).toThrow("not on chain");
  });
});

test("trade instruction positions skip PumpSwap's extend_account", () => {
  const ix = (programAddress: string, data: number[] = [1]) => ({ programAddress: programAddress as Address, data: new Uint8Array(data) });
  expect(tradeInstructionIndexes([ix(TOKEN_PROGRAM_ID), ix(PUMP_PROGRAM_ID)])).toEqual([1]);
});

// ---------------------------------------------------------------------------------------------
// Raydium LaunchLab and CPMM: contexts shaped like the server's, from core's Raydium mainnet snapshot
// ---------------------------------------------------------------------------------------------

/** Base units the wallet holds in the Raydium tests. */
const RAY_BALANCE = 3_000_000_000_000n;
const LAUNCHLAB_VENUE = "Raydium LaunchLab";
const CPMM_VENUE = "Raydium CPMM";

interface RaydiumCase {
  name: string;
  context: () => Promise<LaunchLabTradeContext | CpmmTradeContext>;
  /** core's own state from the same snapshot accounts (loadTokenState through packages/signer's engine helpers). */
  core: (user: Address, baseBalance: bigint) => Promise<LaunchLabState | CpmmState>;
  /** The coin carries a Token-2022 transfer fee. */
  transferFee: boolean;
}

const RAYDIUM_CASES: RaydiumCase[] = [
  {
    name: "LaunchLab letsbonk.fun curve (SPL)",
    context: () => launchLabContext(LL.bonk),
    core: (user, baseBalance) => loadLaunchLabState({ user, baseBalance }, launchLabMint(LL.bonk)),
    transferFee: false,
  },
  {
    name: "LaunchLab StonkFun curve (Token-2022, 3% transfer fee)",
    context: () => launchLabContext(LL.stonkFee),
    core: (user, baseBalance) => loadLaunchLabState({ user, baseBalance }, launchLabMint(LL.stonkFee)),
    transferFee: true,
  },
  {
    name: "LaunchLab TRiX curve (creator fee)",
    context: () => launchLabContext(LL.trix),
    core: (user, baseBalance) => loadLaunchLabState({ user, baseBalance }, launchLabMint(LL.trix)),
    transferFee: false,
  },
  {
    name: "CPMM pool of a graduated letsbonk.fun coin",
    context: async () => cpmmContext(CPMM.bonk, LL.graduated),
    core: (user, baseBalance) => loadCpmmState({ user, baseBalance }, cpmmMint(CPMM.bonk)),
    transferFee: false,
  },
  {
    name: "CPMM pool of a graduated StonkFun coin (3% transfer fee)",
    context: async () => cpmmContext(CPMM.stonk),
    core: (user, baseBalance) => loadCpmmState({ user, baseBalance }, cpmmMint(CPMM.stonk), CPMM.stonk),
    transferFee: true,
  },
];

const feeOf = (info: LocalTokenState["mintInfo"]) => {
  const f = info.extensions.transferFeeConfig;
  return f ? { older: f.olderTransferFee, newer: f.newerTransferFee } : null;
};

/** Everything core's quotes and builders read from a Raydium state (core's decoders also fill fields they never read). */
function readFields(s: LaunchLabState | CpmmState) {
  const common = {
    venue: s.venue,
    mint: s.mint,
    supply: s.mintInfo.supply,
    decimals: s.mintInfo.decimals,
    tokenProgram: s.mintInfo.tokenProgram,
    baseTransferFee: feeOf(s.mintInfo),
    user: s.user,
    userBaseAta: s.userBaseAta,
    userBaseBalance: s.userBaseBalance,
    quoteMint: s.quoteMint,
    quoteTokenProgram: s.quoteTokenProgram,
    quoteDecimals: s.quoteDecimals,
    quoteMintInfo: { decimals: s.quoteMintInfo.decimals, tokenProgram: s.quoteMintInfo.tokenProgram, fee: feeOf(s.quoteMintInfo) },
    epoch: s.clock.epoch,
    poolAddress: s.poolAddress,
  };
  if (s.venue === "launchlab") {
    const p = s.pool;
    return {
      ...common,
      pool: {
        status: p.status,
        migrateType: p.migrateType,
        baseDecimals: p.baseDecimals,
        quoteDecimals: p.quoteDecimals,
        virtualBase: p.virtualBase,
        virtualQuote: p.virtualQuote,
        realBase: p.realBase,
        realQuote: p.realQuote,
        totalBaseSell: p.totalBaseSell,
        totalQuoteFundRaising: p.totalQuoteFundRaising,
        globalConfig: p.globalConfig,
        platformConfig: p.platformConfig,
        baseMint: p.baseMint,
        quoteMint: p.quoteMint,
        baseVault: p.baseVault,
        quoteVault: p.quoteVault,
        creator: p.creator,
        tokenProgramFlag: p.tokenProgramFlag,
      },
      params: launchLabTradeParams({ globalConfig: s.globalConfig, platformConfig: s.platformConfig }),
      platform: { name: s.platformConfig.name, cpswapConfig: s.platformConfig.cpswapConfig, cpCreator: s.platformConfig.platformCpCreator },
    };
  }
  const p = s.pool;
  return {
    ...common,
    pool: {
      ammConfig: p.ammConfig,
      poolCreator: p.poolCreator,
      token0Vault: p.token0Vault,
      token1Vault: p.token1Vault,
      lpMint: p.lpMint,
      token0Mint: p.token0Mint,
      token1Mint: p.token1Mint,
      token0Program: p.token0Program,
      token1Program: p.token1Program,
      observationKey: p.observationKey,
      status: p.status,
      mint0Decimals: p.mint0Decimals,
      mint1Decimals: p.mint1Decimals,
      openTime: p.openTime,
      creatorFeeOn: p.creatorFeeOn,
      enableCreatorFee: p.enableCreatorFee,
    },
    // What the swap math prices with: the vaults net of the fees the pool owes.
    reserves: cpmmVaultAmountsWithoutFees(p, s.vault0Amount, s.vault1Amount),
    rates: cpmmFeeRates(s.ammConfig, s.pool),
    launchLabPool: s.launchLabPool ?? null,
  };
}

/** Ours from the context, core's from the accounts, for the same wallet and balance and the same Clock. */
async function raydiumPair(c: RaydiumCase, user: Address) {
  const ctx = await c.context();
  const core = await c.core(user, RAY_BALANCE);
  const ours = await tokenStateFromContext(
    ctx,
    null,
    { user, balance: { amount: RAY_BALANCE, account: core.userBaseAta } },
    { slot: Number(core.clock.slot), nowMs: Number(core.clock.unixTimestamp) * 1000 },
  );
  if (ours.venue !== "launchlab" && ours.venue !== "cpmm") throw new Error(`built a ${ours.venue} state`);
  return { ctx, core, ours };
}

/** The trade closes the wallet's base token account (CloseAccount, SPL Token / Token-2022 instruction 9). */
function closesBaseAccount(trade: BuiltTrade, s: LocalTokenState): boolean {
  return trade.instructions.some(
    (ix) => ix.programAddress === s.mintInfo.tokenProgram && ix.data?.[0] === 9 && ix.accounts?.[0]?.address === s.userBaseAta,
  );
}

async function errorOf(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
}

describe("Raydium: trade state from the server's context", () => {
  for (const c of RAYDIUM_CASES) {
    test(`${c.name}: the state matches core's decoders, quotes and builds exactly like core`, async () => {
      const user = wallet as Address;
      const { ctx, core, ours } = await raydiumPair(c, user);
      expect(readFields(ours)).toEqual(readFields(core));
      expect(ours.mintInfo.extensions.transferFeeConfig !== null).toBe(c.transferFee);
      for (const req of [
        { side: "buy" as const, amount: 100_000_000n, slippageBps: 1500 },
        { side: "sell" as const, amount: RAY_BALANCE / 3n, slippageBps: 500 },
      ]) {
        const a = await buildTrade(ours, req);
        const b = await buildTrade(core, req);
        expect(a.quote).toEqual(b.quote);
        expect(a.instructions).toEqual(b.instructions);
        expect(a.defaultCuLimit).toBe(b.defaultCuLimit);
        expect(a.hotAccount).toBe(b.hotAccount);
      }
      // A full exit: same quote; the token account is closed unless it may hold withheld transfer fees (the
      // feed does not stream them; core's fixture account holds none, so core closes it).
      const exit = { side: "sell" as const, amount: RAY_BALANCE, slippageBps: 500 };
      const a = await buildTrade(ours, exit);
      const b = await buildTrade(core, exit);
      expect(a.quote).toEqual(b.quote);
      expect(closesBaseAccount(b, core)).toBe(true);
      expect(closesBaseAccount(a, ours)).toBe(!c.transferFee);
      if (!c.transferFee) expect(a.instructions).toEqual(b.instructions);

      // The fee the token page shows is the venue's total rate, from core's own fee helpers.
      const bps = venueFeeBps(ctx, null);
      if (core.venue === "launchlab") {
        const p = launchLabTradeParams({ globalConfig: core.globalConfig, platformConfig: core.platformConfig });
        expect(bps).toBe(Number(p.protocolFeeRate + p.platformFeeRate + p.creatorFeeRate) / 100);
        const q = (await buildTrade(core, { side: "buy", amount: 100_000_000n, slippageBps: 100 })).quote;
        expect(bps).toBe(Number(q.feePpm.protocol + q.feePpm.platform + q.feePpm.creator) / 100);
      } else {
        const r = cpmmFeeRates(core.ammConfig, core.pool);
        expect(bps).toBe(Number(r.tradeFeeRate + r.creatorFeeRate) / 100);
      }
      expect(bps).toBeGreaterThan(0);
    });
  }

  test("only SOL-quoted coins on the four local venues build in the browser", async () => {
    const ll = await launchLabContext(LL.bonk);
    const cp = cpmmContext(CPMM.bonk);
    expect(hasLocalBuilder(ll)).toBe(true);
    expect(hasLocalBuilder(cp)).toBe(true);
    expect(hasLocalBuilder(await curveContext())).toBe(true);
    expect(hasLocalBuilder(poolContext())).toBe(true);
    // USDC and xStock pairs keep the Jupiter fallback for now.
    expect(hasLocalBuilder({ ...ll, quoteMint: USDC_MINT })).toBe(false);
    expect(hasLocalBuilder(await launchLabContext(LL.stonkXstock))).toBe(false);
  });

  test("an account still missing from the context is a NoLocalBuildError; an inconsistent one is refused", async () => {
    const u = { user: wallet as Address, balance: null };
    const ll = await launchLabContext(LL.bonk);
    for (const field of ["globalConfig", "platformConfig", "baseVault", "quoteVault", "creator", "pool"] as const) {
      const e = await errorOf(tokenStateFromContext({ ...ll, [field]: "" }, null, u));
      expect(e).toBeInstanceOf(NoLocalBuildError);
      expect(e.message).toContain("has not read");
    }
    const cp = cpmmContext(CPMM.bonk);
    for (const field of ["ammConfig", "token0Vault", "token1Vault", "observation", "token0Program", "poolCreator"] as const) {
      expect(await errorOf(tokenStateFromContext({ ...cp, [field]: "" }, null, u))).toBeInstanceOf(NoLocalBuildError);
    }
    // Not missing but wrong: refused outright (no Jupiter fallback hides a bad context).
    const wrongPool = await errorOf(tokenStateFromContext({ ...ll, pool: LL.trix }, null, u));
    expect(wrongPool).toBeInstanceOf(TradeStateError);
    expect(wrongPool).not.toBeInstanceOf(NoLocalBuildError);
    expect(wrongPool.message).toContain("is not the LaunchLab pool");
    const flag = await errorOf(tokenStateFromContext({ ...ll, tokenProgramFlag: 1 }, null, u));
    expect(flag.message).toContain("token_program_flag");
    const vaults = await errorOf(tokenStateFromContext({ ...cp, token0Vault: cp.token1Vault, token1Vault: cp.token0Vault }, null, u));
    expect(vaults).not.toBeInstanceOf(NoLocalBuildError);
    expect(vaults.message).toContain("not its PDAs");
    const other = await errorOf(tokenStateFromContext({ ...cp, mint: launchLabMint(LL.bonk) }, null, u));
    expect(other.message).toContain("does not trade this coin");
    // A completed curve waits for Raydium's migration: refused for trades, available to migration orders.
    const complete = await errorOf(tokenStateFromContext({ ...ll, status: 1 }, null, u));
    expect(complete).not.toBeInstanceOf(NoLocalBuildError);
    expect(complete.message).toContain("complete");
    expect((await tokenStateFromContext({ ...ll, status: 1 }, null, u, {}, { allowCompleteCurve: true })).venue).toBe("launchlab");
    expect(await errorOf(tokenStateFromContext({ ...ll, status: 2 }, null, u))).toBeInstanceOf(NoLocalBuildError);
  });

  test("the transfer-fee epoch follows the chain once it moves past the context's", async () => {
    const ctx = await launchLabContext(LL.stonkFee);
    const u = { user: wallet as Address, balance: null };
    const at = await tokenStateFromContext(ctx, null, u, { slot: ctx.slot });
    expect(at.clock?.epoch).toBe(BigInt(ctx.epoch));
    const next = (BigInt(ctx.epoch) + 1n) * MAINNET_SLOTS_PER_EPOCH;
    const later = await tokenStateFromContext(ctx, null, u, { slot: Number(next) });
    expect(later.clock?.epoch).toBe(BigInt(ctx.epoch) + 1n);
    // An older chain view never moves it back.
    expect((await tokenStateFromContext(ctx, null, u, { slot: 1 })).clock?.epoch).toBe(BigInt(ctx.epoch));
  });
});

describe("Raydium: instant trades through the signer worker (dry run)", () => {
  async function hold(ctx: LaunchLabTradeContext | CpmmTradeContext, amount: bigint): Promise<void> {
    const ata = await findAssociatedTokenAddress(wallet as Address, ctx.mint as Address, ctx.tokenProgram as Address);
    ds.subscribe(`wallet:${wallet}`, () => {});
    s.snapshot(`wallet:${wallet}`, 1, {
      address: wallet,
      lamports: "2000000000",
      tokens: [{ mint: ctx.mint, account: ata, amount: amount.toString(), decimals: ctx.decimals, tokenProgram: ctx.tokenProgram }],
      fills: [],
      slot: 1,
    });
  }

  /** The program of the signed transaction's trade instruction, and whether it closes the base ATA. */
  async function signedShape(wire: Uint8Array, ctx: LaunchLabTradeContext | CpmmTradeContext) {
    const decoded = decodeTransaction(wire);
    if (!decoded.ok) throw new Error(decoded.violations.join("; "));
    const ata = await findAssociatedTokenAddress(wallet as Address, ctx.mint as Address, ctx.tokenProgram as Address);
    const ixs = decoded.tx.instructions;
    return {
      programs: ixs.map((ix) => ix.programAddress),
      closesBase: ixs.some((ix) => ix.programAddress === ctx.tokenProgram && ix.data[0] === 9 && ix.accounts[0]?.address === ata),
    };
  }

  test("LaunchLab buy: built in the browser (no Jupiter), signed with the browser's quote as the expectation", async () => {
    const ctx = await launchLabContext(LL.bonk);
    const h = harness({ ctx, token: wireToken({ mint: ctx.mint }) });
    const r = await h.svc.buy({ ...request(ctx.mint), solAmount: 0.1 });
    expect(r.error).toBeNull();
    expect(r.status).toBe("confirmed");
    expect(r.simulated).toBe(true);
    expect(r.route).toBeUndefined();
    expect(h.jupiterRequests).toHaveLength(0);
    expect(r.fill?.solAmount).toBeCloseTo(0.1, 9);
    expect(r.fill?.tokenAmount).toBeGreaterThan(0);
    expect(r.fill?.fees.venueSol).toBeGreaterThan(0);
    const exp = h.signCalls[0]?.expectations;
    expect(exp).toHaveLength(1);
    expect(exp?.[0]?.slippageBps).toBe(1500);
    // The expected out the firewall checked is core's quote over the same state.
    const state = await tokenStateFromContext(ctx, null, { user: wallet as Address, balance: null });
    const q = (await buildTrade(state, { side: "buy", amount: 100_000_000n, slippageBps: 1500 })).quote;
    expect(exp?.[0]?.expectedOut).toBe(q.expectedOut);
    expect(r.fill?.tokenAmount).toBeCloseTo(Number(q.expectedOut) / 10 ** ctx.decimals, 6);
    expect((await signedShape(h.submitted[0] as Uint8Array, ctx)).programs).toContain(RAYDIUM_LAUNCHLAB_PROGRAM_ID);
  });

  test("LaunchLab sell of all of a Token-2022 coin with a transfer fee: the token account is kept", async () => {
    const ctx = await launchLabContext(LL.stonkFee);
    expect(ctx.tokenProgram).toBe(TOKEN_2022_PROGRAM_ID);
    await hold(ctx, RAY_BALANCE);
    const h = harness({ ctx, token: wireToken({ mint: ctx.mint }) });
    const r = await h.svc.sell({ ...request(ctx.mint), pct: 100 });
    expect(r.error).toBeNull();
    expect(r.status).toBe("confirmed");
    expect(r.fill?.tokenAmount).toBe(Number(RAY_BALANCE) / 10 ** ctx.decimals);
    expect(r.fill?.solAmount).toBeGreaterThan(0);
    expect(await signedShape(h.submitted[0] as Uint8Array, ctx)).toMatchObject({ closesBase: false });
  });

  test("CPMM buy and full-exit sell pass the firewall (the SPL coin's token account is closed on exit)", async () => {
    const ctx = cpmmContext(CPMM.bonk, LL.graduated);
    const h = harness({ ctx, token: wireToken({ mint: ctx.mint }) });
    const buy = await h.svc.buy({ ...request(ctx.mint), solAmount: 0.05 });
    expect(buy.error).toBeNull();
    expect(buy.status).toBe("confirmed");
    expect((await signedShape(h.submitted[0] as Uint8Array, ctx)).programs).toContain(RAYDIUM_CPMM_PROGRAM_ID);
    await hold(ctx, RAY_BALANCE);
    const sell = await h.svc.sell({ ...request(ctx.mint), pct: 100 });
    expect(sell.error).toBeNull();
    expect(sell.status).toBe("confirmed");
    expect(await signedShape(h.submitted[1] as Uint8Array, ctx)).toMatchObject({ closesBase: true });
    expect(h.jupiterRequests).toHaveLength(0);
  });

  test("CPMM sell of a Token-2022 coin with a transfer fee", async () => {
    const ctx = cpmmContext(CPMM.stonk);
    await hold(ctx, RAY_BALANCE);
    const h = harness({ ctx, token: wireToken({ mint: ctx.mint }) });
    const r = await h.svc.sell({ ...request(ctx.mint), pct: 50 });
    expect(r.error).toBeNull();
    expect(r.status).toBe("confirmed");
    expect(h.signCalls[0]?.expectations).toHaveLength(1);
  });

  test("a Raydium buy over the per-trade cap is refused by the signer firewall", async () => {
    const ctx = await launchLabContext(LL.trix);
    const h = harness({ ctx, token: wireToken({ mint: ctx.mint }) });
    const r = await h.svc.buy({ ...request(ctx.mint), solAmount: 1.5 });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/signer/i);
    expect(h.submitted).toHaveLength(0);
  });

  test("the context the server's MarketState streams after a real letsbonk.fun buy trades locally", async () => {
    // apps/server's market state over the same snapshot: the bonk.fun buy, then the registry's account reads.
    setLogLevel("error");
    const fetcher = new FixtureFetcher();
    let m: MarketState | null = null;
    const raydium = new RaydiumRegistry(fetcher, {
      launchLabPool: (i) => m?.onLaunchLabPoolReady(i),
      launchLabPoolMissing: (p) => m?.onLaunchLabPoolMissing(p),
      platform: (a) => m?.onPlatformConfig(a),
      cpmmPool: (i) => m?.onCpmmPoolReady(i),
      cpmmRejected: (p) => m?.onCpmmRejected(p),
    });
    m = new MarketState(
      { sniperSlots: 3, bundleMinBuyers: 4, proTraderWallets: [] },
      { resolver: new FakeResolver(), solUsd: () => 150, now: () => 1_791_060_000_000, raydium },
    );
    m.applyTx(raydiumGrpc("bonkBuy"));
    await fetcher.flush();
    const mint = launchLabMint(LL.bonk);
    const streamed = m.tradeContext(mint);
    if (streamed?.venue !== "launchlab") throw new Error(`no LaunchLab context (${streamed?.venue})`);
    // What the socket delivers.
    const ctx = JSON.parse(JSON.stringify(streamed)) as LaunchLabTradeContext;
    // The test contexts have the server's exact shape and accounts (reserves differ: the server's are post-trade).
    const snap = await launchLabContext(LL.bonk);
    expect(Object.keys(ctx).sort()).toEqual(Object.keys(snap).sort());
    for (const k of ["pool", "globalConfig", "platformConfig", "baseVault", "quoteVault", "creator", "tokenProgramFlag"] as const) {
      expect(ctx[k]).toBe(snap[k]);
    }
    for (const k of [
      "protocolFeeRate",
      "platformFeeRate",
      "creatorFeeRate",
      "graduationPool",
      "cpswapConfig",
      "platformCpCreator",
    ] as const) {
      expect(ctx[k]).toBe(snap[k]);
    }
    expect(hasLocalBuilder(ctx)).toBe(true);
    const h = harness({ ctx, token: wireToken({ mint }) });
    const r = await h.svc.buy({ ...request(mint), solAmount: 0.1 });
    expect(r.error).toBeNull();
    expect(r.status).toBe("confirmed");
    expect(h.jupiterRequests).toHaveLength(0);
    expect(h.signCalls[0]?.expectations).toHaveLength(1);
  });

  test("a context still missing an account falls back to Jupiter", async () => {
    const ctx = { ...(await launchLabContext(LL.bonk)), platformConfig: "" };
    const h = harness({ ctx, token: wireToken({ mint: ctx.mint, tokenProgram: ctx.tokenProgram, decimals: ctx.decimals }) });
    const r = await h.svc.buy({ ...request(ctx.mint), solAmount: 0.1 });
    // The captured /build has no route for this coin: what matters is that Jupiter was asked, not the local venue.
    expect(h.jupiterRequests).toHaveLength(1);
    expect(h.jupiterRequests[0]?.url).toContain(`outputMint=${ctx.mint}`);
    expect(r.status).toBe("failed");
    expect(r.error).toContain("No Jupiter route");
    expect(h.signCalls).toHaveLength(0);
  });

  test("a USDC-quoted Raydium coin keeps the Jupiter fallback", async () => {
    const ctx = { ...cpmmContext(CPMM.bonk), quoteMint: USDC_MINT };
    const h = harness({ ctx, token: wireToken({ mint: ctx.mint, tokenProgram: ctx.tokenProgram, decimals: ctx.decimals }) });
    await h.svc.buy({ ...request(ctx.mint), solAmount: 0.1 });
    expect(h.jupiterRequests).toHaveLength(1);
    expect(h.jupiterRequests[0]?.url).toContain(`outputMint=${ctx.mint}`);
  });
});

describe("Raydium: the browser's builds pass the shipped firewall in every landing mode", () => {
  const POLICY = createSignerPolicy();
  const FEE_CAPS = { maxPriorityFeeLamports: POLICY.caps.maxPriorityFeeLamports, maxTipLamports: POLICY.caps.maxTipLamports };
  for (const c of RAYDIUM_CASES) {
    for (const side of ["buy", "sell"] as const) {
      test(`${c.name}: ${side}`, async () => {
        const a = makeActors();
        const ctx = await c.context();
        const ata = await findAssociatedTokenAddress(a.signer, ctx.mint as Address, ctx.tokenProgram as Address);
        const balance = side === "sell" ? { amount: RAY_BALANCE, account: ata } : null;
        const state = await tokenStateFromContext(ctx, null, { user: a.signer, balance }, { slot: ctx.slot });
        const amount = side === "buy" ? 100_000_000n : RAY_BALANCE / 3n;
        const trade = await buildTrade(state, { side, amount, slippageBps: 1500 });
        const [tradeIndex] = tradeInstructionIndexes(trade.instructions);
        if (tradeIndex === undefined) throw new Error("no trade instruction");
        const fw: FirewallContext = { signer: a.signer, connectedWallet: a.connected, ownedNonceAccounts: [], ...POLICY };
        for (const mode of ["standard", "turbo", "protected"] as const) {
          const plan = planFor(mode, trade.defaultCuLimit, FEE_CAPS);
          const tx = assemble(a.signer, trade.instructions, plan);
          const summary = await expectAllowed(tx, fw);
          expect(summary.actions.filter((x) => x.kind === "trade")).toEqual([
            expect.objectContaining({
              venue: state.venue === "launchlab" ? LAUNCHLAB_VENUE : CPMM_VENUE,
              side,
              baseMint: state.mint,
              quoteMint: WSOL_MINT,
            }),
          ]);
          expect(summary.maxBuyLamports).toBe(side === "buy" ? amount : 0n);
          // The browser's quote as the firewall's expectation (what instant mode sends with every trade).
          const expectations: TradeExpectation[] = [
            { instruction: 2 + tradeIndex, expectedOut: trade.quote.expectedOut, slippageBps: 1500 },
          ];
          const checked = await expectAllowed(tx, { ...fw, expectations });
          expect(checked.text).toContain("Checked against your own quote");
        }
      });
    }
  }
});
