/**
 * The armed-order engine's seams, offline: the strict intake parser, live quotes from the server's market
 * state (they must equal the browser's quote from the trade context), chain decoding and the loopback
 * guard, the lanes (variants only ever take the protected lane; DRY_RUN only simulates), and the config.
 */
import { describe, expect, test } from "bun:test";
import type { Address } from "@solana/kit";
import {
  type ArmedOrder,
  armedJsonReviver,
  armedOrderToJson,
  armOrder,
  decodeAmmGlobalConfig,
  decodeFeeConfig,
  decodePumpGlobal,
  type Lane,
  type LaneAck,
  type LiveMarketState,
  liveQuoteOut,
  minOutGrid,
  PUMP_AMM_FEE_CONFIG,
  PUMP_AMM_GLOBAL_CONFIG,
  PUMP_FEE_CONFIG,
  PUMP_GLOBAL,
  pumpSellTemplate,
  type SignedTx,
  WSOL_MINT,
} from "@zerofee/core";
import type { ProgramAccountsResponse } from "@zerofee/protocol";
import { armedWallet, curveContext, nonceRefs, operatorTables, TIP_LEVELS } from "../../../packages/core/test/armedTestKit";
import { fixture as coreFixture } from "../../../packages/core/test/fixtures";
import { ValidationError } from "../src/api/validate";
import { MarketState } from "../src/market/state";
import { isLoopbackUrl, loopbackOnlyFetch, nonceSnapshot, RpcChainReader } from "../src/orders/chain";
import { loadOrdersConfig } from "../src/orders/config";
import { DryRunSubmitter, LiveSubmitter, liveLanes, tipsOf } from "../src/orders/lanes";
import { MarketStateView, ProgramStateCache } from "../src/orders/market";
import { orderView } from "../src/orders/view";
import { parseArmBody, parseArmedOrder } from "../src/orders/wire";
import { RpcClient } from "../src/util/rpc";
import { addr, FakeCurve, FakeResolver, mockFetch, synthTx } from "./helpers";
import { FakeChain } from "./orderFakes";
import { nonceAccountData, synthOrder } from "./orderFixtures";

const LIM = { maxAttempts: 5, maxVariantsPerNonce: 64, maxOrders: 10 };

/** A real signed stop-loss on the fixture curve (8 variants on one nonce, operator table, Jito tips). */
async function signedStopLoss(): Promise<{ order: ArmedOrder; wallet: Address }> {
  const signer = await armedWallet();
  const curve = await curveContext(signer.address);
  const order = await armOrder(
    {
      id: crypto.randomUUID(),
      kind: "stop-loss",
      wallet: signer.address,
      mint: curve.mint,
      amount: 1_234_567_890n,
      fullExit: true,
      trigger: { type: "quote-at-most", threshold: 30_000_000n },
      templates: [await pumpSellTemplate(curve, { amount: 1_234_567_890n, closeBaseAccount: true })],
      minOuts: minOutGrid(30_000_000n, [0, 300, 600, 900]),
      tipLevels: TIP_LEVELS,
      nonces: await nonceRefs(signer.address, 1),
      armingQuoteOut: 40_000_000n,
      lookupTables: await operatorTables(),
    },
    signer,
  );
  return { order, wallet: signer.address };
}

describe("intake parser (untrusted JSON)", async () => {
  const { order } = await signedStopLoss();
  const json = armedOrderToJson(order);
  const mutate = (fn: (o: Record<string, unknown>) => void): string => {
    const o = JSON.parse(json);
    fn(o);
    return JSON.stringify(o);
  };
  const refusal = (text: string) => {
    try {
      parseArmBody(text, LIM);
    } catch (e) {
      if (e instanceof ValidationError) return e.message;
      throw e;
    }
    return null;
  };

  test("a browser-armed order parses to exactly the order (bigints revived), single or batched", () => {
    expect(parseArmBody(json, LIM)).toEqual([order]);
    expect(parseArmBody(`{"orders":[${json}]}`, LIM)).toEqual([order]);
  });

  test("malformed input is refused with the field named", () => {
    expect(refusal("{not json")).toBe("invalid JSON");
    expect(refusal(mutate((o) => (o.id = "sl")))).toContain("lowercase UUID");
    expect(refusal(mutate((o) => (o.amount = "1234")))).toContain("order.amount must be an integer tagged");
    expect(refusal(mutate((o) => (o.extra = 1)))).toContain('unknown field "extra"');
    expect(refusal(mutate((o) => (o.kind = "limit-buy")))).toContain("a limit-buy is a buy");
    expect(refusal(mutate((o) => (o.status = "filled")))).toContain('status must be "armed"');
    expect(refusal(mutate((o) => (o.flags = ["x"])))).toContain("flags must be empty");
    expect(
      refusal(
        mutate((o) => {
          (o.attempts as { status: string }[])[0]!.status = "submitted";
        }),
      ),
    ).toContain('status must be "live"');
    expect(
      refusal(
        mutate((o) => {
          (o.attempts as { variants: { id: string }[] }[])[0]!.variants[0]!.id = "someone-else/0/pump/0/0";
        }),
      ),
    ).toContain("variants[0].id must look like");
    expect(
      refusal(
        mutate((o) => {
          (o.frozen as { mint: string }).mint = addr("other-mint");
        }),
      ),
    ).toContain("frozen.mint must be the order mint");
    expect(
      refusal(
        mutate((o) => {
          (o.attempts as { variants: { tx: { wireBase64: string } }[] }[])[0]!.variants[0]!.tx.wireBase64 = "A".repeat(2_000);
        }),
      ),
    ).toContain("at most 1232 bytes");
    expect(
      refusal(
        mutate((o) => {
          (o.trigger as Record<string, unknown>).extra = 1;
        }),
      ),
    ).toContain("unknown field");
    expect(refusal(`{"orders":[${json},${json}]}`)).toContain("duplicate order ids");
    expect(refusal(`{"orders":[]}`)).toContain("must not be empty");
    expect(() => parseArmedOrder(JSON.parse(json, armedJsonReviver), { ...LIM, maxVariantsPerNonce: 4 })).toThrow("at most 4 items");
  });

  test("views never carry signed bytes", () => {
    const view = orderView(order, {}, { createdAt: 1, updatedAt: 2, dryRun: false });
    const text = JSON.stringify(view);
    for (const a of order.attempts) {
      expect(text).not.toContain(a.nonce.cancel.wireBase64);
      for (const v of a.variants) expect(text).not.toContain(v.tx.wireBase64);
    }
    expect(view).toMatchObject({ trigger: { type: "quote-at-most", threshold: "30000000" }, venues: ["pump"], open: true });
    expect(view.attempts[0]).toMatchObject({ variants: 8, minOutHigh: "30000000", minOutLow: "27300000" });
  });
});

// ---------------------------------------------------------------------------------------------

function programAccounts(fetchedAt = 1): ProgramAccountsResponse {
  const accounts: ProgramAccountsResponse["accounts"] = {};
  for (const a of [PUMP_GLOBAL, PUMP_FEE_CONFIG, PUMP_AMM_GLOBAL_CONFIG, PUMP_AMM_FEE_CONFIG]) {
    const f = coreFixture(a);
    accounts[a] = { owner: f.owner, lamports: f.lamports.toString(), data: Buffer.from(f.data).toString("base64") };
  }
  return { slot: 1, fetchedAt, accounts };
}

describe("live quotes from the server's market state", () => {
  const programs = new ProgramStateCache({ get: () => programAccounts() });
  const global = decodePumpGlobal(coreFixture(PUMP_GLOBAL).data);
  const feeConfig = decodeFeeConfig(coreFixture(PUMP_FEE_CONFIG).data);

  test("a curve coin quotes exactly like the browser's trade context (same inputs, same math)", () => {
    const resolver = new FakeResolver();
    const m = new MarketState({ sniperSlots: 3, bundleMinBuyers: 4, proTraderWallets: [] }, { resolver, solUsd: () => 120 });
    const mint = addr("quote-mint-1");
    const curve = new FakeCurve(mint, addr("quote-dev"));
    m.applyTx(synthTx(100, [curve.create(1_791_048_900)]));
    m.applyTx(synthTx(101, [curve.buy(addr("buyer-1"), 2_000_000_000n, 1_791_048_901)]));
    const view = new MarketStateView({ market: m, pools: resolver.pools, programs });
    const q = view.quote(mint);
    expect(q?.venue).toBe("pump");
    const market = q?.market as Extract<LiveMarketState, { venue: "pump" }>;
    expect(market.curve).toMatchObject({
      virtualTokenReserves: curve.vToken,
      virtualQuoteReserves: curve.vQuote,
      realTokenReserves: curve.rToken,
    });
    // What the browser computes from tradectx + /api/program-accounts:
    const browser: LiveMarketState = {
      venue: "pump",
      curve: {
        virtualTokenReserves: curve.vToken,
        virtualQuoteReserves: curve.vQuote,
        realTokenReserves: curve.rToken,
        realQuoteReserves: curve.rQuote,
        complete: false,
        creator: addr("quote-dev") as Address,
        isMayhemMode: false,
        quoteMint: WSOL_MINT,
        creatorFeeBps: 0n,
      },
      global,
      feeConfig,
      mintSupply: 1_000_000_000_000_000n,
    };
    for (const [side, amount] of [
      ["sell", 10_000_000_000n],
      ["buy", 50_000_000n],
    ] as const) {
      expect(liveQuoteOut(side, amount, market)).toBe(liveQuoteOut(side, amount, browser));
      expect(liveQuoteOut(side, amount, market)).toBeGreaterThan(0n);
    }
    expect(view.coinFacts(mint)).toEqual({
      curve: { creator: addr("quote-dev") as Address, complete: false, isMayhemMode: false, isCashbackCoin: false },
      pool: null,
    });
    expect(view.migrated(mint)).toBe(false);
    expect(view.quote(addr("unknown-mint"))).toBeNull();
  });

  test("not quotable without program accounts, or with an unknown per-coin creator fee", () => {
    const resolver = new FakeResolver();
    const m = new MarketState({ sniperSlots: 3, bundleMinBuyers: 4, proTraderWallets: [] }, { resolver, solUsd: () => 120 });
    const mint = addr("quote-mint-2");
    const curve = new FakeCurve(mint, addr("quote-dev-2"));
    m.applyTx(synthTx(100, [curve.create(1_791_048_900)]));
    expect(new MarketStateView({ market: m, pools: resolver.pools, programs: new ProgramStateCache(null) }).quote(mint)).toEqual({
      venue: "pump",
      market: null,
    });
    const rec = m.tokens.get(mint);
    if (!rec) throw new Error("fixture");
    rec.creatorFeeBps = null;
    const configurable = { get: () => ({ ...programs.get(), global: { ...global, creatorFeeConfigurable: true } }) };
    expect(new MarketStateView({ market: m, pools: resolver.pools, programs: configurable }).quote(mint)?.market).toBeNull();
  });

  test("a migrated coin quotes on its canonical pool; recipients come from the live program accounts", () => {
    const resolver = new FakeResolver();
    const m = new MarketState({ sniperSlots: 3, bundleMinBuyers: 4, proTraderWallets: [] }, { resolver, solUsd: () => 120 });
    const mint = addr("pool-mint");
    const pool = addr("pool-addr");
    const curve = new FakeCurve(mint, addr("pool-dev"));
    m.applyTx(synthTx(100, [curve.create(1_791_048_900)]));
    const rec = m.tokens.get(mint);
    if (!rec) throw new Error("fixture");
    Object.assign(rec, {
      migrated: true,
      complete: true,
      pool,
      poolState: { base: 200_000_000_000_000n, quoteVault: 85_000_000_000n, virtualQuote: 0n },
    });
    resolver.learnPool({
      pool,
      baseMint: mint,
      quoteMint: WSOL_MINT,
      isCanonical: true,
      coinCreator: addr("pool-dev"),
      creatorFeeBps: "0",
      isMayhemMode: false,
    });
    const view = new MarketStateView({ market: m, pools: resolver.pools, programs });
    const q = view.quote(mint);
    expect(q?.venue).toBe("pumpswap");
    expect(liveQuoteOut("sell", 1_000_000_000n, q?.market as LiveMarketState)).toBeGreaterThan(0n);
    expect(view.coinFacts(mint)).toEqual({
      curve: { creator: addr("pool-dev") as Address, complete: true, isMayhemMode: false, isCashbackCoin: false },
      pool: { coinCreator: addr("pool-dev") as Address, isMayhemMode: false },
    });
    const r = view.recipients();
    const gc = decodeAmmGlobalConfig(coreFixture(PUMP_AMM_GLOBAL_CONFIG).data);
    expect(r.feeRecipients?.pump).toContain(global.feeRecipient);
    expect(r.feeRecipients?.pumpswap).toEqual(expect.arrayContaining(gc.protocolFeeRecipients));
    expect(r.buybackFeeRecipients?.pumpswap?.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe("chain reads and the loopback guard", () => {
  test("nonce accounts decode; anything else is not a nonce", () => {
    const authority = addr("nonce-authority");
    const value = "8sTvc2bTU87hQZQoDRCK7ebsKNYeWjn6fT9YZA4M9Rx3";
    const snap = nonceSnapshot({
      address: addr("n") as Address,
      owner: "11111111111111111111111111111111" as Address,
      lamports: 1n,
      data: nonceAccountData(authority, value),
    });
    expect(snap).toEqual({ account: addr("n") as Address, authority: authority as Address, value: value as never, lamports: 1n });
    expect(nonceSnapshot(null)).toBeNull();
    expect(
      nonceSnapshot({
        address: addr("n") as Address,
        owner: addr("other") as Address,
        lamports: 1n,
        data: nonceAccountData(authority, value),
      }),
    ).toBeNull();
    expect(
      nonceSnapshot({
        address: addr("n") as Address,
        owner: "11111111111111111111111111111111" as Address,
        lamports: 1n,
        data: new Uint8Array(80),
      }),
    ).toBeNull();
  });

  test("signature statuses and nonce history over JSON-RPC (mocked)", async () => {
    const { fn, calls } = mockFetch((_url, body) => {
      if (body?.method === "getSignatureStatuses")
        return [
          200,
          {
            jsonrpc: "2.0",
            id: 1,
            result: { context: { slot: 5 }, value: [{ slot: 4, err: null, confirmationStatus: "confirmed" }, null] },
          },
        ];
      if (body?.method === "getSignaturesForAddress")
        return [200, { jsonrpc: "2.0", id: 1, result: [{ signature: "s1", slot: 3, err: { InstructionError: [2, "Custom"] } }] }];
      return [200, { jsonrpc: "2.0", id: 1, result: { context: { slot: 9 }, value: { err: null, logs: ["ok"], unitsConsumed: 77 } } }];
    });
    const chain = new RpcChainReader(new RpcClient({ url: "http://127.0.0.1:1", fetchFn: fn }));
    expect(await chain.signatureStatuses(["a", "b"])).toEqual([{ slot: 4, err: null, confirmationStatus: "confirmed" }, null]);
    expect(await chain.signaturesForAddress("acc", 10)).toEqual([{ signature: "s1", slot: 3, err: { InstructionError: [2, "Custom"] } }]);
    expect(await chain.simulate("AQID")).toEqual({ err: null, logs: ["ok"], unitsConsumed: 77, slot: 9 });
    expect(calls[0]?.body).toMatchObject({ params: [["a", "b"], { searchTransactionHistory: true }] });
    expect(calls[2]?.body).toMatchObject({ params: ["AQID", { encoding: "base64", sigVerify: true, commitment: "confirmed" }] });
  });

  test("loopback-only fetch refuses every non-local URL", async () => {
    expect(isLoopbackUrl("http://127.0.0.1:18899")).toBe(true);
    expect(isLoopbackUrl("http://localhost:8899/x")).toBe(true);
    expect(isLoopbackUrl("https://mainnet.block-engine.jito.wtf/api/v1/transactions")).toBe(false);
    expect(isLoopbackUrl("http://10.0.0.1:8899")).toBe(false);
    const inner = mockFetch(() => [200, { ok: true }]);
    const guarded = loopbackOnlyFetch(inner.fn);
    await expect(guarded("https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/transactions")).rejects.toThrow("non-loopback");
    await expect(guarded("not a url")).rejects.toThrow("non-loopback");
    expect((await guarded("http://127.0.0.1:1/")).status).toBe(200);
    expect(inner.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------

class RecordingLane implements Lane {
  readonly sent: string[] = [];
  constructor(readonly name: string) {}
  async sendTransaction(wire: string): Promise<LaneAck> {
    this.sent.push(wire);
    return { lane: this.name, ok: true, sentAt: 0, ackAt: 1 };
  }
}

describe("lanes", async () => {
  const { order } = await signedStopLoss();
  const variant = order.attempts[0]?.variants[0];
  const cancel = order.attempts[0]?.nonce.cancel as SignedTx;
  if (!variant) throw new Error("fixture");

  test("tips are read from the signed bytes: armed variants tip Jito, the plain cancel tips nobody", () => {
    expect(tipsOf(variant.tx.wireBase64)).toEqual({ jito: variant.tipLamports, helius: 0n });
    expect(tipsOf(cancel.wireBase64)).toEqual({ jito: 0n, helius: 0n });
    expect(tipsOf("not base64 at all")).toEqual({ jito: 0n, helius: 0n });
  });

  test("production lanes: variants ONLY to Jito bundle-only; cancels to plain RPC (+ relays they tip)", () => {
    const lanes = liveLanes({
      jitoRegion: "frankfurt",
      heliusRegion: "fra",
      cancelRpcUrl: "http://127.0.0.1:1",
      fetchFn: loopbackOnlyFetch(),
    });
    expect(lanes.variant.map((l) => l.name)).toEqual(["jito-bundleOnly-frankfurt"]);
    expect(lanes.cancel(cancel).map((l) => l.name)).toEqual(["cancel-rpc"]);
    expect(lanes.cancel({ ...cancel, wireBase64: variant.tx.wireBase64 }).map((l) => l.name)).toEqual(["cancel-rpc", "jito-frankfurt"]);
  });

  test("the live submitter keeps variants and cancels on their own lanes; DRY_RUN only simulates", async () => {
    const protectedLane = new RecordingLane("protected");
    const cancelLane = new RecordingLane("cancel");
    const live = new LiveSubmitter({ variant: [protectedLane], cancel: () => [cancelLane] });
    expect((await live.sendVariant(variant.tx.wireBase64)).ok).toBe(true);
    expect((await live.sendCancel(cancel)).lanes.map((l) => l.lane)).toEqual(["cancel"]);
    expect(protectedLane.sent).toEqual([variant.tx.wireBase64]);
    expect(cancelLane.sent).toEqual([cancel.wireBase64]);

    const chain = new FakeChain();
    const dry = new DryRunSubmitter(chain);
    const r = await dry.sendVariant(variant.tx.wireBase64);
    expect(r).toMatchObject({ dryRun: true, ok: true, lanes: [], simulation: { unitsConsumed: 90_000 } });
    await dry.sendCancel(cancel);
    expect(chain.simulations).toEqual([variant.tx.wireBase64, cancel.wireBase64]);
  });
});

describe("config", () => {
  test("defaults follow the core safety policy; values are validated", () => {
    const c = loadOrdersConfig({});
    expect(c).toMatchObject({
      enabled: true,
      lookupTables: [],
      maxOpenPerUser: 50,
      maxNotionalLamports: 25_000_000_000n,
      missSlots: 8,
      safetyMarginBps: 100,
    });
    const t = addr("table-1");
    expect(loadOrdersConfig({ ARMED_LOOKUP_TABLES: `${t}, ${t}`, ORDERS_MAX_NOTIONAL_SOL: "2.5" })).toMatchObject({
      lookupTables: [t],
      maxNotionalLamports: 2_500_000_000n,
    });
    expect(() => loadOrdersConfig({ ARMED_LOOKUP_TABLES: "nope" })).toThrow("not an address");
    expect(() => loadOrdersConfig({ ORDERS_MAX_NOTIONAL_SOL: "-1" })).toThrow("SOL amount");
    expect(() => loadOrdersConfig({ ORDERS_MISS_SLOTS: "0" })).toThrow("ORDERS_MISS_SLOTS");
    expect(() => loadOrdersConfig({ ORDERS_CANCEL_RPC_URL: "ftp://x" })).toThrow("http(s)");
  });

  test("synthetic orders are valid intake shapes too", () => {
    const o = synthOrder();
    expect(parseArmBody(armedOrderToJson(o), LIM)).toEqual([o]);
  });
});
