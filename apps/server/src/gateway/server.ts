/**
 * Gateway: Bun.serve with WebSocket pub/sub (one topic per view) and a small REST API.
 *
 * WebSocket (/ws): `subscribe` answers with a snapshot at the topic's current seq, then sequenced deltas
 * flow through Bun's native publish. Flush cadences (config): Pulse lists and token headers 4-10 Hz,
 * trade tape + trade contexts every 50-100 ms, candles <= 10 Hz, chain on change (throttled). Late and
 * rolled-back events go out as `correction` messages. Slow clients that exceed the backpressure limit
 * are disconnected (they reconnect and resnapshot).
 *
 * REST: GET /api/health, /api/tokens/:mint, /api/search, /api/candles, /api/trades, /api/history, /api/program-accounts,
 * /api/lookup-tables, /api/img (media/proxy.ts); POST /api/tx;
 * GET /debug; GET /metrics (Prometheus, token or loopback only: src/metrics.ts). Per-IP token-bucket
 * rate limits; an AuthProvider seam for SIWS sessions.
 *
 * With the accounts layer (`user`, src/user.ts): the account / settings / alert / admin endpoints are
 * routed to its API; WebSocket upgrades resolve the session cookie (a cookie-authenticated upgrade
 * must come from an allowed Origin: cross-site WebSocket hijacking); the user topics `wallet:<address>`,
 * `orders`, and the trackers' `tracked`, `tracked:<mint>` and `copy` (UserGateway.userTopics) need a
 * signed-in session (all but `wallet:` are published on per-user internal topics so users never see
 * each other's); sockets close (4401) when their session is revoked or expires.
 */

import {
  CANDLES_SNAPSHOT_MAX,
  type Candle,
  type CandlesResponse,
  type ChainDelta,
  type ClientMessage,
  type ErrorCode,
  type HealthResponse,
  isAddressLike,
  isTimeframe,
  type OrdersDelta,
  type ParsedTopic,
  type PulseColumn,
  parseTopic,
  type SearchResponse,
  TIMEFRAMES,
  type Timeframe,
  type TokenHistory,
  type TokenSummary,
  type Topic,
  type Trade,
  type TradesPageResponse,
  type WalletDelta,
} from "@zerofee/protocol";
import type { Server, ServerWebSocket } from "bun";
import { apiError, json } from "../api/http";
import type { ServerConfig } from "../config";
import type { ChainPublisher } from "../feeds/chain";
import { type LookupTableReader, MAX_LOOKUP_TABLES_PER_REQUEST } from "../feeds/lookupTables";
import type { ProgramAccountsCache } from "../feeds/programAccounts";
import { logger } from "../log";
import { COLUMNS, diffSummary, type PulseBoard } from "../market/pulse";
import type { FeedItem, MarketState } from "../market/state";
import type { MetricsEndpoint } from "../metrics";
import type { StorageReader } from "../storage/reader";
import type { UserTopicSource } from "../user";
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
  /** Client topic -> internal pub/sub topic (they differ for per-user topics such as `orders`). */
  subs: Map<string, string>;
  /** User-topic subscriptions waiting for their (async) authorization and snapshot. */
  pending: Set<string>;
}

/** A per-user topic served by another module (the trackers' `tracked`, `tracked:<mint>`, `copy`). */
export interface UserTopicHandler {
  /** Internal pub/sub topic of this user's subscription (per user, so users never see each other's). */
  internal(userId: string, p: ParsedTopic): string;
  snapshot(userId: string, p: ParsedTopic): Promise<unknown>;
}

/** What the gateway needs from the accounts layer (src/user.ts). */
export interface UserGateway {
  api: { handle(req: Request, ip: string): Promise<Response | null> };
  sessions: { onRevoke(fn: (sessionIds: string[]) => void): void };
  origins: { isAllowed(origin: string | null): boolean };
  limits: { tx: RateLimiter };
  topics: UserTopicSource;
  /** Extra user topics by parsed kind. */
  userTopics?: Partial<Record<ParsedTopic["kind"], UserTopicHandler>>;
  wsConnPerUser: number;
}

/** WebSocket close code for an ended session (revoked, expired). */
export const WS_CLOSE_SESSION_ENDED = 4401;

const ordersTopic = (userId: string) => `orders@${userId}`;

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
  /** GET /api/lookup-tables (chain reads); absent = 503. */
  lookupTables?: LookupTableReader | null;
  auth: AuthProvider;
  tx: TxHandler;
  health(): HealthResponse;
  debugStats(): DebugStats;
  /** Accounts layer; absent = anonymous-only gateway (user topics answer `unavailable`). */
  user?: UserGateway | null;
  /** Mints whose summary changed in the last Pulse flush (the alert engine listens). */
  onTokensChanged?: (mints: string[]) => void;
  /** GET /metrics (src/metrics.ts); refused requests get the normal 404. */
  metrics?: MetricsEndpoint;
  /** GET /api/img (src/media/proxy.ts), with its own per-IP limits; absent = 404. */
  media?: { handle(req: Request, url: URL, ip: string): Promise<Response> } | null;
  /** Trade-history coverage and backfill requests (src/history); absent = no history fields. */
  history?: { state(mint: string): TokenHistory | null; request(mint: string, priority?: 0 | 1 | 2, reason?: string): void } | null;
}

const DEBUG_TOPIC = "debug";
const SNAPSHOT_TRADES = 100;
const MAX_CANDLES_REST = 5_000;
const MAX_TRADES_PAGE = 1_000;
/** Trades per `backfill` correction frame (older ones: GET /api/trades). */
const BACKFILL_TRADES_FRAME = 200;
/** Ceiling for any request body (the tracked-wallet import is the largest legitimate one). */
const MAX_REQUEST_BODY = 4 * 1024 * 1024;

export class Gateway {
  private server: Server<WsData> | null = null;
  hub!: TopicHub;
  private readonly restLimiter: RateLimiter;
  private readonly txLimiter: RateLimiter;
  private readonly wsLimiter: RateLimiter;
  private readonly connsPerIp = new Map<string, number>();
  private readonly connsPerUser = new Map<string, number>();
  /** Signed-in sockets by session id (closed on revocation / expiry). */
  private readonly sessionSockets = new Map<string, Set<ServerWebSocket<WsData>>>();
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
      maxRequestBodySize: MAX_REQUEST_BODY,
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
        open(ws) {
          self.connections++;
          self.stats.connections++;
          const s = ws.data.session;
          if (!s.anonymous) {
            const set = self.sessionSockets.get(s.id) ?? new Set();
            set.add(ws);
            self.sessionSockets.set(s.id, set);
          }
        },
        message(ws, raw) {
          self.onMessage(ws, typeof raw === "string" ? raw : new TextDecoder().decode(raw));
        },
        close(ws) {
          self.connections--;
          const n = (self.connsPerIp.get(ws.data.ip) ?? 1) - 1;
          if (n <= 0) self.connsPerIp.delete(ws.data.ip);
          else self.connsPerIp.set(ws.data.ip, n);
          const s = ws.data.session;
          if (!s.anonymous) {
            const set = self.sessionSockets.get(s.id);
            set?.delete(ws);
            if (set && !set.size) self.sessionSockets.delete(s.id);
            if (s.userId) {
              const u = (self.connsPerUser.get(s.userId) ?? 1) - 1;
              if (u <= 0) self.connsPerUser.delete(s.userId);
              else self.connsPerUser.set(s.userId, u);
            }
          }
          for (const internal of ws.data.subs.values()) self.hub.removeSubscriber(internal);
          ws.data.subs.clear();
          ws.data.pending.clear();
        },
      },
    });
    this.hub = new TopicHub((topic, payload) => this.server?.publish(topic, payload));
    this.d.user?.sessions.onRevoke((ids) => this.closeSessions(ids));
    const f = this.d.cfg.flush;
    this.timers.push(
      setInterval(() => this.flushPulse(), f.pulseMs),
      setInterval(() => this.flushTape(), f.tapeMs),
      setInterval(() => this.flushCandles(), f.candleMs),
      setInterval(() => this.flushChain(), f.chainMs),
      setInterval(() => this.flushDebug(), 250),
      setInterval(() => this.expirePulse(), 5_000),
      setInterval(() => this.closeExpiredSessions(), 15_000),
    );
    log.info(`listening on http://${this.d.cfg.host}:${this.port} (ws /ws, debug /debug)`);
  }

  /** Closes the sockets of revoked sessions (sign-out, rotation, session cap). */
  closeSessions(sessionIds: string[]): void {
    for (const id of sessionIds) {
      for (const ws of this.sessionSockets.get(id) ?? []) ws.close(WS_CLOSE_SESSION_ENDED, "session ended");
    }
  }

  /** Closes sockets whose session passed its absolute expiry. */
  closeExpiredSessions(now = Date.now()): void {
    for (const set of this.sessionSockets.values()) {
      for (const ws of set) {
        const exp = ws.data.session.expiresAt;
        if (exp !== null && exp <= now) ws.close(WS_CLOSE_SESSION_ENDED, "session expired");
      }
    }
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    const server = this.server;
    this.server = null;
    if (!server) return;
    // Bun 1.3.14: once the server has closed a WebSocket itself (ws.close, e.g. on sign-out),
    // stop(true) still closes the listener and every connection, but its promise never settles.
    // Wait a bounded time instead of hanging shutdown.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([server.stop(true), new Promise<void>((r) => (timer = setTimeout(r, 500)))]);
    clearTimeout(timer);
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
      const userId = session.anonymous ? null : session.userId;
      if (!session.anonymous) {
        // The cookie rode along: only our own pages may open a signed-in socket.
        if (!this.d.user?.origins.isAllowed(req.headers.get("origin"))) return apiError(403, "forbidden", "cross-origin WebSocket refused");
        if (userId && (this.connsPerUser.get(userId) ?? 0) >= (this.d.user?.wsConnPerUser ?? Number.POSITIVE_INFINITY)) {
          return apiError(429, "rate_limited", "too many connections for this account");
        }
      }
      this.connsPerIp.set(ip, conns + 1);
      if (userId) this.connsPerUser.set(userId, (this.connsPerUser.get(userId) ?? 0) + 1);
      const data: WsData = { id: crypto.randomUUID(), ip, session, subs: new Map(), pending: new Set() };
      if (server.upgrade(req, { data })) return undefined;
      this.connsPerIp.set(ip, conns);
      if (userId) this.connsPerUser.set(userId, (this.connsPerUser.get(userId) ?? 1) - 1);
      return apiError(400, "bad_request", "websocket upgrade failed");
    }
    // Token images: a page loads dozens at once, so they have their own (larger) per-IP budget.
    if (url.pathname === "/api/img" && this.d.media) {
      return this.d.media.handle(req, url, ip).catch((e) => {
        log.error(`GET /api/img failed: ${e instanceof Error ? e.message : e}`);
        return apiError(500, "internal", "internal error");
      });
    }
    if (!this.restLimiter.allow(ip)) {
      this.stats.rejected++;
      return apiError(429, "rate_limited", "slow down");
    }
    try {
      if (req.method === "GET" && url.pathname === "/api/health") return json(this.d.health());
      if (req.method === "GET" && url.pathname === "/metrics") {
        const r = this.d.metrics?.handle(req, server.requestIP(req)?.address ?? null);
        if (r) return r;
      }
      if (req.method === "GET" && url.pathname === "/debug")
        return new Response(DEBUG_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (req.method === "GET" && url.pathname.startsWith("/api/tokens/"))
        return this.getToken(decodeURIComponent(url.pathname.slice("/api/tokens/".length)));
      if (req.method === "GET" && url.pathname === "/api/search") return this.search(url);
      if (req.method === "GET" && url.pathname === "/api/candles") return this.getCandles(url);
      if (req.method === "GET" && url.pathname === "/api/trades") return this.getTrades(url);
      if (req.method === "GET" && url.pathname === "/api/history") return this.getHistory(url);
      if (req.method === "GET" && url.pathname === "/api/program-accounts") {
        const v = this.d.programAccounts?.get();
        return v ? json(v) : apiError(503, "unavailable", "program accounts not loaded yet");
      }
      if (req.method === "GET" && url.pathname === "/api/lookup-tables") return await this.lookupTables(url);
      if (url.pathname === "/api/tx") {
        if (req.method !== "POST") return apiError(405, "bad_request", "POST only");
        if (!this.txLimiter.allow(ip)) return apiError(429, "rate_limited", "slow down");
        const session = await this.d.auth.authenticate(req);
        if (session && !session.anonymous && this.d.user) {
          // Cookie-authenticated mutation: CSRF origin check, then the per-user rate limit.
          if (!this.d.user.origins.isAllowed(req.headers.get("origin"))) return apiError(403, "forbidden", "cross-origin request refused");
          if (!this.d.user.limits.tx.allow(session.userId ?? session.id)) return apiError(429, "rate_limited", "slow down");
        }
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return apiError(400, "bad_request", "invalid JSON");
        }
        const r = await this.d.tx.handle(body, session);
        return json(r.body, r.status);
      }
      if (this.d.user) {
        const r = await this.d.user.api.handle(req, ip);
        if (r) return r;
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

  /** GET /api/search?q&limit: a contract address matches exactly; text matches tickers and names in memory. */
  private search(url: URL): Response {
    const q = (url.searchParams.get("q") ?? "").trim();
    const limit = Math.min(50, Math.max(1, Math.floor(Number(url.searchParams.get("limit") ?? 20)) || 20));
    if (q.length > 64) return apiError(400, "bad_request", "query too long");
    let tokens: TokenSummary[];
    if (isAddressLike(q)) {
      const token = this.d.market.summary(q) ?? this.d.reader?.token(q)?.summary ?? null;
      tokens = token ? [token] : [];
    } else tokens = this.d.market.search(q, limit);
    const body: SearchResponse = { tokens };
    return json(body);
  }

  private async lookupTables(url: URL): Promise<Response> {
    const list = (url.searchParams.get("addresses") ?? "").split(",").filter((a) => a.length > 0);
    if (list.length === 0 || list.length > MAX_LOOKUP_TABLES_PER_REQUEST) {
      return apiError(400, "bad_request", `addresses must list 1-${MAX_LOOKUP_TABLES_PER_REQUEST} lookup tables`);
    }
    if (!list.every(isAddressLike)) return apiError(400, "bad_request", "invalid address");
    if (!this.d.lookupTables) return apiError(503, "unavailable", "lookup tables are not served here");
    try {
      return json(await this.d.lookupTables.read(list));
    } catch (e) {
      return apiError(503, "unavailable", `lookup tables unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * GET /api/candles?mint&tf&from&to&limit: without `from`, the whole stored history (newest `limit` buckets);
   * `next.to` pages older buckets. Asks for a backfill when the coin's history is incomplete.
   */
  private getCandles(url: URL): Response {
    const mint = url.searchParams.get("mint") ?? "";
    const tf = url.searchParams.get("tf") ?? "1m";
    if (!parseTopic(`token:${mint}`)) return apiError(400, "bad_request", "invalid mint");
    if (!isTimeframe(tf)) return apiError(400, "bad_request", "tf must be one of 1s,15s,1m,5m,15m,1h");
    // `before` (exclusive) is `to` (inclusive) minus one millisecond
    const before = url.searchParams.get("before");
    const to = before !== null ? Number(before) - 1 : Number(url.searchParams.get("to") ?? Date.now() + 60_000);
    const from = Number(url.searchParams.get("from") ?? 0);
    const limit = Math.min(
      MAX_CANDLES_REST,
      Math.max(1, Math.floor(Number(url.searchParams.get("limit") ?? MAX_CANDLES_REST)) || MAX_CANDLES_REST),
    );
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return apiError(400, "bad_request", "invalid from/to");
    // one extra bucket tells whether an older page exists
    const page = this.candles(mint, tf, from, to, limit + 1);
    const more = page.length > limit;
    const candles = more ? page.slice(-limit) : page;
    const supply = this.d.market.summary(mint)?.supply ?? this.d.reader?.token(mint)?.summary.supply ?? 0;
    const history = this.historyOf(mint, true);
    const body: CandlesResponse = {
      mint,
      tf,
      supply,
      candles,
      next: more && candles[0] ? { to: candles[0].t - 1 } : null,
      hasMore: more,
      ...(history ? { history, historyState: history.state } : {}),
    };
    return json(body);
  }

  /**
   * GET /api/trades?mint&before&limit: every stored trade of the coin (live and backfilled), newest first, by
   * (slot, tx index, id) keyset. `before` = the previous page's `next`, or a transaction signature.
   */
  private getTrades(url: URL): Response {
    const mint = url.searchParams.get("mint") ?? "";
    if (!parseTopic(`token:${mint}`)) return apiError(400, "bad_request", "invalid mint");
    const limit = Math.min(MAX_TRADES_PAGE, Math.max(1, Math.floor(Number(url.searchParams.get("limit") ?? 200)) || 200));
    const raw = url.searchParams.get("before");
    let before: { slot: number; txIndex: number; id: string } | null = null;
    if (raw) {
      const m = /^(\d+):(-?\d+):(.+)$/.exec(raw);
      if (m) before = { slot: Number(m[1]), txIndex: Number(m[2]), id: m[3] as string };
      else if (isAddressLike(raw) || /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(raw)) {
        const at = this.d.reader?.slotOfSignature(raw);
        if (!at) return apiError(404, "not_found", "unknown signature");
        // every trade of that transaction and later ones in the slot are excluded
        before = { slot: at.slot, txIndex: at.txIndex, id: `${raw}:` };
      } else return apiError(400, "bad_request", "before must be a cursor or a signature");
    }
    // unflushed live trades: the store lags the tape by up to one writer flush
    const page = this.d.reader?.tradesPage(mint, before, limit) ?? { trades: [], next: null };
    let trades = page.trades;
    if (!before) {
      const ids = new Set(trades.map((t) => t.id));
      const live = this.d.market.recentTrades(mint, limit).filter((t) => !ids.has(t.id));
      if (live.length) trades = mergeNewestFirst(live, trades).slice(0, limit);
    }
    const history = this.historyOf(mint, true);
    const body: TradesPageResponse = { mint, trades, next: page.next, history, ...(history ? { historyState: history.state } : {}) };
    return json(body);
  }

  /** GET /api/history?mint: coverage, and a backfill request when it is incomplete. */
  private getHistory(url: URL): Response {
    const mint = url.searchParams.get("mint") ?? "";
    if (!parseTopic(`token:${mint}`)) return apiError(400, "bad_request", "invalid mint");
    const history = this.historyOf(mint, true);
    return json({ mint, history, ...(history ? { historyState: history.state } : {}) });
  }

  /** A coin's coverage; `view` = a client is looking at it (a backfill is requested when incomplete). */
  private historyOf(mint: string, view: boolean): TokenHistory | null {
    const h = this.d.history;
    if (!h) return null;
    const s = h.state(mint);
    if (view && (!s || s.state === "partial" || s.state === "unknown")) h.request(mint, 0, "view");
    return h.state(mint) ?? s;
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
    if (!ws.data.subs.has(topic) && ws.data.subs.size + ws.data.pending.size >= this.d.cfg.wsMaxSubscriptions) {
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
      ws.data.pending.delete(topic);
      const internal = ws.data.subs.get(topic);
      if (internal !== undefined) {
        ws.data.subs.delete(topic);
        ws.unsubscribe(internal);
        this.hub.removeSubscriber(internal);
      }
      return;
    }
    if (parsed && (parsed.kind === "wallet" || parsed.kind === "orders" || parsed.kind === "tracked" || parsed.kind === "copy")) {
      void this.subscribeUserTopic(ws, topic, parsed).catch((e) => {
        log.error(`user topic ${parsed.kind} failed: ${e instanceof Error ? e.message : e}`);
        this.sendError(ws, "internal", "internal error", topic);
      });
      return;
    }
    // Snapshot and subscribe in one synchronous step: no publish can interleave.
    const data = parsed
      ? this.snapshotData(topic as Topic, parsed)
      : { recent: this.recentFeed.slice(-200).reverse(), stats: this.d.debugStats() };
    ws.send(this.hub.snapshot(topic, data));
    if (!ws.data.subs.has(topic)) {
      ws.data.subs.set(topic, topic);
      ws.subscribe(topic);
      this.hub.addSubscriber(topic);
    }
  }

  /**
   * `wallet:<address>` and `orders`: signed-in sessions only. Authorization and the snapshot need the
   * database, so this runs async; the internal topic is counted as subscribed before the read so a
   * concurrent publish advances its seq, and a read that raced a publish is retried. The snapshot is
   * sent and the socket subscribed in one synchronous step, as for market topics.
   */
  private async subscribeUserTopic(
    ws: ServerWebSocket<WsData>,
    topic: string,
    p: Extract<ParsedTopic, { kind: "wallet" | "orders" | "tracked" | "copy" }>,
  ): Promise<void> {
    const user = this.d.user;
    if (!user) return this.sendError(ws, "unavailable", "user topics need the accounts layer", topic);
    const extra = p.kind === "tracked" || p.kind === "copy" ? user.userTopics?.[p.kind] : undefined;
    if ((p.kind === "tracked" || p.kind === "copy") && !extra)
      return this.sendError(ws, "unavailable", `${p.kind} is not served here`, topic);
    const s = ws.data.session;
    if (s.anonymous || !s.userId) return this.sendError(ws, "unauthorized", "sign in to subscribe to user topics", topic);
    if (s.expiresAt !== null && s.expiresAt <= Date.now()) return this.sendError(ws, "unauthorized", "session expired", topic);
    const userId = s.userId;
    if (ws.data.pending.has(topic)) return; // the same subscribe is already in flight
    ws.data.pending.add(topic);
    const internal = extra ? extra.internal(userId, p) : p.kind === "orders" ? ordersTopic(userId) : topic;
    let data: unknown = null;
    let counted = false;
    try {
      if (p.kind === "wallet" && !(await user.topics.canWatchWallet(userId, p.address))) {
        ws.data.pending.delete(topic);
        return this.sendError(ws, "forbidden", "not your wallet: subscribe to your own or one of your trading wallets", topic);
      }
      this.hub.addSubscriber(internal);
      counted = true;
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = this.hub.seq(internal);
        data = extra
          ? await extra.snapshot(userId, p)
          : p.kind === "orders"
            ? await user.topics.ordersSnapshot(userId)
            : p.kind === "wallet"
              ? await user.topics.walletSnapshot(p.address)
              : null;
        if (this.hub.seq(internal) === before) break;
      }
    } catch (e) {
      if (counted) this.hub.removeSubscriber(internal);
      ws.data.pending.delete(topic);
      throw e;
    }
    // A repeated subscribe re-sends the snapshot (cheap resync), as for market topics.
    const stillWanted = ws.data.pending.delete(topic) && ws.readyState === 1;
    if (!stillWanted || data === null) {
      this.hub.removeSubscriber(internal);
      if (stillWanted) this.sendError(ws, "unavailable", "no snapshot for this topic right now", topic);
      return;
    }
    ws.send(this.hub.snapshot(internal, data, topic));
    if (ws.data.subs.get(topic) === internal) {
      this.hub.removeSubscriber(internal); // resync of an existing subscription: keep one count
      return;
    }
    ws.data.subs.set(topic, internal);
    ws.subscribe(internal);
  }

  /**
   * A backfill round (history/service.ts): its new trades go out on trades:<mint> and its rebuilt candles on every
   * subscribed candles:<mint>:<tf>, as `backfill` corrections (newest BACKFILL_TRADES_FRAME trades, newest
   * CANDLES_SNAPSHOT_MAX buckets per timeframe; older ones page through REST). The coverage rides on the token
   * summary (token:<mint> patches).
   */
  publishBackfill(mint: string, added: readonly Trade[], candles: ReadonlyMap<Timeframe, readonly Candle[]>, _history: TokenHistory): void {
    if (added.length && this.hub.hasSubscribers(`trades:${mint}`)) {
      const upsert = [...added].sort((a, b) => b.slot - a.slot || (a.id < b.id ? 1 : -1)).slice(0, BACKFILL_TRADES_FRAME);
      this.hub.publish(`trades:${mint}`, "correction", { remove: [], upsert }, "backfill");
    }
    for (const tf of TIMEFRAMES) {
      const list = candles.get(tf);
      const topic = `candles:${mint}:${tf}`;
      if (!list?.length || !this.hub.hasSubscribers(topic)) continue;
      this.hub.publish(topic, "correction", { candles: list.slice(-CANDLES_SNAPSHOT_MAX) }, "backfill");
    }
  }

  /** Publishes an orders delta to one user's sockets (armed-orders engine, Phase 5). */
  publishOrders(userId: string, delta: OrdersDelta): boolean {
    return this.hub.publish(ordersTopic(userId), "delta", delta, undefined, "orders");
  }

  /** Publishes a wallet delta to the sockets watching that wallet (wallet feed, Phase 6). */
  publishWallet(address: string, delta: WalletDelta): boolean {
    return this.hub.publish(`wallet:${address}`, "delta", delta);
  }

  private snapshotData(topic: Topic, p: ParsedTopic): unknown {
    const m = this.d.market;
    switch (p.kind) {
      case "pulse":
        return { tokens: this.d.pulse.snapshot(p.column) };
      case "token": {
        this.historyOf(p.mint, true);
        const s = m.summary(p.mint) ?? this.d.reader?.token(p.mint)?.summary ?? null;
        if (s) this.lastToken.set(p.mint, s);
        return s;
      }
      case "trades": {
        // memory (newest, maybe unflushed) merged with the store (older, backfilled)
        const live = m.recentTrades(p.mint, SNAPSHOT_TRADES);
        const stored = live.length >= SNAPSHOT_TRADES ? [] : (this.d.reader?.recentTrades(p.mint, SNAPSHOT_TRADES) ?? []);
        const ids = new Set(live.map((t) => t.id));
        const trades = mergeNewestFirst(
          live,
          stored.filter((t) => !ids.has(t.id)),
        ).slice(0, SNAPSHOT_TRADES);
        const history = this.historyOf(p.mint, true);
        return { trades, ...(history ? { history } : {}) };
      }
      case "candles": {
        const supply = m.summary(p.mint)?.supply ?? this.d.reader?.token(p.mint)?.summary.supply ?? 0;
        const page = this.candles(p.mint, p.tf, 0, Date.now() + 60_000, CANDLES_SNAPSHOT_MAX + 1);
        const more = page.length > CANDLES_SNAPSHOT_MAX;
        const history = this.historyOf(p.mint, true);
        return { supply, candles: more ? page.slice(-CANDLES_SNAPSHOT_MAX) : page, more, ...(history ? { history } : {}) };
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
    if (changed.length && this.d.onTokensChanged) {
      try {
        this.d.onTokensChanged(changed);
      } catch (e) {
        log.error(`token change listener failed: ${e instanceof Error ? e.message : e}`);
      }
    }
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

/** Two newest-first trade lists merged newest first (by slot, then block time). */
function mergeNewestFirst(a: readonly Trade[], b: readonly Trade[]): Trade[] {
  return [...a, ...b].sort((x, y) => y.slot - x.slot || y.blockTime - x.blockTime || (x.id < y.id ? 1 : x.id > y.id ? -1 : 0));
}
