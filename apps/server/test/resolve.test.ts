/**
 * Opening any mint by address (market/resolve.ts) against real mainnet accounts (core's offline snapshots): a pump
 * curve coin, a migrated pump coin (canonical PumpSwap pool), a LaunchLab coin, a graduated LaunchLab coin (CPMM),
 * a pool address (redirect), a wallet (not a token), a mint without a venue (Jupiter or "no_venue"); the abuse
 * limits; storage reloads; and the REST / WebSocket surface of the whole server.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { WSOL_MINT } from "@zerofee/core";
import mainSnap from "../../../packages/core/test/fixtures/mainnet-accounts.json";
import metaSnap from "../../../packages/core/test/fixtures/metadata-accounts.json";
import raySnap from "../../../packages/core/test/fixtures/raydium-mainnet.json";
import { RaydiumRegistry } from "../src/accounts/raydium";
import { AccountResolver } from "../src/accounts/resolver";
import type { ResolveConfig } from "../src/config";
import { setLogLevel } from "../src/log";
import { isMintAddress, MintResolver, type MintResolverDeps, type ResolveOutcome } from "../src/market/resolve";
import { MarketState } from "../src/market/state";
import { openDb } from "../src/storage/db";
import { StorageReader } from "../src/storage/reader";
import { StorageWriter } from "../src/storage/writer";
import { RpcClient } from "../src/util/rpc";
import { mockFetch, waitFor } from "./helpers";

setLogLevel("error");

type Acc = { owner: string; lamports: string; data: string };
const ACCOUNTS: Record<string, Acc> = {
  ...(mainSnap.accounts as Record<string, Acc>),
  ...(raySnap.accounts as Record<string, Acc>),
  ...(metaSnap.accounts as Record<string, Acc>),
};

/** pump.fun coin on its curve (curve 2kZ7…). */
const CURVE_COIN = mainSnap.curveMint;
/** Migrated pump coin: canonical PumpSwap pool 5Rxf… with both vaults in the snapshot. */
const POOL_COIN = "3fr6BBobNvytZQPVLj8o5o7vToBZf7E5tc9zmJvSpump";
const POOL = mainSnap.pool;
/** letsbonk.fun coin on its LaunchLab curve (pool 6kgX…, SOL quote). */
const LL_COIN = "5ojxCYwee4AgDRH4NxwCEXCGiMiKiYYB5r4Ycdo6bonk";
const LL_POOL = "6kgXHSnUa2g9n2VH6aGL9GYBEuQJYxVLwNzSsgNqmrYo";
/** letsbonk.fun coin that graduated into CPMM 92WC… */
const GRAD_COIN = "7dmcQ9TyPDcfTTjfCfcZhuwK79FThVuKqmzVM9uKpRhK";
const GRAD_CPMM = "92WCdsbayLJNUFAL3EQypWJLTL8gvmSpXMh6qZxo6PHh";
/** SPL mint with Metaplex metadata and no venue. */
const BARE_MINT = metaSnap.legacyMint;
/** No account at all (a fresh keypair-like address). */
const NOBODY = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

const CFG: ResolveConfig = {
  enabled: true,
  perMin: 600,
  burst: 100,
  maxConcurrent: 4,
  timeoutMs: 5_000,
  pinMs: 60_000,
  jupiterProbe: false,
};

function fixtureRpc(o: { delayMs?: number } = {}) {
  const m = mockFetch((_url, body) => {
    if (body?.method !== "getMultipleAccounts") return [200, { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "not mocked" } }];
    const addrs = (body.params?.[0] as string[]) ?? [];
    return [
      200,
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          context: { slot: 400_000_000 },
          value: addrs.map((a) => {
            const f = ACCOUNTS[a];
            return f ? { owner: f.owner, lamports: Number(f.lamports), data: [f.data, "base64"] } : null;
          }),
        },
      },
    ];
  });
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    if (o.delayMs) await Bun.sleep(o.delayMs);
    return m.fn(input, init);
  }) as typeof fetch;
  return { rpc: new RpcClient({ url: "http://rpc.test", fetchFn, maxConcurrent: 16 }), calls: m.calls };
}

interface World {
  market: MarketState;
  resolver: AccountResolver;
  r: MintResolver;
  calls: { method: string; body: { params?: unknown[] } | null }[];
  requested: { mint: string; priority: number | undefined; reason: string | undefined }[];
  reader: StorageReader;
  writer: StorageWriter;
}

const resolvers: AccountResolver[] = [];
afterEach(() => {
  for (const r of resolvers.splice(0)) r.stop();
});

function world(o: Omit<Partial<MintResolverDeps>, "cfg"> & { cfg?: Partial<ResolveConfig>; delayMs?: number } = {}): World {
  const { rpc, calls } = fixtureRpc({ delayMs: o.delayMs });
  const db = openDb(":memory:");
  const writer = new StorageWriter(db, { flushMs: 1_000_000, retentionHours: 72 });
  const reader = new StorageReader(db);
  let market: MarketState | null = null;
  const resolver = new AccountResolver(
    rpc,
    {
      pool: (p) => market?.onPoolReady(p),
      mint: (mm) => market?.onMintResolved(mm),
      curve: (c) => market?.onCurveResolved(c),
      metaplex: (mint, md) => market?.onMetaplexResolved(mint, md),
    },
    { batchIntervalMs: 10, retryDelayMs: 10 },
  );
  resolvers.push(resolver);
  resolver.start();
  const raydium = new RaydiumRegistry(resolver, {
    launchLabPool: (info) => market?.onLaunchLabPoolReady(info),
    launchLabPoolMissing: (pool) => market?.onLaunchLabPoolMissing(pool),
    platform: (address) => market?.onPlatformConfig(address),
    cpmmPool: (info) => market?.onCpmmPoolReady(info),
    cpmmRejected: (pool) => market?.onCpmmRejected(pool),
  });
  market = new MarketState(
    { sniperSlots: 3, bundleMinBuyers: 4, proTraderWallets: [] },
    { resolver, raydium, solUsd: () => 150, storage: writer },
  );
  market.persistIntervalMs = 0;
  const requested: World["requested"] = [];
  const r = new MintResolver({
    cfg: { ...CFG, ...o.cfg },
    market,
    store: reader,
    accounts: resolver,
    raydium,
    history: { request: (mint, priority, reason) => requested.push({ mint, priority, reason }) },
    jupiterRoutes: o.jupiterRoutes ?? null,
    ...(o.now ? { now: o.now } : {}),
  });
  return { market, resolver, r, calls: calls as World["calls"], requested, reader, writer };
}

const ok = (o: ResolveOutcome) => {
  if (!o.ok) throw new Error(`expected a token, got ${o.status} ${o.message}`);
  return o;
};

describe("on-demand resolve per venue", () => {
  test("pump curve coin: price, market cap, liquidity, progress, supply and a pump trade context from one batched read", async () => {
    const w = world();
    const out = ok(await w.r.resolve(CURVE_COIN, "client"));
    expect(out.source).toBe("chain");
    expect(out.token).toMatchObject({ mint: CURVE_COIN, launchpad: "pump", migrated: false, decimals: 6 });
    expect(out.token.priceSol).toBeGreaterThan(0);
    expect(out.token.mcSol).toBeGreaterThan(0);
    expect(out.token.liquidity).toBeGreaterThan(0);
    expect(out.token.bondingProgressBps).toBeGreaterThan(0);
    expect(out.token.supply).toBeGreaterThan(0);
    expect(out.tradeContext).toMatchObject({ venue: "pump", mint: CURVE_COIN });
    // round 1: mint + metadata + curve + PumpSwap pool + 2 LaunchLab pools, in one getMultipleAccounts
    const first = w.calls.find((c) => c.method === "getMultipleAccounts");
    expect((first?.body?.params?.[0] as string[] | undefined)?.length).toBe(6);
    expect(w.calls.filter((c) => c.method === "getMultipleAccounts")).toHaveLength(1);
    // backfill at viewed priority
    expect(w.requested).toEqual([{ mint: CURVE_COIN, priority: 0, reason: "resolve" }]);
    // reserves anchored at the read's slot: an older backfilled trade cannot take over the price
    expect(w.market.tokens.get(CURVE_COIN)?.curveKey?.[0]).toBe(400_000_000);
    expect(w.r.pinned(CURVE_COIN)).toBe(true);
  });

  test("migrated pump coin: canonical PumpSwap pool and its vault reserves, a pumpswap trade context", async () => {
    const w = world();
    const out = ok(await w.r.resolve(POOL_COIN, "client"));
    expect(out.token).toMatchObject({ mint: POOL_COIN, launchpad: "pump", migrated: true, complete: true, pool: POOL });
    expect(out.token.priceSol).toBeGreaterThan(0);
    expect(out.token.liquidity).toBeGreaterThan(0);
    expect(out.tradeContext).toMatchObject({ venue: "pumpswap", pool: POOL, isCanonical: true });
    // the pool's signed virtual quote reserves are part of the price
    expect(out.tradeContext && "virtualQuoteReserves" in out.tradeContext ? out.tradeContext.virtualQuoteReserves : "0").not.toBe("0");
    expect(w.calls.filter((c) => c.method === "getMultipleAccounts")).toHaveLength(2);
  });

  test("LaunchLab coin: the pool and its platform / global configs, label, a launchlab trade context", async () => {
    const w = world();
    const out = ok(await w.r.resolve(LL_COIN, "client"));
    expect(out.token).toMatchObject({ mint: LL_COIN, launchpad: "launchlab", migrated: false, platform: "letsbonk.fun" });
    expect(out.token.priceSol).toBeGreaterThan(0);
    expect(out.token.bondingProgressBps).toBeGreaterThan(0);
    expect(out.tradeContext).toMatchObject({ venue: "launchlab", pool: LL_POOL });
    expect(w.requested[0]).toMatchObject({ mint: LL_COIN, priority: 0 });
  });

  test("graduated LaunchLab coin: its CPMM graduation pool, priced from the vaults, a cpmm trade context", async () => {
    const w = world();
    const out = ok(await w.r.resolve(GRAD_COIN, "client"));
    expect(out.token).toMatchObject({ mint: GRAD_COIN, launchpad: "launchlab", migrated: true, pool: GRAD_CPMM });
    expect(out.token.priceSol).toBeGreaterThan(0);
    expect(out.tradeContext).toMatchObject({ venue: "cpmm", pool: GRAD_CPMM });
  });

  test("a pool address is not a token, and names the coin's mint", async () => {
    const w = world();
    const out = await w.r.resolve(POOL, "client");
    expect(out).toMatchObject({ ok: false, status: 404, reason: "not_a_token", redirect: POOL_COIN });
    const cp = await w.r.resolve(GRAD_CPMM, "client");
    expect(cp).toMatchObject({ ok: false, reason: "not_a_token", redirect: GRAD_COIN });
  });

  test("an address with no account is not a token; the answer is cached (no second read)", async () => {
    const w = world();
    expect(await w.r.resolve(NOBODY, "client")).toMatchObject({ ok: false, status: 404, reason: "not_a_token" });
    const reads = w.calls.length;
    expect(await w.r.resolve(NOBODY, "client")).toMatchObject({ ok: false, reason: "not_a_token" });
    expect(w.calls.length).toBe(reads);
    expect(w.market.tokens.has(NOBODY)).toBe(false);
  });

  test("a mint with no venue: 'no_venue' without a Jupiter route, a Jupiter-routed 'other' record with one", async () => {
    const none = world({ jupiterRoutes: async () => false });
    expect(await none.r.resolve(BARE_MINT, "client")).toMatchObject({ ok: false, status: 404, reason: "no_venue" });
    expect(none.market.tokens.has(BARE_MINT)).toBe(false);

    const asked: string[] = [];
    const jup = world({
      jupiterRoutes: async (m) => {
        asked.push(m);
        return true;
      },
    });
    const out = ok(await jup.r.resolve(BARE_MINT, "client"));
    expect(asked).toEqual([BARE_MINT]);
    expect(out.token).toMatchObject({ launchpad: "other", symbol: "TALUN", priceSol: null });
    expect(out.tradeContext).toBeNull();
    expect(jup.requested).toHaveLength(0); // nothing to walk
  });

  test("a coin already priced in memory answers without any read", async () => {
    const w = world();
    ok(await w.r.resolve(CURVE_COIN, "client"));
    const reads = w.calls.length;
    const again = ok(await w.r.resolve(CURVE_COIN, "client"));
    expect(again.source).toBe("memory");
    expect(w.calls.length).toBe(reads);
  });

  test("a pruned coin comes back from storage, then its reserves are refreshed from chain", async () => {
    const w = world();
    ok(await w.r.resolve(CURVE_COIN, "client"));
    const rec = w.market.tokens.get(CURVE_COIN);
    if (!rec) throw new Error("no record");
    rec.name = "Stored Name";
    rec.curve = { vToken: 1n, vQuote: 1n, rToken: 1n, rQuote: 1n }; // stale, persisted
    w.market.evictIdle(-1, () => false); // persists and drops it
    await w.writer.drain();
    expect(w.market.tokens.has(CURVE_COIN)).toBe(false);
    const fresh = world();
    // same database
    (fresh.r as unknown as { d: { store: StorageReader } }).d.store = w.reader;
    const out = ok(await fresh.r.resolve(CURVE_COIN, "client"));
    expect(out.source).toBe("store");
    expect(out.token.name).toBe("Stored Name");
    expect(fresh.market.tokens.get(CURVE_COIN)?.curve?.vToken).toBeGreaterThan(1n);
  });
});

describe("abuse limits", () => {
  test("malformed input is refused before any read", async () => {
    const w = world();
    for (const bad of ["", "abc", "0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl", `${CURVE_COIN}x`, "../../etc/passwd"]) {
      expect(await w.r.resolve(bad, "client")).toMatchObject({ ok: false, status: 400 });
    }
    expect(w.calls).toHaveLength(0);
    expect(isMintAddress(CURVE_COIN)).toBe(true);
    expect(isMintAddress("1111111111111111111111111111111")).toBe(false); // 31 chars
  });

  test("chain resolves are rate limited per client; other clients are not affected", async () => {
    const w = world({ cfg: { perMin: 1, burst: 2 } });
    expect((await w.r.resolve(CURVE_COIN, "a")).ok).toBe(true);
    expect((await w.r.resolve(POOL_COIN, "a")).ok).toBe(true);
    const third = await w.r.resolve(LL_COIN, "a");
    expect(third).toMatchObject({ ok: false, status: 429, code: "rate_limited" });
    expect(third.ok === false && third.retryAfterSec).toBeGreaterThan(0);
    // memory hits cost nothing
    expect((await w.r.resolve(CURVE_COIN, "a")).ok).toBe(true);
    expect((await w.r.resolve(LL_COIN, "b")).ok).toBe(true);
  });

  test("concurrent resolves are capped server-wide (503, retry); one mint asked twice shares one resolve", async () => {
    const w = world({ cfg: { maxConcurrent: 1 }, delayMs: 60 });
    const a1 = w.r.resolve(CURVE_COIN, "a");
    const a2 = w.r.resolve(CURVE_COIN, "b"); // same mint: shared
    const b = await w.r.resolve(POOL_COIN, "c"); // another mint while the slot is taken
    expect(b).toMatchObject({ ok: false, status: 503, code: "unavailable" });
    const [r1, r2] = await Promise.all([a1, a2]);
    expect(r1.ok && r2.ok).toBe(true);
    // the shared resolve read round 1 once
    expect(w.calls.filter((c) => c.method === "getMultipleAccounts")).toHaveLength(1);
    expect(w.r.running).toBe(0);
  });

  test("a resolved coin is pinned (kept from the idle eviction) until its pin expires", async () => {
    let skew = 0;
    const w = world({ cfg: { pinMs: 60_000 }, now: () => Date.now() + skew });
    ok(await w.r.resolve(CURVE_COIN, "client"));
    expect(w.r.pinned(CURVE_COIN)).toBe(true);
    expect(w.market.evictIdle(-1, (m) => w.r.pinned(m))).toBe(0);
    skew = 61_000;
    expect(w.r.pinned(CURVE_COIN)).toBe(false);
  });

  test("a resolve that outlasts the timeout answers 503 (retry) while it keeps going", async () => {
    const w = world({ cfg: { timeoutMs: 500 }, delayMs: 700 });
    expect(await w.r.resolve(CURVE_COIN, "client")).toMatchObject({ ok: false, status: 503 });
    await waitFor(() => w.r.running === 0, 5_000);
    expect(w.market.tokens.get(CURVE_COIN)?.curve).not.toBeNull();
    expect(WSOL_MINT).toBeTruthy();
  });
});
