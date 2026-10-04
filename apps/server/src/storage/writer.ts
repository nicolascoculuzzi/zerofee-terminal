/**
 * The single SQLite writer: queues rows from the market state and flushes them in ONE transaction every
 * ~250 ms (WAL + prepared statements). Candle and token updates coalesce by key (latest wins); trades append.
 * A periodic job prunes trades past the retention window and short-timeframe candles.
 *
 * With `threadPath` (the server's database file) the transaction runs on a writer thread (writerWorker.ts)
 * with its own connection: the event loop only hands over plain row arrays, so inserts (tens of ms per flush
 * under the firehose, growing with the tables) never stall ingest or the gateway. At most one batch is in
 * flight; while the thread is busy, rows keep coalescing here. Without it (tests, in-memory databases) the
 * flush runs inline.
 */
import type { Database } from "bun:sqlite";
import type { Candle, Timeframe, TokenSummary, Trade } from "@zerofee/protocol";
import type { PoolInfo } from "../accounts/resolver";
import { logger } from "../log";
import type { StorageSink } from "../market/state";
import type { TokenRecord } from "../market/token";
import { perf } from "../perf";
import { BatchApplier, batchRows, type WriteBatch } from "./batch";
import { serializeRecord } from "./codec";

const log = logger("storage");

export interface WriterOptions {
  flushMs: number;
  retentionHours: number;
  /** Max trades deleted per prune pass (keeps passes short). */
  pruneBatch?: number;
  /** Database file for the writer thread; absent (or ":memory:") = write inline on this thread. */
  threadPath?: string | null;
}

/** A wallet's first incoming SOL transfer (Helius funded-by); funder null = none found. */
export interface WalletFunderRow {
  wallet: string;
  funder: string | null;
  funderName: string | null;
  funderType: string | null;
  amountLamports: string | null;
  fundedAt: number | null;
  slot: number | null;
  fetchedAt: number;
}

interface Done {
  type: "done";
  id: number;
  ms: number;
  rows: number;
  pruned?: number;
  error?: string;
}

export class StorageWriter implements StorageSink {
  private trades: unknown[][] = [];
  private tradeDeletes: string[] = [];
  private readonly candles = new Map<string, unknown[]>();
  /** Latest record per mint, serialized at flush time: repeated persists of one token cost one serialization. */
  private readonly tokens = new Map<string, { rec: TokenRecord; summary: TokenSummary }>();
  private readonly pools = new Map<string, unknown[]>();
  private readonly meta = new Map<string, unknown[]>();
  private readonly funders = new Map<string, unknown[]>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  readonly stats = { flushes: 0, rows: 0, errors: 0, lastFlushMs: null as number | null, maxFlushMs: 0, pruned: 0 };
  private readonly applier: BatchApplier;
  private worker: Worker | null = null;
  private seq = 0;
  private inFlight: { id: number; rows: number; trades: number } | null = null;
  private readonly waiters = new Map<number, () => void>();

  constructor(
    db: Database,
    private readonly opts: WriterOptions,
  ) {
    this.applier = new BatchApplier(db);
    if (opts.threadPath && opts.threadPath !== ":memory:") {
      try {
        const w = new Worker(new URL("./writerWorker.ts", import.meta.url).href);
        w.postMessage({ type: "init", path: opts.threadPath });
        w.onmessage = (ev: MessageEvent<Done>) => this.onDone(ev.data);
        w.onerror = (ev) => log.error(`writer thread error: ${(ev as ErrorEvent).message ?? String(ev)}`);
        this.worker = w;
      } catch (e) {
        log.warn(`writer thread unavailable, writing inline: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  /** True when flushes run on the writer thread. */
  get threaded(): boolean {
    return this.worker !== null;
  }

  start(): void {
    this.timer ??= setInterval(() => this.flush(), this.opts.flushMs);
    this.pruneTimer ??= setInterval(() => this.prune(), 60_000);
  }

  /**
   * Stops the timers and writes everything still queued. Threaded: waits for the batch in flight, writes
   * the rest inline on this connection (shutdown only), then ends the thread.
   */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.timer = null;
    this.pruneTimer = null;
    const w = this.worker;
    if (!w) {
      this.flush();
      return;
    }
    if (this.inFlight) await this.wait(this.inFlight.id, 10_000);
    this.worker = null;
    this.inFlight = null;
    this.flush();
    const id = ++this.seq;
    w.postMessage({ type: "close", id });
    await this.wait(id, 2_000);
    w.terminate();
  }

  private wait(id: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiters.delete(id);
        resolve();
      }, timeoutMs);
      this.waiters.set(id, () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  get pending(): number {
    return (
      this.trades.length +
      this.tradeDeletes.length +
      this.candles.size +
      this.tokens.size +
      this.pools.size +
      this.meta.size +
      this.funders.size +
      (this.inFlight?.rows ?? 0)
    );
  }

  trade(t: Trade, evIndex: number): void {
    this.trades.push([
      t.id,
      t.mint,
      t.signature,
      t.slot,
      t.txIndex,
      evIndex,
      t.blockTime,
      t.receivedAt,
      t.venue === "pump" ? 0 : 1,
      t.side === "buy" ? 0 : 1,
      t.trader,
      t.quoteAmount,
      t.tokenAmount,
      t.amountSol,
      t.priceSol,
      t.mcSol,
    ]);
  }

  deleteTrades(ids: string[]): void {
    this.tradeDeletes.push(...ids);
  }

  candle(mint: string, tf: Timeframe, c: Candle): void {
    this.candles.set(`${mint}|${tf}|${c.t}`, [mint, tf, c.t, c.o, c.h, c.l, c.c, c.v, c.n, c.solUsd]);
  }

  token(rec: TokenRecord, summary: TokenSummary): void {
    this.tokens.set(rec.mint, { rec, summary });
  }

  walletFunder(r: WalletFunderRow): void {
    this.funders.set(r.wallet, [r.wallet, r.funder, r.funderName, r.funderType, r.amountLamports, r.fundedAt, r.slot, r.fetchedAt]);
  }

  pool(info: PoolInfo): void {
    this.pools.set(info.pool, [info.pool, info.baseMint, info.quoteMint, JSON.stringify(info), info.updatedAt]);
  }

  metadata(key: string, json: string | null, ok: boolean): void {
    this.meta.set(key, [key, json, ok ? 1 : 0, Date.now()]);
  }

  /** Moves everything queued into one batch (token rows are serialized here). */
  private takeBatch(): WriteBatch {
    const tokens: unknown[][] = [];
    for (const { rec, summary } of this.tokens.values()) {
      tokens.push([
        rec.mint,
        rec.name,
        rec.symbol,
        rec.launchpad,
        rec.createdAt,
        rec.migratedAt,
        rec.updatedAt,
        JSON.stringify(summary),
        serializeRecord(rec),
        // dev history keys on the creator recorded at creation (the live one can be rewritten by fee sharing)
        rec.creatorAtCreate ?? rec.creator,
        rec.migrated ? 1 : 0,
      ]);
    }
    const b: WriteBatch = {
      trades: this.trades,
      deletes: this.tradeDeletes,
      candles: [...this.candles.values()],
      tokens,
      pools: [...this.pools.values()],
      meta: [...this.meta.values()],
      funders: [...this.funders.values()],
    };
    this.trades = [];
    this.tradeDeletes = [];
    this.candles.clear();
    this.tokens.clear();
    this.pools.clear();
    this.meta.clear();
    this.funders.clear();
    return b;
  }

  flush(): void {
    if (this.pending === 0) return;
    const t0 = performance.now();
    if (this.worker) {
      if (this.inFlight) return; // the thread is busy: keep coalescing
      const batch = this.takeBatch();
      const rows = batchRows(batch);
      if (rows === 0) return;
      const id = ++this.seq;
      this.inFlight = { id, rows, trades: batch.trades.length };
      this.worker.postMessage({ type: "batch", id, batch });
      perf.span("storage.handoff", performance.now() - t0);
      return;
    }
    const batch = this.takeBatch();
    try {
      this.applier.apply(batch);
      const ms = performance.now() - t0;
      this.recordFlush(batchRows(batch), ms);
      perf.span("storage.flush", ms);
    } catch (e) {
      this.stats.errors++;
      log.error(
        `flush failed (${batch.trades.length} trades, ${batch.candles.length} candles dropped): ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  private recordFlush(rows: number, ms: number): void {
    this.stats.flushes++;
    this.stats.rows += rows;
    this.stats.lastFlushMs = Math.round(ms * 100) / 100;
    if (ms > this.stats.maxFlushMs) this.stats.maxFlushMs = Math.round(ms);
  }

  private onDone(d: Done): void {
    if (this.inFlight?.id === d.id) {
      const trades = this.inFlight.trades;
      this.inFlight = null;
      if (d.error) {
        this.stats.errors++;
        log.error(`flush failed on the writer thread (${trades} trades dropped): ${d.error}`);
      } else {
        this.recordFlush(d.rows, d.ms);
        perf.stage("storage.threadFlush", d.ms);
      }
    } else if (d.pruned !== undefined) this.stats.pruned += d.pruned;
    else if (d.error) log.warn(`writer thread: ${d.error}`);
    const waiter = this.waiters.get(d.id);
    if (waiter) {
      this.waiters.delete(d.id);
      waiter();
    }
  }

  prune(now = Date.now()): void {
    const pruneBatch = this.opts.pruneBatch ?? 50_000;
    if (this.worker) {
      this.worker.postMessage({ type: "prune", id: ++this.seq, now, retentionHours: this.opts.retentionHours, pruneBatch });
      return;
    }
    const t0 = performance.now();
    try {
      this.stats.pruned += this.applier.prune(now, this.opts.retentionHours, pruneBatch);
    } catch (e) {
      log.warn(`prune failed: ${e instanceof Error ? e.message : e}`);
    }
    perf.span("storage.prune", performance.now() - t0);
  }
}
