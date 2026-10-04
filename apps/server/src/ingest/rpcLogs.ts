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
 * Raydium events also lack the trading wallet, and LaunchLab graduations (`migrate_to_cpswap`) emit no
 * event at all. With `raydiumTx` set, Raydium notifications (LaunchLab events, graduations, and the CPMM
 * swaps `wants` accepts; LaunchLab first) are re-read with `getTransaction` at `confirmed` under a calls-per-second cap
 * (the public RPC allows 40 calls / 10 s per method), and the full transaction (accounts, wallet, token
 * balances) replaces the logs-only record. A transaction not found after a few tries, or one that does not
 * fit the queue, falls back to its logs-only record (graduations then become a `hint`).
 *
 * Backpressure: the socket handler only parses and enqueues; a drain loop decodes in time-boxed
 * batches so I/O keeps flowing. The queue is bounded; overflow drops the oldest notifications and is
 * reported. Reconnects use exponential backoff; a silent socket is recycled by a watchdog.
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

/** Re-reading Raydium transactions (their events lack mints and wallets; graduations emit no event). */
export interface RaydiumTxFetchOptions {
  /** getTransaction (json, maxSupportedTransactionVersion 1, confirmed); null when not found (yet). */
  fetch(signature: string): Promise<RpcJsonTx | null>;
  /** Max getTransaction calls per second. */
  perSec: number;
  /** Max queued transactions; beyond it they keep their logs-only record. Default 500. */
  maxQueue?: number;
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
  /** Recycle the socket after this long without any message. */
  idleTimeoutMs?: number;
  /** Decode budget per drain tick before yielding to I/O. */
  drainBudgetMs?: number;
  WebSocketImpl?: typeof WebSocket;
  raydiumTx?: RaydiumTxFetchOptions | null;
}

interface FetchJob {
  p: Pending;
  /** The logs-only record, emitted when the fetch gives up. */
  fallback: IngestTx | null;
  migration: boolean;
  /** LaunchLab events and graduations go before CPMM swaps when the budget is short. */
  priority: 0 | 1;
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
  readonly fetchStats = { queued: 0, fetched: 0, notFound: 0, errors: 0, fallbacks: 0, expired: 0, overflow: 0, skipped: 0, maxQueue: 0 };
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
    /** LaunchLab graduations seen in the logs (no event; resolved through a fetch or a hint). */
    migrations: 0,
    lastMessageAt: null as number | null,
    slot: null as number | null,
    tipSlot: null as number | null,
    slotUpdates: "pending" as "pending" | "ok" | "unsupported",
    lastError: null as string | null,
  };

  constructor(private readonly opts: RpcLogsSourceOptions) {
    this.queue = new RingQueue(opts.queueMax);
  }

  start(sink: IngestSink): void {
    this.sink = sink;
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => this.checkIdle(), 5_000);
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
    const idle = this.opts.idleTimeoutMs ?? 30_000;
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
      // LaunchLab graduations emit no event but must reach the decoder (fetch or hint).
      if (!logs.some((l) => l.startsWith("Program data:")) && !isLaunchLabMigrationLog(logs)) {
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
    if (r.truncated) this.stats.truncatedLogs++;
    if (r.failures) {
      this.stats.decodeFailures += r.failures;
      for (const message of r.failureMessages) this.sink?.decodeFailure?.({ source: this.name, signature: p.signature, message });
    }
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
    if (f && f.perSec > 0 && (migration || r.events.some((e) => RAYDIUM_KINDS.has(e.kind)))) {
      if (f.wants && !f.wants(r.events, migration)) this.fetchStats.skipped++;
      else if (this.fetchQueue.length >= (f.maxQueue ?? 500)) this.fetchStats.overflow++;
      else {
        const priority = migration || r.events.some((e) => e.kind === "launchlabTrade" || e.kind === "launchlabPoolCreate") ? 0 : 1;
        this.fetchQueue.push({ p, fallback, migration, priority, attempts: 0, notBefore: p.receivedAt + (f.firstDelayMs ?? 1_200) });
        this.fetchStats.queued++;
        if (this.fetchQueue.length > this.fetchStats.maxQueue) this.fetchStats.maxQueue = this.fetchQueue.length;
        return;
      }
    }
    this.emitFallback(p, fallback, migration);
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
      if (now - job.p.receivedAt <= maxAge) {
        i++;
        continue;
      }
      this.fetchQueue.splice(i, 1);
      this.fetchStats.expired++;
      this.fetchStats.fallbacks++;
      this.emitFallback(job.p, job.fallback, job.migration);
    }
    if (f.paused?.()) return;
    while (this.fetchTokens >= 1 && this.fetchInFlight < (f.maxConcurrent ?? 4)) {
      let i = this.fetchQueue.findIndex((j) => j.priority === 0 && j.notBefore <= now);
      if (i < 0) i = this.fetchQueue.findIndex((j) => j.notBefore <= now);
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
        for (const message of built.failures) this.sink?.decodeFailure?.({ source: this.name, signature: job.p.signature, message });
        this.stats.decodedTxs++;
        this.sink?.tx(built.tx);
        return;
      }
    } else if (!failed) this.fetchStats.notFound++;
    if (!tx && job.attempts < (f.maxAttempts ?? 4)) {
      job.notBefore = Date.now() + (f.retryDelayMs ?? 1_500) * job.attempts;
      this.fetchQueue.push(job);
      return;
    }
    this.fetchStats.fallbacks++;
    this.emitFallback(job.p, job.fallback, job.migration);
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
              `raydium tx fetch: queue ${this.fetchQueue.length} (max ${this.fetchStats.maxQueue}), fetched ${this.fetchStats.fetched}, ` +
                `not found ${this.fetchStats.notFound}, errors ${this.fetchStats.errors}, logs-only fallbacks ${this.fetchStats.fallbacks} ` +
                `(${this.fetchStats.expired} waited too long), ` +
                `overflow ${this.fetchStats.overflow}, skipped ${this.fetchStats.skipped}; graduations in logs ${this.stats.migrations}`,
            ]
          : []),
        ...(this.stats.lastError ? [`last error: ${this.stats.lastError}`] : []),
      ],
    };
  }
}
