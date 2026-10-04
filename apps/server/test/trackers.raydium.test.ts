/**
 * Wallet tracker and copy trading on Raydium trades (real LaunchLab / CPMM transactions from core's snapshot
 * through the real MarketState): Raydium events carry no wallet, so matching keys on the swap
 * instruction's payer; logs-only records (no wallet) match nobody; LaunchLab launches by tracked devs; a
 * copy-task leader's LaunchLab buy becomes a copy signal on venue "launchlab".
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DEFAULT_COPY_CONFIG, type TrackedWalletAlerts } from "@zerofee/protocol";
import { RaydiumRegistry } from "../src/accounts/raydium";
import { UserStore } from "../src/db/pg";
import type { IngestTx } from "../src/ingest/types";
import { setLogLevel } from "../src/log";
import { MarketState } from "../src/market/state";
import { TrackerService } from "../src/trackers/service";
import { addr, FakeResolver } from "./helpers";
import { pgliteDb, type TestDb } from "./pgHelpers";
import { FixtureFetcher, LL, llPool, raydiumGrpc, raydiumLogs, rtx } from "./raydiumFixtures";
import { FakeHub, trackerConfig } from "./trackerHelpers";

setLogLevel("error");
let t: TestDb;
let store: UserStore;

beforeAll(async () => {
  t = await pgliteDb();
  store = new UserStore(t.db);
}, 60_000);
afterAll(async () => {
  await t.close();
});

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const NO_ALERTS: TrackedWalletAlerts = { buy: false, sell: false, create: false, minSol: 0 };
let n = 0;

function env() {
  const hub = new FakeHub();
  const svc = new TrackerService({ cfg: trackerConfig(), db: t.db, store, alerts: { onWalletActivity: () => {} }, now: () => NOW });
  svc.attachHub(hub);
  const fetcher = new FixtureFetcher();
  let market: MarketState | null = null;
  const reg = new RaydiumRegistry(fetcher, {
    launchLabPool: (i) => market?.onLaunchLabPoolReady(i),
    platform: (a) => market?.onPlatformConfig(a),
    cpmmPool: (i) => market?.onCpmmPoolReady(i),
  });
  market = new MarketState(
    { sniperSlots: 3, bundleMinBuyers: 4, proTraderWallets: [] },
    { resolver: new FakeResolver(), solUsd: () => 150, now: () => NOW, onTrade: (tr, tx) => svc.onTrade(tr, tx), raydium: reg },
  );
  svc.attachMarket(market, () => 150);
  const m = market;
  const ingest = (tx: IngestTx) => {
    m.applyTx(tx);
    svc.onTx(tx);
  };
  return { svc, hub, market: m, fetcher, ingest };
}

async function user(tag: string): Promise<string> {
  return (await store.users.upsertOnLogin(addr(`ray-${tag}-${++n}`), NOW)).id;
}

async function track(svc: TrackerService, userId: string, address: string, label: string): Promise<void> {
  await store.tracked.upsertMany(userId, [{ address, label, emoji: "", tags: [], alerts: NO_ALERTS }], {
    now: NOW,
    max: 10_000,
    overwriteAlerts: true,
  });
  await svc.reloadTracked(userId);
}

describe("tracked wallets on Raydium", () => {
  test("a LaunchLab trade matches its payer (gRPC); the logs-only record of the same trade matches nobody", async () => {
    const e = env();
    const alice = await user("alice");
    const wallet = rtx("bonkBuy").feePayer;
    await track(e.svc, alice, wallet, "bonk whale");
    e.hub.subs.add(`tracked@${alice}`);
    e.ingest(raydiumLogs("bonkBuy", { receivedAt: NOW }));
    await e.fetcher.flush();
    e.svc.feed.flush();
    expect(e.hub.rows(`tracked@${alice}`)).toEqual([]);

    const tx = raydiumGrpc("bonkBuy", { receivedAt: NOW, signature: "grpc".padEnd(88, "4"), slot: rtx("bonkBuy").slot + 1 });
    e.ingest(tx);
    e.svc.feed.flush();
    const [row] = e.hub.rows(`tracked@${alice}`);
    expect(row).toMatchObject({
      kind: "buy",
      wallet,
      role: "trader",
      trader: wallet,
      mint: llPool(LL.bonk).baseMint,
      launchpad: "launchlab",
      venue: "launchlab",
      signature: tx.signature,
      label: "bonk whale",
    });
    expect(row.amountSol).toBeGreaterThan(0);
  });

  test("CPMM swaps on a graduation pool match too", async () => {
    const e = env();
    const alice = await user("alice");
    const wallet = rtx("cpmmBonkSell").feePayer;
    await track(e.svc, alice, wallet, "graduate seller");
    e.hub.subs.add(`tracked@${alice}`);
    e.ingest(raydiumGrpc("cpmmBonkSell", { receivedAt: NOW }));
    await e.fetcher.flush(); // the unknown pool is classified as the letsbonk graduate's pool
    e.svc.feed.flush();
    expect(e.hub.rows(`tracked@${alice}`)[0]).toMatchObject({ kind: "sell", trader: wallet, venue: "cpmm", launchpad: "launchlab" });
  });

  test("a LaunchLab launch by a tracked dev is a create row", async () => {
    const e = env();
    const alice = await user("alice");
    const dev = "GxArAcmevRQ9xCPL7adUPXdm5LtNuhdSUhvDSHra9FmM";
    await track(e.svc, alice, dev, "dev");
    e.hub.subs.add(`tracked@${alice}`);
    e.ingest(raydiumGrpc("create", { receivedAt: NOW }));
    e.svc.feed.flush();
    const rows = e.hub.rows(`tracked@${alice}`);
    expect(rows.map((r) => r.kind).sort()).toEqual(["buy", "create"]);
    expect(rows.find((r) => r.kind === "create")).toMatchObject({
      mint: "GMoT4hnb9g4QkaStKSFgmfwxxZ1iucH3odHv6emC3nLr",
      symbol: "CATETOBER",
      launchpad: "launchlab",
      venue: "launchlab",
      marketTags: ["dev"],
    });
  });
});

describe("copy trading on Raydium", () => {
  test("a leader's LaunchLab buy becomes a copy signal on venue launchlab", async () => {
    const e = env();
    const alice = await user("alice");
    const leader = rtx("bonkBuy").feePayer;
    e.hub.subs.add(`copy@${alice}`);
    await e.svc.copy.createTask(alice, {
      leader,
      label: "",
      status: "active",
      config: { ...DEFAULT_COPY_CONFIG, ageSec: { min: null, max: null } },
    });
    e.ingest(raydiumGrpc("bonkBuy", { receivedAt: NOW }));
    const [s] = e.svc.copy.pendingOf(alice);
    expect(s).toMatchObject({ side: "buy", mint: llPool(LL.bonk).baseMint, leader, venue: "launchlab" });
  });
});
