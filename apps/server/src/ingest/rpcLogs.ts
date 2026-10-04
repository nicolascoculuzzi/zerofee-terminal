/**
 * RpcLogsSource - the free development feed: Solana RPC WebSocket `logsSubscribe` with one `mentions`
 * filter per program (the filter accepts exactly one address), decoding events from `Program data:`
 * lines. Also subscribes to `slotSubscribe` (chain tip, to measure lag) and tries the unstable
 * `slotsUpdatesSubscribe` for dead-slot notices.
 *
 * Logs carry no account keys, no tx index and no block time, so: ordering inside a slot is arrival
 * order, PumpSwap pools are resolved to mints by an RPC lookup, and holder tracking is trade-based.
 *
 * Backpressure: the socket handler only parses and enqueues; a drain loop decodes in time-boxed
 * batches so I/O keeps flowing. The queue is bounded; overflow drops the oldest notifications and is
 * reported. Reconnects use exponential backoff; a silent socket is recycled by a watchdog.
 */
import type { Address } from "@solana/kit";
import { decodeLogEvents, PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID } from "@zerofee/core";
import type { SourceHealth } from "@zerofee/protocol";
import { logger } from "../log";
import { Backoff } from "../util/backoff";
import { BoundedSet } from "../util/lru";
import { SampleRing } from "../util/stats";
import { type IngestSink, RingQueue, type Source } from "./types";

const log = logger("rpc-logs");

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

export const PROGRAM_IDS = { pump: PUMP_PROGRAM_ID, pumpswap: PUMP_AMM_PROGRAM_ID } as const;

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
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
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
    ws.onmessage = (ev) => this.onMessage(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
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
      if (!logs.some((l) => l.startsWith("Program data:"))) {
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
        this.subs.set(m.result as number, program === PUMP_PROGRAM_ID ? "pump" : program === PUMP_AMM_PROGRAM_ID ? "pumpswap" : program);
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
    if (this.queue.size > 0) setImmediate(() => this.drain());
    else this.draining = false;
  }

  private process(p: Pending): void {
    const r = decodeLogEvents(p.logs);
    if (r.truncated) this.stats.truncatedLogs++;
    if (r.failures) {
      this.stats.decodeFailures += r.failures;
      for (const message of r.failureMessages) this.sink?.decodeFailure?.({ source: this.name, signature: p.signature, message });
    }
    if (!r.events.length) {
      this.stats.withoutEvents++;
      return;
    }
    this.stats.decodedTxs++;
    this.sink?.tx({
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
    });
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
        ...(this.stats.lastError ? [`last error: ${this.stats.lastError}`] : []),
      ],
    };
  }
}
