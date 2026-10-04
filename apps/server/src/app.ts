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
import { LookupTableReader } from "./feeds/lookupTables";
import { MetadataFetcher } from "./feeds/metadata";
import { ProgramAccountsCache } from "./feeds/programAccounts";
import { SolUsdFeed } from "./feeds/solUsd";
import { AnonymousAuth, type AuthProvider } from "./gateway/auth";
import { type DebugStats, Gateway } from "./gateway/server";
import { TxHandler } from "./gateway/tx";
import { HeliusHistoryReader, type HistoryReader, RpcHistoryReader } from "./history/reader";
import { type HistoryDeps, HistoryService } from "./history/service";
import type { RpcJsonTx } from "./ingest/jsonTx";
import { PumpPortalSource, Reconciler } from "./ingest/pumpPortal";
import { PROGRAM_IDS, type RaydiumTxFetchOptions, RpcLogsSource } from "./ingest/rpcLogs";
import type { IngestSink, Source } from "./ingest/types";
import { YellowstoneSource } from "./ingest/yellowstone";
import { logger } from "./log";
import { JupiterPricer, jupiterQuoter, jupiterRouteProbe } from "./market/jupiterPrice";
import { PulseBoard } from "./market/pulse";
import { MintResolver } from "./market/resolve";
import { MarketState } from "./market/state";
import { ImageProxy } from "./media";
import { HostPacer, PRIORITY, type Priority } from "./media/pacer";
import { WorkPool } from "./media/pool";
import { pumpCdnUrl } from "./media/proxy";
import { Metrics } from "./metrics";
import { createOrderService, type OrderService, type OrderServiceOverrides } from "./orders";
import { perf, ringStat } from "./perf";
import { openDb } from "./storage/db";
import { StorageReader } from "./storage/reader";
import { replayHolders, restoreMarket } from "./storage/restore";
import { StorageWriter } from "./storage/writer";
import type { UserLayer } from "./user";
import type { LoopLagMonitor } from "./util/loopLag";
import { RpcClient } from "./util/rpc";
import { WalletFeed } from "./wallets/feed";

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
  /** Chain history reads for backfills (tests: a fake); null disables the history service. */
  historyReader?: HistoryReader | null;
  /** Decoder for fetched history transactions (tests). */
  historyDecode?: HistoryDeps["decode"];
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
  /** Token image proxy (GET /api/img). */
  media: ImageProxy;
  metadata: MetadataFetcher;
  /** Event-loop lag of the ingest / gateway thread. */
  loopLag: LoopLagMonitor;
  metrics: Metrics;
  /** Trade-history coverage, backfill and gap-fill from chain (null when disabled). */
  history: HistoryService | null;
  /** On-demand resolve of mints opened by address. */
  resolve: MintResolver;
  health(): HealthResponse;
  stop(): Promise<void>;
}

export interface SourceDeps {
  /** The RPC endpoint the logs source re-reads transactions from (RPC_LOGS_TX_FETCH_RPS), on its own client. */
  rpc?: RpcClient;
  /** That client itself, when the caller wants to watch its cooldown (history reads yield to it). */
  txRpc?: RpcClient;
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
  // Its own client: a getTransaction 429 cools down the re-reads, not the resolver's account reads.
  const rpc = deps.txRpc ?? (deps.rpc ? new RpcClient({ url: deps.rpc.url, maxConcurrent: 2 }) : undefined);
  return new RpcLogsSource({
    wsUrl: cfg.rpcWsUrl,
    programs,
    commitment: cfg.rpcLogsCommitment,
    queueMax: cfg.rpcLogsQueueMax,
    idleTimeoutMs: cfg.rpcLogsIdleMs,
    silenceSlots: cfg.rpcLogsSilenceSlots,
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
  const rpc = o.rpc ?? new RpcClient({ url: cfg.rpcUrl, fetchFn: o.fetchFn, maxConcurrent: cfg.rpcMaxConcurrent });
  const db = o.db ?? openDb(cfg.dbPath);
  const writer = new StorageWriter(db, {
    flushMs: cfg.flushIntervalMs,
    retentionHours: cfg.tradesRetentionHours,
    // the server's own database file: inserts run on the writer thread, off the event loop
    threadPath: o.db ? null : cfg.dbPath,
  });
  const reader = new StorageReader(db);
  const solUsd = o.solUsd === undefined ? new SolUsdFeed({ urls: cfg.binanceWsUrls, staleMs: cfg.solUsdStaleMs }) : o.solUsd;

  // MarketState, the resolver and the enricher reference each other through callbacks.
  let market: MarketState | null = null;
  let enricher: Enricher | null = null;
  // wallet:<address> feed (built once the gateway exists; it needs the topic hub).
  let walletFeed: WalletFeed | null = null;
  const resolver = new AccountResolver(rpc, {
    pool: (p) => perf.time("market.onPoolReady", () => market?.onPoolReady(p)),
    mint: (m) => perf.time("market.onMintResolved", () => market?.onMintResolved(m)),
    curve: (c) => perf.time("market.onCurveResolved", () => market?.onCurveResolved(c)),
    metaplex: (mint, md) => perf.time("market.onMetaplexResolved", () => market?.onMetaplexResolved(mint, md)),
    persistPool: (p) => writer.pool(p),
  });
  resolver.loadPools(reader.pools());
  // The process's one event-loop lag monitor: /api/perf, /api/health and /metrics all read it. Process-wide
  // like `perf` itself (its timer is unref'd), so stop() leaves it running for the next app in the process.
  perf.start();
  const loopLag = perf.loop;
  // Image and metadata fetches share one pacer (same IPFS gateways) and one pool of niced worker processes
  // for the CPU work (decode / resize / encode, JSON parsing), so the event loop only routes bytes.
  const pacer = new HostPacer({ limits: cfg.media.hostLimits, fallback: cfg.media.hostFallback });
  const workPool = new WorkPool({ workers: cfg.media.workers, nice: cfg.media.workerNice, maxQueue: cfg.media.workQueue });
  let pulseRef: PulseBoard | null = null;
  let gatewayRef: Gateway | null = null;
  /** On screen somewhere: in a Pulse column or behind an open token page. */
  const priorityOf = (mint: string): Priority | undefined =>
    pulseRef?.isListed(mint) || gatewayRef?.isWatched(mint) ? PRIORITY.visible : undefined;
  // Token images: the proxy fetches only the image a known token's metadata names (by mint).
  const media = new ImageProxy({
    cfg: cfg.media,
    gateways: cfg.metadataGateways,
    fetchFn: o.fetchFn,
    pacer,
    pool: workPool,
    priorityOf,
    lookup: (mint) => {
      const rec = market?.tokens.get(mint);
      if (rec) return { image: rec.image, pump: rec.launchpad === "pump" };
      const row = reader.token(mint);
      return row ? { image: row.summary.image ?? null, pump: row.summary.launchpad === "pump" } : null;
    },
  });
  /** A pump coin whose metadata can't be had (yet): pump.fun's own CDN image meanwhile. */
  const fallbackImage = (mint: string) => {
    const rec = market?.tokens.get(mint);
    if (rec && rec.launchpad === "pump" && !rec.image && market?.setFallbackImage(mint, pumpCdnUrl(mint))) media.warm(mint);
  };
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
    pacer,
    patienceMs: cfg.media.patienceMs,
    retryMax: cfg.metadataRetryMax,
    backgroundRps: cfg.metadataBackgroundRps,
    priorityOf,
    wanted: (mint) => market?.tokens.has(mint) ?? false,
    parse: cfg.media.workers > 0 ? (text, gateways, prio) => workPool.parseMetadata(text, gateways, prio) : undefined,
    store: reader.metadataStore((k, json, ok) => writer.metadata(k, json, ok)),
    onResult: (mint, meta) => {
      market?.setMetadata(mint, meta);
      if (meta?.image)
        media.warm(mint); // the first viewer of a new launch gets a cache hit
      else if (!meta) fallbackImage(mint);
    },
    onRetry: (mint) => fallbackImage(mint),
  });
  const m = new MarketState(cfg.metrics, {
    resolver,
    solUsd: () => solUsd?.current() ?? null,
    requestMetadata: (mint, uri, origin) => metadata.request(mint, uri, origin),
    storage: writer,
    funderOf: (w) => enricher?.funderOf(w) ?? null,
    onLaunch: (rec) => enricher?.onLaunch(rec),
    onMigrate: (rec) => enricher?.onMigrate(rec),
    // Wallet tracker / copy trading: every recorded trade is matched against the tracked wallets; a watched
    // wallet's own trades go out on its wallet:<address> topic.
    onTrade: o.user
      ? (t, tx) => {
          o.user?.trackers.onTrade(t, tx);
          walletFeed?.onTrade(t);
        }
      : undefined,
    raydium,
  });
  m.persistIntervalMs = cfg.tokenPersistIntervalMs;
  market = m;
  const now = Date.now();
  perf.externalStage("detect.trade", () => ringStat(m.latency));
  perf.externalStage("detect.launch", () => ringStat(m.launchLatency));
  const replaySinceMs = now - cfg.replayHours * 3_600_000;
  // Phase 1 (records only) now; the trade replay that rebuilds holder books runs after ingest started.
  const restored = restoreMarket(m, reader, {
    sinceMs: now - Math.max(cfg.pulse.migratedWindowMs, cfg.pulse.newMaxAgeMs),
    replaySinceMs,
    now,
  });

  const pulse = new PulseBoard(cfg.pulse);
  pulseRef = pulse;
  // Seed the Pulse lists with the restored tokens so the very first snapshot is complete (otherwise a
  // quiet restored token only appears once it trades again).
  perf.time("restore.pulseSeed", () => pulse.update(m.tokens.keys(), (mint) => m.summary(mint), now));
  // Restored tokens' images: refetched in the background (priority 2, IMG_BACKGROUND_RPS), disk hits first.
  for (const [mint, rec] of m.tokens) if (rec.image) media.warm(mint, PRIORITY.background);
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
  const txRpc = new RpcClient({ url: rpc.url, fetchFn: o.fetchFn, maxConcurrent: 2 });
  const source =
    o.source === undefined
      ? cfg.source === "none"
        ? null
        : createSource(cfg, { rpc, txRpc, wants: (events, migration) => m.wantsRaydiumTx(events, migration) })
      : o.source;
  if (source instanceof RpcLogsSource) {
    const delay = source.slotDelay;
    perf.externalStage("rpc.afterSlot", () => ringStat(delay));
  }
  // Trade history: its own client and budget; on the live endpoint it yields while the live re-reads cool down.
  let history: HistoryService | null = null;
  const historyReader: HistoryReader | null =
    o.historyReader !== undefined
      ? o.historyReader
      : cfg.history.enabled
        ? (() => {
            const hrpc = new RpcClient({ url: cfg.history.rpcUrl, fetchFn: o.fetchFn, maxConcurrent: 2, timeoutMs: 20_000 });
            const opts = {
              rpc: hrpc,
              perSec: cfg.history.rps,
              batchSize: cfg.history.batch,
              concurrency: cfg.history.concurrency,
              paused: cfg.history.rpcUrl === rpc.url ? () => txRpc.coolingDown() || rpc.coolingDown() : undefined,
            };
            return cfg.history.helius ? new HeliusHistoryReader({ ...opts, name: "helius" }) : new RpcHistoryReader(opts);
          })()
        : null;
  if (historyReader && cfg.history.enabled) {
    history = new HistoryService({
      cfg: cfg.history,
      market: m,
      reader: historyReader,
      store: reader,
      writer,
      watched: () => (gateway?.hub ? watchedMints(gateway.hub) : []),
      listed: () => [...pulse.members("final"), ...pulse.members("migrated")],
      publish: (mint, added, candles, h) => gateway?.publishBackfill(mint, added, candles, h),
      poolReady: (pool) => AccountResolver.ready(resolver.pools.get(pool)),
      requestPool: (pool) => resolver.requestPool(pool),
      ...(o.historyDecode ? { decode: o.historyDecode } : {}),
    });
  }

  // Any mint by address: on-demand chain resolves (GET /api/tokens/:mint, token:<mint> subscriptions). Jupiter-only
  // coins are priced from a keyless /build quote: one serialized quoter for the route probe and the refreshes.
  const jupiterQuote = cfg.resolve.jupiterProbe ? jupiterQuoter(o.fetchFn) : null;
  const jupiterPricer = jupiterQuote
    ? new JupiterPricer({ quote: jupiterQuote, market: m, watched: () => (gateway?.hub ? watchedMints(gateway.hub) : []) })
    : null;
  const resolve = new MintResolver({
    cfg: cfg.resolve,
    market: m,
    store: reader,
    accounts: resolver,
    raydium,
    history,
    jupiterRoutes: jupiterQuote ? jupiterRouteProbe(jupiterQuote) : null,
    jupiterPrime: jupiterPricer ? (mint) => jupiterPricer.prime(mint) : null,
  });

  const reconciler = cfg.pumpPortalEnabled ? new Reconciler() : null;
  const pumpPortal = cfg.pumpPortalEnabled ? new PumpPortalSource({ url: cfg.pumpPortalUrl, apiKey: cfg.pumpPortalApiKey }) : null;
  if (reconciler) reconciler.onMismatch = (mm) => log.info(`pumpportal mismatch ${JSON.stringify(mm)}`);

  let orders: (OrderService & { ready: Promise<void> }) | null = null;
  const sink: IngestSink = {
    tx: (tx) => {
      const t0 = performance.now();
      m.applyTx(tx);
      const t1 = performance.now();
      perf.span("market.applyTx", t1 - t0);
      o.user?.trackers.onTx(tx);
      orders?.engine.onIngestTx(tx);
      perf.span("sink.trackersOrders", performance.now() - t1);
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
    gap: (g) => {
      log.warn(
        `feed gap (${g.source}): ${g.reason}, slots ${g.fromSlot ?? "?"}..${g.toSlot ?? "?"}${g.signature ? ` ${g.signature}` : ""}`,
      );
      if (cfg.rpcLogsGapFill) history?.onGap(g);
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
        `resolve (by address): ${JSON.stringify(resolve.stats)}, ${resolve.running} running`,
        ...(enricher?.notes() ?? ["enrich: off"]),
        `metadata: ${metadata.stats.requested} requested, ${metadata.stats.cacheHits} cached, ${metadata.stats.fetched} fetched, ` +
          `${metadata.stats.retries} retries, ${metadata.stats.permanent} failed for good, ${metadata.stats.gaveUp} gave up, ` +
          `${metadata.pendingCount} pending, ${metadata.stats.withImage} with an image`,
        `images: ${media.stats.requests} requests, ${media.stats.memoryHits + media.stats.diskHits} hits, ${media.stats.misses} misses, ` +
          `${media.stats.notFound} not found ${JSON.stringify(media.stats.notFoundByState)}; jobs ${JSON.stringify(media.stats.jobs)}, ` +
          `${JSON.stringify(media.jobCounts())}; pool ${workPool.running} running, ${workPool.queued} queued, ${workPool.stats.dropped} dropped`,
      );
    const lag = loopLag.stats();
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
      eventLoopLag: { p50: lag.p50, p99: lag.p99, max: lag.max, samples: lag.samples },
      ...(history ? { history: history.health() } : {}),
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
    media,
    metadata,
    workPool,
    loopLag,
    // The admin kill switch (POST /api/admin/halt) shows up as zerofee_halted{scope="tx"} too.
    halted: user ? () => user.halt.isHalted() : undefined,
    history: history ? () => (history as HistoryService).health() : undefined,
  });

  user?.trackers.attachMarket(m, () => solUsd?.current() ?? null);
  gateway = new Gateway({
    cfg,
    market: m,
    pulse,
    chain,
    reader,
    programAccounts,
    lookupTables: new LookupTableReader(rpc),
    auth: o.auth ?? user?.sessions ?? new AnonymousAuth(),
    tx,
    health,
    debugStats,
    user,
    media,
    history,
    resolve,
    onTokensChanged: user
      ? (mints) => {
          user.alerts.onTokensChanged(mints);
          user.trackers.onTokensChanged(mints);
        }
      : undefined,
    metrics,
  });
  gatewayRef = gateway;
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
  if (user) {
    const hub = gateway.hub;
    const gw = gateway;
    walletFeed = new WalletFeed({
      rpc,
      history: (address, limit) => reader.tradesByTrader(address, limit),
      watched: (address) => hub.hasSubscribers(`wallet:${address}`),
      watchedAll: () => [...hub.subscribed("wallet:")].map((t) => t.slice("wallet:".length)),
      publish: (address, delta) => gw.publishWallet(address, delta),
      refreshMs: cfg.walletFeed.refreshMs,
      afterFillMs: cfg.walletFeed.afterFillMs,
    });
    const feed = walletFeed;
    user.attachWalletFeed((address) => feed.snapshot(address));
    if (o.pollers !== false) feed.start();
  }
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
  let stopped = false;
  const replay = restored.pending.length
    ? replayHolders(m, reader, restored.pending, { replaySinceMs, receivedBefore: startedAt, cancelled: () => stopped }).catch((e) =>
        log.error(`trade replay failed: ${e instanceof Error ? e.message : e}`),
      )
    : Promise.resolve();
  history?.start();
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
  // viewed Jupiter-only coins: one re-quote per tick at most, each coin about every 30 s
  const jupiterTimer = jupiterPricer && o.pollers !== false ? setInterval(() => void jupiterPricer.tick(), 5_000) : null;
  const evictTimer = setInterval(() => {
    const n = m.evictIdle(
      cfg.tokenIdleEvictMs,
      (mint) =>
        pulse.isListed(mint) ||
        pulse.columnOf(mint) !== null ||
        (gateway?.isWatched(mint) ?? false) ||
        (user?.alerts.watches(mint) ?? false) ||
        (user?.trackers.watchesMint(mint) ?? false) ||
        (orders?.engine.watches(mint) ?? false) ||
        (history?.busy(mint) ?? false) ||
        resolve.pinned(mint),
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
    media,
    metadata,
    loopLag,
    metrics,
    history,
    resolve,
    health,
    async stop() {
      stopped = true;
      await replay;
      clearInterval(evictTimer);
      await history?.stop();
      if (raydiumTimer) clearInterval(raydiumTimer);
      if (jupiterTimer) clearInterval(jupiterTimer);
      if (reconcileTimer) clearInterval(reconcileTimer);
      enricher?.stop();
      metrics.stop();
      walletFeed?.stop();
      await orders?.engine.stop();
      await source?.stop();
      await pumpPortal?.stop();
      solUsd?.stop();
      chain.stop();
      programAccounts.stop();
      resolver.stop();
      metadata.stop();
      media.stop();
      workPool.stop();
      await gateway?.stop();
      await user?.stop();
      await writer.stop();
      if (!o.db) db.close();
    },
  };
}
