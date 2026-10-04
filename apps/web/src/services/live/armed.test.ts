/**
 * Armed orders from the browser, offline: the server's trade context and program accounts shaped from
 * core's mainnet snapshots, nonce slots from a stubbed probe, every variant and cancel signed by the
 * shipped signer policy in an in-process worker, and the POSTed orders checked with core's assertArmable and
 * the server intake's own rules (serverRules: the checks its intake runs before its chain reads). Raydium
 * LaunchLab / CPMM contexts come from core's Raydium mainnet snapshot (raydiumTestkit.ts).
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type Address, getBase58Decoder } from "@solana/kit";
import {
  type ArmedOrder,
  armedJsonReviver,
  armedOrderFromJson,
  assertArmable,
  bondingCurvePda,
  decodeBondingCurve,
  decodeMint,
  findAssociatedTokenAddress,
  nonceSlotAddresses,
  PUMP_AMM_FEE_CONFIG,
  PUMP_AMM_GLOBAL_CONFIG,
  PUMP_FEE_CONFIG,
  PUMP_GLOBAL,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_MINT,
  WSOL_MINT,
} from "@zerofee/core";
import type {
  CpmmTradeContext,
  CurveTradeContext,
  LaunchLabTradeContext,
  NonceProbeResponse,
  OrderLimits,
  ProgramAccountsResponse,
  TradeContext,
  TxSubmitResponse,
  Order as WireOrder,
} from "@zerofee/protocol";
import { operatorTables } from "../../../../../packages/core/test/armedTestKit";
import { CURVE_MINT, fixture } from "../../../../../packages/core/test/fixtures";
import { serverRules } from "../../../../server/src/orders/intake";
import type { ExecutionSettings } from "../tradeService";
import { setApiFetch } from "./api";
import { LiveArmedOrders } from "./armed";
import { firstSignature, toBase64 } from "./bytes";
import { wireChain, wireToken } from "./fixtures";
import { LiveDataSource } from "./LiveDataSource";
import { ProgramAccounts } from "./programs";
import { CPMM, cpmmContext, LL, launchLabContext } from "./raydiumTestkit";
import { signerConfigFromSettings } from "./signerConfig";
import { SignerHost } from "./signerHost";
import { type FakeSocket, inProcessSignerFactory, ManualClock, socketFactory } from "./testkit";
import type { TradeContexts } from "./tradeContexts";

setDefaultTimeout(30_000);

const PASSWORD = "correct horse battery staple";
const CONNECTED = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const SETTINGS: ExecutionSettings = { slippagePct: 15, priorityFeeSol: 0.001, tipSol: 0.0001, landing: "secure" };
const LIMITS: OrderLimits = {
  maxOpenOrders: 20,
  maxArmedNotionalLamports: "25000000000",
  maxBuyLamports: "1000000000",
  maxGridDepthBps: 5_000,
  maxTipLamports: "10000000",
  maxPriorityFeeLamports: "10000000",
  maxAttempts: 5,
  maxVariantsPerNonce: 64,
  maxBuyVariants: 3,
  lookupTables: [],
  openOrders: 0,
  armedNotionalLamports: "0",
  dryRun: true,
};

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

/** The user's per-trade cap the server applies to armed buys (maxTradeSol 1). */
const USER_BUY_CAP = 1_000_000_000n;

const nonceValue = () => getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32)));

/** A wire Order view of an armed order, as the server answers (enough for the adapters). */
function view(o: ArmedOrder): WireOrder {
  return {
    id: o.id,
    wallet: o.wallet,
    kind: o.kind,
    side: o.side,
    mint: o.mint,
    amount: o.amount.toString(),
    fullExit: o.fullExit,
    trigger: JSON.parse(JSON.stringify(o.trigger, (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
    ocoGroup: o.ocoGroup ?? null,
    status: "armed",
    statusReason: null,
    flags: [],
    attempts: o.attempts.map((a) => ({
      index: a.index,
      nonceAccount: a.nonce.account,
      status: "live",
      variants: a.variants.length,
      minOutLow: a.variants.reduce((m, v) => (v.minOut < m ? v.minOut : m), a.variants[0]?.minOut ?? 0n).toString(),
      minOutHigh: a.variants.reduce((m, v) => (v.minOut > m ? v.minOut : m), 0n).toString(),
      submittedVariantId: null,
      submittedAtSlot: null,
      consumedBy: null,
    })),
    venues: o.frozen.venues.map((v) => v.venue),
    armingQuoteOut: o.armingQuoteOut.toString(),
    armedAt: o.armedAtMs,
    reservation: { lamports: o.reservation.lamports.toString(), tokens: o.reservation.tokens.toString() },
    capCost: { buyLamports: o.capCost.buyLamports.toString(), feeLamports: o.capCost.feeLamports.toString() },
    signature: null,
    highWater: null,
    open: true,
    dryRun: true,
    createdAt: o.armedAtMs,
    updatedAt: o.armedAtMs,
  };
}

let ds: LiveDataSource;
let s: FakeSocket;
let host: SignerHost;
let stopSigner: () => void;
let wallet: string;
let slots: string[];

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
  host.configure(signerConfigFromSettings({ perTradeSol: 1, dailySol: 50, autoLockMinutes: 15 }));
  await host.rpc.call("createVault", { password: PASSWORD, connectedWallet: CONNECTED });
  wallet = (await host.rpc.call("addWallet", { label: "Main" })).address;
  slots = await nonceSlotAddresses(wallet as Address, 16);
});

afterEach(() => {
  host.stop();
  stopSigner();
  ds.close();
  setApiFetch(null);
});

interface Server {
  armed: ArmedOrder[][];
  submitted: Uint8Array[];
  calls: string[];
}

/** The armed-order REST surface: `ready` slots exist on chain, the rest are absent; the operator table is set up. */
async function harness(ready: number) {
  const tables = await operatorTables();
  const values = slots.map(() => nonceValue());
  const server: Server = { armed: [], submitted: [], calls: [] };
  const rest = async <T>(path: string, o: { method?: string; body?: unknown; rawBody?: string } = {}): Promise<T> => {
    server.calls.push(`${o.method ?? "GET"} ${path.split("?")[0]}`);
    if (path === "/api/orders/limits") return { ...LIMITS, lookupTables: Object.keys(tables) } as T;
    if (path.startsWith("/api/lookup-tables")) {
      return {
        slot: 1,
        tables: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, { addresses: v, active: true, lastExtendedSlot: 1 }])),
      } as T;
    }
    if (path.startsWith("/api/orders/nonce-probe")) {
      const res: NonceProbeResponse = {
        wallet,
        slot: 1,
        rentLamports: "1447680",
        slots: slots.map((a, index) => ({
          index,
          nonceAccount: a,
          state: index < ready ? "ready" : "absent",
          nonceValue: index < ready ? (values[index] as string) : null,
          lamports: index < ready ? "1447680" : null,
          orderId: null,
        })),
      };
      return res as T;
    }
    if (path === "/api/orders/armed") {
      const raw = o.rawBody ?? "";
      const parsed = JSON.parse(raw, armedJsonReviver) as ArmedOrder | { orders: ArmedOrder[] };
      const orders = "orders" in parsed ? parsed.orders : [armedOrderFromJson(raw)];
      // What the server's intake checks before reading the chain: structure, caps, signatures, firewall-like rules.
      for (const order of orders) {
        await assertArmable(order, { lookupTables: tables });
        // The intake's rules on top (operator tables, Jito-only, reservation, quote asset, the user's buy cap).
        expect(serverRules(order, tables, USER_BUY_CAP)).toEqual([]);
      }
      server.armed.push(orders);
      return { orders: orders.map(view) } as T;
    }
    if (path.endsWith("/cancel")) return { orders: [] } as T;
    if (path === "/api/orders/panic") return { cancelled: 2, orders: [] } as T;
    throw new Error(`unexpected ${path}`);
  };
  const submit = async (wire: Uint8Array, preset: "reduced" | "secure" | "fast"): Promise<TxSubmitResponse> => {
    server.submitted.push(wire);
    return {
      signature: firstSignature(wire) ?? "",
      dryRun: true,
      preset,
      lanes: [],
      simulation: { err: null, logs: [], unitsConsumed: 6_000, slot: 9 },
      receivedAt: Date.now(),
    };
  };
  return { server, rest, submit };
}

async function armed(ready: number, ctx: TradeContext) {
  const h = await harness(ready);
  const contexts = { get: async () => ({ ctx, token: wireToken({ mint: ctx.mint }) }), close: () => {} } as unknown as TradeContexts;
  const svc = new LiveArmedOrders({
    data: ds,
    signer: host,
    programs: new ProgramAccounts(async () => programAccounts()),
    contexts,
    rest: h.rest,
    submit: h.submit,
    sleep: async () => {},
  });
  return { svc, ...h };
}

async function holdTokens(ctx: TradeContext, amount: bigint): Promise<void> {
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

const priceOf = (ctx: CurveTradeContext) =>
  Number(BigInt(ctx.virtualQuoteReserves)) / 1e9 / (Number(BigInt(ctx.virtualTokenReserves)) / 10 ** ctx.decimals);

describe("arming in the browser", () => {
  test("a full-exit stop-loss: variants and cancel signed by the worker's firewall, accepted by core's intake checks", async () => {
    const ctx = await curveContext();
    await holdTokens(ctx, 5_000_000_000n);
    const { svc, server } = await armed(2, ctx);
    const order = await svc.placeLimit({
      mint: ctx.mint,
      wallet,
      side: "sell",
      trigger: { metric: "price", direction: "below", value: priceOf(ctx) * 0.7 },
      size: { kind: "pct", pct: 100 },
      settings: SETTINGS,
    });
    expect(order.kind).toBe("stop_loss");
    const [batch] = server.armed;
    const o = batch?.[0];
    expect(o?.kind).toBe("stop-loss");
    expect(o?.fullExit).toBe(true);
    expect(o?.amount).toBe(5_000_000_000n);
    expect(o?.trigger.type).toBe("quote-at-most");
    expect(o?.attempts).toHaveLength(1);
    expect(o?.attempts[0]?.nonce.account).toBe(slots[0] as Address);
    expect(o?.attempts[0]?.variants.length).toBeGreaterThanOrEqual(2);
    // Every variant pays a Jito tip within the caps; the trigger sits about 30% under the arming quote.
    for (const v of o?.attempts[0]?.variants ?? []) expect(v.tipLamports).toBeGreaterThanOrEqual(1_000n);
    if (o?.trigger.type === "quote-at-most") expect(Number(o.trigger.threshold) / Number(o.armingQuoteOut)).toBeLessThan(0.8);
    expect(server.submitted).toHaveLength(0);
  });

  test("a take-profit / stop-loss pair shares one nonce (OCO) and arms atomically", async () => {
    const ctx = await curveContext();
    await holdTokens(ctx, 5_000_000_000n);
    const { svc, server } = await armed(2, ctx);
    const orders = await svc.armTpSl({
      mint: ctx.mint,
      wallet,
      entryPriceSol: priceOf(ctx),
      legs: [
        { kind: "take_profit", triggerPct: 50, sellPct: 50 },
        { kind: "stop_loss", triggerPct: 30, sellPct: 100 },
      ],
      settings: SETTINGS,
      oco: true,
    });
    expect(orders).toHaveLength(2);
    const [batch] = server.armed;
    expect(batch?.map((o) => o.kind)).toEqual(["take-profit", "stop-loss"]);
    expect(batch?.[0]?.ocoGroup).toBeDefined();
    expect(batch?.[0]?.ocoGroup).toBe(batch?.[1]?.ocoGroup);
    expect(batch?.[0]?.attempts[0]?.nonce.account).toBe(batch?.[1]?.attempts[0]?.nonce.account as Address);
  });

  test("a limit buy stays within the buy-variant cap", async () => {
    const ctx = await curveContext();
    const { svc, server } = await armed(1, ctx);
    await svc.placeLimit({
      mint: ctx.mint,
      wallet,
      side: "buy",
      trigger: { metric: "price", direction: "below", value: priceOf(ctx) * 0.8 },
      size: { kind: "sol", sol: 0.1 },
      settings: SETTINGS,
    });
    const o = server.armed[0]?.[0];
    expect(o?.kind).toBe("limit-buy");
    expect(o?.trigger.type).toBe("quote-at-least");
    const variants = o?.attempts.reduce((n, a) => n + a.variants.length, 0) ?? 0;
    expect(variants).toBeGreaterThan(0);
    expect(variants).toBeLessThanOrEqual(3);
  });

  test("a migration snipe is a PumpSwap buy pre-signed against the coin's canonical pool", async () => {
    const ctx = await curveContext();
    const { svc, server } = await armed(1, ctx);
    const order = await svc.armMigration({ mint: ctx.mint, wallet, side: "buy", size: { kind: "sol", sol: 0.05 }, settings: SETTINGS });
    expect(order.kind).toBe("migration_buy");
    const o = server.armed[0]?.[0];
    expect(o?.trigger).toEqual({ type: "migration" });
    expect(o?.frozen.venues.map((v) => v.venue)).toEqual(["pumpswap"]);
  });

  test("missing slots: the worker signs their creation; in dry run nothing lands, so arming stops with the reason", async () => {
    const ctx = await curveContext();
    await holdTokens(ctx, 5_000_000_000n);
    const { svc, server } = await armed(0, ctx);
    const err = await svc
      .placeLimit({
        mint: ctx.mint,
        wallet,
        side: "sell",
        trigger: { metric: "price", direction: "above", value: priceOf(ctx) * 2 },
        size: { kind: "pct", pct: 50 },
        settings: SETTINGS,
      })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("dry-run");
    expect(server.submitted).toHaveLength(1); // the slot creation, signed through the firewall
    expect(server.armed).toHaveLength(0);
  });

  test("cancel and Panic go to the server", async () => {
    const ctx = await curveContext();
    const { svc, server } = await armed(1, ctx);
    await svc.cancel("order-1");
    expect(await svc.panic()).toEqual({ cancelled: 2 });
    expect(server.calls).toEqual(["POST /api/orders/order-1/cancel", "POST /api/orders/panic"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Raydium LaunchLab and CPMM
// ---------------------------------------------------------------------------------------------

/** SOL per whole token at the context's reserves (curve sides / net pool reserves). */
function raydiumPriceOf(ctx: LaunchLabTradeContext | CpmmTradeContext): number {
  if (ctx.venue === "launchlab") {
    const quote = BigInt(ctx.virtualQuote) + BigInt(ctx.realQuote);
    const base = BigInt(ctx.virtualBase) - BigInt(ctx.realBase);
    return Number(quote) / 1e9 / (Number(base) / 10 ** ctx.decimals);
  }
  const baseIs0 = ctx.token0Mint === ctx.mint;
  const base = BigInt(baseIs0 ? ctx.token0Reserve : ctx.token1Reserve);
  const quote = BigInt(baseIs0 ? ctx.token1Reserve : ctx.token0Reserve);
  return Number(quote) / 1e9 / (Number(base) / 10 ** ctx.decimals);
}

describe("arming Raydium coins in the browser", () => {
  test("a LaunchLab limit buy: signed by the worker's firewall, within the buy-variant cap, accepted by the intake", async () => {
    const ctx = await launchLabContext(LL.bonk);
    const { svc, server } = await armed(1, ctx);
    const order = await svc.placeLimit({
      mint: ctx.mint,
      wallet,
      side: "buy",
      trigger: { metric: "price", direction: "below", value: raydiumPriceOf(ctx) * 0.8 },
      size: { kind: "sol", sol: 0.1 },
      settings: SETTINGS,
    });
    expect(order.kind).toBe("limit_buy");
    const o = server.armed[0]?.[0];
    expect(o?.kind).toBe("limit-buy");
    expect(o?.trigger.type).toBe("quote-at-least");
    expect(o?.frozen.quoteMint).toBe(WSOL_MINT as Address);
    expect(o?.frozen.venues).toEqual([
      expect.objectContaining({ venue: "launchlab", market: ctx.pool, config: ctx.platformConfig, creator: ctx.creator }),
    ]);
    const variants = o?.attempts.reduce((n, a) => n + a.variants.length, 0) ?? 0;
    expect(variants).toBeGreaterThan(0);
    expect(variants).toBeLessThanOrEqual(LIMITS.maxBuyVariants);
    // The buy pays for the temporary wSOL account and the coin's token account.
    expect(o?.reservation.lamports).toBeGreaterThanOrEqual(100_000_000n + 2n * 2_039_280n);
    // The trigger sits about 20% under the arming quote's price (more tokens for the same spend).
    if (o?.trigger.type === "quote-at-least") expect(Number(o.trigger.threshold) / Number(o.armingQuoteOut)).toBeGreaterThan(1.1);
  });

  test("a full-exit LaunchLab stop-loss closes the SPL coin's token account", async () => {
    const ctx = await launchLabContext(LL.trix);
    await holdTokens(ctx, 5_000_000_000n);
    const { svc, server } = await armed(1, ctx);
    await svc.placeLimit({
      mint: ctx.mint,
      wallet,
      side: "sell",
      trigger: { metric: "price", direction: "below", value: raydiumPriceOf(ctx) * 0.7 },
      size: { kind: "pct", pct: 100 },
      settings: SETTINGS,
    });
    const o = server.armed[0]?.[0];
    expect(o?.kind).toBe("stop-loss");
    expect(o?.fullExit).toBe(true);
    expect(o?.amount).toBe(5_000_000_000n);
    expect(o?.frozen.venues.map((v) => v.venue)).toEqual(["launchlab"]);
  });

  test("selling all of a Token-2022 coin with a transfer fee keeps its token account (withheld fees block CloseAccount)", async () => {
    const ctx = await launchLabContext(LL.stonkFee);
    expect(ctx.tokenProgram).toBe(TOKEN_2022_PROGRAM_ID);
    expect(ctx.baseTransferFee).not.toBeNull();
    await holdTokens(ctx, 5_000_000_000n);
    const { svc, server } = await armed(1, ctx);
    await svc.placeLimit({
      mint: ctx.mint,
      wallet,
      side: "sell",
      trigger: { metric: "price", direction: "above", value: raydiumPriceOf(ctx) * 2 },
      size: { kind: "pct", pct: 100 },
      settings: SETTINGS,
    });
    const o = server.armed[0]?.[0];
    expect(o?.kind).toBe("limit-sell");
    expect(o?.amount).toBe(5_000_000_000n);
    expect(o?.fullExit).toBe(false);
  });

  test("a CPMM take-profit / stop-loss pair shares one nonce (OCO)", async () => {
    const ctx = cpmmContext(CPMM.bonk, LL.graduated);
    await holdTokens(ctx, 5_000_000_000n);
    const { svc, server } = await armed(2, ctx);
    const orders = await svc.armTpSl({
      mint: ctx.mint,
      wallet,
      entryPriceSol: raydiumPriceOf(ctx),
      legs: [
        { kind: "take_profit", triggerPct: 50, sellPct: 50 },
        { kind: "stop_loss", triggerPct: 30, sellPct: 100 },
      ],
      settings: SETTINGS,
      oco: true,
    });
    expect(orders).toHaveLength(2);
    const [batch] = server.armed;
    expect(batch?.map((o) => o.kind)).toEqual(["take-profit", "stop-loss"]);
    expect(batch?.[0]?.ocoGroup).toBe(batch?.[1]?.ocoGroup);
    expect(batch?.[0]?.attempts[0]?.nonce.account).toBe(batch?.[1]?.attempts[0]?.nonce.account as Address);
    for (const o of batch ?? []) {
      expect(o.frozen.venues).toEqual([expect.objectContaining({ venue: "cpmm", market: ctx.pool, config: ctx.ammConfig })]);
    }
    expect(batch?.[1]?.fullExit).toBe(true);
  });

  test("a CPMM limit buy on a Token-2022 coin with a transfer fee", async () => {
    const ctx = cpmmContext(CPMM.stonk);
    const { svc, server } = await armed(1, ctx);
    await svc.placeLimit({
      mint: ctx.mint,
      wallet,
      side: "buy",
      trigger: { metric: "price", direction: "below", value: raydiumPriceOf(ctx) * 0.9 },
      size: { kind: "sol", sol: 0.05 },
      settings: SETTINGS,
    });
    const o = server.armed[0]?.[0];
    expect(o?.kind).toBe("limit-buy");
    expect(o?.frozen.venues.map((v) => v.venue)).toEqual(["cpmm"]);
  });

  test("a Raydium buy above the per-trade cap is refused by the signer firewall", async () => {
    const ctx = await launchLabContext(LL.bonk);
    const { svc, server } = await armed(1, ctx);
    const err = await svc
      .placeLimit({
        mint: ctx.mint,
        wallet,
        side: "buy",
        trigger: { metric: "price", direction: "below", value: raydiumPriceOf(ctx) * 0.8 },
        size: { kind: "sol", sol: 1.5 },
        settings: SETTINGS,
      })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/signer firewall.*Raydium LaunchLab buy_exact_in.*above the per-trade cap/);
    expect(server.armed).toHaveLength(0);
  });

  test("refused: migration snipes on Raydium coins and coins not quoted in SOL", async () => {
    const ll = await launchLabContext(LL.bonk);
    const snipe = { wallet, side: "buy" as const, size: { kind: "sol" as const, sol: 0.05 }, settings: SETTINGS };
    const a = await armed(1, ll);
    await expect(a.svc.armMigration({ ...snipe, mint: ll.mint })).rejects.toThrow("LaunchLab");
    const cp = cpmmContext(CPMM.bonk);
    const b = await armed(1, cp);
    await expect(b.svc.armMigration({ ...snipe, mint: cp.mint })).rejects.toThrow("already trades on Raydium CPMM");
    const usdc = await armed(1, { ...ll, quoteMint: USDC_MINT });
    await expect(
      usdc.svc.placeLimit({
        mint: ll.mint,
        wallet,
        side: "buy",
        trigger: { metric: "price", direction: "below", value: 1e-9 },
        size: { kind: "sol", sol: 0.1 },
        settings: SETTINGS,
      }),
    ).rejects.toThrow("quoted in SOL");
    expect([...a.server.armed, ...b.server.armed, ...usdc.server.armed]).toHaveLength(0);
  });
});
