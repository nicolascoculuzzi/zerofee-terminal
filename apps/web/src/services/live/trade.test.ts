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
  bondingCurvePda,
  buildTrade,
  decodeBondingCurve,
  decodeMint,
  decodePool,
  findAssociatedTokenAddress,
  isCanonicalPumpPool,
  loadTokenState,
  PUMP_AMM_FEE_CONFIG,
  PUMP_AMM_GLOBAL_CONFIG,
  PUMP_FEE_CONFIG,
  PUMP_GLOBAL,
  PUMP_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from "@zerofee/core";
import type { CurveTradeContext, PoolTradeContext, ProgramAccountsResponse, TxSubmitResponse } from "@zerofee/protocol";
import { CURVE_MINT, fixture, POOL } from "../../../../../packages/core/test/fixtures";
import snapshot from "../../../../../packages/core/test/fixtures/mainnet-accounts.json";
import { jupiterCase, jupiterFetch, jupiterRpc, type RpcAccount } from "../../../../../packages/core/test/jupiter-fixtures";
import type { ExecutionSettings, TradeProgress } from "../tradeService";
import { setApiFetch } from "./api";
import { firstSignature, toBase64 } from "./bytes";
import { wireChain, wireToken } from "./fixtures";
import { LiveDataSource } from "./LiveDataSource";
import { LiveTradeService, tradeInstructionIndexes, verifiedLookupTables } from "./LiveTradeService";
import { planLanding } from "./landingFees";
import { ProgramAccounts } from "./programs";
import { signerConfigFromSettings } from "./signerConfig";
import { SignerHost } from "./signerHost";
import { type FakeSocket, inProcessSignerFactory, ManualClock, socketFactory } from "./testkit";
import type { TradeContexts, TradeInputs } from "./tradeContexts";
import { tokenStateFromContext, venueFeeBps } from "./tradeState";
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
    jupiter: { fetchFn: jupiterFetch().fetch },
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
  return { svc, submitted, signCalls };
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
