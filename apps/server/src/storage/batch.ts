/**
 * One flush worth of rows and the code that writes it in a single transaction. Shared by the in-process
 * writer (tests, in-memory databases) and the writer thread (storage/writerWorker.ts), so both paths run
 * the exact same SQL.
 */
import type { Database, Statement } from "bun:sqlite";
import type { Timeframe } from "@zerofee/protocol";

/** Candle retention for short timeframes (longer ones are kept). */
export const CANDLE_RETENTION_MS: Partial<Record<Timeframe, number>> = { "1s": 2 * 86_400_000, "15s": 7 * 86_400_000 };

/** Positional rows, in the column order of the statements below (plain values: structured-clone friendly). */
export interface WriteBatch {
  trades: unknown[][];
  deletes: string[];
  candles: unknown[][];
  tokens: unknown[][];
  pools: unknown[][];
  meta: unknown[][];
  funders: unknown[][];
  /** token_history rows (history/service.ts). */
  histories: unknown[][];
}

export function batchRows(b: WriteBatch): number {
  return (
    b.trades.length +
    b.deletes.length +
    b.candles.length +
    b.tokens.length +
    b.pools.length +
    b.meta.length +
    b.funders.length +
    b.histories.length
  );
}

type StatementName = "trade" | "delTrade" | "candle" | "delCandle" | "token" | "pool" | "meta" | "funder" | "history";

export class BatchApplier {
  private readonly st: Record<StatementName, Statement>;

  constructor(private readonly db: Database) {
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
      delCandle: db.prepare("DELETE FROM candles WHERE mint = ? AND tf = ? AND t = ?"),
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
      history: db.prepare(
        `INSERT INTO token_history (mint, state, from_slot, from_time, from_creation, capped, trades, cursors, retain_until, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(mint) DO UPDATE SET state = excluded.state, from_slot = excluded.from_slot, from_time = excluded.from_time,
           from_creation = excluded.from_creation, capped = excluded.capped, trades = excluded.trades,
           cursors = COALESCE(excluded.cursors, token_history.cursors),
           retain_until = MAX(COALESCE(excluded.retain_until, 0), COALESCE(token_history.retain_until, 0)), updated_at = excluded.updated_at`,
      ),
    };
  }

  /** Writes the batch in one transaction (throws on failure: nothing of it is written). */
  apply(b: WriteBatch): void {
    const st = this.st;
    this.db.transaction(() => {
      for (const r of b.trades) st.trade.run(...(r as never[]));
      for (const id of b.deletes) st.delTrade.run(id);
      for (const r of b.candles) {
        // an emptied bucket (dead-slot rollback) arrives with n = 0: delete it
        if ((r[8] as number) <= 0) st.delCandle.run(r[0] as never, r[1] as never, r[2] as never);
        else st.candle.run(...(r as never[]));
      }
      for (const r of b.tokens) st.token.run(...(r as never[]));
      for (const r of b.pools) st.pool.run(...(r as never[]));
      for (const r of b.meta) st.meta.run(...(r as never[]));
      for (const r of b.funders) st.funder.run(...(r as never[]));
      for (const r of b.histories ?? []) st.history.run(...(r as never[]));
    })();
  }

  /**
   * Deletes trades past retention (bounded; a backfilled token keeps its whole history until its
   * token_history.retain_until) and old short-timeframe candles; returns trades deleted.
   */
  prune(now: number, retentionHours: number, pruneBatch: number): number {
    const cutoff = now - retentionHours * 3_600_000;
    const r = this.db.run(
      `DELETE FROM trades WHERE rowid IN (SELECT rowid FROM trades WHERE block_time < ?
         AND mint NOT IN (SELECT mint FROM token_history WHERE retain_until >= ?) LIMIT ?)`,
      [cutoff, now, pruneBatch] as never,
    );
    for (const [tf, ms] of Object.entries(CANDLE_RETENTION_MS)) {
      this.db.run("DELETE FROM candles WHERE tf = ? AND t < ?", [tf, now - (ms as number)] as never);
    }
    return r.changes;
  }
}
