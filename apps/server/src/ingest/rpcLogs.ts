/**
 * RpcLogsSource - the free development feed: Solana RPC WebSocket `logsSubscribe` with one `mentions`
 * filter per program (the filter accepts exactly one address: pump, PumpSwap, Raydium LaunchLab, Raydium
 * CPMM), decoding events from `Program data:` lines. Also subscribes to `slotSubscribe` (chain tip, to
 * measure lag) and tries the unstable `slotsUpdatesSubscribe` for dead-slot notices.
 *
 * Logs carry no account keys, no tx index and no block time, so: ordering inside a slot is arrival
 * order, PumpSwap and LaunchLab pools are resolved to mints by an RPC lookup, and holder tracking is
 * trade-based.
 *
 * Transaction re-reads (`raydiumTx`, RPC_LOGS_TX_FETCH_RPS): some notifications are not enough on their own, and
 * are re-read with `getTransaction` at `confirmed` under one calls-per-second cap (the public RPC allows 40 calls /
 * 10 s per method), the full transaction (event-CPI events, accounts, wallet, token balances) replacing the logs:
 *  - priority 0, data loss: logs the RPC cut short ("Log truncated", or no logs at all), logs with fewer trade
 *    events than pump / PumpSwap trade instructions or with an undecodable event, LaunchLab events (their
 *    events lack the mint and the wallet) and LaunchLab graduations (`migrate_to_cpswap`: no event at all);
 *  - priority 1: Raydium CPMM swaps `wants` accepts (their wallet);
 *  - priority 2, recovery: notifications the bounded decode queue dropped, re-read by signature.
 * Higher priorities go first and, when the re-read queue is full, displace the lowest queued job. A job not
 * found after a few tries, too old, or displaced falls back to its logs-only record (graduations become a
 * `hint`); a dropped notification that cannot be re-read is reported as a `gap` (sink.gap) for the history
 * service to repair from chain. Nothing is lost silently: every case is counted in `capture`.
 *
 * Backpressure: the socket handler only parses and enqueues; a drain loop decodes in time-boxed
 * batches so I/O keeps flowing. The queue is bounded; overflow drops the oldest notifications (counted, re-read).
 * Reconnects use exponential backoff; a silent socket is recycled by a watchdog. The slots the socket was down
 * for are reported as a `gap` once it is back (logsSubscribe does not replay). A logs subscription that stalls
 * while slot notifications keep flowing (pump silent for `silenceSlots`) is recycled the same way.
 */
import type { Address } from "@solana/kit";
import {
  type DecodedEvent,
  decodeLogEvents,
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_LAUNCHLAB_PROGRAM_ID,
} from "@zerofee/core";
import type { SourceHealth } from "@zerofee/protocol";
import { logger } from "../log";
import { perf } from "../perf";
import { Backoff } from "../util/backoff";
import { BoundedSet } from "../util/lru";
import { SampleRing } from "../util/stats";
import { ingestFromJsonTx, type RpcJsonTx } from "./jsonTx";
import { type IngestSink, type IngestTx, RingQueue, type Source } from "./types";

const log = logger("rpc-logs");

/** Transaction re-reads (Raydium accounts, truncated / incomplete logs, dropped notifications): see the header. */
export interface RaydiumTxFetchOptions {
  /** getTransaction (json, maxSupportedTransactionVersion 1, confirmed); null when not found (yet). */
  fetch(signature: string): Promise<RpcJsonTx | null>;
  /** Max getTransaction calls per second. */
  perSec: number;
  /** Max queued transactions; beyond it they keep their logs-only record. Default 500. */
  maxQueue?: number;
  /** Re-read notifications the decode queue dropped (default true). */
  recover?: boolean;
  /** Wait before the first try (processed -> confirmed). Default 1,200 ms. */
  firstDelayMs?: number;
  retryDelayMs?: number;
  /** Tries before falling back to the logs-only record. Default 4. */
  maxAttempts?: number;
  maxConcurrent?: number;
  /** While true no call starts (the RPC client is cooling down after a 429); waiting does not use up tries. */
  paused?(): boolean;
  /** A transaction still unfetched this long after its notification keeps its logs-only record. Default 20 s. */
  maxAgeMs?: number;
  /** Which Raydium notifications are worth a call (default all): e.g. CPMM swaps only on tracked pools. */
  wants?(events: readonly DecodedEvent[], migration: boolean): boolean;
}

export interface RpcLogsSourceOptions {
  wsUrl: string;
  programs: readonly Address[];
  commitment: "processed" | "confirmed";
  queueMax: number;
  /** Recycle the socket after this long without any message (default 10 s; slots alone arrive every ~400 ms). */
  idleTimeoutMs?: number;
  /** Decode budget per drain tick before yielding to I/O. */
  drainBudgetMs?: number;
  WebSocketImpl?: typeof WebSocket;
  raydiumTx?: RaydiumTxFetchOptions | null;
  /**
   * Recycle the socket when pump (the busiest program, trading in nearly every slot) produced no notification for
   * this many slots while slot notifications kept coming: the logs subscription stalled on its own (0 = off).
   */
  silenceSlots?: number;
}

type FetchReason = "raydium" | "truncated" | "incomplete" | "recover";

interface FetchJob {
  p: Pending;
  /** The logs-only record, emitted when the fetch gives up (null: nothing decodable, or a recovery). */
  fallback: IngestTx | null;
  migration: boolean;
  /** 0 data loss (truncated / incomplete logs, LaunchLab), 1 CPMM wallets, 2 recovery of dropped notifications. */
  priority: 0 | 1 | 2;
  reason: FetchReason;
  attempts: number;
  notBefore: number;
}

interface Pending {
  signature: string;
  slot: number;
  logs: string[];
  receivedAt: number;
}

interface LogsNotification {
  method: "logsNotification";
  params: {
    subscription: number;
    result: { context: { slot: number }; value: { signature: string; err: unknown; logs: string[] | null } };
  };
}

export const PROGRAM_IDS = {
  pump: PUMP_PROGRAM_ID,
  pumpswap: PUMP_AMM_PROGRAM_ID,
  launchlab: RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  cpmm: RAYDIUM_CPMM_PROGRAM_ID,
} as const;
export type RpcLogsProgram = keyof typeof PROGRAM_IDS;

const PROGRAM_NAMES = new Map<string, string>(Object.entries(PROGRAM_IDS).map(([k, v]) => [v, k]));
const MIGRATE_LOG = "Program log: Instruction: MigrateToCpswap";
const INVOKE_RE = /^Program (\w{32,44}) invoke \[(\d+)\]$/;
const EXIT_RE = /^Program (\w{32,44}) (?:success|failed)/;
const TRADE_IX_RE = /^Program log: Instruction: (?:Buy|Sell)\w*$/;

/**
 * pump / PumpSwap trade instructions in the logs (each successful one emits exactly one TradeEvent / BuyEvent /
 * SellEvent): more instructions than decoded trade events means the logs lost an event.
 */
export function expectedTradeEvents(logs: readonly string[]): number {
  const stack: string[] = [];
  let n = 0;
  for (const line of logs) {
    if (!line.startsWith("Program ")) continue;
    const inv = INVOKE_RE.exec(line);
    if (inv) {
      stack.length = Math.max(0, Number(inv[2]) - 1);
      stack.push(inv[1] as string);
      continue;
    }
    if (EXIT_RE.test(line)) {
      stack.pop();
      continue;
    }
    const top = stack[stack.length - 1];
    if ((top === PUMP_PROGRAM_ID || top === PUMP_AMM_PROGRAM_ID) && TRADE_IX_RE.test(line)) n++;
  }
  return n;
}

const isTradeEvent = (e: DecodedEvent) => e.kind === "pumpTrade" || e.kind === "ammBuy" || e.kind === "ammSell";
const RAYDIUM_KINDS = new Set<string>(["launchlabTrade", "launchlabPoolCreate", "cpmmSwap"]);

/** A LaunchLab `migrate_to_cpswap` in the logs (the instruction line under a LaunchLab invoke). */
export function isLaunchLabMigrationLog(logs: readonly string[]): boolean {
  for (let i = 0; i < logs.length; i++) {
    if (logs[i] !== MIGRATE_LOG) continue;
    for (let j = i - 1; j >= 0; j--) {
      const m = /^Program (\w{32,44}) invoke \[\d+\]$/.exec(logs[j] as string);
      if (m) {
        if (m[1] === RAYDIUM_LAUNCHLAB_PROGRAM_ID) return true;
        break;
      }
    }
  }
  return false;
}

const LOGS_NOTIFICATION_PREFIX = '{"jsonrpc":"2.0","method":"logsNotification"';
const SLOT_SUB_ID = 1000;
const SLOT_UPDATES_SUB_ID = 1001;

export class RpcLogsSource implements Source {
  readonly name = "rpc-logs";
  private ws: WebSocket | null = null;
  private sink: IngestSink | null = null;
  private readonly queue: RingQueue<Pending>;
  private readonly seen = new BoundedSet<string>(200_000);
  private readonly backoff = new Backoff(500, 30_000);
  private draining = false;
  private stopped = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly subs = new Map<number, string>();
  readonly lag = new SampleRing(20_000);
  /**
   * Sub-second view of the pipeline: ms between the node announcing a slot (slotNotification) and each
   * successful logs notification for that slot. Complements event-timestamp latency (1 s resolution).
   */
  readonly slotDelay = new SampleRing(50_000);
  private readonly slotSeenAt = new Map<number, number>();
  private readonly fetchQueue: FetchJob[] = [];
  private fetchTimer: ReturnType<typeof setInterval> | null = null;
  private fetchTokens = 1;
  private fetchInFlight = 0;
  private fetchLastRefill = 0;
  readonly fetchStats = {
    queued: 0,
    fetched: 0,
    notFound: 0,
    errors: 0,
    fallbacks: 0,
    expired: 0,
    overflow: 0,
    skipped: 0,
    maxQueue: 0,
    /** Lower-priority jobs pushed out of a full queue by higher-priority ones (they fell back). */
    displaced: 0,
  };
  /** Trade-capture accounting (SourceHealth.capture). */
  readonly capture = {
    queueDropped: 0,
    truncated: 0,
    incomplete: 0,
    refetched: 0,
    recovered: 0,
    partial: 0,
    lost: 0,
    gaps: 0,
    downMs: 0,
  };
  private downSince: number | null = null;
  private slotBeforeDown: number | null = null;
  /** Last slot pump produced a notification in (silence detection). */
  private lastPumpSlot: number | null = null;
  private silenceReported = false;
  readonly stats = {
    connected: false,
    reconnects: 0,
    messages: 0,
    bytes: 0,
    notifications: 0,
    perProgram: {} as Record<string, number>,
    failedTxs: 0,
    duplicates: 0,
    withoutEvents: 0,
    decodedTxs: 0,
    decodeFailures: 0,
    truncatedLogs: 0,
    /** Sockets recycled because the logs subscription stalled while slots kept coming. */
    silenceRecycles: 0,
    /** LaunchLab graduations seen in the logs (no event; resolved through a fetch or a hint). */
    migrations: 0,
    lastMessageAt: null as number | null,
    slot: null as number | null,
    tipSlot: null as number | null,
    slotUpdates: "pending" as "pending" | "ok" | "unsupported",
    lastError: null as string | null,
  };

  constructor(private readonly opts: RpcLogsSourceOptions) {
    this.queue = new RingQueue(opts.queueMax, (p) => this.onQueueDrop(p));
  }

  /** The decode queue dropped a notification: re-read it by signature, or report it lost. */
  private onQueueDrop(p: Pending): void {
    this.capture.queueDropped++;
    const f = this.opts.raydiumTx;
    if (f && f.perSec > 0 && f.recover !== false) {
      const job: FetchJob = {
        p,
        fallback: null,
        migration: false,
        priority: 2,
        reason: "recover",
        attempts: 0,
        notBefore: Date.now() + (f.firstDelayMs ?? 1_200),
      };
      if (this.enqueueFetch(job, f)) return;
    }
    this.lose(p);
  }

  private lose(p: Pending): void {
    this.capture.lost++;
    this.capture.gaps++;
    this.sink?.gap?.({ source: this.name, reason: "lost", fromSlot: p.slot, toSlot: p.slot, signature: p.signature });
  }

  start(sink: IngestSink): void {
    this.sink = sink;
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => this.checkIdle(), 1_000);
    if (this.opts.raydiumTx && this.opts.raydiumTx.perSec > 0) this.fetchTimer = setInterval(() => this.fetchTick(), 50);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.fetchTimer) clearInterval(this.fetchTimer);
    this.fetchTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const Impl = this.opts.WebSocketImpl ?? WebSocket;
    const ws = new Impl(this.opts.wsUrl);
    this.ws = ws;
    let openedAt: number | null = null;
    ws.onopen = () => {
      this.stats.connected = true;
      openedAt = Date.now();
      this.lastPumpSlot = null;
      this.silenceReported = false;
      this.stats.lastMessageAt = Date.now();
      log.info(`connected; subscribing to ${this.opts.programs.length} program(s) at ${this.opts.commitment}`);
      for (const [i, p] of this.opts.programs.entries()) {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: i + 1,
            method: "logsSubscribe",
            params: [{ mentions: [p] }, { commitment: this.opts.commitment }],
          }),
        );
      }
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: SLOT_SUB_ID, method: "slotSubscribe" }));
      if (this.stats.slotUpdates !== "unsupported") {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: SLOT_UPDATES_SUB_ID, method: "slotsUpdatesSubscribe" }));
      }
    };
    ws.onmessage = (ev) => {
      const t0 = performance.now();
      this.onMessage(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
      perf.span("ingest.onMessage", performance.now() - t0);
    };
    ws.onerror = (ev) => {
      this.stats.lastError = (ev as ErrorEvent).message ?? "websocket error";
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.stats.connected = false;
      this.ws = null;
      this.subs.clear();
      if (this.stopped) return;
      // logsSubscribe does not replay: everything until the next notification is a gap (reported then)
      if (openedAt !== null && this.downSince === null) {
        this.downSince = Date.now();
        this.slotBeforeDown = this.stats.slot;
      }
      // Only a connection that opened AND stayed up for a minute resets the backoff. (Using the last
      // successful open here made every refused upgrade reset it: reconnect storms every ~400 ms.)
      if (openedAt !== null && Date.now() - openedAt > 60_000) this.backoff.reset();
      const delay = this.backoff.next();
      this.stats.reconnects++;
      log.warn(`socket closed (${ev.code} ${ev.reason || ""}); reconnect #${this.stats.reconnects} in ${delay} ms`);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
  }

  private checkIdle(): void {
    const idle = this.opts.idleTimeoutMs ?? 10_000;
    if (this.ws && this.stats.connected && this.stats.lastMessageAt && Date.now() - this.stats.lastMessageAt > idle) {
      log.warn(`no messages for ${idle} ms; recycling the socket`);
      this.ws.close();
    }
  }

  /** Socket handler: parse, account, enqueue. Exposed for tests. */
  onMessage(raw: string): void {
    const now = Date.now();
    this.stats.messages++;
    this.stats.bytes += raw.length;
    this.stats.lastMessageAt = now;
    // ~40% of notifications are failed transactions we drop anyway: skip parsing them (`"err":null` only
    // occurs unescaped as the value's own field; inside a log string the quotes would be escaped).
    if (raw.startsWith(LOGS_NOTIFICATION_PREFIX) && !raw.includes('"err":null')) {
      this.stats.notifications++;
      this.stats.failedTxs++;
      return;
    }
    let m: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.method === "logsNotification") {
      const n = m as LogsNotification;
      const { context, value } = n.params.result;
      this.stats.notifications++;
      const prog = this.subs.get(n.params.subscription) ?? "?";
      this.stats.perProgram[prog] = (this.stats.perProgram[prog] ?? 0) + 1;
      if (this.stats.tipSlot !== null) this.lag.add(this.stats.tipSlot - context.slot);
      if (this.stats.slot === null || context.slot > this.stats.slot) this.stats.slot = context.slot;
      if (this.downSince !== null) this.endDown(now, context.slot);
      if (prog === "pump" && (this.lastPumpSlot === null || context.slot > this.lastPumpSlot)) {
        this.lastPumpSlot = context.slot;
        this.silenceReported = false;
      }
      if (value.err) {
        this.stats.failedTxs++;
        return;
      }
      const seenAt = this.slotSeenAt.get(context.slot);
      if (seenAt !== undefined) this.slotDelay.add(now - seenAt);
      // The same tx mentions both programs (e.g. migrations): dedupe per (signature, slot).
      if (!this.seen.add(`${value.signature}:${context.slot}`)) {
        this.stats.duplicates++;
        return;
      }
      const logs = value.logs ?? [];
      // LaunchLab graduations emit no event but must reach the decoder (fetch or hint); so must logs the RPC cut
      // short (or left out) before any event line: their events are only in the full transaction.
      const cut = value.logs === null || logs[logs.length - 1] === "Log truncated" || logs.includes("Log truncated");
      if (!cut && !logs.some((l) => l.startsWith("Program data:")) && !isLaunchLabMigrationLog(logs)) {
        this.stats.withoutEvents++;
        return;
      }
      this.queue.push({ signature: value.signature, slot: context.slot, logs, receivedAt: now });
      this.scheduleDrain();
      return;
    }
    if (m.method === "slotNotification") {
      const slot = (m.params as { result: { slot: number } }).result.slot;
      if (this.stats.tipSlot === null || slot > this.stats.tipSlot) this.stats.tipSlot = slot;
      this.checkSilence(slot);
      if (!this.slotSeenAt.has(slot)) {
        this.slotSeenAt.set(slot, now);
        if (this.slotSeenAt.size > 256) this.slotSeenAt.delete(this.slotSeenAt.keys().next().value as number);
      }
      this.sink?.slot?.(slot, "processed");
      return;
    }
    if (m.method === "slotsUpdatesNotification") {
      const u = (m.params as { result: { type: string; slot: number } }).result;
      if (u.type === "dead") this.sink?.slot?.(u.slot, "dead");
      else if (u.type === "optimisticConfirmation") this.sink?.slot?.(u.slot, "confirmed");
      else if (u.type === "root") this.sink?.slot?.(u.slot, "finalized");
      return;
    }
    if (m.id !== undefined) {
      if (m.error) {
        if (m.id === SLOT_UPDATES_SUB_ID) {
          this.stats.slotUpdates = "unsupported";
          log.info(`slotsUpdatesSubscribe unavailable (${m.error.message}); dead-slot rollbacks disabled for this source`);
        } else {
          this.stats.lastError = m.error.message;
          log.warn(`subscription ${m.id} failed: ${m.error.message}`);
        }
        return;
      }
      if (m.id === SLOT_UPDATES_SUB_ID) this.stats.slotUpdates = "ok";
      else if (m.id >= 1 && m.id <= this.opts.programs.length) {
        const program = this.opts.programs[m.id - 1] as string;
        this.subs.set(m.result as number, PROGRAM_NAMES.get(program) ?? program);
      }
    }
  }

  /** First notification after a reconnect: the slots in between are a gap. */
  private endDown(now: number, slot: number): void {
    const since = this.downSince as number;
    this.downSince = null;
    this.capture.downMs += now - since;
    this.capture.gaps++;
    this.sink?.gap?.({ source: this.name, reason: "reconnect", fromSlot: this.slotBeforeDown, toSlot: slot });
  }

  /** pump trades in nearly every slot: a long stretch without one while the tip advances is a stalled subscription. */
  private checkSilence(tip: number): void {
    const n = this.opts.silenceSlots ?? 0;
    if (!n || this.silenceReported || !this.stats.connected || this.lastPumpSlot === null) return;
    if (!this.opts.programs.includes(PUMP_PROGRAM_ID) || tip - this.lastPumpSlot < n) return;
    this.silenceReported = true;
    this.stats.silenceRecycles++;
    log.warn(`no pump notification for ${tip - this.lastPumpSlot} slots while slots advance; recycling the socket`);
    this.ws?.close();
  }

  private scheduleDrain(): void {
    if (this.draining) return;
    this.draining = true;
    setImmediate(() => this.drain());
  }

  /** Decodes queued notifications for up to `drainBudgetMs`, then yields. Exposed for tests. */
  drain(): void {
    const budget = this.opts.drainBudgetMs ?? 8;
    const t0 = performance.now();
    for (let item = this.queue.shift(); item; item = this.queue.shift()) {
      this.process(item);
      if (performance.now() - t0 > budget) break;
    }
    perf.span("ingest.drain", performance.now() - t0);
    if (this.queue.size > 0) setImmediate(() => this.drain());
    else this.draining = false;
  }

  private process(p: Pending): void {
    perf.stage("ingest.queue", Date.now() - p.receivedAt);
    const t0 = performance.now();
    const r = decodeLogEvents(p.logs);
    perf.stage("ingest.decode", performance.now() - t0);
    const truncated = r.truncated || p.logs.length === 0;
    if (truncated) {
      this.stats.truncatedLogs++;
      this.capture.truncated++;
    }
    if (r.failures) {
      this.stats.decodeFailures += r.failures;
      for (const message of r.failureMessages) this.sink?.decodeFailure?.({ source: this.name, signature: p.signature, message });
    }
    // fewer trade events than trade instructions, or an event that did not decode: the logs lost something
    const incomplete = !truncated && (r.failures > 0 || r.events.filter(isTradeEvent).length < expectedTradeEvents(p.logs));
    if (incomplete) this.capture.incomplete++;
    const migration = isLaunchLabMigrationLog(p.logs);
    if (migration) this.stats.migrations++;
    const fallback: IngestTx | null = r.events.length
      ? {
          signature: p.signature,
          slot: p.slot,
          txIndex: null,
          blockTime: null,
          receivedAt: p.receivedAt,
          sourceCreatedAt: null,
          source: this.name,
          events: r.events,
          signers: null,
          accountKeys: null,
          poolMints: [],
          tokenBalances: null,
        }
      : null;
    const f = this.opts.raydiumTx;
    const notBefore = p.receivedAt + (f?.firstDelayMs ?? 1_200);
    if (f && f.perSec > 0 && (truncated || incomplete)) {
      // data loss: always re-read (the logs-only record goes out if the re-read fails)
      if (
        this.enqueueFetch(
          { p, fallback, migration, priority: 0, reason: truncated ? "truncated" : "incomplete", attempts: 0, notBefore },
          f,
        )
      )
        return;
      this.capture.partial++;
    } else if (f && f.perSec > 0 && (migration || r.events.some((e) => RAYDIUM_KINDS.has(e.kind)))) {
      if (f.wants && !f.wants(r.events, migration)) this.fetchStats.skipped++;
      else {
        const priority = migration || r.events.some((e) => e.kind === "launchlabTrade" || e.kind === "launchlabPoolCreate") ? 0 : 1;
        if (this.enqueueFetch({ p, fallback, migration, priority, reason: "raydium", attempts: 0, notBefore }, f)) return;
      }
    } else if (truncated || incomplete) this.capture.partial++;
    this.emitFallback(p, fallback, migration);
  }

  /**
   * Queues a re-read. A full queue makes room by displacing its lowest-priority, newest job when the new one
   * ranks higher (the displaced job falls back now); otherwise the new job is refused (overflow).
   */
  private enqueueFetch(job: FetchJob, f: RaydiumTxFetchOptions): boolean {
    const max = f.maxQueue ?? 500;
    if (this.fetchQueue.length >= max) {
      let worst = -1;
      for (let i = 0; i < this.fetchQueue.length; i++) {
        const j = this.fetchQueue[i] as FetchJob;
        if (j.priority > job.priority && (worst < 0 || j.priority >= (this.fetchQueue[worst] as FetchJob).priority)) worst = i;
      }
      if (worst < 0) {
        this.fetchStats.overflow++;
        return false;
      }
      const out = this.fetchQueue.splice(worst, 1)[0] as FetchJob;
      this.fetchStats.displaced++;
      this.giveUp(out);
    }
    this.fetchQueue.push(job);
    this.fetchStats.queued++;
    if (this.fetchQueue.length > this.fetchStats.maxQueue) this.fetchStats.maxQueue = this.fetchQueue.length;
    return true;
  }

  /** A re-read that will not happen: its logs-only record goes out, a recovery becomes a reported gap. */
  private giveUp(job: FetchJob): void {
    this.fetchStats.fallbacks++;
    if (job.reason === "recover") {
      this.lose(job.p);
      return;
    }
    if (job.reason === "truncated" || job.reason === "incomplete") this.capture.partial++;
    this.emitFallback(job.p, job.fallback, job.migration);
  }

  private emitFallback(p: Pending, fallback: IngestTx | null, migration: boolean): void {
    if (migration) this.sink?.hint?.({ kind: "launchlabMigration", signature: p.signature, slot: p.slot });
    if (!fallback) {
      if (!migration) this.stats.withoutEvents++;
      return;
    }
    this.stats.decodedTxs++;
    this.sink?.tx(fallback);
  }

  /** Token-bucket scheduler for Raydium getTransaction calls. Exposed for tests. */
  fetchTick(now = Date.now()): void {
    const f = this.opts.raydiumTx;
    if (!f || f.perSec <= 0) return;
    const elapsed = this.fetchLastRefill ? now - this.fetchLastRefill : 0;
    this.fetchLastRefill = now;
    this.fetchTokens = Math.min(Math.max(1, f.perSec), this.fetchTokens + (elapsed * f.perSec) / 1000);
    // Too old to be worth the wait: the logs-only record goes out (in order).
    const maxAge = f.maxAgeMs ?? 20_000;
    for (let i = 0; i < this.fetchQueue.length; ) {
      const job = this.fetchQueue[i] as FetchJob;
      // recoveries carry no logs-only record to fall back to: they may wait longer
      if (now - job.p.receivedAt <= (job.reason === "recover" ? maxAge * 6 : maxAge)) {
        i++;
        continue;
      }
      this.fetchQueue.splice(i, 1);
      this.fetchStats.expired++;
      this.giveUp(job);
    }
    if (f.paused?.()) return;
    while (this.fetchTokens >= 1 && this.fetchInFlight < (f.maxConcurrent ?? 4)) {
      let i = -1;
      for (let k = 0; k < this.fetchQueue.length; k++) {
        const j = this.fetchQueue[k] as FetchJob;
        if (j.notBefore <= now && (i < 0 || j.priority < (this.fetchQueue[i] as FetchJob).priority)) i = k;
      }
      if (i < 0) return;
      const job = this.fetchQueue.splice(i, 1)[0] as FetchJob;
      this.fetchTokens -= 1;
      this.fetchInFlight++;
      void this.runFetch(job, f).finally(() => {
        this.fetchInFlight--;
      });
    }
  }

  private async runFetch(job: FetchJob, f: RaydiumTxFetchOptions): Promise<void> {
    job.attempts++;
    let tx: RpcJsonTx | null = null;
    let failed = false;
    try {
      tx = await f.fetch(job.p.signature);
    } catch (e) {
      failed = true;
      this.fetchStats.errors++;
      this.stats.lastError = e instanceof Error ? e.message : String(e);
    }
    if (this.stopped) return;
    if (tx) {
      const built = ingestFromJsonTx({ signature: job.p.signature, tx, receivedAt: job.p.receivedAt, source: this.name, slot: job.p.slot });
      if (built && (built.tx.events.length || built.tx.raydium?.migrations.length)) {
        this.fetchStats.fetched++;
        if (job.reason !== "raydium") this.capture.refetched++;
        if (job.reason === "recover") this.capture.recovered++;
        for (const message of built.failures) this.sink?.decodeFailure?.({ source: this.name, signature: job.p.signature, message });
        this.stats.decodedTxs++;
        this.sink?.tx(built.tx);
        return;
      }
      // a recovered transaction that failed or carries no event of ours: nothing was lost
      if (job.reason === "recover") {
        this.capture.recovered++;
        return;
      }
    } else if (!failed) this.fetchStats.notFound++;
    if (!tx && job.attempts < (f.maxAttempts ?? 4)) {
      job.notBefore = Date.now() + (f.retryDelayMs ?? 1_500) * job.attempts;
      this.fetchQueue.push(job);
      return;
    }
    this.giveUp(job);
  }

  get fetchQueueSize(): number {
    return this.fetchQueue.length;
  }

  health(): SourceHealth {
    const [p50, p90, max] = this.lag.percentiles([50, 90, 100]);
    const [d50, d90, d99] = this.slotDelay.percentiles([50, 90, 99]);
    return {
      name: this.name,
      connected: this.stats.connected,
      reconnects: this.stats.reconnects,
      messages: this.stats.messages,
      lastMessageAt: this.stats.lastMessageAt,
      slot: this.stats.slot,
      dropped: this.queue.dropped,
      capture: { ...this.capture, downMs: this.capture.downMs + (this.downSince !== null ? Date.now() - this.downSince : 0) },
      notes: [
        `queue ${this.queue.size}/${this.queue.capacity} (max seen ${this.queue.maxSeen})`,
        `slot lag vs tip p50=${p50 ?? "-"} p90=${p90 ?? "-"} max=${max ?? "-"}`,
        `ms after slotNotification p50=${d50 ?? "-"} p90=${d90 ?? "-"} p99=${d99 ?? "-"} (n=${this.slotDelay.count})`,
        `notifications ${this.stats.notifications} (failed txs ${this.stats.failedTxs}, duplicates ${this.stats.duplicates}, without events ${this.stats.withoutEvents})`,
        `decoded txs ${this.stats.decodedTxs}, decode failures ${this.stats.decodeFailures}, truncated logs ${this.stats.truncatedLogs}`,
        `received ${(this.stats.bytes / 1e6).toFixed(1)} MB`,
        `slotsUpdates ${this.stats.slotUpdates}`,
        ...(this.opts.raydiumTx && this.opts.raydiumTx.perSec > 0
          ? [
              `tx re-reads: queue ${this.fetchQueue.length} (max ${this.fetchStats.maxQueue}), fetched ${this.fetchStats.fetched}, ` +
                `not found ${this.fetchStats.notFound}, errors ${this.fetchStats.errors}, logs-only fallbacks ${this.fetchStats.fallbacks} ` +
                `(${this.fetchStats.expired} waited too long, ${this.fetchStats.displaced} displaced), ` +
                `overflow ${this.fetchStats.overflow}, skipped ${this.fetchStats.skipped}; graduations in logs ${this.stats.migrations}`,
            ]
          : []),
        `capture: ${this.capture.queueDropped} dropped by the queue (${this.capture.recovered} recovered, ${this.capture.lost} lost), ` +
          `${this.capture.truncated} truncated + ${this.capture.incomplete} incomplete logs (${this.capture.refetched} re-read, ${this.capture.partial} partial), ` +
          `${this.capture.gaps} gaps reported, down ${Math.round(this.capture.downMs / 1000)} s`,
        ...(this.stats.lastError ? [`last error: ${this.stats.lastError}`] : []),
      ],
    };
  }
}
