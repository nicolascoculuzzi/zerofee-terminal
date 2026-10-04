/**
 * GET /metrics: Prometheus text exposition (format 0.0.4) for operations. It covers ingest rate and
 * decode failures, feed silence and slot lag, WebSocket clients and messages, the gateway's queue of
 * pending deltas, the SQLite writer queue, POST /api/tx outcomes, kill-switch (halt) state, SOL/USD
 * freshness and process memory. The alerts built on it are in docs/ops/RUNBOOK.md.
 *
 * Access is decided from the socket peer, never from X-Forwarded-For:
 *  - METRICS_TOKEN set: any peer that sends `Authorization: Bearer <token>`, and nobody else.
 *  - unset: loopback peers only, and only requests that did not pass through a proxy.
 * Refused requests fall through to the gateway's ordinary 404, so the path looks unrouted.
 *
 * Two alarm gauges are pre-computed so a plain keyword monitor (Uptime Kuma) can alert without
 * PromQL. Their healthy lines are `zerofee_feed_stalled 0` and `zerofee_blockhash_stale 0`.
 *
 * Rendering only reads in-memory counters, plus one stat() per kill-switch flag file.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ServerConfig } from "./config";
import type { ChainPublisher } from "./feeds/chain";
import type { MetadataFetcher } from "./feeds/metadata";
import type { SolUsdFeed } from "./feeds/solUsd";
import type { Gateway } from "./gateway/server";
import type { TxHandler } from "./gateway/tx";
import type { Source } from "./ingest/types";
import type { PulseBoard } from "./market/pulse";
import type { MarketState } from "./market/state";
import type { ImageProxy } from "./media";
import type { WorkPool } from "./media/pool";
import type { StorageWriter } from "./storage/writer";
import type { LoopLagMonitor } from "./util/loopLag";
import type { RpcClient } from "./util/rpc";
import { RateCounter } from "./util/stats";

export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** A blockhash older than this is a risk for browser-built transactions (valid for ~40-45 s). */
export const BLOCKHASH_STALE_MS = 30_000;

/**
 * Flag files the edge (Caddy) checks on every request: HALT_TX answers POST /api/tx with 503,
 * MAINTENANCE answers everything with 503. deploy/scripts/kill-switch.sh creates and removes them.
 */
export const KILL_SWITCH_FLAGS = { tx: "HALT_TX", site: "MAINTENANCE" } as const;

/** What the gateway calls for GET /metrics; null means "refused" (the gateway answers 404). */
export interface MetricsEndpoint {
  handle(req: Request, peer: string | null): Response | null;
}

export interface MetricsDeps {
  version: string;
  startedAt: number;
  dryRun: boolean;
  market: Pick<MarketState, "stats" | "latency" | "launchLatency" | "changes" | "tokens" | "pendingPoolEvents">;
  pulse: Pick<PulseBoard, "counts">;
  chain: Pick<ChainPublisher, "state" | "stats">;
  writer: Pick<StorageWriter, "pending" | "stats">;
  tx: Pick<TxHandler, "stats">;
  rpc: Pick<RpcClient, "stats">;
  solUsd: Pick<SolUsdFeed, "snapshot"> | null;
  /** Ingest sources, primary first. */
  sources(): Source[];
  /** Late-bound: the gateway is built after the metrics. */
  gateway(): Pick<Gateway, "connectionCount" | "stats" | "hub"> | null;
  /** App-level halt (POST /api/halt, Phase 5), OR-ed with the edge HALT_TX flag. */
  halted?(): boolean;
  /** Token image proxy (GET /api/img). */
  media?: Pick<ImageProxy, "stats" | "latency" | "health" | "diskBytes" | "memoryBytes"> &
    Partial<Pick<ImageProxy, "pacer" | "jobCounts" | "timeToImage">>;
  /** Token metadata fetcher (retries, permanent failures, pending URIs). */
  metadata?: Pick<MetadataFetcher, "stats" | "pendingCount" | "queued">;
  /** Worker processes for image decoding / encoding and metadata parsing. */
  workPool?: Pick<WorkPool, "stats" | "running" | "queued" | "timing">;
  /** Event-loop lag of the main thread. */
  loopLag?: Pick<LoopLagMonitor, "stats">;
}

type Labels = Record<string, string>;
type Value = number | boolean | null | undefined;
type Row = [Labels, Value];

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** `{k="v",...}` with Prometheus escaping (backslash, double quote, newline); "" for no labels. */
export function formatLabels(labels: Labels): string {
  const keys = Object.keys(labels);
  if (!keys.length) return "";
  return `{${keys.map((k) => `${k}="${escapeLabel(labels[k] ?? "")}"`).join(",")}}`;
}

/** Collects metric families; samples whose value is null, undefined or not finite are left out. */
class Exposition {
  private readonly out: string[] = [];

  add(name: string, type: "counter" | "gauge", help: string, samples: Value | Row[]): void {
    const rows: Row[] = Array.isArray(samples) ? samples : [[{}, samples]];
    const lines: string[] = [];
    for (const [labels, raw] of rows) {
      const v = typeof raw === "boolean" ? (raw ? 1 : 0) : raw;
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      lines.push(`${name}${formatLabels(labels)} ${String(v)}`);
    }
    if (!lines.length) return;
    this.out.push(`# HELP ${name} ${help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")}`, `# TYPE ${name} ${type}`, ...lines);
  }

  text(): string {
    return `${this.out.join("\n")}\n`;
  }
}

/** True for 127.0.0.0/8 and ::1, including IPv4-mapped IPv6 forms. */
export function isLoopback(ip: string | null): boolean {
  if (!ip) return false;
  const v = ip.toLowerCase();
  return v === "::1" || v.startsWith("127.") || v.startsWith("::ffff:127.");
}

/** Constant-time comparison of two secrets of any length. */
function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

const sec = (ms: number | null | undefined): number | null => (ms === null || ms === undefined ? null : ms / 1000);

export class Metrics implements MetricsEndpoint {
  private readonly rate10 = new RateCounter(10);
  private readonly rate60 = new RateCounter(60);
  private lastEvents: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly cfg: ServerConfig["monitoring"],
    private readonly d: MetricsDeps,
  ) {}

  /** Samples the event counter every second for the events/s gauges. */
  start(): void {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), 1_000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sample(now = Date.now()): void {
    const events = this.d.market.stats.events;
    if (this.lastEvents !== null && events > this.lastEvents) {
      this.rate10.add(events - this.lastEvents, now);
      this.rate60.add(events - this.lastEvents, now);
    }
    this.lastEvents = events;
  }

  allowed(req: Request, peer: string | null): boolean {
    const token = this.cfg.metricsToken;
    if (token) {
      const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
      return !!m && sameSecret(m[1] as string, token);
    }
    // Without a token, a local reverse proxy would make every forwarded request look like loopback.
    if (req.headers.has("x-forwarded-for") || req.headers.has("forwarded") || req.headers.has("x-real-ip")) return false;
    return isLoopback(peer);
  }

  handle(req: Request, peer: string | null): Response | null {
    if (!this.allowed(req, peer)) return null;
    return new Response(this.render(), { headers: { "content-type": METRICS_CONTENT_TYPE, "cache-control": "no-store" } });
  }

  private flag(name: string): boolean {
    const dir = this.cfg.killSwitchDir;
    if (!dir) return false;
    try {
      return existsSync(join(dir, name));
    } catch {
      return false;
    }
  }

  private renderMedia(e: Exposition, p: NonNullable<MetricsDeps["media"]>): void {
    const s = p.stats;
    e.add("zerofee_img_requests_total", "counter", "GET /api/img requests.", s.requests);
    e.add("zerofee_img_responses_total", "counter", "GET /api/img answers by kind.", [
      [{ kind: "memory_hit" }, s.memoryHits],
      [{ kind: "disk_hit" }, s.diskHits],
      [{ kind: "miss" }, s.misses],
      [{ kind: "not_modified" }, s.notModified],
      [{ kind: "not_found" }, s.notFound],
      [{ kind: "rate_limited" }, s.rateLimited],
    ]);
    e.add(
      "zerofee_img_failures_total",
      "counter",
      "Upstream image fetch and check failures by reason.",
      Object.entries(s.failures).map(([reason, n]): Row => [{ reason }, n]),
    );
    e.add("zerofee_img_upstream_total", "counter", "Upstream image fetch attempts by result.", [
      [{ result: "ok" }, s.upstreamOk],
      [{ result: "failed" }, s.upstreamFailed],
    ]);
    e.add(
      "zerofee_img_source_total",
      "counter",
      "Successful upstream image fetches by host.",
      Object.entries(s.sources).map(([host, n]): Row => [{ host }, n]),
    );
    e.add(
      "zerofee_img_source_down",
      "gauge",
      "1 while an image or metadata source host is skipped after repeated failures.",
      p.health.snapshot().map((h): Row => [{ host: h.host }, h.down]),
    );
    e.add("zerofee_img_outputs_total", "counter", "Images re-encoded to WebP, or passed through when they could not be decoded.", [
      [{ kind: "resized" }, s.resized],
      [{ kind: "passthrough" }, s.passthrough],
    ]);
    e.add(
      "zerofee_img_prefetched_total",
      "counter",
      "Images fetched ahead of the first request (new launches, restored tokens).",
      s.prefetched,
    );
    e.add(
      "zerofee_img_shed_total",
      "counter",
      "Prefetch / background image work dropped or postponed because the work pool was saturated.",
      s.shed,
    );
    e.add(
      "zerofee_img_not_found_total",
      "counter",
      "GET /api/img 404s by the state told to the client (pending: retry later; failed / none: keep the monogram).",
      Object.entries(s.notFoundByState).map(([state, n]): Row => [{ state }, n]),
    );
    e.add("zerofee_img_jobs_total", "counter", "Image fetch jobs by outcome (retried: a transient failure scheduled a retry).", [
      [{ outcome: "started" }, s.jobs.started],
      [{ outcome: "ok" }, s.jobs.ok],
      [{ outcome: "retried" }, s.jobs.retried],
      [{ outcome: "failed_permanent" }, s.jobs.failedPermanent],
      [{ outcome: "gave_up" }, s.jobs.gaveUp],
    ]);
    e.add(
      "zerofee_img_upstream_failures_by_host_total",
      "counter",
      "Failed upstream image attempts by host and reason.",
      Object.entries(s.hostFailures).map(([k, n]): Row => {
        const [host = "", reason = ""] = k.split(" ");
        return [{ host, reason }, n];
      }),
    );
    e.add(
      "zerofee_img_bad_magic_total",
      "counter",
      "Upstream bodies refused for their magic bytes, by what they were (html, json, bmp, ico, empty ...).",
      Object.entries(s.badMagic).map(([kind, n]): Row => [{ kind }, n]),
    );
    e.add(
      "zerofee_img_source_formats_total",
      "counter",
      "Accepted upstream images by format.",
      Object.entries(s.formats).map(([format, n]): Row => [{ format }, n]),
    );
    if (p.jobCounts) {
      const j = p.jobCounts();
      e.add("zerofee_img_jobs", "gauge", "Image fetch jobs by state (queued per priority: 0 visible, 1 launch, 2 background).", [
        [{ state: "queued", priority: "0" }, j.queued[0]],
        [{ state: "queued", priority: "1" }, j.queued[1]],
        [{ state: "queued", priority: "2" }, j.queued[2]],
        [{ state: "running" }, j.running],
        [{ state: "backoff" }, j.backoff],
        [{ state: "failed" }, j.failed],
      ]);
    }
    if (p.timeToImage) {
      const rows: Row[] = [];
      p.timeToImage.forEach((ring, prio) => {
        const [q50, q90] = ring.percentiles([50, 90]);
        rows.push([{ priority: String(prio), quantile: "0.5" }, sec(q50)], [{ priority: String(prio), quantile: "0.9" }, sec(q90)]);
      });
      e.add("zerofee_img_time_to_image_seconds", "gauge", "Image job created -> image ready, by priority.", rows);
    }
    if (p.pacer) {
      const hosts = p.pacer.snapshot();
      e.add(
        "zerofee_upstream_host_requests_total",
        "counter",
        "Requests started per upstream host (images and metadata, paced).",
        hosts.map((h): Row => [{ host: h.host }, h.started]),
      );
      e.add(
        "zerofee_upstream_host_throttled_total",
        "counter",
        "429 / 503 answers per upstream host.",
        hosts.map((h): Row => [{ host: h.host }, h.throttled]),
      );
      e.add(
        "zerofee_upstream_host_queued",
        "gauge",
        "Requests waiting for a slot per upstream host.",
        hosts.map((h): Row => [{ host: h.host }, h.queued]),
      );
      e.add(
        "zerofee_upstream_host_rate",
        "gauge",
        "Current paced request rate per upstream host (req/s; halves on 429, recovers slowly).",
        hosts.map((h): Row => [{ host: h.host }, h.rate]),
      );
      e.add(
        "zerofee_upstream_host_paused_seconds",
        "gauge",
        "Remaining pause per upstream host after a 429 (Retry-After or back-off).",
        hosts.map((h): Row => [{ host: h.host }, h.pausedMs / 1000]),
      );
    }
    e.add("zerofee_img_bytes_out_total", "counter", "Image bytes sent.", s.bytesOut);
    e.add("zerofee_img_cache_bytes", "gauge", "Image cache size by tier.", [
      [{ tier: "memory" }, p.memoryBytes],
      [{ tier: "disk" }, p.diskBytes],
    ]);
    const [h50, h90] = p.latency.hit.percentiles([50, 90]);
    const [m50, m90] = p.latency.miss.percentiles([50, 90]);
    e.add(
      "zerofee_img_latency_seconds",
      "gauge",
      "GET /api/img latency percentiles, served from cache (hit) or after an upstream fetch (miss).",
      [
        [{ path: "hit", quantile: "0.5" }, sec(h50)],
        [{ path: "hit", quantile: "0.9" }, sec(h90)],
        [{ path: "miss", quantile: "0.5" }, sec(m50)],
        [{ path: "miss", quantile: "0.9" }, sec(m90)],
      ],
    );
  }

  render(now = Date.now()): string {
    const e = new Exposition();
    const d = this.d;
    const m = d.market;

    // --- build, mode and kill switches ------------------------------------------------------------
    e.add("zerofee_build_info", "gauge", "Server version and runtime; always 1.", [[{ version: d.version, bun: Bun.version }, 1]]);
    e.add("zerofee_dry_run", "gauge", "1 while DRY_RUN=true: POST /api/tx simulates and never sends.", d.dryRun);
    const dir = this.cfg.killSwitchDir;
    if (dir) {
      e.add("zerofee_kill_switch_dir_present", "gauge", "1 when KILL_SWITCH_DIR exists (the flags below are observable).", existsSync(dir));
    }
    if (dir || d.halted) {
      const rows: Row[] = [[{ scope: "tx" }, this.flag(KILL_SWITCH_FLAGS.tx) || (d.halted?.() ?? false)]];
      if (dir) rows.push([{ scope: "site" }, this.flag(KILL_SWITCH_FLAGS.site)]);
      e.add("zerofee_halted", "gauge", "1 while a kill switch is on: tx = POST /api/tx refused, site = maintenance page.", rows);
    }

    // --- ingest -----------------------------------------------------------------------------------
    const s = m.stats;
    e.add("zerofee_ingest_txs_total", "counter", "Transactions with at least one decoded event, applied to market state.", s.txs);
    e.add("zerofee_ingest_events_total", "counter", "Decoded launchpad and AMM events applied to market state.", s.events);
    e.add("zerofee_ingest_events_per_second", "gauge", "Decoded events per second over a sliding window.", [
      [{ window: "10s" }, this.rate10.perSec(now)],
      [{ window: "60s" }, this.rate60.perSec(now)],
    ]);
    e.add("zerofee_ingest_trades_total", "counter", "Trades applied (bonding curve and AMM).", s.trades);
    e.add("zerofee_ingest_launches_total", "counter", "Token launches seen.", s.launches);
    e.add("zerofee_ingest_migrations_total", "counter", "Curve-to-AMM migrations seen.", s.migrations);
    e.add("zerofee_ingest_decode_failures_total", "counter", "Transactions or events the decoders could not parse.", s.decodeFailures);
    e.add("zerofee_ingest_anomalies_total", "counter", "Out-of-order, duplicate and rolled-back ingest events by kind.", [
      [{ kind: "duplicate" }, s.duplicates],
      [{ kind: "fork_parked" }, s.forkParked],
      [{ kind: "late_trade" }, s.lateTrades],
      [{ kind: "dead_slot" }, s.deadSlots],
      [{ kind: "rolled_back_trade" }, s.rolledBackTrades],
      [{ kind: "pending_dropped" }, s.pendingDropped],
    ]);
    e.add("zerofee_ingest_pending_pool_events", "gauge", "AMM events waiting for their pool to resolve.", m.pendingPoolEvents);
    e.add("zerofee_ingest_last_event_timestamp_seconds", "gauge", "Receive time of the last ingested transaction.", sec(s.lastEventAt));
    const silenceMs = Math.max(0, now - (s.lastEventAt ?? d.startedAt));
    e.add(
      "zerofee_feed_silence_seconds",
      "gauge",
      "Seconds since the last ingested transaction (since start if none yet).",
      silenceMs / 1000,
    );
    e.add(
      "zerofee_feed_stalled",
      "gauge",
      `1 when no transaction was ingested for ${this.cfg.feedStallMs / 1000} s or more (METRICS_FEED_STALL_SEC).`,
      silenceMs >= this.cfg.feedStallMs,
    );
    const [l50, l90, l99] = m.latency.percentiles([50, 90, 99]);
    e.add("zerofee_ingest_detection_latency_seconds", "gauge", "Trade detection latency (receive time - block time) percentiles.", [
      [{ quantile: "0.5" }, sec(l50)],
      [{ quantile: "0.9" }, sec(l90)],
      [{ quantile: "0.99" }, sec(l99)],
    ]);
    const [c50, c90, c99] = m.launchLatency.percentiles([50, 90, 99]);
    e.add("zerofee_ingest_launch_latency_seconds", "gauge", "Launch detection latency percentiles.", [
      [{ quantile: "0.5" }, sec(c50)],
      [{ quantile: "0.9" }, sec(c90)],
      [{ quantile: "0.99" }, sec(c99)],
    ]);

    // --- sources and chain ------------------------------------------------------------------------
    const health = d.sources().map((src) => src.health());
    const by = (f: (h: (typeof health)[number]) => Value): Row[] => health.map((h) => [{ source: h.name }, f(h)]);
    e.add(
      "zerofee_source_up",
      "gauge",
      "1 while the ingest source is connected.",
      by((h) => h.connected),
    );
    e.add(
      "zerofee_source_reconnects_total",
      "counter",
      "Reconnects of the ingest source.",
      by((h) => h.reconnects),
    );
    e.add(
      "zerofee_source_messages_total",
      "counter",
      "Raw notifications or updates received from the source.",
      by((h) => h.messages),
    );
    e.add(
      "zerofee_source_dropped_total",
      "counter",
      "Messages dropped by the source's bounded queue (backpressure).",
      by((h) => h.dropped),
    );
    e.add(
      "zerofee_source_slot",
      "gauge",
      "Latest slot the source delivered a transaction for.",
      by((h) => h.slot),
    );
    e.add(
      "zerofee_source_last_message_age_seconds",
      "gauge",
      "Seconds since the source's last message.",
      by((h) => (h.lastMessageAt === null ? null : Math.max(0, now - h.lastMessageAt) / 1000)),
    );
    const c = d.chain.state;
    e.add("zerofee_chain_tip_slot", "gauge", "Highest processed slot announced by the slot stream.", c.slot);
    const primarySlot = health[0]?.slot ?? null;
    e.add(
      "zerofee_ingest_slot_lag",
      "gauge",
      "Slots between the chain tip and the primary source's latest transaction.",
      c.slot !== null && primarySlot !== null ? Math.max(0, c.slot - primarySlot) : null,
    );
    const blockhashAgeMs = c.blockhashUpdatedAt === null ? null : Math.max(0, now - c.blockhashUpdatedAt);
    e.add("zerofee_blockhash_age_seconds", "gauge", "Age of the blockhash streamed to browsers.", sec(blockhashAgeMs));
    e.add(
      "zerofee_blockhash_stale",
      "gauge",
      `1 when the streamed blockhash is ${BLOCKHASH_STALE_MS / 1000} s old or older (or missing after start-up).`,
      (blockhashAgeMs ?? now - d.startedAt) >= BLOCKHASH_STALE_MS,
    );
    const cs = d.chain.stats;
    e.add("zerofee_chain_poll_errors_total", "counter", "Failed chain-state polls by kind.", [
      [{ kind: "blockhash" }, cs.blockhashErrors],
      [{ kind: "fees" }, cs.feeErrors],
      [{ kind: "tip_floor" }, cs.tipErrors],
    ]);
    const sol = d.solUsd?.snapshot(now) ?? null;
    e.add("zerofee_sol_usd_price", "gauge", "Last SOL/USD price.", sol?.price);
    e.add("zerofee_sol_usd_age_seconds", "gauge", "Age of the last SOL/USD price.", sol ? Math.max(0, now - sol.updatedAt) / 1000 : null);
    e.add("zerofee_sol_usd_stale", "gauge", "1 when the SOL/USD price is stale or missing.", d.solUsd ? (sol?.stale ?? true) : null);

    // --- gateway ----------------------------------------------------------------------------------
    const g = d.gateway();
    if (g) {
      e.add("zerofee_ws_clients", "gauge", "Open WebSocket connections.", g.connectionCount);
      e.add("zerofee_ws_connections_total", "counter", "WebSocket connections accepted since start.", g.stats.connections);
      e.add("zerofee_ws_subscriptions", "gauge", "Active topic subscriptions across all connections.", g.hub.subscriptionCount);
      e.add("zerofee_ws_topics", "gauge", "Topics with at least one subscriber.", g.hub.topicCount);
      e.add("zerofee_ws_messages_received_total", "counter", "Client messages received over WebSocket.", g.stats.messagesIn);
      e.add(
        "zerofee_ws_messages_published_total",
        "counter",
        "Deltas and corrections published (once per topic, fanned out).",
        g.hub.stats.published,
      );
      e.add(
        "zerofee_ws_published_bytes_total",
        "counter",
        "Bytes of published deltas and corrections (before fan-out).",
        g.hub.stats.bytes,
      );
      e.add("zerofee_rest_rate_limited_total", "counter", "REST requests refused by the per-IP rate limiter.", g.stats.rejected);
    }
    const ch = m.changes;
    let trades = 0;
    for (const list of ch.trades.values()) trades += list.length;
    let candles = 0;
    for (const byT of ch.candles.values()) candles += byT.size;
    let corrections = 0;
    for (const x of ch.tradeCorrections.values()) corrections += x.remove.length + x.upsert.length;
    for (const byT of ch.candleCorrections.values()) corrections += byT.size;
    e.add("zerofee_gateway_queue_depth", "gauge", "Pending changes waiting for the gateway's next flush, by queue.", [
      [{ queue: "tokens" }, ch.tokens.size],
      [{ queue: "trades" }, trades],
      [{ queue: "trade_contexts" }, ch.tradeCtx.size],
      [{ queue: "candles" }, candles],
      [{ queue: "corrections" }, corrections],
      [{ queue: "feed" }, ch.feed.length],
    ]);

    // --- POST /api/tx -----------------------------------------------------------------------------
    const t = d.tx.stats;
    e.add("zerofee_tx_requests_total", "counter", "POST /api/tx requests that reached the handler.", t.requests);
    e.add("zerofee_tx_outcomes_total", "counter", "POST /api/tx results: simulated (dry run), sent to lanes, or rejected (4xx/5xx).", [
      [{ outcome: "simulated" }, t.simulated],
      [{ outcome: "sent" }, t.sent],
      [{ outcome: "rejected" }, t.rejected],
    ]);

    // --- GET /api/img ----------------------------------------------------------------------------
    if (d.media) this.renderMedia(e, d.media);
    if (d.metadata) {
      const ms = d.metadata.stats;
      e.add("zerofee_metadata_fetches_total", "counter", "Token metadata fetches by outcome.", [
        [{ outcome: "fetched" }, ms.fetched],
        [{ outcome: "cache_hit" }, ms.cacheHits],
        [{ outcome: "retried" }, ms.retries],
        [{ outcome: "failed_permanent" }, ms.permanent],
        [{ outcome: "gave_up" }, ms.gaveUp],
        [{ outcome: "unsafe" }, ms.unsafe],
      ]);
      e.add(
        "zerofee_metadata_failures_total",
        "counter",
        "Failed metadata fetch rounds by reason.",
        Object.entries(ms.reasons).map(([reason, n]): Row => [{ reason }, n]),
      );
      e.add("zerofee_metadata_pending", "gauge", "Metadata URIs queued, in flight or waiting for a retry.", d.metadata.pendingCount);
    }
    if (d.workPool) {
      const wp = d.workPool;
      e.add("zerofee_img_pool_jobs", "gauge", "Image / metadata worker jobs by state.", [
        [{ state: "running" }, wp.running],
        [{ state: "queued" }, wp.queued],
      ]);
      e.add("zerofee_img_pool_jobs_total", "counter", "Image / metadata worker jobs by outcome.", [
        [{ outcome: "done" }, wp.stats.done],
        [{ outcome: "failed" }, wp.stats.failed],
        [{ outcome: "dropped" }, wp.stats.dropped],
        [{ outcome: "crashed" }, wp.stats.crashed],
      ]);
      const [w50, w99] = wp.timing.wait.percentiles([50, 99]);
      const [r50, r99] = wp.timing.run.percentiles([50, 99]);
      e.add("zerofee_img_pool_seconds", "gauge", "Worker job queue wait and run time percentiles.", [
        [{ phase: "wait", quantile: "0.5" }, sec(w50)],
        [{ phase: "wait", quantile: "0.99" }, sec(w99)],
        [{ phase: "run", quantile: "0.5" }, sec(r50)],
        [{ phase: "run", quantile: "0.99" }, sec(r99)],
      ]);
    }
    if (d.loopLag) {
      const l = d.loopLag.stats();
      e.add("zerofee_event_loop_lag_seconds", "gauge", "Event-loop lag of the main thread (50 ms timer lateness, last ~5 min).", [
        [{ quantile: "0.5" }, sec(l.p50)],
        [{ quantile: "0.99" }, sec(l.p99)],
        [{ quantile: "1" }, sec(l.max)],
      ]);
    }

    // --- storage, RPC, market ---------------------------------------------------------------------
    const w = d.writer.stats;
    e.add("zerofee_storage_queue_rows", "gauge", "Rows waiting for the batched SQLite writer.", d.writer.pending);
    e.add("zerofee_storage_flushes_total", "counter", "SQLite writer flushes.", w.flushes);
    e.add("zerofee_storage_errors_total", "counter", "Failed SQLite writer flushes (their rows are dropped).", w.errors);
    e.add("zerofee_storage_last_flush_seconds", "gauge", "Duration of the last SQLite flush.", sec(w.lastFlushMs));
    const r = d.rpc.stats;
    e.add("zerofee_rpc_calls_total", "counter", "HTTP RPC calls.", r.calls);
    e.add("zerofee_rpc_errors_total", "counter", "Failed HTTP RPC calls.", r.errors);
    e.add("zerofee_rpc_rate_limited_total", "counter", "HTTP RPC calls answered with a rate limit.", r.rateLimited);
    e.add("zerofee_tokens_in_memory", "gauge", "Tokens held in market state.", m.tokens.size);
    const pc = d.pulse.counts();
    e.add("zerofee_pulse_tokens", "gauge", "Tokens listed per Pulse column.", [
      [{ column: "new" }, pc.new],
      [{ column: "final" }, pc.final],
      [{ column: "migrated" }, pc.migrated],
    ]);

    // --- process ----------------------------------------------------------------------------------
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    e.add("process_start_time_seconds", "gauge", "Process start time (unix seconds).", d.startedAt / 1000);
    e.add("process_resident_memory_bytes", "gauge", "Resident set size.", mem.rss);
    e.add("process_cpu_seconds_total", "counter", "User plus system CPU time.", (cpu.user + cpu.system) / 1e6);
    e.add("zerofee_process_memory_bytes", "gauge", "JavaScript heap and off-heap memory by area.", [
      [{ area: "heap_used" }, mem.heapUsed],
      [{ area: "heap_total" }, mem.heapTotal],
      [{ area: "external" }, mem.external],
      [{ area: "array_buffers" }, mem.arrayBuffers],
    ]);
    return e.text();
  }
}
