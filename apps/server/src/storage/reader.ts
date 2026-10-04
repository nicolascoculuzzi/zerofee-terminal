/** Read-side queries (REST history, restore on startup, caches). */
import type { Database } from "bun:sqlite";
import type { Candle, Timeframe, TokenSummary, Trade } from "@zerofee/protocol";
import type { PoolInfo } from "../accounts/resolver";
import type { MetadataStore } from "../feeds/metadata";
import type { WalletFunderRow } from "./writer";

/** trades.venue codes (writer.ts VENUE_CODE). */
const VENUES: readonly Trade["venue"][] = ["pump", "pumpswap", "launchlab", "cpmm"];

/** One launch of a creator: when (creation time, else first sighting) and whether it migrated. */
export interface LaunchRow {
  mint: string;
  t: number;
  migrated: boolean;
}

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
  /** NULL when the trade's quote had no known SOL value (schema v3). */
  amount_sol: number | null;
  price_sol: number | null;
  mc_sol: number | null;
}

export function rowToTrade(r: TradeRow): Trade {
  return {
    id: r.id,
    signature: r.signature,
    slot: r.slot,
    txIndex: r.tx_index,
    mint: r.mint,
    venue: VENUES[r.venue] ?? "pumpswap",
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

  /**
   * One token's trades since `sinceMs` received before `receivedBefore`, in chain order, row by row (the
   * startup replay yields to the event loop between slices).
   */
  *iterateTradesOf(mint: string, sinceMs: number, receivedBefore = Number.MAX_SAFE_INTEGER): Generator<TradeRow> {
    const q = this.db.query(
      "SELECT * FROM trades WHERE mint = ? AND block_time >= ? AND received_at < ? ORDER BY slot, COALESCE(tx_index, 0), received_at, ev_index",
    );
    for (const r of q.iterate(mint, sinceMs, receivedBefore) as Iterable<TradeRow>) yield r;
  }

  recentTrades(mint: string, limit: number): Trade[] {
    return (
      this.db
        .query("SELECT * FROM trades WHERE mint = ? ORDER BY block_time DESC, slot DESC, ev_index DESC LIMIT ?")
        .all(mint, limit) as TradeRow[]
    ).map(rowToTrade);
  }

  /** A wallet's most recent trades (as the trade's own wallet), newest first, within trade retention. */
  tradesByTrader(trader: string, limit: number): Trade[] {
    return (
      this.db
        .query("SELECT * FROM trades WHERE trader = ? ORDER BY block_time DESC, slot DESC, ev_index DESC LIMIT ?")
        .all(trader, limit) as TradeRow[]
    ).map(rowToTrade);
  }

  pools(): PoolInfo[] {
    return (this.db.query("SELECT info FROM pools").all() as { info: string }[]).map((r) => JSON.parse(r.info) as PoolInfo);
  }

  /** A creator's launches we recorded (most recent `limit`). Indexed by (creator, created_at). */
  launchesBy(creator: string, limit = 5_000): LaunchRow[] {
    const rows = this.db
      .query(
        `SELECT mint, COALESCE(created_at, json_extract(state, '$.firstSeenAt'), updated_at) AS t, migrated
         FROM tokens WHERE creator = ? ORDER BY t DESC LIMIT ?`,
      )
      .all(creator, limit) as { mint: string; t: number; migrated: number }[];
    return rows.map((r) => ({ mint: r.mint, t: r.t, migrated: r.migrated === 1 }));
  }

  /** Cached funding of a wallet (undefined = never looked up). */
  walletFunder(wallet: string): WalletFunderRow | undefined {
    const r = this.db
      .query(
        `SELECT wallet, funder, funder_name AS funderName, funder_type AS funderType, amount_lamports AS amountLamports,
           funded_at AS fundedAt, slot, fetched_at AS fetchedAt FROM wallet_funders WHERE wallet = ?`,
      )
      .get(wallet) as WalletFunderRow | null;
    return r ?? undefined;
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
