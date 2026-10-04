/** Read-side queries (REST history, restore on startup, caches). */
import type { Database } from "bun:sqlite";
import type { Candle, Timeframe, TokenSummary, Trade } from "@zerofee/protocol";
import type { PoolInfo } from "../accounts/resolver";
import type { MetadataStore } from "../feeds/metadata";
import type { TokenHistoryRow, WalletFunderRow } from "./writer";

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

  /** A wallet's most recent trades (as the trade's own wallet), newest first, within trade retention. */
  tradesByTrader(trader: string, limit: number): Trade[] {
    return (
      this.db
        .query("SELECT * FROM trades WHERE trader = ? ORDER BY block_time DESC, slot DESC, ev_index DESC LIMIT ?")
        .all(trader, limit) as TradeRow[]
    ).map(rowToTrade);
  }

  /**
   * One page of a token's trades, newest first, by (slot, tx index, id) keyset: `before` is the previous page's
   * last trade as `slot:txIndex:id` (txIndex -1 when unknown). Returns the page and the cursor of its last row.
   */
  tradesPage(
    mint: string,
    before: { slot: number; txIndex: number; id: string } | null,
    limit: number,
  ): { trades: Trade[]; next: string | null } {
    const rows = (
      before
        ? this.db
            .query(
              `SELECT * FROM trades WHERE mint = ?1 AND (slot < ?2 OR (slot = ?2 AND (COALESCE(tx_index, -1) < ?3 OR (COALESCE(tx_index, -1) = ?3 AND id < ?4))))
               ORDER BY slot DESC, COALESCE(tx_index, -1) DESC, id DESC LIMIT ?5`,
            )
            .all(mint, before.slot, before.txIndex, before.id, limit + 1)
        : this.db
            .query("SELECT * FROM trades WHERE mint = ?1 ORDER BY slot DESC, COALESCE(tx_index, -1) DESC, id DESC LIMIT ?2")
            .all(mint, limit + 1)
    ) as TradeRow[];
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { trades: page.map(rowToTrade), next: more && last ? `${last.slot}:${last.tx_index ?? -1}:${last.id}` : null };
  }

  /** Slot of a stored trade of `signature` (any event), for `before=<signature>` cursors. */
  slotOfSignature(signature: string): { slot: number; txIndex: number } | null {
    const r = this.db
      .query("SELECT slot, tx_index FROM trades WHERE id >= ?1 AND id < ?2 ORDER BY id LIMIT 1")
      .get(`${signature}:`, `${signature};`) as { slot: number; tx_index: number | null } | null;
    return r ? { slot: r.slot, txIndex: r.tx_index ?? -1 } : null;
  }

  /** Stored trades of a token in chain order (history rebuilds), at most `limit`. */
  tradesOfMint(mint: string, limit = 1_000_000): TradeRow[] {
    return this.db
      .query("SELECT * FROM trades WHERE mint = ? ORDER BY slot, COALESCE(tx_index, 0), ev_index, id LIMIT ?")
      .all(mint, limit) as TradeRow[];
  }

  /** A token's stored trades with block time in [from, to) (candle window rebuilds). */
  tradesInRange(mint: string, from: number, to: number): TradeRow[] {
    return this.db.query("SELECT * FROM trades WHERE mint = ? AND block_time >= ? AND block_time < ?").all(mint, from, to) as TradeRow[];
  }

  /** Identity of a token's stored trades (backfill dedupe). */
  tradeKeys(mint: string): { signature: string; side: number; token_amount: string }[] {
    return this.db.query("SELECT signature, side, token_amount FROM trades WHERE mint = ?").all(mint) as {
      signature: string;
      side: number;
      token_amount: string;
    }[];
  }

  /** Distinct signatures of a token's stored trades (backfills skip them). */
  tradeSignatures(mint: string): Set<string> {
    const out = new Set<string>();
    for (const r of this.db.query("SELECT DISTINCT signature FROM trades WHERE mint = ?").iterate(mint) as Iterable<{ signature: string }>)
      out.add(r.signature);
    return out;
  }

  /** Stored trades of a token and the oldest one's slot / time. */
  tradeCoverage(mint: string): { trades: number; fromSlot: number | null; fromTime: number | null } {
    const r = this.db.query("SELECT COUNT(*) AS n, MIN(slot) AS s, MIN(block_time) AS t FROM trades WHERE mint = ?").get(mint) as {
      n: number;
      s: number | null;
      t: number | null;
    };
    return { trades: r.n, fromSlot: r.s, fromTime: r.t };
  }

  historyRow(mint: string): TokenHistoryRow | null {
    const r = this.db
      .query(
        `SELECT mint, state, from_slot AS fromSlot, from_time AS fromTime, from_creation AS fromCreation, capped, trades, cursors,
           retain_until AS retainUntil, updated_at AS updatedAt FROM token_history WHERE mint = ?`,
      )
      .get(mint) as (Omit<TokenHistoryRow, "fromCreation" | "capped"> & { fromCreation: number; capped: number }) | null;
    return r ? { ...r, fromCreation: r.fromCreation === 1, capped: r.capped === 1 } : null;
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
