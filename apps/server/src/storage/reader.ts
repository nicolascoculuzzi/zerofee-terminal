/** Read-side queries (REST history, restore on startup, caches). */
import type { Database } from "bun:sqlite";
import type { Candle, Timeframe, TokenSummary, Trade } from "@zerofee/protocol";
import type { PoolInfo } from "../accounts/resolver";
import type { MetadataStore } from "../feeds/metadata";

export interface TradeRow {
  id: string;
  mint: string;
  signature: string;
  slot: number;
  tx_index: number | null;
  ev_index: number;
  block_time: number;
  received_at: number;
  venue: number;
  side: number;
  trader: string;
  quote_amount: string;
  token_amount: string;
  amount_sol: number;
  price_sol: number;
  mc_sol: number;
}

export function rowToTrade(r: TradeRow): Trade {
  return {
    id: r.id,
    signature: r.signature,
    slot: r.slot,
    txIndex: r.tx_index,
    mint: r.mint,
    venue: r.venue === 0 ? "pump" : "pumpswap",
    side: r.side === 0 ? "buy" : "sell",
    trader: r.trader,
    quoteAmount: r.quote_amount,
    tokenAmount: r.token_amount,
    amountSol: r.amount_sol,
    amountUsd: null,
    priceSol: r.price_sol,
    mcSol: r.mc_sol,
    blockTime: r.block_time,
    receivedAt: r.received_at,
    tags: [],
  };
}

export class StorageReader {
  constructor(private readonly db: Database) {}

  candles(mint: string, tf: Timeframe, from: number, to: number, limit: number): Candle[] {
    const rows = this.db
      .query(
        `SELECT t, o, h, l, c, v, n, sol_usd AS solUsd FROM candles WHERE mint = ? AND tf = ? AND t >= ? AND t <= ? ORDER BY t DESC LIMIT ?`,
      )
      .all(mint, tf, from, to, limit) as Candle[];
    return rows.reverse();
  }

  token(mint: string): { summary: TokenSummary; state: string } | null {
    const r = this.db.query("SELECT summary, state FROM tokens WHERE mint = ?").get(mint) as { summary: string; state: string } | null;
    return r ? { summary: JSON.parse(r.summary) as TokenSummary, state: r.state } : null;
  }

  /** Tokens worth restoring: created, migrated or updated since `sinceMs`. */
  tokensSince(sinceMs: number, limit = 200_000): { mint: string; state: string }[] {
    return this.db
      .query(
        `SELECT mint, state FROM tokens WHERE updated_at >= ?1 OR created_at >= ?1 OR migrated_at >= ?1 ORDER BY updated_at DESC LIMIT ?2`,
      )
      .all(sinceMs, limit) as { mint: string; state: string }[];
  }

  /** Trades of `mints` since `sinceMs`, in chain order (for replay). */
  *tradesFor(mints: readonly string[], sinceMs: number): Generator<TradeRow> {
    const q = this.db.query(
      "SELECT * FROM trades WHERE mint = ? AND block_time >= ? ORDER BY slot, COALESCE(tx_index, 0), received_at, ev_index",
    );
    for (const m of mints) for (const r of q.iterate(m, sinceMs) as Iterable<TradeRow>) yield r;
  }

  recentTrades(mint: string, limit: number): Trade[] {
    return (
      this.db
        .query("SELECT * FROM trades WHERE mint = ? ORDER BY block_time DESC, slot DESC, ev_index DESC LIMIT ?")
        .all(mint, limit) as TradeRow[]
    ).map(rowToTrade);
  }

  pools(): PoolInfo[] {
    return (this.db.query("SELECT info FROM pools").all() as { info: string }[]).map((r) => JSON.parse(r.info) as PoolInfo);
  }

  /** Metadata cache adapter (reads here, writes through the batched writer). */
  metadataStore(put: (key: string, json: string | null, ok: boolean) => void): MetadataStore {
    const q = this.db.query("SELECT json, ok, fetched_at AS fetchedAt FROM metadata_cache WHERE key = ?");
    return {
      get: (key) => {
        const r = q.get(key) as { json: string | null; ok: number; fetchedAt: number } | null;
        return r ? { json: r.json, ok: r.ok === 1, fetchedAt: r.fetchedAt } : null;
      },
      put,
    };
  }
}
