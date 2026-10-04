/**
 * Enrichment, offline: DexScreener (recorded responses), holder reconciliation over a mocked RPC, Helius
 * DAS and funded-by (mocked from the documented response shapes), budgets, back-off and dev history.
 */
import { describe, expect, test } from "bun:test";
import { type Address, getAddressEncoder } from "@solana/kit";
import type { PumpMigrationEvent } from "@zerofee/core";
import { type EnrichConfig, loadEnrichConfig } from "../src/enrich/config";
import { dexPaidFrom, parseOrders, parseProfileMints } from "../src/enrich/dexscreener";
import { Enricher, watchedMints } from "../src/enrich/index";
import { TokenBucket } from "../src/enrich/limiter";
import { setLogLevel } from "../src/log";
import { PulseBoard } from "../src/market/pulse";
import { type MarketConfig, MarketState } from "../src/market/state";
import { openDb } from "../src/storage/db";
import { StorageReader } from "../src/storage/reader";
import { StorageWriter } from "../src/storage/writer";
import { RpcClient } from "../src/util/rpc";
import dex from "./fixtures/dexscreener.json";
import { addr, FakeCurve, FakeResolver, mockFetch, synthTx, waitFor } from "./helpers";

setLogLevel("error");

const T0 = Math.floor(Date.now() / 1000) - 120;
const RPC_URL = "http://rpc.test/";
const PULSE = { finalStretchBps: 6_000, migratedWindowMs: 86_400_000, newMaxAgeMs: 86_400_000, finalMaxIdleMs: 3_600_000, listLimit: 100 };
const enc = getAddressEncoder();

/** A 165-byte SPL token account: mint | owner | amount (u64 LE) | zeros. */
function tokenAccountData(mint: string, owner: string, amount: bigint): string {
  const b = new Uint8Array(165);
  b.set(enc.encode(mint as Address), 0);
  b.set(enc.encode(owner as Address), 32);
  new DataView(b.buffer).setBigUint64(64, amount, true);
  return Buffer.from(b).toString("base64");
}

type Route = (url: string, body: { method?: string; params?: unknown } | null, init?: RequestInit) => [number, unknown] | null;

function setup(env: Record<string, string> = {}, route: Route = () => null, mcfg: Partial<MarketConfig> = {}) {
  const db = openDb(":memory:");
  const writer = new StorageWriter(db, { flushMs: 1_000_000, retentionHours: 72 });
  const reader = new StorageReader(db);
  let enricher: Enricher | null = null;
  const market = new MarketState(
    { sniperSlots: 3, bundleMinBuyers: 4, proTraderWallets: [], insiders: env.HELIUS_API_KEY !== undefined, ...mcfg },
    {
      resolver: new FakeResolver(),
      solUsd: () => 120,
      storage: writer,
      funderOf: (w) => enricher?.funderOf(w) ?? null,
      onLaunch: (r) => enricher?.onLaunch(r),
      onMigrate: (r) => enricher?.onMigrate(r),
    },
  );
  market.persistIntervalMs = 0;
  const pulse = new PulseBoard(PULSE);
  const focused = new Set<string>();
  const http = mockFetch((url, body) => route(url, body) ?? [404, { error: "not mocked" }]);
  const cfg: EnrichConfig = loadEnrichConfig({ ENRICH_RPC_URL: RPC_URL, ENRICH_ACTIVE_TOKENS: "0", ...env });
  enricher = new Enricher({
    cfg,
    market,
    pulse,
    focused: () => focused,
    launches: reader,
    fundingStore: { get: (w) => reader.walletFunder(w), put: (r) => writer.walletFunder(r) },
    fetchFn: http.fn,
    rpc: new RpcClient({ url: RPC_URL, fetchFn: http.fn, cooldownMs: 10 }),
  });
  return { db, writer, reader, market, pulse, focused, http, enricher, cfg };
}

function migrateEvent(c: FakeCurve, ts: number): PumpMigrationEvent {
  return {
    kind: "pumpMigrate",
    user: c.creator as Address,
    mint: c.mint as Address,
    mintAmount: 206_900_000_000_000n,
    solAmount: 84_990_359_530n,
    poolMigrationFee: 15_000_001n,
    bondingCurve: c.bondingCurve as Address,
    timestamp: BigInt(ts),
    pool: addr(`pool:${c.mint}`) as Address,
    quoteMint: "So11111111111111111111111111111111111111112" as Address,
  };
}

/** Ticks like the 1 s timer would (each pass dispatches at most two concurrent requests per service). */
async function ticks(e: Enricher, n: number, at = Date.now()): Promise<void> {
  for (let i = 0; i < n; i++) {
    e.tick(at + i);
    await Bun.sleep(5);
  }
}

function launch(market: MarketState, tag: string, slot = 1_000, creator = addr(`dev-${tag}`)) {
  const mint = addr(`mint-${tag}`);
  const c = new FakeCurve(mint, creator);
  market.applyTx(synthTx(slot, [c.create(T0), c.buy(creator, 1_000_000_000n, T0)]));
  return { mint, c, dev: creator };
}

describe("token bucket", () => {
  test("perWindow(n) never admits more than n requests in any 60 s window, small n included", () => {
    for (const [n, min] of [
      [60, 160],
      [4, 11],
      [1, 3],
    ] as const) {
      const b = TokenBucket.perWindow(n, 5, 0);
      const times: number[] = [];
      for (let t = 0; t <= 180_000; t += 50) if (b.take(1, t)) times.push(t);
      for (const t of times) expect(times.filter((x) => x >= t && x < t + 60_000).length).toBeLessThanOrEqual(n);
      expect(times.length).toBeGreaterThanOrEqual(min); // and it keeps refilling
    }
  });

  test("pause drains and blocks", () => {
    const b = new TokenBucket(5, 60, 0);
    b.pause(10_000, 0);
    expect(b.take(1, 5_000)).toBe(false);
    expect(b.take(1, 11_000)).toBe(true);
  });
});

describe("DexScreener parsing (recorded responses)", () => {
  test("orders: current {orders, boosts} shape and the documented bare array", () => {
    const paid = dexPaidFrom(parseOrders(dex.ordersApproved.body));
    expect(paid).toEqual({ paid: true, paidAt: 1_791_057_256_097 });
    expect(dexPaidFrom(parseOrders(dex.ordersEmpty.body))).toEqual({ paid: false, paidAt: null });
    const legacy = [
      { type: "communityTakeover", status: "approved", paymentTimestamp: 1 },
      { type: "tokenProfile", status: "processing", paymentTimestamp: 2 },
    ];
    expect(dexPaidFrom(parseOrders(legacy)).paid).toBe(false); // a CTO or a pending profile is not Dex Paid
    expect(parseOrders({ nope: 1 })).toEqual([]);
  });

  test("profiles feed: Solana mints only", () => {
    const mints = parseProfileMints(dex.profilesLatest);
    expect(mints).toHaveLength(4);
    expect(mints.every((m) => !m.startsWith("0x"))).toBe(true);
  });
});

describe("Dex Paid scheduling", () => {
  function dexRoute(paid: Set<string>, status = 200): Route {
    return (url) => {
      if (url.endsWith("/token-profiles/latest/v1")) return [status, dex.profilesLatest];
      const m = /\/orders\/v1\/solana\/(\w+)$/.exec(url);
      if (!m) return null;
      if (status !== 200) return [status, {}];
      const mint = m[1] as string;
      return [
        200,
        paid.has(mint)
          ? { orders: [{ type: "tokenProfile", status: "approved", paymentTimestamp: 1_700_000_000_000 }] }
          : dex.ordersEmpty.body,
      ];
    };
  }

  test("focused tokens first, within the per-window budget; a paid token is never re-checked", async () => {
    const paidMint = addr("mint-dex-0");
    const s = setup({ DEXSCREENER_RPM: "20" }, dexRoute(new Set([paidMint])));
    const mints = Array.from({ length: 6 }, (_, i) => launch(s.market, `dex-${i}`).mint);
    for (const m of mints) s.focused.add(m);
    await ticks(s.enricher, 8);
    await waitFor(() => s.enricher.stats.dexChecks === 4);
    // burst 5: one profiles-feed poll + four orders checks; the rest wait for the bucket
    const orderCalls = s.http.calls.filter((c) => c.url.includes("/orders/"));
    expect(orderCalls).toHaveLength(4);
    expect(s.http.calls.filter((c) => c.url.includes("token-profiles"))).toHaveLength(1);
    expect(s.market.summary(paidMint)).toMatchObject({ dexPaid: true, dexPaidAt: 1_700_000_000_000 });
    expect(s.market.summary(mints[1] as string)?.dexPaid).toBe(false);
    expect(s.market.summary(mints[5] as string)?.dexPaid).toBeNull(); // not checked yet: unknown, not false
    await ticks(s.enricher, 8, Date.now() + 120_000);
    await waitFor(() => s.http.calls.filter((c) => c.url.includes("/orders/")).length >= 6);
    expect(s.http.calls.filter((c) => c.url.endsWith(`/orders/v1/solana/${paidMint}`))).toHaveLength(1);
  });

  test("a token that appears in the paid-profiles feed is checked even when nothing shows it", async () => {
    const s = setup({}, dexRoute(new Set([dex.ordersApproved.mint])));
    // seed the record directly: a token we track that is not focused or listed
    s.market.applyTx(synthTx(5, [new FakeCurve(dex.ordersApproved.mint, addr("profile-dev")).create(T0)]));
    s.enricher.tick();
    await waitFor(() => s.enricher.stats.profileHits === 1);
    s.enricher.tick();
    await waitFor(() => s.market.summary(dex.ordersApproved.mint)?.dexPaid === true);
  });

  test("HTTP 429 pauses DexScreener calls", async () => {
    const s = setup({}, dexRoute(new Set(), 429));
    s.focused.add(launch(s.market, "dex-429").mint);
    s.enricher.tick();
    await waitFor(() => s.enricher.stats.dexErrors >= 1);
    const n = s.http.calls.length;
    s.enricher.tick(Date.now() + 1_000);
    await Bun.sleep(20);
    expect(s.http.calls.length).toBe(n);
    expect(s.enricher.notes()[0]).toContain("HTTP 429");
  });
});

describe("holder reconciliation", () => {
  test("largest accounts over RPC: owners read, curve excluded, transfer recipients added, source rpc", async () => {
    let largestCalls = 0;
    const s = setup({ DEXSCREENER_ENABLED: "false" }, (url, body) => {
      if (url !== RPC_URL) return null;
      const accts = { a1: addr("acct-1"), a2: addr("acct-2"), a3: addr("acct-3") };
      if (body?.method === "getTokenLargestAccounts") {
        largestCalls++;
        return [
          200,
          {
            jsonrpc: "2.0",
            id: 1,
            result: { context: { slot: 1_050 }, value: Object.values(accts).map((address) => ({ address, amount: "1" })) },
          },
        ];
      }
      if (body?.method === "getMultipleAccounts") {
        const mint = addr("mint-rpc");
        const data: Record<string, string> = {
          [accts.a1]: tokenAccountData(mint, addr(`curve:${mint}`), 700_000_000_000_000n),
          [accts.a2]: tokenAccountData(mint, addr("receiver"), 40_000_000_000_000n),
          [accts.a3]: tokenAccountData(mint, addr("dev-rpc"), 1n),
        };
        const keys = (body.params as [string[]])[0];
        return [
          200,
          {
            jsonrpc: "2.0",
            id: 1,
            result: {
              context: { slot: 1_051 },
              value: keys.map((k) => ({
                owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                lamports: 2_039_280,
                data: [data[k], "base64"],
              })),
            },
          },
        ];
      }
      return null;
    });
    const { mint } = launch(s.market, "rpc");
    s.focused.add(mint);
    s.enricher.tick();
    await waitFor(() => s.enricher.stats.rpcChecks === 1);
    const sum = s.market.summary(mint);
    expect(sum).toMatchObject({ holdersSource: "rpc", holders: 2 }); // dev (1 base unit left) + receiver
    expect(sum?.holdersCheckedAt).toBeGreaterThan(0);
    expect(sum?.top10Pct).toBeCloseTo(4, 3); // 40M of 1B; the curve's 700M is excluded
    expect(s.market.tokens.get(mint)?.holders?.transferRecipients()).toEqual([addr("receiver")]);
    expect(largestCalls).toBe(1);
  });

  test("a refused getTokenLargestAccounts (public RPC) backs off instead of retrying every tick", async () => {
    let calls = 0;
    const s = setup({ DEXSCREENER_ENABLED: "false" }, (url, body) => {
      if (url === RPC_URL && body?.method === "getTokenLargestAccounts") {
        calls++;
        return [429, { jsonrpc: "2.0", error: { code: 429, message: "Too many requests for a specific RPC call" } }];
      }
      return null;
    });
    const { mint } = launch(s.market, "rpc-429");
    s.focused.add(mint);
    s.enricher.tick();
    await waitFor(() => s.enricher.stats.holderErrors === 1);
    s.enricher.tick(Date.now() + 40_000); // focused interval passed, back-off (60 s) not
    await Bun.sleep(20);
    expect(calls).toBe(1);
    expect(s.enricher.notes()[1]).toContain("rate-limited by the RPC");
    expect(s.market.summary(mint)?.holdersSource).toBe("trades");
  });

  test("Helius DAS full scan: exact holder set, source das; a 403 falls back to the RPC", async () => {
    const pages: number[] = [];
    let refuse = false;
    const s = setup(
      { DEXSCREENER_ENABLED: "false", HELIUS_API_KEY: "test-key", HELIUS_DAS_PAGE_SIZE: "2", HELIUS_FUNDED_BY_PER_MIN: "0" },
      (url, body) => {
        if (url !== RPC_URL || body?.method !== "getTokenAccounts") return null;
        if (refuse) return [403, { error: "forbidden" }];
        const p = body.params as { mint: string; page: number; limit: number; options: { showZeroBalance: boolean } };
        pages.push(p.page);
        expect(p.options.showZeroBalance).toBe(false);
        const all = [
          { address: addr("ta-1"), mint: p.mint, owner: addr("holder-1"), amount: 5_000_000, delegated_amount: 0, frozen: false },
          { address: addr("ta-2"), mint: p.mint, owner: addr("holder-2"), amount: 7_000_000, delegated_amount: 0, frozen: false },
          { address: addr("ta-3"), mint: p.mint, owner: addr("holder-1"), amount: 1_000_000, delegated_amount: 0, frozen: false },
        ];
        const slice = all.slice((p.page - 1) * p.limit, p.page * p.limit);
        return [
          200,
          {
            jsonrpc: "2.0",
            id: "zerofee",
            result: { last_indexed_slot: 1_070, total: slice.length, limit: p.limit, token_accounts: slice },
          },
        ];
      },
    );
    const { mint, dev } = launch(s.market, "das");
    s.focused.add(mint);
    s.enricher.tick();
    await waitFor(() => s.enricher.stats.dasScans === 1);
    expect(pages).toEqual([1, 2]); // page 2 returned 1 of 2: last page
    const book = s.market.tokens.get(mint)?.holders;
    expect([book?.balanceOf(addr("holder-1")), book?.balanceOf(addr("holder-2")), book?.balanceOf(dev)]).toEqual([
      6_000_000n,
      7_000_000n,
      0n,
    ]);
    expect(s.market.summary(mint)).toMatchObject({ holders: 2, holdersSource: "das" });
    refuse = true;
    s.enricher.tick(Date.now() + 60_000);
    await waitFor(() => s.enricher.stats.holderErrors === 1);
    expect(s.enricher.notes()[1]).toContain("DAS refused (HTTP 403)");
  });
});

describe("insiders and shared-funder bundles (Helius funded-by)", () => {
  function fundingRoute(
    funders: Record<string, { funder: string; funderType?: string } | null>,
    counter: { n: number },
    status = 200,
  ): Route {
    return (url) => {
      const m = /\/v1\/wallet\/(\w+)\/funded-by$/.exec(url);
      if (!m) return null;
      counter.n++;
      if (status !== 200) return [status, { error: "nope" }];
      const f = funders[m[1] as string];
      if (!f) return [404, { error: "No funding transaction found" }];
      return [
        200,
        {
          funder: f.funder,
          funderName: f.funderType === "exchange" ? "Coinbase 2" : null,
          funderType: f.funderType ?? null,
          mint: "So11111111111111111111111111111111111111112",
          symbol: "SOL",
          amount: 0.5,
          amountRaw: "500000000",
          decimals: 9,
          signature: "sig",
          timestamp: 1_791_000_000,
          date: "2026-10-03T00:00:00.000Z",
          slot: 400_000_000,
          explorerUrl: "https://orbmarkets.io/tx/sig",
        },
      ];
    };
  }

  test("creator-funded holders within two hops are insiders; exchange-funded are not; results are cached forever", async () => {
    const dev = addr("dev-ins");
    const funders = {
      [addr("hop1")]: { funder: dev },
      [addr("hop2")]: { funder: addr("middle") },
      [addr("middle")]: { funder: dev },
      [addr("cex")]: { funder: addr("binance-hot"), funderType: "exchange" },
    };
    const counter = { n: 0 };
    const s = setup(
      { DEXSCREENER_ENABLED: "false", HOLDERS_RECONCILE: "false", HELIUS_API_KEY: "k", HELIUS_FUNDED_BY_PER_MIN: "600" },
      fundingRoute(funders, counter),
    );
    const { mint, c } = launch(s.market, "ins", 1_000, dev);
    for (const [i, w] of ["hop1", "hop2", "cex", "nobody"].entries())
      s.market.applyTx(synthTx(1_010 + i, [c.buy(addr(w), 1_000_000_000n, T0 + 5)]));
    expect(s.market.summary(mint)?.insidersPct).toBeNull();
    s.focused.add(mint);
    s.enricher.tick();
    await waitFor(() => s.enricher.stats.insiderRuns === 1);
    const book = s.market.tokens.get(mint)?.holders;
    expect([...(book?.fundedInsiders ?? [])].sort()).toEqual([addr("hop1"), addr("hop2")].sort());
    const pct = s.market.summary(mint)?.insidersPct ?? 0;
    const expected =
      Number((((book?.balanceOf(addr("hop1")) ?? 0n) + (book?.balanceOf(addr("hop2")) ?? 0n)) * 1_000_000n) / 1_000_000_000_000_000n) /
      10_000;
    expect(pct).toBeCloseTo(expected, 6);
    expect(counter.n).toBe(5); // hop1, hop2 + middle, cex (exchange: no second hop), nobody (404)
    s.writer.flush();
    expect((s.db.query("SELECT COUNT(*) AS n FROM wallet_funders").get() as { n: number }).n).toBe(5);
    expect(s.reader.walletFunder(addr("nobody"))?.funder).toBeNull();
    // a fresh process (empty memory cache) reads SQLite, not Helius
    const s2 = setup({ HELIUS_API_KEY: "k" }, fundingRoute(funders, counter));
    for (const w of ["hop1", "middle", "cex", "nobody"]) {
      const row = s.reader.walletFunder(addr(w));
      if (row) s2.writer.walletFunder(row);
    }
    s2.writer.flush();
    const before = counter.n;
    expect(await s2.enricher.funding.resolve(addr("hop1"))).toMatchObject({ funder: dev });
    expect(s2.enricher.funding.funderOf(addr("cex"))).toBeNull(); // exchange funders never cluster
    expect(counter.n).toBe(before);
  });

  test("buyers of a crowded slot that share a funder become bundlers after the lookup", async () => {
    const funders: Record<string, { funder: string }> = {};
    for (const w of ["b1", "b2", "b3", "b4"]) funders[addr(w)] = { funder: addr("bundle-funder") };
    const s = setup(
      { DEXSCREENER_ENABLED: "false", HOLDERS_RECONCILE: "false", HELIUS_API_KEY: "k", HELIUS_FUNDED_BY_PER_MIN: "600" },
      fundingRoute(funders, { n: 0 }),
    );
    const { mint, c } = launch(s.market, "bund");
    ["b1", "b2", "b3", "b4"].forEach((w, i) => {
      s.market.applyTx(synthTx(1_020, [c.buy(addr(w), BigInt(i + 1) * 900_000_000n, T0 + 9)]));
    });
    expect(s.market.tokens.get(mint)?.holders?.bundlers.size).toBe(0);
    s.focused.add(mint);
    s.enricher.tick();
    await waitFor(() => s.enricher.stats.bundlesAdded === 4);
    expect(s.market.summary(mint)?.bundlersPct).toBeGreaterThan(0);
  });

  test("a plan without funded-by (403) disables the lookups; insidersPct stays null", async () => {
    const counter = { n: 0 };
    const s = setup({ DEXSCREENER_ENABLED: "false", HOLDERS_RECONCILE: "false", HELIUS_API_KEY: "k" }, fundingRoute({}, counter, 403));
    const { mint, c } = launch(s.market, "ins-403");
    s.market.applyTx(synthTx(1_001, [c.buy(addr("w"), 1_000_000_000n, T0)]));
    s.focused.add(mint);
    s.enricher.tick();
    await waitFor(() => counter.n === 1);
    await waitFor(() => !s.enricher.funding.available);
    expect(s.market.summary(mint)?.insidersPct).toBeNull();
    expect(s.enricher.notes()[2]).toContain("needs a paid Helius plan");
    s.enricher.tick(Date.now() + 600_000);
    await Bun.sleep(20);
    expect(counter.n).toBe(1);
  });

  test("without HELIUS_API_KEY nothing is looked up and insidersPct is null", () => {
    const s = setup({ DEXSCREENER_ENABLED: "false", HOLDERS_RECONCILE: "false" });
    const { mint } = launch(s.market, "ins-off");
    s.focused.add(mint);
    s.enricher.tick();
    expect(s.http.calls).toHaveLength(0);
    expect(s.market.summary(mint)?.insidersPct).toBeNull();
    expect(s.enricher.notes()[2]).toContain("no HELIUS_API_KEY");
  });
});

describe("dev history", () => {
  test("earlier launches and migrations from the database; a later migration updates newer tokens", () => {
    const s = setup({ DEXSCREENER_ENABLED: "false", HOLDERS_RECONCILE: "false" });
    const dev = addr("serial-dev");
    const t = (min: number) => Math.floor(Date.now() / 1000) - min * 60;
    // three earlier launches already in the database, one migrated
    const old = [0, 1, 2].map((i) => {
      const c = new FakeCurve(addr(`old-${i}`), dev);
      s.market.applyTx(synthTx(100 + i, [c.create(t(300 - i))]));
      return c;
    });
    s.market.applyTx(synthTx(150, [migrateEvent(old[0] as FakeCurve, t(250))]));
    s.writer.flush();
    for (const c of old) s.market.tokens.delete(c.mint); // evicted from memory; the database remembers
    // a new launch by the same creator, and one by somebody else
    const fresh = launch(s.market, "fresh", 200, dev);
    const other = launch(s.market, "other", 201);
    s.enricher.tick();
    expect(s.market.summary(fresh.mint)).toMatchObject({ devLaunches: 3, devMigrated: 1 });
    expect(s.market.summary(other.mint)).toMatchObject({ devLaunches: 0, devMigrated: 0 });
    // an earlier launch (still in memory) migrates later: the newer token sees one more migrated predecessor
    const mid = new FakeCurve(addr("mid"), dev);
    s.market.applyTx(synthTx(210, [mid.create(t(100))]));
    s.enricher.tick();
    s.market.applyTx(synthTx(220, [migrateEvent(mid, t(50))]));
    s.enricher.tick();
    expect(s.market.summary(fresh.mint)).toMatchObject({ devLaunches: 4, devMigrated: 2 });
  });
});

test("watchedMints maps token-page topics to mints", () => {
  const topics = [`token:${addr("a")}`, `trades:${addr("b")}`, `candles:${addr("c")}:1s`, `tradectx:${addr("a")}`, "pulse:new"];
  const hub = {
    *subscribed(prefix: string) {
      for (const t of topics) if (t.startsWith(prefix)) yield t;
    },
  };
  expect(watchedMints(hub).sort()).toEqual([addr("a"), addr("b"), addr("c")].sort());
});
