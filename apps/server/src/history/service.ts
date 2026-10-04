/**
 * HistoryService - every buy and sell of a coin, not just the ones the live feed saw: per-coin trade-history
 * coverage, backfill from chain and gap-fill after feed losses.
 *
 * Coverage (TokenSummary.history): "complete" when the server holds every trade since creation (create seen live
 * by this process, or a backfill that walked the coin's accounts back to their first transaction), "partial"
 * otherwise (first seen mid-life, capped backfill, a feed gap not repaired yet), "backfilling" while a job runs.
 * Persisted in token_history with the newest signature covered per account, so a later gap-fill only walks what
 * is new (getSignaturesForAddress `until`).
 *
 * A job walks the coin's accounts (bonding curve, then its PumpSwap / LaunchLab / CPMM pool) newest first with
 * getSignaturesForAddress, skips failed transactions and signatures it already holds, fetches the rest with
 * getTransaction, decodes them with the live decoders (ingestFromJsonTx: Anchor event-CPI) and merges them in
 * rounds (MarketState.collectHistory / mergeHistory, idempotent on signature + side + amount): trades are stored,
 * the touched hours' candles rebuilt, and each round goes out as a `backfill` correction on trades:<mint> and
 * candles:<mint>:<tf>. When the walk reaches the creation, the holder book is rebuilt from the full list.
 *
 * Refresh: a viewed coin (HISTORY_VIEW_REFRESH_MS) and a listed one (HISTORY_LISTED_REFRESH_MS) is re-checked against
 * the chain: one signatures page down to the last signature covered, getTransaction only for what the feed missed.
 * logsSubscribe can drop notifications without any sign, so this is what keeps the coins people look at whole.
 *
 * Priority: coins a user views (token / trades / candles topic, GET /api/trades) first, then Final Stretch and
 * Migrated coins, then everything else (HISTORY_BACKGROUND). One RPC budget (HISTORY_RPS) is shared; the job
 * with the best priority takes each next call, so a viewed coin pre-empts a background walk mid-way. Effort is
 * capped per coin (HISTORY_MAX_TX_PER_COIN, HISTORY_MAX_SIG_PAGES); a capped coin stays "partial" with `capped`.
 *
 * Off the hot path: its own RPC client and pacer, awaits between calls, merges in small rounds that yield to the
 * event loop; it never touches the ingest queue.
 */
import type { Address } from "@solana/kit";
import { bondingCurvePda } from "@zerofee/core";
import type { Candle, HistoryHealth, Timeframe, TokenHistory, Trade } from "@zerofee/protocol";
import type { HistoryConfig } from "../config";
import { ingestFromJsonTx, type RpcJsonTx } from "../ingest/jsonTx";
import type { IngestGap, IngestTx } from "../ingest/types";
import { logger } from "../log";
import type { HistoryIndex, MarketState } from "../market/state";
import type { TokenRecord } from "../market/token";
import { deserializeRecord } from "../storage/codec";
import type { StorageReader } from "../storage/reader";
import type { StorageWriter, TokenHistoryRow } from "../storage/writer";
import { RpcError } from "../util/rpc";
import { type CoinAccounts, walkAccounts } from "./coin";
import type { HistoryReader, SignatureInfo } from "./reader";

const log = logger("history");
const HOUR = 3_600_000;

export type HistoryPriority = 0 | 1 | 2;
const PRIORITY_NAMES = ["viewed", "listed", "background"] as const;

/** A feed gap a source reported (reconnect, lost transaction, stalled subscription). */
export type FeedGap = IngestGap;

export interface HistoryDeps {
  cfg: HistoryConfig;
  market: MarketState;
  reader: HistoryReader;
  store: StorageReader;
  writer: StorageWriter;
  /** Mints a user views right now (token / trades / candles subscribers). */
  watched(): Iterable<string>;
  /** Final Stretch and Migrated coins (Pulse). */
  listed(): Iterable<string>;
  /** A merge round's new trades and rebuilt candles, and the coverage after it (gateway: backfill corrections). */
  publish?(mint: string, added: readonly Trade[], candles: ReadonlyMap<Timeframe, readonly Candle[]>, history: TokenHistory): void;
  /** Decodes a fetched transaction (default ingestFromJsonTx: event-CPI, accounts, balances). Tests inject one. */
  decode?(signature: string, tx: RpcJsonTx, receivedAt: number): IngestTx | null;
  /** Waits for a PumpSwap pool's accounts (decimals) before a backfill applies its swaps. */
  poolReady?(pool: string): boolean;
  requestPool?(pool: string): void;
  now?(): number;
}

interface WalkState {
  address: string;
  before?: string;
  until?: string;
  newest: string | null;
  done: boolean;
  /** The walk ran out of signatures without an `until`: it reached the account's first transaction. */
  reachedStart: boolean;
  pages: number;
  lastSlot: number;
  rankInSlot: number;
}

interface Job {
  mint: string;
  priority: HistoryPriority;
  reason: string;
  enqueuedAt: number;
  notBefore: number;
  started: boolean;
  coin: CoinAccounts | null;
  walks: WalkState[];
  pending: { signature: string; slot: number; seq: number }[];
  buffer: { tx: IngestTx; seq: number }[];
  known: HistoryIndex;
  stats: { signatures: number; fetched: number; added: number };
  capped: boolean;
  errors: number;
  waitPoolUntil: number;
  lastProgressAt: number;
  /** A routine re-check of a complete coin: its coverage stays "complete" unless it finds trades. */
  quiet: boolean;
}

export class HistoryService {
  private readonly jobs = new Map<string, Job>();
  private readonly lastAttempt = new Map<string, number>();
  private readonly lastRefresh = new Map<string, number>();
  private running: string | null = null;
  private stopped = true;
  private loop: Promise<void> | null = null;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private readonly gapTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly startedAt: number;
  readonly stats = {
    completed: 0,
    partial: 0,
    failed: 0,
    tradesAdded: 0,
    gaps: 0,
    gapFills: 0,
    evicted: 0,
    rateLimitedSteps: 0,
    overcounts: 0,
  };

  constructor(private readonly d: HistoryDeps) {
    this.startedAt = this.now();
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  start(): void {
    if (!this.d.cfg.enabled || !this.stopped) return;
    this.stopped = false;
    this.scanTimer = setInterval(() => this.scan(), 3_000);
    (this.scanTimer as { unref?: () => void }).unref?.();
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.scanTimer) clearInterval(this.scanTimer);
    for (const t of this.gapTimers) clearTimeout(t);
    this.gapTimers.clear();
    await this.loop;
  }

  // ---------------------------------------------------------------------------------------------
  // coverage
  // ---------------------------------------------------------------------------------------------

  /** Coverage of a coin (assessing it on first use); null when the coin is unknown here. */
  state(mint: string): TokenHistory | null {
    const rec = this.d.market.tokens.get(mint);
    if (rec) {
      if (!rec.history) this.assess(rec);
      return rec.history;
    }
    const row = this.d.store.historyRow(mint);
    return row ? this.fromRow(row, null) : null;
  }

  private fromRow(row: TokenHistoryRow, progress: TokenHistory["progress"]): TokenHistory {
    return {
      state: row.state as TokenHistory["state"],
      fromSlot: row.fromSlot,
      fromTime: row.fromTime,
      trades: row.trades,
      fromCreation: row.fromCreation,
      capped: row.capped,
      progress,
      updatedAt: row.updatedAt,
    };
  }

  /** Initial coverage of a coin the service has not looked at yet. */
  private assess(rec: TokenRecord): void {
    const now = this.now();
    const row = this.d.store.historyRow(rec.mint);
    let h: TokenHistory;
    if (row) {
      h = this.fromRow(row, null);
      // complete before this process started: the downtime is a gap until a gap-fill walks it
      if (h.state === "complete" && row.updatedAt < this.startedAt) h = { ...h, state: "partial", updatedAt: now };
      if (h.state === "backfilling") h = { ...h, state: "partial", updatedAt: now };
    } else {
      const seenFromCreate = rec.createdAt !== null && rec.firstSeenAt - rec.createdAt < 120_000;
      const thisProcess = rec.firstSeenAt >= this.startedAt;
      h = {
        state: seenFromCreate && thisProcess ? "complete" : "partial",
        fromSlot: seenFromCreate ? rec.createdSlot : (rec.trades[0]?.trade.slot ?? null),
        fromTime: seenFromCreate ? rec.createdAt : (rec.trades[0]?.tsMs ?? null),
        trades: null,
        fromCreation: seenFromCreate && thisProcess,
        capped: false,
        progress: null,
        updatedAt: now,
      };
    }
    rec.history = h;
  }

  private setHistory(mint: string, h: TokenHistory): void {
    this.d.market.setHistory(mint, h);
  }

  // ---------------------------------------------------------------------------------------------
  // queue
  // ---------------------------------------------------------------------------------------------

  /** Asks for a coin's history (a viewer opened it: priority 0). */
  request(mint: string, priority: HistoryPriority = 0, reason = "request"): void {
    if (!this.d.cfg.enabled) return;
    this.consider(mint, priority, reason, true);
  }

  private consider(mint: string, priority: HistoryPriority, reason: string, force = false): void {
    const job = this.jobs.get(mint);
    if (job) {
      if (priority < job.priority) job.priority = priority;
      return;
    }
    const h = this.state(mint);
    if (h && h.state === "complete" && reason !== "gap" && reason !== "refresh") return;
    // a capped / failed coin is not walked again in a loop
    const last = this.lastAttempt.get(mint);
    const cool = priority === 0 ? 5 * 60_000 : 30 * 60_000;
    if (!force && last !== undefined && this.now() - last < cool) return;
    if (force && last !== undefined && this.now() - last < 15_000) return;
    if (this.jobs.size >= this.d.cfg.queueMax && !this.evictFor(priority)) return;
    this.jobs.set(mint, {
      mint,
      priority,
      reason,
      enqueuedAt: this.now(),
      notBefore: 0,
      started: false,
      coin: null,
      walks: [],
      pending: [],
      buffer: [],
      known: { counts: new Map(), sigs: new Set() },
      stats: { signatures: 0, fetched: 0, added: 0 },
      capped: false,
      errors: 0,
      waitPoolUntil: 0,
      lastProgressAt: 0,
      quiet: reason === "refresh" && h?.state === "complete",
    });
    // a viewer is waiting: say "backfilling" now (the job starts within a step or two)
    if (priority === 0 && h && h.state !== "complete" && h.state !== "backfilling") {
      this.setHistory(mint, { ...h, state: "backfilling", progress: { signatures: 0, fetched: 0, added: 0 }, updatedAt: this.now() });
    }
  }

  /** Drops the newest not-started job of a worse priority to make room. */
  private evictFor(priority: HistoryPriority): boolean {
    let victim: Job | null = null;
    for (const j of this.jobs.values()) {
      if (j.started || j.priority <= priority) continue;
      if (!victim || j.priority > victim.priority || (j.priority === victim.priority && j.enqueuedAt > victim.enqueuedAt)) victim = j;
    }
    if (!victim) return false;
    this.jobs.delete(victim.mint);
    this.stats.evicted++;
    return true;
  }

  /** Periodic: viewed coins, listed coins, then (background) coins first seen mid-life. */
  scan(): void {
    if (this.stopped) return;
    const now = this.now();
    const refresh = (mint: string, every: number, p: HistoryPriority) => {
      if (!every || this.jobs.has(mint) || now - (this.lastRefresh.get(mint) ?? 0) < every) return;
      if (this.state(mint)?.state !== "complete") return;
      this.lastRefresh.set(mint, now);
      this.consider(mint, p, "refresh", true);
    };
    // a holder book above the circulating supply missed sells: gap-fill, then rebuild it from the full history
    const repair = (mint: string, p: HistoryPriority) => {
      const rec = this.d.market.tokens.get(mint);
      if (!rec || this.jobs.has(mint) || !this.d.market.holdersOvercounted(mint)) return;
      if (now - (this.lastRefresh.get(mint) ?? 0) < 5 * 60_000) return;
      this.stats.overcounts++;
      this.lastRefresh.set(mint, now);
      this.lastAttempt.delete(mint);
      this.consider(mint, p, "gap", true);
    };
    for (const mint of this.d.watched()) {
      this.consider(mint, 0, "view");
      refresh(mint, this.d.cfg.viewRefreshMs, 0);
      repair(mint, 0);
    }
    for (const mint of this.d.listed()) {
      this.consider(mint, 1, "listed");
      refresh(mint, this.d.cfg.listedRefreshMs, 1);
      repair(mint, 1);
    }
    if (!this.d.cfg.background) return;
    const cutoff = this.now() - 30 * 60_000;
    for (const rec of this.d.market.tokens.values()) {
      if (this.jobs.size >= this.d.cfg.queueMax) break;
      if (!rec.history) this.assess(rec);
      if (rec.history?.state !== "partial" || (rec.lastTradeAt ?? 0) < cutoff) continue;
      this.consider(rec.mint, 2, "midlife");
    }
  }

  /**
   * A source lost part of the feed: the active coins (viewed, listed, traded in the last 10 minutes) become
   * "partial" and get a gap-fill once in-flight re-reads have landed.
   */
  onGap(g: FeedGap): void {
    if (!this.d.cfg.enabled) return;
    this.stats.gaps++;
    const t = setTimeout(() => {
      this.gapTimers.delete(t);
      const viewed = new Set(this.d.watched());
      const listed = new Set(this.d.listed());
      const recent = this.now() - 10 * 60_000;
      const active: { mint: string; p: HistoryPriority; last: number }[] = [];
      for (const rec of this.d.market.tokens.values()) {
        const p: HistoryPriority = viewed.has(rec.mint) ? 0 : listed.has(rec.mint) ? 1 : 2;
        if (p === 2 && (rec.lastTradeAt ?? 0) < recent) continue;
        active.push({ mint: rec.mint, p, last: rec.lastTradeAt ?? 0 });
      }
      // background tier: the busiest recent coins only
      active.sort((a, b) => a.p - b.p || b.last - a.last);
      let background = 0;
      for (const a of active) {
        if (a.p === 2 && ++background > 50) break;
        const rec = this.d.market.tokens.get(a.mint);
        if (!rec) continue;
        if (!rec.history) this.assess(rec);
        if (rec.history?.state === "complete") this.setHistory(a.mint, { ...rec.history, state: "partial", updatedAt: this.now() });
        this.lastAttempt.delete(a.mint);
        this.consider(a.mint, a.p, "gap");
        this.stats.gapFills++;
      }
      log.info(
        `feed gap (${g.source} ${g.reason}, slots ${g.fromSlot ?? "?"}..${g.toSlot ?? "?"}): gap-fill queued for ${active.length} coins`,
      );
    }, this.d.cfg.gapDelayMs);
    (t as { unref?: () => void }).unref?.();
    this.gapTimers.add(t);
  }

  // ---------------------------------------------------------------------------------------------
  // work loop
  // ---------------------------------------------------------------------------------------------

  private pick(): Job | null {
    const now = this.now();
    let best: Job | null = null;
    for (const j of this.jobs.values()) {
      if (j.notBefore > now) continue;
      if (
        !best ||
        j.priority < best.priority ||
        (j.priority === best.priority && j.started && !best.started) ||
        (j.priority === best.priority && j.started === best.started && j.enqueuedAt < best.enqueuedAt)
      )
        best = j;
    }
    return best;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const job = this.pick();
      if (!job) {
        await Bun.sleep(200);
        continue;
      }
      this.running = job.mint;
      try {
        await this.step(job);
      } catch (e) {
        // rate limited even after the reader's retries: the budget is short, not the job broken
        if (e instanceof RpcError && e.code === 429) {
          this.stats.rateLimitedSteps++;
          job.notBefore = this.now() + 15_000;
          this.running = null;
          continue;
        }
        job.errors++;
        log.warn(`backfill ${job.mint}: ${e instanceof Error ? e.message : e} (error ${job.errors})`);
        if (job.errors >= 5) {
          this.stats.failed++;
          await this.finalize(job, true);
        } else job.notBefore = this.now() + 5_000 * job.errors;
      }
      this.running = null;
      // yield to the event loop between steps
      await new Promise((r) => setImmediate(r));
    }
  }

  /** One unit of work: a signatures page, a getTransaction batch, a merge round or the final bookkeeping. */
  async step(job: Job): Promise<void> {
    if (!job.started && !(await this.begin(job))) return;
    if (job.buffer.length >= this.d.cfg.mergeEvery) return this.merge(job);
    if (job.pending.length) {
      const n = Math.max(1, this.d.reader.batchSize);
      const batch = job.pending.splice(0, n);
      const txs = await this.d.reader.transactions(batch.map((b) => b.signature));
      txs.forEach((tx, i) => {
        const b = batch[i] as (typeof batch)[number];
        job.stats.fetched++;
        if (!tx) return;
        const built = this.d.decode
          ? this.d.decode(b.signature, tx, this.now())
          : (ingestFromJsonTx({ signature: b.signature, tx, receivedAt: this.now(), source: "backfill" })?.tx ?? null);
        if (built && (built.events.length || built.raydium?.migrations.length)) job.buffer.push({ tx: built, seq: b.seq });
      });
      if (job.stats.fetched >= this.d.cfg.maxTxPerCoin) {
        job.capped = true;
        job.pending = [];
        for (const w of job.walks) w.done = true;
      }
      this.progress(job);
      return;
    }
    const walk = job.walks.find((w) => !w.done);
    if (walk) return this.page(job, walk);
    if (job.buffer.length) return this.merge(job);
    await this.finalize(job, false);
  }

  /** Resolves the coin's record and accounts, loads what is already held, marks it backfilling. */
  private async begin(job: Job): Promise<boolean> {
    const rec = await this.ensureRecord(job.mint);
    if (!rec) {
      this.jobs.delete(job.mint);
      return false;
    }
    const coin = coinOf(rec);
    if (!coin.curve && rec.launchpad === "pump") coin.curve = await bondingCurvePda(rec.mint as Address);
    // PumpSwap swaps need the pool's decimals before they can be priced
    if (coin.pumpPool && this.d.poolReady && !this.d.poolReady(coin.pumpPool)) {
      if (!job.waitPoolUntil) {
        job.waitPoolUntil = this.now() + 15_000;
        this.d.requestPool?.(coin.pumpPool);
      }
      if (this.now() < job.waitPoolUntil) {
        job.notBefore = this.now() + 500;
        return false;
      }
      coin.pumpPool = null; // never resolved: walk the curve only
    }
    job.coin = coin;
    await this.d.writer.drain();
    const row = this.d.store.historyRow(job.mint);
    const cursors = row?.cursors ? (JSON.parse(row.cursors) as Record<string, string>) : {};
    // gap-fill of a coin whose walk once completed: stop at the newest signature covered then
    const gapOnly = row?.state === "complete" || (row?.fromCreation === true && !row.capped);
    job.walks = walkAccounts(coin).map((a) => ({
      address: a.address,
      until: gapOnly ? cursors[a.address] : undefined,
      newest: null,
      done: false,
      reachedStart: false,
      pages: 0,
      lastSlot: -1,
      rankInSlot: 0,
    }));
    for (const r of this.d.store.tradeKeys(job.mint)) {
      const k = `${r.signature}|${r.side === 0 ? "buy" : "sell"}|${r.token_amount}`;
      job.known.counts.set(k, (job.known.counts.get(k) ?? 0) + 1);
      job.known.sigs.add(r.signature);
    }
    job.started = true;
    this.lastAttempt.set(job.mint, this.now());
    this.lastRefresh.set(job.mint, this.now());
    if (job.quiet) return true;
    const h = rec.history ?? this.state(job.mint);
    this.setHistory(job.mint, {
      state: "backfilling",
      fromSlot: h?.fromSlot ?? null,
      fromTime: h?.fromTime ?? null,
      trades: h?.trades ?? null,
      fromCreation: h?.fromCreation ?? false,
      capped: false,
      progress: { signatures: 0, fetched: 0, added: 0 },
      updatedAt: this.now(),
    });
    log.debug(
      `backfill ${job.mint} (${PRIORITY_NAMES[job.priority]}, ${job.reason}): ${job.walks.length} accounts, ${job.known.sigs.size} txs held`,
    );
    return true;
  }

  private async page(job: Job, w: WalkState): Promise<void> {
    const sigs: SignatureInfo[] = await this.d.reader.signatures(w.address, { before: w.before, until: w.until, limit: 1_000 });
    w.pages++;
    if (w.newest === null) w.newest = sigs[0]?.signature ?? w.until ?? null;
    for (const s of sigs) {
      // newest first: within a slot, later transactions come first; seq counts down so older sorts first
      if (s.slot !== w.lastSlot) {
        w.lastSlot = s.slot;
        w.rankInSlot = 0;
      }
      w.rankInSlot++;
      job.stats.signatures++;
      if (s.err) continue;
      if (job.known.sigs.has(s.signature) || this.d.market.hasSeen(s.signature)) continue;
      job.pending.push({ signature: s.signature, slot: s.slot, seq: -w.rankInSlot });
    }
    if (sigs.length) w.before = sigs[sigs.length - 1]?.signature;
    if (sigs.length < 1_000) {
      w.done = true;
      w.reachedStart = w.until === undefined;
    } else if (w.pages >= this.d.cfg.maxSignaturePages) {
      w.done = true;
      job.capped = true;
    }
    this.progress(job);
  }

  /** Applies the buffered transactions: trades stored, touched hours' candles rebuilt, a correction published. */
  private async merge(job: Job): Promise<void> {
    const coin = job.coin as CoinAccounts;
    const buffer = job.buffer;
    job.buffer = [];
    const { entries } = this.d.market.collectHistory(coin, buffer);
    const { added, hours } = this.d.market.mergeHistory(job.mint, entries, job.known);
    job.stats.added += added.length;
    this.stats.tradesAdded += added.length;
    let candles: Map<Timeframe, Candle[]> = new Map();
    if (added.length) {
      await this.d.writer.drain();
      await new Promise((r) => setImmediate(r));
      candles = this.d.market.rebuildCandleWindows(
        job.mint,
        hours.map((h) => ({ from: h, to: h + HOUR, rows: this.d.store.tradesInRange(job.mint, h, h + HOUR) })),
      );
    }
    const h = this.progress(job, true);
    if (added.length && h) this.d.publish?.(job.mint, added, candles, h);
  }

  private progress(job: Job, force = false): TokenHistory | null {
    const rec = this.d.market.tokens.get(job.mint);
    if (!rec?.history) return null;
    if (job.quiet) return rec.history;
    const now = this.now();
    if (!force && now - job.lastProgressAt < 1_000) return rec.history;
    job.lastProgressAt = now;
    const h: TokenHistory = {
      ...rec.history,
      state: "backfilling",
      progress: { signatures: job.stats.signatures, fetched: job.stats.fetched, added: job.stats.added },
      updatedAt: now,
    };
    this.setHistory(job.mint, h);
    return h;
  }

  private async finalize(job: Job, failed: boolean): Promise<void> {
    this.jobs.delete(job.mint);
    const rec = this.d.market.tokens.get(job.mint);
    if (job.buffer.length && rec && job.coin) await this.merge(job);
    if (!rec) return;
    await this.d.writer.drain();
    const walked = job.walks.length > 0 && job.walks.every((w) => w.done);
    const prev = this.d.store.historyRow(job.mint);
    const prevComplete = prev?.state === "complete" || (prev?.fromCreation === true && !prev.capped);
    // complete: every account walked to its first transaction, or a gap-fill of a once-complete walk
    const complete = !failed && !job.capped && walked && job.walks.every((w) => w.reachedStart || (w.until !== undefined && prevComplete));
    const fromCreation = complete && rec.createdAt !== null;
    if (fromCreation && (job.stats.added > 0 || !rec.holders || this.d.market.holdersOvercounted(job.mint))) {
      const rows = this.d.store.tradesOfMint(job.mint, 200_000);
      if (rows.length < 200_000) this.d.market.rebuildHolders(job.mint, rows);
    }
    const cov = this.d.store.tradeCoverage(job.mint);
    const now = this.now();
    const h: TokenHistory = {
      state: complete ? "complete" : "partial",
      fromSlot: fromCreation ? (rec.createdSlot ?? cov.fromSlot) : cov.fromSlot,
      fromTime: fromCreation ? (rec.createdAt ?? cov.fromTime) : cov.fromTime,
      trades: cov.trades,
      fromCreation,
      capped: job.capped,
      progress: null,
      updatedAt: now,
    };
    const cursors: Record<string, string> = prev?.cursors ? JSON.parse(prev.cursors) : {};
    if (!failed) for (const w of job.walks) if (w.newest) cursors[w.address] = w.newest;
    this.d.writer.history({
      mint: job.mint,
      state: h.state,
      fromSlot: h.fromSlot,
      fromTime: h.fromTime,
      fromCreation: h.fromCreation,
      capped: h.capped,
      trades: h.trades,
      cursors: complete ? JSON.stringify(cursors) : (prev?.cursors ?? null),
      retainUntil: this.d.cfg.retainDays > 0 ? now + this.d.cfg.retainDays * 86_400_000 : null,
      updatedAt: now,
    });
    this.lastRefresh.set(job.mint, now);
    // a routine re-check that found nothing leaves the coverage as it was (no patch to clients)
    if (!(job.quiet && complete && job.stats.added === 0)) {
      this.setHistory(job.mint, h);
      this.d.publish?.(job.mint, [], new Map(), h);
    }
    if (job.quiet) {
      if (job.stats.added) log.info(`refresh ${job.mint}: ${job.stats.added} trades the feed missed`);
      return;
    }
    if (complete) this.stats.completed++;
    else if (!failed) this.stats.partial++;
    log.info(
      `backfill ${job.mint} ${h.state}${job.capped ? " (capped)" : ""}: ${job.stats.signatures} signatures, ${job.stats.fetched} fetched, ` +
        `${job.stats.added} trades added, ${cov.trades} held`,
    );
  }

  /** The coin's record: in memory, restored from the store, or (pump coins never seen) created from chain. */
  private async ensureRecord(mint: string): Promise<TokenRecord | null> {
    const m = this.d.market;
    const live = m.tokens.get(mint);
    if (live) return live;
    const row = this.d.store.token(mint);
    if (row) {
      try {
        const { rec } = deserializeRecord(row.state, this.now());
        m.restore(rec);
        return m.tokens.get(mint) ?? null;
      } catch {
        /* fall through to discovery */
      }
    }
    // Never seen: a pump.fun coin is discoverable from its curve PDA (the walk's create event builds the record).
    if (!mint.endsWith("pump")) return null;
    return m.ensureToken(mint, { launchpad: "pump", bondingCurve: await bondingCurvePda(mint as Address) });
  }

  health(): HistoryHealth {
    const queued = { viewed: 0, listed: 0, background: 0 };
    for (const j of this.jobs.values()) queued[PRIORITY_NAMES[j.priority]]++;
    const r = this.d.reader.stats;
    return {
      enabled: this.d.cfg.enabled,
      queued,
      running: this.running,
      completed: this.stats.completed,
      partial: this.stats.partial,
      failed: this.stats.failed,
      signatures: r.signatures,
      transactions: r.transactions,
      tradesAdded: this.stats.tradesAdded,
      rpcErrors: r.errors,
      rateLimited: r.rateLimited,
      rps: this.d.cfg.rps,
    };
  }

  /** A backfill of this coin is queued or running (keeps it in memory). */
  busy(mint: string): boolean {
    return this.jobs.has(mint);
  }

  /** Pending jobs (tests, debug). */
  get queueSize(): number {
    return this.jobs.size;
  }
}

/** Accounts carrying a coin's trades, from its record. */
export function coinOf(rec: TokenRecord): CoinAccounts {
  const launchLab = rec.launchpad === "launchlab";
  return {
    mint: rec.mint,
    curve: !launchLab && rec.launchpad === "pump" ? rec.bondingCurve : null,
    pumpPool: !launchLab ? rec.pool : null,
    launchLabPool: rec.launchLab?.pool ?? null,
    cpmmPool: launchLab && rec.migrated ? rec.pool : null,
  };
}
