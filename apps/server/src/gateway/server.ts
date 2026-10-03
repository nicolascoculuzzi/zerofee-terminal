/**
 * Gateway: Bun.serve with WebSocket pub/sub (one topic per view) and a small REST API.
 *
 * WebSocket (/ws): `subscribe` answers with a snapshot at the topic's current seq, then sequenced deltas
 * flow through Bun's native publish. Flush cadences (config): Pulse lists and token headers 4-10 Hz,
 * trade tape + trade contexts every 50-100 ms, candles <= 10 Hz, chain on change (throttled). Late and
 * rolled-back events go out as `correction` messages. Slow clients that exceed the backpressure limit
 * are disconnected (they reconnect and resnapshot).
 *
 * REST: GET /api/health, /api/tokens/:mint, /api/candles, /api/program-accounts; POST /api/tx;
 * GET /debug. Per-IP token-bucket rate limits; an AuthProvider seam for SIWS sessions.
 */

import {
  type Candle,
  type ChainDelta,
  type ClientMessage,
  type ErrorCode,
  type HealthResponse,
  isTimeframe,
  type ParsedTopic,
  type PulseColumn,
  parseTopic,
  TIMEFRAME_MS,
  type Timeframe,
  type TokenSummary,
  type Topic,
} from "@zerofee/protocol";
import type { Server, ServerWebSocket } from "bun";
import type { ServerConfig } from "../config";
import type { ChainPublisher } from "../feeds/chain";
import type { ProgramAccountsCache } from "../feeds/programAccounts";
import { logger } from "../log";
import { COLUMNS, diffSummary, type PulseBoard } from "../market/pulse";
import type { FeedItem, MarketState } from "../market/state";
import type { StorageReader } from "../storage/reader";
import type { AuthProvider, Session } from "./auth";
import { DEBUG_HTML } from "./debug";
import { RateLimiter } from "./rateLimit";
import { TopicHub } from "./topics";
import type { TxHandler } from "./tx";

const log = logger("gateway");

interface WsData {
  id: string;
  ip: string;
  session: Session;
  subs: Set<string>;
}

export interface DebugStats {
  source: string;
  launches: number;
  migrations: number;
  tradesPerSec: number;
  decodeFailures: number;
  reconnects: number;
  latency: { p50: number | null; p90: number | null };
  launchLatency: { p50: number | null; p90: number | null };
}

export interface GatewayDeps {
  cfg: Pick<ServerConfig, "host" | "port" | "trustProxy" | "flush" | "rateLimit" | "wsMaxSubscriptions" | "wsCompression">;
  market: MarketState;
  pulse: PulseBoard;
  chain: ChainPublisher;
  reader: StorageReader | null;
  programAccounts: ProgramAccountsCache | null;
  auth: AuthProvider;
  tx: TxHandler;
  health(): HealthResponse;
  debugStats(): DebugStats;
}

const DEBUG_TOPIC = "debug";
const SNAPSHOT_TRADES = 100;
const SNAPSHOT_CANDLES = 300;
const MAX_CANDLES_REST = 2_000;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

function apiError(status: number, code: ErrorCode, error: string): Response {
  return json({ error, code }, status);
}

export class Gateway {
  private server: Server<WsData> | null = null;
  hub!: TopicHub;
  private readonly restLimiter: RateLimiter;
  private readonly txLimiter: RateLimiter;
  private readonly wsLimiter: RateLimiter;
  private readonly connsPerIp = new Map<string, number>();
  private readonly lastToken = new Map<string, TokenSummary>();
  private readonly recentFeed: FeedItem[] = [];
  private pendingChain: ChainDelta | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private connections = 0;
  readonly stats = { connections: 0, messagesIn: 0, rejected: 0, backpressureCloses: 0 };

  constructor(private readonly d: GatewayDeps) {
    this.restLimiter = new RateLimiter(d.cfg.rateLimit.restPerSec, d.cfg.rateLimit.restBurst);
    this.txLimiter = new RateLimiter(d.cfg.rateLimit.txPerSec, d.cfg.rateLimit.txPerSec * 2);
    this.wsLimiter = new RateLimiter(d.cfg.rateLimit.wsMsgPerSec, d.cfg.rateLimit.wsMsgPerSec * 2);
  }

  get port(): number {
    return this.server?.port ?? 0;
  }

  get connectionCount(): number {
    return this.connections;
  }

  /** True when a client watches this mint (keeps it in memory). */
  isWatched(mint: string): boolean {
    return (
      this.hub.hasSubscribers(`token:${mint}`) ||
      this.hub.hasSubscribers(`trades:${mint}`) ||
      this.hub.hasSubscribers(`tradectx:${mint}`) ||
      [...this.hub.subscribed(`candles:${mint}:`)].length > 0
    );
  }

  start(): void {
    const self = this;
    this.server = Bun.serve<WsData, never>({
      hostname: this.d.cfg.host,
      port: this.d.cfg.port,
      async fetch(req, server) {
        return self.route(req, server);
      },
      websocket: {
        maxPayloadLength: 64 * 1024,
        idleTimeout: 120,
        backpressureLimit: 4 * 1024 * 1024,
        closeOnBackpressureLimit: true,
        perMessageDeflate: this.d.cfg.wsCompression,
        sendPings: true,
        open() {
          self.connections++;
          self.stats.connections++;
        },
        message(ws, raw) {
          self.onMessage(ws, typeof raw === "string" ? raw : new TextDecoder().decode(raw));
        },
        close(ws) {
          self.connections--;
          const n = (self.connsPerIp.get(ws.data.ip) ?? 1) - 1;
          if (n <= 0) self.connsPerIp.delete(ws.data.ip);
          else self.connsPerIp.set(ws.data.ip, n);
          for (const t of ws.data.subs) self.hub.removeSubscriber(t);
          ws.data.subs.clear();
        },
      },
    });
    this.hub = new TopicHub((topic, payload) => this.server?.publish(topic, payload));
    const f = this.d.cfg.flush;
    this.timers.push(
      setInterval(() => this.flushPulse(), f.pulseMs),
      setInterval(() => this.flushTape(), f.tapeMs),
      setInterval(() => this.flushCandles(), f.candleMs),
      setInterval(() => this.flushChain(), f.chainMs),
      setInterval(() => this.flushDebug(), 250),
      setInterval(() => this.expirePulse(), 5_000),
    );
    log.info(`listening on http://${this.d.cfg.host}:${this.port} (ws /ws, debug /debug)`);
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await this.server?.stop(true);
    this.server = null;
  }

  private clientIp(req: Request, server: Server<WsData>): string {
    if (this.d.cfg.trustProxy) {
      const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
      if (fwd) return fwd;
    }
    return server.requestIP(req)?.address ?? "unknown";
  }

  // ---------------------------------------------------------------------------------------------
  // REST
  // ---------------------------------------------------------------------------------------------

  private async route(req: Request, server: Server<WsData>): Promise<Response | undefined> {
    const url = new URL(req.url);
    const ip = this.clientIp(req, server);
    if (url.pathname === "/ws") {
      const conns = this.connsPerIp.get(ip) ?? 0;
      if (conns >= this.d.cfg.rateLimit.wsConnPerIp) return apiError(429, "rate_limited", "too many connections");
      const session = await this.d.auth.authenticate(req);
      if (!session) return apiError(401, "unauthorized", "unauthorized");
      this.connsPerIp.set(ip, conns + 1);
      const ok = server.upgrade(req, { data: { id: crypto.randomUUID(), ip, session, subs: new Set<string>() } });
      if (ok) return undefined;
      this.connsPerIp.set(ip, conns);
      return apiError(400, "bad_request", "websocket upgrade failed");
    }
    if (!this.restLimiter.allow(ip)) {
      this.stats.rejected++;
      return apiError(429, "rate_limited", "slow down");
    }
    try {
      if (req.method === "GET" && url.pathname === "/api/health") return json(this.d.health());
      if (req.method === "GET" && url.pathname === "/debug")
        return new Response(DEBUG_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (req.method === "GET" && url.pathname.startsWith("/api/tokens/"))
        return this.getToken(decodeURIComponent(url.pathname.slice("/api/tokens/".length)));
      if (req.method === "GET" && url.pathname === "/api/candles") return this.getCandles(url);
      if (req.method === "GET" && url.pathname === "/api/program-accounts") {
        const v = this.d.programAccounts?.get();
        return v ? json(v) : apiError(503, "unavailable", "program accounts not loaded yet");
      }
      if (url.pathname === "/api/tx") {
        if (req.method !== "POST") return apiError(405, "bad_request", "POST only");
        if (!this.txLimiter.allow(ip)) return apiError(429, "rate_limited", "slow down");
        const session = await this.d.auth.authenticate(req);
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return apiError(400, "bad_request", "invalid JSON");
        }
        const r = await this.d.tx.handle(body, session);
        return json(r.body, r.status);
      }
      return apiError(404, "not_found", "not found");
    } catch (e) {
      log.error(`${req.method} ${url.pathname} failed: ${e instanceof Error ? e.message : e}`);
      return apiError(500, "internal", "internal error");
    }
  }

  private getToken(mint: string): Response {
    const p = parseTopic(`token:${mint}`);
    if (!p) return apiError(400, "bad_request", "invalid mint");
    const token = this.d.market.summary(mint) ?? this.d.reader?.token(mint)?.summary ?? null;
    if (!token) return apiError(404, "not_found", "unknown token");
    return json({ token, tradeContext: this.d.market.tradeContext(mint) });
  }

  private getCandles(url: URL): Response {
    const mint = url.searchParams.get("mint") ?? "";
    const tf = url.searchParams.get("tf") ?? "1m";
    if (!parseTopic(`token:${mint}`)) return apiError(400, "bad_request", "invalid mint");
    if (!isTimeframe(tf)) return apiError(400, "bad_request", "tf must be one of 1s,15s,1m,5m,15m,1h");
    const to = Number(url.searchParams.get("to") ?? Date.now());
    const from = Number(url.searchParams.get("from") ?? to - TIMEFRAME_MS[tf] * 500);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return apiError(400, "bad_request", "invalid from/to");
    const candles = this.candles(mint, tf, from, to, MAX_CANDLES_REST);
    const supply = this.d.market.summary(mint)?.supply ?? this.d.reader?.token(mint)?.summary.supply ?? 0;
    return json({ mint, tf, supply, candles });
  }

  /** DB history merged with the in-memory tail (memory wins: it holds the open bucket). */
  private candles(mint: string, tf: Timeframe, from: number, to: number, limit: number): Candle[] {
    const byT = new Map<number, Candle>();
    for (const c of this.d.reader?.candles(mint, tf, from, to, limit) ?? []) byT.set(c.t, c);
    for (const c of this.d.market.candles.range(mint, tf, from, to)) byT.set(c.t, c);
    return [...byT.values()].sort((a, b) => a.t - b.t).slice(-limit);
  }

  // ---------------------------------------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------------------------------------

  private sendError(ws: ServerWebSocket<WsData>, code: ErrorCode, message: string, topic?: string): void {
    ws.send(JSON.stringify({ type: "error", code, message, ...(topic ? { topic } : {}) }));
  }

  /** Rate limit, parse and validate one client message. */
  private validate(
    ws: ServerWebSocket<WsData>,
    raw: string,
  ):
    | { ok: true; msg: ClientMessage; topic: string; parsed: ParsedTopic | null }
    | { ok: false; code: ErrorCode; message: string; topic?: string } {
    if (!this.wsLimiter.allow(ws.data.id)) return { ok: false, code: "rate_limited", message: "too many messages" };
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return { ok: false, code: "bad_request", message: "invalid JSON" };
    }
    if (!msg || typeof msg !== "object" || typeof (msg as { topic?: unknown }).topic !== "string") {
      return { ok: false, code: "bad_request", message: "expected { type, topic }" };
    }
    const topic = msg.topic as string;
    if (msg.type === "unsubscribe") return { ok: true, msg, topic, parsed: null };
    if (msg.type !== "subscribe") return { ok: false, code: "bad_request", message: "type must be subscribe or unsubscribe" };
    const parsed = topic === DEBUG_TOPIC ? null : parseTopic(topic);
    if (topic !== DEBUG_TOPIC && !parsed) return { ok: false, code: "unknown_topic", message: "unknown topic", topic };
    if (parsed && (parsed.kind === "wallet" || parsed.kind === "orders")) {
      return { ok: false, code: "unavailable", message: "wallet and orders topics are not published yet (phase 3/5)", topic };
    }
    if (!ws.data.subs.has(topic) && ws.data.subs.size >= this.d.cfg.wsMaxSubscriptions) {
      return {
        ok: false,
        code: "too_many_subscriptions",
        message: `max ${this.d.cfg.wsMaxSubscriptions} subscriptions per connection`,
        topic,
      };
    }
    return { ok: true, msg, topic, parsed };
  }

  private onMessage(ws: ServerWebSocket<WsData>, raw: string): void {
    this.stats.messagesIn++;
    const err = this.validate(ws, raw);
    if (!err.ok) {
      this.sendError(ws, err.code, err.message, err.topic);
      return;
    }
    const { msg, topic, parsed } = err;
    if (msg.type === "unsubscribe") {
      if (ws.data.subs.delete(topic)) {
        ws.unsubscribe(topic);
        this.hub.removeSubscriber(topic);
      }
      return;
    }
    // Snapshot and subscribe in one synchronous step: no publish can interleave.
    const data = parsed
      ? this.snapshotData(topic as Topic, parsed)
      : { recent: this.recentFeed.slice(-200).reverse(), stats: this.d.debugStats() };
    ws.send(this.hub.snapshot(topic, data));
    if (!ws.data.subs.has(topic)) {
      ws.data.subs.add(topic);
      ws.subscribe(topic);
      this.hub.addSubscriber(topic);
    }
  }

  private snapshotData(topic: Topic, p: ParsedTopic): unknown {
    const m = this.d.market;
    switch (p.kind) {
      case "pulse":
        return { tokens: this.d.pulse.snapshot(p.column) };
      case "token": {
        const s = m.summary(p.mint) ?? this.d.reader?.token(p.mint)?.summary ?? null;
        if (s) this.lastToken.set(p.mint, s);
        return s;
      }
      case "trades": {
        const live = m.recentTrades(p.mint, SNAPSHOT_TRADES);
        return { trades: live.length ? live : (this.d.reader?.recentTrades(p.mint, SNAPSHOT_TRADES) ?? []) };
      }
      case "candles": {
        const to = Date.now();
        const supply = m.summary(p.mint)?.supply ?? this.d.reader?.token(p.mint)?.summary.supply ?? 0;
        return { supply, candles: this.candles(p.mint, p.tf, to - TIMEFRAME_MS[p.tf] * SNAPSHOT_CANDLES, to + 60_000, SNAPSHOT_CANDLES) };
      }
      case "tradectx":
        return m.tradeContext(p.mint);
      case "chain":
        return this.d.chain.snapshot();
      default:
        log.warn(`no snapshot for ${topic}`);
        return null;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // flushers
  // ---------------------------------------------------------------------------------------------

  /** Pulse lists + token headers (4-10 Hz). */
  flushPulse(now = Date.now()): void {
    const m = this.d.market;
    const changed = [...m.changes.tokens];
    m.changes.tokens.clear();
    const deltas = this.d.pulse.update(changed, (mint) => m.summary(mint), now);
    for (const col of COLUMNS) this.publishPulse(col, deltas[col]);
    for (const mint of changed) {
      const topic = `token:${mint}`;
      if (!this.hub.hasSubscribers(topic)) continue;
      const s = m.summary(mint);
      if (!s) continue;
      const prev = this.lastToken.get(mint);
      const patch = prev ? diffSummary(prev, s) : s;
      this.lastToken.set(mint, s);
      if (patch) this.hub.publish(topic, "delta", patch);
    }
    if (this.lastToken.size > 10_000)
      for (const k of this.lastToken.keys()) if (!this.hub.hasSubscribers(`token:${k}`)) this.lastToken.delete(k);
  }

  private publishPulse(col: PulseColumn, delta: { upsert: unknown[]; remove: string[] }): void {
    if (delta.upsert.length || delta.remove.length) this.hub.publish(`pulse:${col}`, "delta", delta);
  }

  private expirePulse(now = Date.now()): void {
    const m = this.d.market;
    this.d.pulse.expire((mint) => m.summary(mint), now);
    const deltas = this.d.pulse.update([], (mint) => m.summary(mint), now);
    for (const col of COLUMNS) this.publishPulse(col, deltas[col]);
  }

  /** Trade tape, trade corrections and trade contexts (50-100 ms). */
  flushTape(): void {
    const c = this.d.market.changes;
    for (const [mint, trades] of c.trades) this.hub.publish(`trades:${mint}`, "delta", { trades });
    c.trades.clear();
    for (const [mint, corr] of c.tradeCorrections) {
      const reason = corr.remove.length ? "dead_slot" : "late_event";
      this.hub.publish(`trades:${mint}`, "correction", corr, reason);
    }
    c.tradeCorrections.clear();
    for (const mint of c.tradeCtx) {
      const topic = `tradectx:${mint}`;
      if (!this.hub.hasSubscribers(topic)) continue;
      const ctx = this.d.market.tradeContext(mint);
      if (ctx) this.hub.publish(topic, "delta", ctx);
    }
    c.tradeCtx.clear();
  }

  /** Candle upserts and corrections (<= 10 Hz). */
  flushCandles(): void {
    const c = this.d.market.changes;
    for (const [key, byT] of c.candles) {
      const [mint, tf] = key.split("|") as [string, string];
      this.hub.publish(`candles:${mint}:${tf}`, "delta", { candles: [...byT.values()].sort((a, b) => a.t - b.t) });
    }
    c.candles.clear();
    for (const [key, byT] of c.candleCorrections) {
      const [mint, tf] = key.split("|") as [string, string];
      const candles = [...byT.values()].sort((a, b) => a.t - b.t);
      this.hub.publish(`candles:${mint}:${tf}`, "correction", { candles }, candles.some((x) => x.n === 0) ? "dead_slot" : "late_event");
    }
    c.candleCorrections.clear();
  }

  chainDelta(delta: ChainDelta): void {
    this.pendingChain = { ...(this.pendingChain ?? {}), ...delta };
  }

  private flushChain(): void {
    if (!this.pendingChain) return;
    this.hub.publish("chain", "delta", this.pendingChain);
    this.pendingChain = null;
  }

  private flushDebug(): void {
    const feed = this.d.market.changes.feed;
    if (!feed.length) return;
    const items = feed.splice(0, feed.length);
    for (const it of items) if (it.kind !== "trade" || Math.random() < 0.05) this.recentFeed.push(it);
    if (this.recentFeed.length > 1_000) this.recentFeed.splice(0, this.recentFeed.length - 1_000);
    if (!this.hub.hasSubscribers(DEBUG_TOPIC)) return;
    // all launches/migrations, at most 25 trades per frame
    const out: FeedItem[] = [];
    let trades = 0;
    for (const it of items) {
      if (it.kind !== "trade") out.push(it);
      else if (trades < 25) {
        out.push(it);
        trades++;
      }
    }
    this.hub.publish(DEBUG_TOPIC, "delta", { feed: out, stats: this.d.debugStats() });
  }
}
