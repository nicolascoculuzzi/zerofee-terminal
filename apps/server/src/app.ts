/**
 * Wires the server: ingest source -> MarketState (single writer) -> storage + gateway, plus the
 * resolver, metadata fetcher, SOL/USD feed and chain publisher. `createApp` takes overrides so tests
 * can run the whole thing in-process with a fake source and mocked network.
 */
import type { Database } from "bun:sqlite";
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, RAYDIUM_CPMM_PROGRAM_ID, RAYDIUM_LAUNCHLAB_PROGRAM_ID } from "@zerofee/core";
import type { HealthResponse } from "@zerofee/protocol";
import { RaydiumRegistry } from "./accounts/raydium";
import { AccountResolver } from "./accounts/resolver";
import type { ServerConfig } from "./config";
import { Enricher, watchedMints } from "./enrich";
import { ChainPublisher } from "./feeds/chain";
import { MetadataFetcher } from "./feeds/metadata";
import { ProgramAccountsCache } from "./feeds/programAccounts";
import { SolUsdFeed } from "./feeds/solUsd";
import { AnonymousAuth, type AuthProvider } from "./gateway/auth";
import { type DebugStats, Gateway } from "./gateway/server";
import { TxHandler } from "./gateway/tx";
import type { RpcJsonTx } from "./ingest/jsonTx";
import { PumpPortalSource, Reconciler } from "./ingest/pumpPortal";
import { PROGRAM_IDS, type RaydiumTxFetchOptions, RpcLogsSource } from "./ingest/rpcLogs";
import type { IngestSink, Source } from "./ingest/types";
import { YellowstoneSource } from "./ingest/yellowstone";
import { logger } from "./log";
import { PulseBoard } from "./market/pulse";
import { MarketState } from "./market/state";
import { Metrics } from "./metrics";
import { createOrderService, type OrderService, type OrderServiceOverrides } from "./orders";
import { openDb } from "./storage/db";
import { StorageReader } from "./storage/reader";
import { restoreMarket } from "./storage/restore";
import { StorageWriter } from "./storage/writer";
import type { UserLayer } from "./user";
import { RpcClient } from "./util/rpc";

const log = logger("app");
export const VERSION = "0.2.0";

export interface AppOverrides {
  source?: Source | null;
  rpc?: RpcClient;
  db?: Database;
  auth?: AuthProvider;
  fetchFn?: typeof fetch;
  /** Skip the Binance socket (tests). */
  solUsd?: SolUsdFeed | null;
  /** Skip periodic network pollers (blockhash, fees, tip floor, program accounts, enrichment timer). */
  pollers?: boolean;
  /** false: no enrichment at all (Dex Paid, holder reconciliation, funding, dev history). */
  enrich?: boolean;
  /**
   * Accounts layer (createUserLayer): SIWS sessions, settings / alert / admin API, user topics.
   * Without it the gateway is anonymous-only. The app starts it and stops it with itself.
   */
  user?: UserLayer | null;
  /** Armed-orders engine seams (tests: recording lanes, fake chain reads, pinned lookup tables). */
  orders?: OrderServiceOverrides;
}

export interface App {
  cfg: ServerConfig;
  market: MarketState;
  pulse: PulseBoard;
  gateway: Gateway;
  resolver: AccountResolver;
  writer: StorageWriter;
  reader: StorageReader;
  chain: ChainPublisher;
  solUsd: SolUsdFeed | null;
  source: Source | null;
  sink: IngestSink;
  reconciler: Reconciler | null;
  enricher: Enricher | null;
  user: UserLayer | null;
  /** Armed-orders engine (with the accounts layer and ORDERS_ENABLED); `ready` settles once it loaded. */
  orders: (OrderService & { ready: Promise<void> }) | null;
  metrics: Metrics;
  health(): HealthResponse;
  stop(): Promise<void>;
}

export interface SourceDeps {
  /** The RPC client the logs source re-reads Raydium transactions with (RPC_LOGS_TX_FETCH_RPS). */
  rpc?: RpcClient;
  /** Which Raydium notifications are worth a getTransaction (MarketState.wantsRaydiumTx). */
  wants?: RaydiumTxFetchOptions["wants"];
}

export function createSource(cfg: ServerConfig, deps: SourceDeps = {}): Source {
  const programs = cfg.rpcLogsPrograms.map((p) => PROGRAM_IDS[p]);
  if (cfg.source === "yellowstone") {
    return new YellowstoneSource({
      endpoint: cfg.yellowstoneEndpoint as string,
      xToken: cfg.yellowstoneXToken,
      commitment: cfg.yellowstoneCommitment,
      programs: [PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, RAYDIUM_LAUNCHLAB_PROGRAM_ID, RAYDIUM_CPMM_PROGRAM_ID],
    });
  }
  // Its own client: a getTransaction 429 cools down the Raydium re-reads, not the resolver's account reads.
  const rpc = deps.rpc ? new RpcClient({ url: deps.rpc.url, maxConcurrent: 2 }) : undefined;
  return new RpcLogsSource({
    wsUrl: cfg.rpcWsUrl,
    programs,
    commitment: cfg.rpcLogsCommitment,
    queueMax: cfg.rpcLogsQueueMax,
    raydiumTx:
      rpc && cfg.rpcLogsTxFetchPerSec > 0
        ? {
            perSec: cfg.rpcLogsTxFetchPerSec,
            paused: () => rpc.coolingDown(),
            fetch: (signature) =>
              rpc.call<RpcJsonTx | null>("getTransaction", [
                signature,
                { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" },
              ]),
            ...(deps.wants ? { wants: deps.wants } : {}),
          }
        : null,
  });
}

export function createApp(cfg: ServerConfig, o: AppOverrides = {}): App {
  const startedAt = Date.now();
  const rpc = o.rpc ?? new RpcClient({ url: cfg.rpcUrl, fetchFn: o.fetchFn });
  const db = o.db ?? openDb(cfg.dbPath);
  const writer = new StorageWriter(db, { flushMs: cfg.flushIntervalMs, retentionHours: cfg.tradesRetentionHours });
  const reader = new StorageReader(db);
  const solUsd = o.solUsd === undefined ? new SolUsdFeed({ urls: cfg.binanceWsUrls, staleMs: cfg.solUsdStaleMs }) : o.solUsd;

  // MarketState, the resolver and the enricher reference each other through callbacks.
  let market: MarketState | null = null;
  let enricher: Enricher | null = null;
  const resolver = new AccountResolver(rpc, {
    pool: (p) => market?.onPoolReady(p),
    mint: (m) => market?.onMintResolved(m),
    curve: (c) => market?.onCurveResolved(c),
    metaplex: (mint, md) => market?.onMetaplexResolved(mint, md),
    persistPool: (p) => writer.pool(p),
  });
  resolver.loadPools(reader.pools());
  // Raydium LaunchLab / CPMM accounts share the resolver's batches.
  const raydium = new RaydiumRegistry(resolver, {
    launchLabPool: (info) => market?.onLaunchLabPoolReady(info),
    launchLabPoolMissing: (pool) => market?.onLaunchLabPoolMissing(pool),
    platform: (address) => market?.onPlatformConfig(address),
    cpmmPool: (info) => market?.onCpmmPoolReady(info),
    cpmmRejected: (pool) => market?.onCpmmRejected(pool),
  });
  const metadata = new MetadataFetcher({
    gateways: cfg.metadataGateways,
    timeoutMs: cfg.metadataTimeoutMs,
    fetchFn: o.fetchFn,
    store: reader.metadataStore((k, json, ok) => writer.metadata(k, json, ok)),
    onResult: (mint, meta) => market?.setMetadata(mint, meta),
  });
  const m = new MarketState(cfg.metrics, {
    resolver,
    solUsd: () => solUsd?.current() ?? null,
    requestMetadata: (mint, uri) => metadata.request(mint, uri),
    storage: writer,
    funderOf: (w) => enricher?.funderOf(w) ?? null,
    onLaunch: (rec) => enricher?.onLaunch(rec),
    onMigrate: (rec) => enricher?.onMigrate(rec),
    // Wallet tracker / copy trading: every recorded trade is matched against the tracked wallets.
    onTrade: o.user ? (t, tx) => o.user?.trackers.onTrade(t, tx) : undefined,
    raydium,
  });
  m.persistIntervalMs = cfg.tokenPersistIntervalMs;
  market = m;
  const now = Date.now();
  restoreMarket(m, reader, {
    sinceMs: now - Math.max(cfg.pulse.migratedWindowMs, cfg.pulse.newMaxAgeMs),
    replaySinceMs: now - cfg.replayHours * 3_600_000,
    now,
  });

  const pulse = new PulseBoard(cfg.pulse);
  let gateway: Gateway | null = null;
  if (cfg.enrich.enabled && o.enrich !== false) {
    enricher = new Enricher({
      cfg: cfg.enrich,
      market: m,
      pulse,
      // the hub exists once the gateway started (before that nobody can have a token page open)
      focused: () => (gateway?.hub ? watchedMints(gateway.hub) : []),
      launches: reader,
      fundingStore: { get: (w) => reader.walletFunder(w), put: (row) => writer.walletFunder(row) },
      fetchFn: o.fetchFn,
    });
  }
  const chain = new ChainPublisher({
    rpc,
    blockhashMode: cfg.source === "yellowstone" ? "stream" : "rpc",
    pollMs: cfg.blockhashPollMs,
    fetchFn: o.fetchFn,
    onChange: (d) => gateway?.chainDelta(d),
  });
  solUsd?.onPrice((p) => chain.setSolUsd(p));
  // Kill switch on the chain topic: snapshots carry it, every change goes out as a delta.
  if (o.user) {
    chain.setHalt(o.user.halt.state);
    o.user.halt.onChange((s) => chain.setHalt(s));
  }
  const programAccounts = new ProgramAccountsCache(rpc);
  const source =
    o.source === undefined ? createSource(cfg, { rpc, wants: (events, migration) => m.wantsRaydiumTx(events, migration) }) : o.source;

  const reconciler = cfg.pumpPortalEnabled ? new Reconciler() : null;
  const pumpPortal = cfg.pumpPortalEnabled ? new PumpPortalSource({ url: cfg.pumpPortalUrl, apiKey: cfg.pumpPortalApiKey }) : null;
  if (reconciler) reconciler.onMismatch = (mm) => log.info(`pumpportal mismatch ${JSON.stringify(mm)}`);

  let orders: (OrderService & { ready: Promise<void> }) | null = null;
  const sink: IngestSink = {
    tx: (tx) => {
      m.applyTx(tx);
      o.user?.trackers.onTx(tx);
      orders?.engine.onIngestTx(tx);
      if (reconciler) {
        for (const ev of tx.events) {
          if (ev.kind !== "pumpCreate" && ev.kind !== "pumpMigrate") continue;
          const info = {
            signature: tx.signature,
            slot: tx.slot,
            detail: {
              quoteMint: ev.quoteMint,
              crossConnected: pumpPortal?.stats.connected ?? false,
              ...(ev.kind === "pumpCreate"
                ? { mayhem: ev.isMayhemMode, tokenProgram: ev.tokenProgram, cashback: ev.isCashbackEnabled, user: ev.user }
                : {}),
            },
          };
          reconciler.seenPrimary(ev.kind === "pumpCreate" ? "create" : "migrate", ev.mint, tx.receivedAt, info);
        }
      }
    },
    slot: (slot, status) => {
      chain.onSlot(slot, status);
      if (status === "dead") {
        o.user?.trackers.onDeadSlot(slot); // before dropSlot replays parked fork copies
        m.dropSlot(slot);
      }
    },
    blockMeta: (meta) => chain.onBlockMeta(meta),
    decodeFailure: (info) => {
      m.stats.decodeFailures++;
      log.debug(`decode failure (${info.source}) ${info.signature ?? ""}: ${info.message}`);
    },
    hint: (h) => {
      if (h.kind === "launchlabMigration") m.onLaunchLabMigrationHint();
    },
  };

  const tx = new TxHandler({
    rpc,
    dryRun: cfg.dryRun,
    allowAnonymous: cfg.allowAnonymousTx,
    landing: cfg.landing,
    fetchFn: o.fetchFn,
    halt: o.user?.halt ?? null,
  });
  const sources = (): Source[] => [source, pumpPortal as unknown as Source].filter(Boolean) as Source[];

  const debugStats = (): DebugStats => {
    const [p50, p90] = m.latency.percentiles([50, 90]);
    const [l50, l90] = m.launchLatency.percentiles([50, 90]);
    return {
      source: source?.name ?? "none",
      launches: m.stats.launches,
      migrations: m.stats.migrations,
      tradesPerSec: m.tradeRate.perSec(),
      decodeFailures: m.stats.decodeFailures,
      reconnects: source?.health().reconnects ?? 0,
      latency: { p50, p90 },
      launchLatency: { p50: l50, p90: l90 },
    };
  };

  const health = (): HealthResponse => {
    const [p50, p90, p99] = m.latency.percentiles([50, 90, 99]);
    const [l50, l90, l99] = m.launchLatency.percentiles([50, 90, 99]);
    const sol = solUsd?.snapshot() ?? null;
    const counts = pulse.counts();
    const notes: string[] = [];
    if (reconciler) {
      reconciler.sweep();
      const r = reconciler.stats;
      const lead = [...r.leadMs].sort((a, b) => a - b);
      const q = (p: number) => (lead.length ? lead[Math.min(lead.length - 1, Math.floor((p / 100) * lead.length))] : "-");
      notes.push(
        `pumpportal reconcile: matched ${r.matched}, late ${r.late}, primary-only ${r.primaryOnly}, pumpportal-only ${r.crossOnly}, ` +
          `repeats ${r.repeats}, pending ${reconciler.pending}; pumpportal arrives after us by p50=${q(50)} p90=${q(90)} ms`,
      );
    }
    const srcHealth = sources().map((s) => s.health());
    if (srcHealth[0])
      srcHealth[0].notes.push(
        ...notes,
        `rpc: ${rpc.stats.calls} calls, ${rpc.stats.errors} errors, ${rpc.stats.dataAllowance} data-allowance, ${rpc.stats.rateLimited} rate-limited`,
        `raydium: launchlab ${m.stats.launchLabLaunches} launches, ${m.stats.launchLabTrades} trades, ${m.stats.launchLabCompletes} completed, ` +
          `${m.stats.launchLabGraduations} graduated (+${m.stats.launchLabGraduatesFound} earlier graduates found); ` +
          `cpmm ${m.stats.cpmmTrades} trades (${m.stats.cpmmIgnored} on other pools ignored); ` +
          `${m.stats.unattributedTrades} trades without a wallet; registry ${raydium.launchLabPools.size} pools, ` +
          `${raydium.cpmmPools.size} graduation pools, ${raydium.stats.rejected} CPMM pools rejected, ${raydium.platforms.size} platforms`,
        ...(enricher?.notes() ?? ["enrich: off"]),
      );
    return {
      ok: !!source && srcHealth[0]?.connected === true,
      version: VERSION,
      startedAt,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      dryRun: cfg.dryRun,
      sources: srcHealth,
      ingest: {
        txs: m.stats.txs,
        events: m.stats.events,
        trades: m.stats.trades,
        launches: m.stats.launches,
        migrations: m.stats.migrations,
        decodeFailures: m.stats.decodeFailures,
        pendingPoolEvents: m.pendingPoolEvents,
        tradesPerSec1m: Math.round(m.tradeRate.perSec() * 10) / 10,
        lastEventAt: m.stats.lastEventAt,
        latency: { p50, p90, p99, samples: m.latency.count },
        launchLatency: { p50: l50, p90: l90, p99: l99, samples: m.launchLatency.count },
      },
      solUsd: { price: sol?.price ?? null, ageMs: sol ? Date.now() - sol.updatedAt : null, stale: sol?.stale ?? true },
      chain: {
        slot: chain.state.slot,
        blockhashAgeMs: chain.state.blockhashUpdatedAt ? Date.now() - chain.state.blockhashUpdatedAt : null,
      },
      tokens: { inMemory: m.tokens.size, pulse: counts },
      storage: {
        pendingRows: writer.pending,
        lastFlushMs: writer.stats.lastFlushMs,
        flushes: writer.stats.flushes,
        errors: writer.stats.errors,
      },
      gateway: {
        connections: gateway?.connectionCount ?? 0,
        subscriptions: gateway?.hub.subscriptionCount ?? 0,
        topics: gateway?.hub.topicCount ?? 0,
      },
    };
  };

  const user = o.user ?? null;
  // Price / market-cap alerts read live summaries and re-evaluate the mints each Pulse flush changed.
  user?.attachMarket((mint) => m.summary(mint));

  const metrics = new Metrics(cfg.monitoring, {
    version: VERSION,
    startedAt,
    dryRun: cfg.dryRun,
    market: m,
    pulse,
    chain,
    writer,
    tx,
    rpc,
    solUsd,
    sources,
    gateway: () => gateway,
    // The admin kill switch (POST /api/admin/halt) shows up as zerofee_halted{scope="tx"} too.
    halted: user ? () => user.halt.isHalted() : undefined,
  });

  user?.trackers.attachMarket(m, () => solUsd?.current() ?? null);
  gateway = new Gateway({
    cfg,
    market: m,
    pulse,
    chain,
    reader,
    programAccounts,
    auth: o.auth ?? user?.sessions ?? new AnonymousAuth(),
    tx,
    health,
    debugStats,
    user,
    onTokensChanged: user
      ? (mints) => {
          user.alerts.onTokensChanged(mints);
          user.trackers.onTokensChanged(mints);
        }
      : undefined,
    metrics,
  });
  if (user && cfg.orders.enabled) {
    const svc = createOrderService({
      cfg,
      user,
      market: m,
      pools: resolver.pools,
      programAccounts,
      chain,
      rpc,
      publish: (userId, delta) => gateway?.publishOrders(userId, delta),
      fetchFn: o.fetchFn,
      overrides: o.orders,
    });
    user.api.add(svc.routes);
    user.attachCopyExits(svc.engine);
    orders = { ...svc, ready: Promise.resolve() };
  }

  // start
  writer.start();
  resolver.start();
  gateway.start();
  metrics.start();
  user?.trackers.attachHub(gateway.hub);
  user?.start();
  if (orders) {
    orders.ready = orders.start().catch((e) => log.error(`armed-orders engine failed to start: ${e instanceof Error ? e.message : e}`));
  }
  solUsd?.start();
  if (o.pollers !== false) {
    chain.start();
    programAccounts.start();
    enricher?.start();
  }
  source?.start(sink);
  pumpPortal?.start((ev) =>
    reconciler?.seenCross(ev.kind, ev.mint, ev.receivedAt, {
      signature: ev.signature,
      pool: ev.pool,
      detail: { primaryConnected: source?.health().connected ?? false },
    }),
  );
  const reconcileTimer = reconciler ? setInterval(() => reconciler.sweep(), 5_000) : null;
  // LaunchLab platform / global configs and CPMM AmmConfigs: fee rates and graduation pools can change.
  const raydiumTimer = o.pollers !== false ? setInterval(() => raydium.refreshConfigs(), 10 * 60_000) : null;
  const evictTimer = setInterval(() => {
    const n = m.evictIdle(
      cfg.tokenIdleEvictMs,
      (mint) =>
        pulse.isListed(mint) ||
        pulse.columnOf(mint) !== null ||
        (gateway?.isWatched(mint) ?? false) ||
        (user?.alerts.watches(mint) ?? false) ||
        (user?.trackers.watchesMint(mint) ?? false) ||
        (orders?.engine.watches(mint) ?? false),
    );
    if (n) log.debug(`evicted ${n} idle tokens`);
  }, 60_000);

  return {
    cfg,
    market: m,
    pulse,
    gateway,
    resolver,
    writer,
    reader,
    chain,
    solUsd,
    source,
    sink,
    reconciler,
    enricher,
    user,
    orders,
    metrics,
    health,
    async stop() {
      clearInterval(evictTimer);
      if (raydiumTimer) clearInterval(raydiumTimer);
      if (reconcileTimer) clearInterval(reconcileTimer);
      enricher?.stop();
      metrics.stop();
      await orders?.engine.stop();
      await source?.stop();
      await pumpPortal?.stop();
      solUsd?.stop();
      chain.stop();
      programAccounts.stop();
      resolver.stop();
      metadata.stop();
      await gateway?.stop();
      await user?.stop();
      writer.stop();
      if (!o.db) db.close();
    },
  };
}
