/**
 * Armed orders on Raydium venues, offline: the market view's live quotes and coin facts over the real
 * MarketState (core's mainnet snapshot), the engine firing LaunchLab / CPMM orders from ingested Raydium
 * transactions (dev-sell exits keyed on the swap's payer, migration snipes on graduation), and the intake
 * accepting genuinely signed LaunchLab and CPMM orders while refusing exotic quotes, tampered configs and
 * malformed frozen venues. Nothing is ever sent.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Address, AddressesByLookupTableAddress, KeyPairSigner } from "@solana/kit";
import {
  type ArmedOrder,
  type ArmedOrderSpec,
  armedOrderToJson,
  armOrder,
  classifyStaleness,
  cpmmFeeRates,
  cpmmSellTemplate,
  detectStaleness,
  type LaunchLabTradeEvent,
  launchLabSellTemplate,
  launchLabTradeParams,
  liveQuoteOut,
  minOutGrid,
} from "@zerofee/core";
import type { ArmOrdersResponse, ArmRejection } from "@zerofee/protocol";
import {
  CPMM_POOLS,
  cpmmArmedContext,
  cpmmMarket,
  LL_POOLS,
  launchLabArmedContext,
  launchLabMarket,
} from "../../../packages/core/test/armedRaydiumKit";
import { armedWallet, nonceRefs, operatorTables, TIP_LEVELS } from "../../../packages/core/test/armedTestKit";
import { RaydiumRegistry } from "../src/accounts/raydium";
import { UserStore } from "../src/db/pg";
import type { IngestTx } from "../src/ingest/types";
import { setLogLevel } from "../src/log";
import { MarketState } from "../src/market/state";
import { loadOrdersConfig } from "../src/orders/config";
import { OrderEngine } from "../src/orders/engine";
import { MarketStateView } from "../src/orders/market";
import { ArmedOrdersRepo } from "../src/orders/repo";
import { addr, FakeResolver } from "./helpers";
import { FakeChain, RecordingSubmitter } from "./orderFakes";
import { synthOrder } from "./orderFixtures";
import { pgliteDb, type TestDb } from "./pgHelpers";
import { ammConfigOf, CPMM, cpmmPoolOf, FixtureFetcher, LL, llGlobal, llPlatform, llPool, raydiumGrpc, rtx } from "./raydiumFixtures";
import { Browser, startUserApp, type UserTestEnv } from "./userHelpers";

setLogLevel("error");

const NOW = 1_791_060_000_000;
const EMPTY_PROGRAMS = { get: () => ({ global: null, pumpFeeConfig: null, ammGlobalConfig: null, ammFeeConfig: null }) };

function world() {
  const resolver = new FakeResolver();
  const fetcher = new FixtureFetcher();
  let m: MarketState | null = null;
  const reg = new RaydiumRegistry(fetcher, {
    launchLabPool: (i) => m?.onLaunchLabPoolReady(i),
    launchLabPoolMissing: (p) => m?.onLaunchLabPoolMissing(p),
    platform: (a) => m?.onPlatformConfig(a),
    cpmmPool: (i) => m?.onCpmmPoolReady(i),
    cpmmRejected: (p) => m?.onCpmmRejected(p),
  });
  m = new MarketState(
    { sniperSlots: 3, bundleMinBuyers: 4, proTraderWallets: [] },
    { resolver, solUsd: () => 150, now: () => NOW, raydium: reg },
  );
  const view = new MarketStateView({ market: m, pools: resolver.pools, programs: EMPTY_PROGRAMS });
  return { m, reg, fetcher, view };
}

const tradeOf = (tx: IngestTx): LaunchLabTradeEvent => {
  const ev = tx.events[0];
  if (ev?.kind !== "launchlabTrade") throw new Error("fixture");
  return ev;
};

/** The graduated letsbonk pool read as status 1 (between its last buy and migrate_to_cpswap). */
function curveComplete(fetcher: FixtureFetcher): void {
  const real = fetcher.lookup(LL.graduated);
  if (!real) throw new Error("fixture");
  const data = new Uint8Array(real.data);
  data[17] = 1;
  fetcher.accounts.set(LL.graduated, { ...real, data });
}

/** A buy on the graduated letsbonk curve that leaves it complete (status 1). */
function completingBuy(): IngestTx {
  const base = raydiumGrpc("bonkBuy", { slot: 452_341_400, signature: "complete".padEnd(88, "1"), receivedAt: NOW - 10_000 });
  const pool = llPool(LL.graduated);
  const acc = base.raydium?.accounts[0];
  if (acc?.kind !== "launchlabSwap") throw new Error("fixture");
  return {
    ...base,
    events: [
      {
        ...tradeOf(base),
        pool: LL.graduated as Address,
        totalBaseSell: pool.totalBaseSell,
        virtualBase: pool.virtualBase,
        virtualQuote: pool.virtualQuote,
        realBaseAfter: pool.totalBaseSell,
        realQuoteAfter: pool.realQuote,
        poolStatus: 1,
      },
    ],
    raydium: {
      accounts: [
        {
          ...acc,
          pool: LL.graduated,
          baseMint: pool.baseMint,
          quoteMint: pool.quoteMint,
          platformConfig: pool.platformConfig,
          globalConfig: pool.globalConfig,
        },
      ],
      migrations: [],
    },
  };
}

describe("market view: Raydium quotes and coin facts", () => {
  test("LaunchLab: quotable once its configs are known, with core's math on the same inputs", async () => {
    const { m, fetcher, view } = world();
    const tx = raydiumGrpc("bonkBuy");
    m.applyTx(tx);
    const mint = llPool(LL.bonk).baseMint;
    expect(view.quote(mint)).toEqual({ venue: "launchlab", market: null }); // configs unread
    await fetcher.flush();
    const q = view.quote(mint);
    expect(q?.venue).toBe("launchlab");
    const ev = tradeOf(tx);
    const pool = llPool(LL.bonk);
    const independent = {
      venue: "launchlab" as const,
      pool: {
        status: 0,
        virtualBase: ev.virtualBase,
        virtualQuote: ev.virtualQuote,
        realBase: ev.realBaseAfter,
        realQuote: ev.realQuoteAfter,
        totalBaseSell: ev.totalBaseSell,
        totalQuoteFundRaising: pool.totalQuoteFundRaising,
      },
      params: launchLabTradeParams({ globalConfig: llGlobal(pool.globalConfig), platformConfig: llPlatform(pool.platformConfig) }),
      transferFees: { base: null, quote: null, epoch: 0n },
      mintSupply: pool.supply,
    };
    for (const [side, amount] of [
      ["sell", 5_000_000_000n],
      ["buy", 20_000_000n],
    ] as const) {
      const ours = q?.market ? liveQuoteOut(side, amount, q.market) : null;
      expect(ours).not.toBeNull();
      expect(ours).toBe(liveQuoteOut(side, amount, independent));
    }
    expect(view.coinFacts(mint)).toEqual({
      launchLabPool: { creator: pool.creator, status: 0 },
      launchLabGraduationPool: expect.any(String),
    });
  });

  test("CPMM after graduation: quotes from the net reserves and the AmmConfig; facts name the graduation pool", async () => {
    const { m, fetcher, view } = world();
    curveComplete(fetcher);
    const mint = llPool(LL.graduated).baseMint;
    m.applyTx(completingBuy());
    await fetcher.flush();
    expect(view.coinFacts(mint)).toEqual({
      launchLabPool: { creator: llPool(LL.graduated).creator, status: 1 },
      launchLabGraduationPool: CPMM.bonk as Address,
    });
    expect(view.quote(mint)?.venue).toBe("launchlab");
    expect(view.quote(mint)?.market && liveQuoteOut("sell", 1_000_000n, view.quote(mint)?.market as never)).toBeNull(); // complete: no quote
    m.applyTx(raydiumGrpc("migrate"));
    await fetcher.flush();
    m.applyTx(raydiumGrpc("cpmmBonkBuy"));
    const q = view.quote(mint);
    expect(q?.venue).toBe("cpmm");
    const rec = m.tokens.get(mint);
    const pool = cpmmPoolOf(CPMM.bonk);
    const baseIs0 = pool.token0Mint === mint;
    const zero = {
      protocolFeesToken0: 0n,
      protocolFeesToken1: 0n,
      fundFeesToken0: 0n,
      fundFeesToken1: 0n,
      creatorFeesToken0: 0n,
      creatorFeesToken1: 0n,
    };
    const independent = {
      venue: "cpmm" as const,
      pool: { ...pool, ...zero },
      vault0Amount: (baseIs0 ? rec?.poolState?.base : rec?.poolState?.quoteVault) as bigint,
      vault1Amount: (baseIs0 ? rec?.poolState?.quoteVault : rec?.poolState?.base) as bigint,
      rates: cpmmFeeRates(ammConfigOf(pool.ammConfig), pool),
      baseMint: mint as Address,
      transferFees: { base: null, quote: null, epoch: 0n },
      baseMintSupply: rec?.supply as bigint,
    };
    expect(liveQuoteOut("buy", 100_000_000n, q?.market as never)).toBe(liveQuoteOut("buy", 100_000_000n, independent));
    expect(view.coinFacts(mint)).toEqual({
      launchLabPool: expect.objectContaining({ status: 2 }),
      launchLabGraduationPool: CPMM.bonk as Address,
    });
    expect(view.migratedPool(mint)).toBe(CPMM.bonk);
  });

  test("staleness: a CPMM leg signed for another pool, and a curve-only order after graduation", async () => {
    const { m, fetcher, view } = world();
    curveComplete(fetcher);
    const mint = llPool(LL.graduated).baseMint;
    m.applyTx(completingBuy());
    await fetcher.flush();
    const creator = llPool(LL.graduated).creator;
    const order = (cpmmMarketAddr: string) => {
      const o = synthOrder({ mint, venues: ["launchlab", "cpmm"], creator });
      o.frozen.venues = [
        { venue: "launchlab", creator, market: LL.graduated as Address, config: llPool(LL.graduated).platformConfig },
        { venue: "cpmm", creator, market: cpmmMarketAddr as Address, config: cpmmPoolOf(CPMM.bonk).ammConfig },
      ];
      return o;
    };
    expect(detectStaleness(order(CPMM.bonk), view.coinFacts(mint))).toEqual([]);
    const moved = classifyStaleness(detectStaleness(order(addr("old-graduation-pool")), view.coinFacts(mint))).stale;
    expect(moved?.reason).toBe("graduation-pool-changed");

    m.applyTx(raydiumGrpc("migrate"));
    const curveOnly = synthOrder({ mint, venues: ["launchlab"], creator });
    curveOnly.frozen.venues = [
      { venue: "launchlab", creator, market: LL.graduated as Address, config: llPool(LL.graduated).platformConfig },
    ];
    expect(classifyStaleness(detectStaleness(curveOnly, view.coinFacts(mint))).stale?.reason).toBe("migrated");
  });
});

// ---------------------------------------------------------------------------------------------
// engine
// ---------------------------------------------------------------------------------------------

describe("engine: Raydium triggers from ingested transactions", () => {
  const dbs: TestDb[] = [];
  const engines: OrderEngine[] = [];
  afterEach(async () => {
    for (const e of engines.splice(0)) await e.stop();
    for (const d of dbs.splice(0)) await d.close();
  });

  async function engineFor(w: ReturnType<typeof world>) {
    const db = await pgliteDb();
    dbs.push(db);
    const repo = new ArmedOrdersRepo(db.db);
    const chain = new FakeChain();
    const submitter = new RecordingSubmitter(false);
    const engine = new OrderEngine({
      cfg: { ...loadOrdersConfig({}), statePersistMs: 0 },
      repo,
      market: w.view,
      chain,
      submitter,
      publish: () => {},
      notify: () => {},
      lookupTables: {},
      baseMintOfPool: (p) => w.m.raydiumBaseMint(p),
      now: () => NOW,
    });
    engines.push(engine);
    await engine.start({ timers: false });
    const store = new UserStore(db.db);
    const userId = (await store.users.upsertOnLogin(addr("raydium-engine-user"), NOW)).id;
    const arm = async (o: ArmedOrder, tokens = o.amount) => {
      for (const a of o.attempts) chain.setNonce(a.nonce.account, o.wallet, a.nonce.value);
      chain.lamports.set(o.wallet, 10_000_000_000n);
      if (o.side === "sell") {
        const { findAssociatedTokenAddress } = await import("@zerofee/core");
        const ata = await findAssociatedTokenAddress(o.wallet, o.mint, o.frozen.baseTokenProgram);
        chain.tokens.set(ata, { mint: o.mint, owner: o.wallet, amount: tokens });
      }
      engine.admit(await repo.insertBatch(userId, [{ order: o, triggerState: {} }], { now: NOW, maxActive: 100 }));
      await engine.settle();
    };
    /** Applies a transaction the way the app's ingest sink does. */
    const ingest = async (tx: IngestTx) => {
      w.m.applyTx(tx);
      engine.onIngestTx(tx);
      await engine.settle();
    };
    return { engine, repo, submitter, arm, ingest };
  }

  test("dev-sell exit on a LaunchLab coin fires when the watched wallet (the swap's payer) sells", async () => {
    const w = world();
    const e = await engineFor(w);
    const mint = llPool(LL.bonk).baseMint;
    w.m.applyTx(raydiumGrpc("bonkBuy"));
    await w.fetcher.flush();
    const seller = rtx("bonkSell").feePayer;
    const o = synthOrder({
      mint,
      kind: "dev-sell-exit",
      side: "sell",
      venues: ["launchlab"],
      amount: 1_000_000_000n,
      minOuts: [1n],
      trigger: { type: "dev-sell", creator: seller },
    });
    const pool = llPool(LL.bonk);
    // what a browser-armed LaunchLab order freezes (a wrong creator would make it stale at once)
    o.frozen.venues = [{ venue: "launchlab", creator: pool.creator, market: LL.bonk as Address, config: pool.platformConfig }];
    await e.arm(o);
    expect(e.submitter.variants).toHaveLength(0);
    await e.ingest(raydiumGrpc("bonkSell"));
    expect(e.submitter.variants).toHaveLength(1);
    expect((await e.repo.get(o.id))?.order.attempts[0]?.submittedVariantId).toContain("/launchlab/");
  });

  test("a CPMM migration snipe fires on migrate_to_cpswap once the graduation pool quotes", async () => {
    const w = world();
    const e = await engineFor(w);
    curveComplete(w.fetcher);
    const mint = llPool(LL.graduated).baseMint;
    w.m.applyTx(completingBuy());
    await w.fetcher.flush();
    const o = synthOrder({
      mint,
      kind: "migration-snipe",
      side: "buy",
      venues: ["cpmm"],
      amount: 10_000_000n,
      minOuts: [1n],
      trigger: { type: "migration" },
    });
    // armed against the derived graduation pool before it exists
    o.frozen.venues = [
      {
        venue: "cpmm",
        creator: llPlatform(llPool(LL.graduated).platformConfig).platformCpCreator,
        market: CPMM.bonk as Address,
        config: cpmmPoolOf(CPMM.bonk).ammConfig,
      },
    ];
    await e.arm(o);
    expect(e.submitter.variants).toHaveLength(0);
    // the pool account / AmmConfig must be read before it quotes: the snipe holds, then fires on the next update
    await e.ingest(raydiumGrpc("migrate"));
    await w.fetcher.flush();
    await e.ingest(raydiumGrpc("cpmmBonkBuy"));
    expect(e.submitter.variants).toHaveLength(1);
    expect((await e.repo.get(o.id))?.order.attempts[0]?.submittedVariantId).toContain("/cpmm/");
  });
});

// ---------------------------------------------------------------------------------------------
// intake
// ---------------------------------------------------------------------------------------------

describe("intake: armed Raydium orders", () => {
  let env: UserTestEnv;
  let tables: AddressesByLookupTableAddress;
  const chain = new FakeChain();

  beforeAll(async () => {
    tables = await operatorTables();
    env = await startUserApp({ orders: { lookupTables: tables, chain, timers: false } });
  }, 60_000);
  afterAll(async () => {
    await env.close();
  });

  async function trader(): Promise<{ b: Browser; signer: KeyPairSigner }> {
    const b = new Browser(env);
    await b.signIn();
    const signer = await armedWallet();
    const r = await b.req("POST", "/api/trading-wallets", { publicKey: signer.address });
    expect(r.status).toBe(200);
    return { b, signer };
  }

  const post = (b: Browser, body: string) => b.json<ArmOrdersResponse & ArmRejection>("POST", "/api/orders/armed", body);
  const codes = (r: { body: ArmRejection }) => [...new Set(r.body.violations.map((v) => v.code))];

  async function sell(
    signer: KeyPairSigner,
    venue: "launchlab" | "cpmm",
    pool: Address,
    over: Partial<ArmedOrderSpec> = {},
    nonceFrom = 0,
  ): Promise<ArmedOrder> {
    const amount = 5_000_000_000n;
    const ctx = venue === "launchlab" ? launchLabArmedContext(signer.address, pool) : cpmmArmedContext(signer.address, pool);
    const live = liveQuoteOut("sell", amount, venue === "launchlab" ? launchLabMarket(pool) : cpmmMarket(pool)) as bigint;
    const template =
      venue === "launchlab"
        ? await launchLabSellTemplate(launchLabArmedContext(signer.address, pool), { amount, closeBaseAccount: true })
        : await cpmmSellTemplate(cpmmArmedContext(signer.address, pool), { amount, closeBaseAccount: true });
    const mint = "baseMint" in ctx ? ctx.baseMint : ctx.pool.baseMint;
    const o = await armOrder(
      {
        id: crypto.randomUUID(),
        kind: "stop-loss",
        wallet: signer.address,
        mint,
        amount,
        fullExit: true,
        trigger: { type: "quote-at-most", threshold: (live * 8n) / 10n },
        templates: [template],
        minOuts: minOutGrid((live * 8n) / 10n, [0, 300]),
        tipLevels: TIP_LEVELS,
        nonces: await nonceRefs(signer.address, 1, nonceFrom),
        armingQuoteOut: live,
        lookupTables: tables,
        ...over,
      },
      signer,
    );
    for (const a of o.attempts) chain.setNonce(a.nonce.account, o.wallet, a.nonce.value);
    return o;
  }

  test("a signed LaunchLab stop-loss and a CPMM stop-loss are accepted", async () => {
    const { b, signer } = await trader();
    const ll = await sell(signer, "launchlab", LL_POOLS.bonk);
    const r1 = await post(b, armedOrderToJson(ll));
    expect(r1.status).toBe(201);
    expect(r1.body.orders[0]).toMatchObject({ id: ll.id, status: "armed", venues: ["launchlab"] });
    const cp = await sell(signer, "cpmm", CPMM_POOLS.bonk, {}, 1);
    const r2 = await post(b, armedOrderToJson(cp));
    expect(r2.status).toBe(201);
    expect(r2.body.orders[0]).toMatchObject({ id: cp.id, status: "armed", venues: ["cpmm"] });
  });

  test("an xStock-quoted LaunchLab order is refused (no SOL value for the caps)", async () => {
    const { b, signer } = await trader();
    const o = await sell(signer, "launchlab", LL_POOLS.stonkXstock);
    const r = await post(b, armedOrderToJson(o));
    expect(r.status).toBe(400);
    expect(codes(r)).toContain("quote-unsupported");
  });

  test("a tampered frozen config fails the signed-bytes check; recipients on a Raydium venue fail the wire check", async () => {
    const { b, signer } = await trader();
    const o = await sell(signer, "launchlab", LL_POOLS.bonk);
    const j = JSON.parse(armedOrderToJson(o));
    j.frozen.venues[0].config = addr("another-platform");
    const r = await post(b, JSON.stringify(j));
    expect(r.status).toBe(400);
    expect(codes(r)).toContain("account-mismatch");

    const k = JSON.parse(armedOrderToJson(o));
    k.frozen.venues[0].feeRecipient = addr("someone");
    const r2 = await post(b, JSON.stringify(k));
    expect(r2.status).toBe(400);
    expect(JSON.stringify(r2.body)).toContain("feeRecipient");
  });
});
