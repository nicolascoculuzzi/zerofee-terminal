/**
 * The single SQLite writer: queues rows from the market state and flushes them in ONE transaction every
 * ~250 ms (WAL + prepared statements; thousands of rows per flush are cheap). Candle and token updates
 * coalesce by key (latest wins); trades append. A periodic job prunes trades past the retention window
 * and short-timeframe candles.
 */
import type { Database, Statement } from "bun:sqlite";
import type { Candle, Timeframe, TokenSummary, Trade } from "@zerofee/protocol";
import type { PoolInfo } from "../accounts/resolver";
import { logger } from "../log";
import type { StorageSink } from "../market/state";
import type { TokenRecord } from "../market/token";
import { perf } from "../perf";
import { serializeRecord } from "./codec";

const log = logger("storage");

/** Candle retention for short timeframes (longer ones are kept). */
const CANDLE_RETENTION_MS: Partial<Record<Timeframe, number>> = { "1s": 2 * 86_400_000, "15s": 7 * 86_400_000 };

export interface WriterOptions {
  flushMs: number;
  retentionHours: number;
  /** Max trades deleted per prune pass (keeps passes short). */
  pruneBatch?: number;
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

export class StorageWriter implements StorageSink {
  private trades: unknown[][] = [];
  private tradeDeletes: string[] = [];
  private readonly candles = new Map<string, unknown[]>();
  private readonly tokens = new Map<string, unknown[]>();
  private readonly pools = new Map<string, unknown[]>();
  private readonly meta = new Map<string, unknown[]>();
  private readonly funders = new Map<string, unknown[]>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  readonly stats = { flushes: 0, rows: 0, errors: 0, lastFlushMs: null as number | null, maxFlushMs: 0, pruned: 0 };
  private readonly st: Record<"trade" | "delTrade" | "candle" | "token" | "pool" | "meta" | "funder", Statement>;

  constructor(
    private readonly db: Database,
    private readonly opts: WriterOptions,
  ) {
    this.st = {
      trade: db.prepare(
        `INSERT OR IGNORE INTO trades (id, mint, signature, slot, tx_index, ev_index, block_time, received_at, venue, side, trader, quote_amount, token_amount, amount_sol, price_sol, mc_sol)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      delTrade: db.prepare("DELETE FROM trades WHERE id = ?"),
      candle: db.prepare(
        `INSERT INTO candles (mint, tf, t, o, h, l, c, v, n, sol_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(mint, tf, t) DO UPDATE SET o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c, v = excluded.v, n = excluded.n, sol_usd = excluded.sol_usd`,
      ),
      token: db.prepare(
        `INSERT INTO tokens (mint, name, symbol, launchpad, created_at, migrated_at, updated_at, summary, state, creator, migrated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(mint) DO UPDATE SET name = excluded.name, symbol = excluded.symbol, launchpad = excluded.launchpad, created_at = excluded.created_at,
           migrated_at = excluded.migrated_at, updated_at = excluded.updated_at, summary = excluded.summary, state = excluded.state,
           creator = excluded.creator, migrated = excluded.migrated`,
      ),
      pool: db.prepare(
        `INSERT INTO pools (pool, base_mint, quote_mint, info, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(pool) DO UPDATE SET base_mint = excluded.base_mint, quote_mint = excluded.quote_mint, info = excluded.info, updated_at = excluded.updated_at`,
      ),
      meta: db.prepare(
        `INSERT INTO metadata_cache (key, json, ok, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET json = excluded.json, ok = excluded.ok, fetched_at = excluded.fetched_at`,
      ),
      funder: db.prepare(
        `INSERT INTO wallet_funders (wallet, funder, funder_name, funder_type, amount_lamports, funded_at, slot, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(wallet) DO UPDATE SET funder = excluded.funder, funder_name = excluded.funder_name, funder_type = excluded.funder_type,
           amount_lamports = excluded.amount_lamports, funded_at = excluded.funded_at, slot = excluded.slot, fetched_at = excluded.fetched_at`,
      ),
    };
  }

  start(): void {
    this.timer ??= setInterval(() => this.flush(), this.opts.flushMs);
    this.pruneTimer ??= setInterval(() => this.prune(), 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.timer = null;
    this.pruneTimer = null;
    this.flush();
  }

  get pending(): number {
    return (
      this.trades.length +
      this.tradeDeletes.length +
      this.candles.size +
      this.tokens.size +
      this.pools.size +
      this.meta.size +
      this.funders.size
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
    this.tokens.set(rec.mint, [
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

  walletFunder(r: WalletFunderRow): void {
    this.funders.set(r.wallet, [r.wallet, r.funder, r.funderName, r.funderType, r.amountLamports, r.fundedAt, r.slot, r.fetchedAt]);
  }

  pool(info: PoolInfo): void {
    this.pools.set(info.pool, [info.pool, info.baseMint, info.quoteMint, JSON.stringify(info), info.updatedAt]);
  }

  metadata(key: string, json: string | null, ok: boolean): void {
    this.meta.set(key, [key, json, ok ? 1 : 0, Date.now()]);
  }

  flush(): void {
    if (this.pending === 0) return;
    const t0 = performance.now();
    const trades = this.trades;
    const deletes = this.tradeDeletes;
    this.trades = [];
    this.tradeDeletes = [];
    const candles = [...this.candles.values()];
    const tokens = [...this.tokens.values()];
    const pools = [...this.pools.values()];
    const meta = [...this.meta.values()];
    const funders = [...this.funders.values()];
    this.candles.clear();
    this.tokens.clear();
    this.pools.clear();
    this.meta.clear();
    this.funders.clear();
    try {
      this.db.transaction(() => {
        for (const r of trades) this.st.trade.run(...(r as never[]));
        for (const id of deletes) this.st.delTrade.run(id);
        for (const r of candles) {
          // an emptied bucket (dead-slot rollback) arrives with n = 0: delete it
          if ((r[8] as number) <= 0) this.db.run("DELETE FROM candles WHERE mint = ? AND tf = ? AND t = ?", [r[0], r[1], r[2]] as never);
          else this.st.candle.run(...(r as never[]));
        }
        for (const r of tokens) this.st.token.run(...(r as never[]));
        for (const r of pools) this.st.pool.run(...(r as never[]));
        for (const r of meta) this.st.meta.run(...(r as never[]));
        for (const r of funders) this.st.funder.run(...(r as never[]));
      })();
      this.stats.flushes++;
      this.stats.rows += trades.length + deletes.length + candles.length + tokens.length + pools.length + meta.length + funders.length;
      const ms = performance.now() - t0;
      perf.span("storage.flush", ms);
      this.stats.lastFlushMs = Math.round(ms * 100) / 100;
      if (ms > this.stats.maxFlushMs) this.stats.maxFlushMs = Math.round(ms);
    } catch (e) {
      this.stats.errors++;
      log.error(`flush failed (${trades.length} trades, ${candles.length} candles dropped): ${e instanceof Error ? e.message : e}`);
    }
  }

  prune(now = Date.now()): void {
    const t0 = performance.now();
    try {
      const cutoff = now - this.opts.retentionHours * 3_600_000;
      const r = this.db.run("DELETE FROM trades WHERE rowid IN (SELECT rowid FROM trades WHERE block_time < ? LIMIT ?)", [
        cutoff,
        this.opts.pruneBatch ?? 50_000,
      ] as never);
      this.stats.pruned += r.changes;
      for (const [tf, ms] of Object.entries(CANDLE_RETENTION_MS)) {
        this.db.run("DELETE FROM candles WHERE tf = ? AND t < ?", [tf, now - (ms as number)] as never);
      }
    } catch (e) {
      log.warn(`prune failed: ${e instanceof Error ? e.message : e}`);
    }
    perf.span("storage.prune", performance.now() - t0);
  }
}
