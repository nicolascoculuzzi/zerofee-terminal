/**
 * Startup restore: reload recent token records and rebuild what lives only in memory (holder books,
 * rolling windows, the trade ring) by replaying stored trades. Holder tracking is restored only for
 * tokens created within `replayHours` (their full trade history is in the trades table); older tokens
 * come back with untracked (null) audit metrics and windows that refill from live trades.
 */
import { logger } from "../log";
import type { OrderKey } from "../market/candles";
import type { MarketState } from "../market/state";
import type { TokenRecord, TradeEntry } from "../market/token";
import { perf } from "../perf";
import { deserializeRecord } from "./codec";
import { rowToTrade, type StorageReader, type TradeRow } from "./reader";

const log = logger("restore");

export interface RestoreOptions {
  /** Restore tokens touched within this window. */
  sinceMs: number;
  /** Replay trades (holders, windows) for tokens created after this time. */
  replaySinceMs: number;
  now: number;
}

export function restoreMarket(
  market: MarketState,
  reader: StorageReader,
  o: RestoreOptions,
): { tokens: number; replayed: number; trades: number } {
  const t0 = performance.now();
  const replay: TokenRecord[] = [];
  let tokens = 0;
  for (const row of reader.tokensSince(o.sinceMs)) {
    try {
      const { rec, hadHolders } = deserializeRecord(row.state, o.now);
      if (hadHolders && rec.createdAt !== null && rec.createdAt >= o.replaySinceMs) {
        rec.holders = market.newHolderBook(rec.createdSlot);
        rec.holders.exclude(rec.bondingCurve);
        rec.holders.exclude(rec.pool);
        rec.holders.addDev(rec.creatorAtCreate);
        rec.holders.addDev(rec.creator);
        replay.push(rec);
      }
      market.restore(rec);
      tokens++;
    } catch (e) {
      log.warn(`skipping ${row.mint}: ${e instanceof Error ? e.message : e}`);
    }
  }
  let trades = 0;
  let group: TradeRow[] = [];
  const flushGroup = () => {
    if (!group.length) return;
    const rec = market.tokens.get((group[0] as TradeRow).mint);
    const buyers = new Set(group.filter((r) => r.side === 0).map((r) => r.trader));
    if (rec) for (const r of group) replayTrade(rec, r, buyers);
    trades += group.length;
    group = [];
  };
  for (const r of reader.tradesFor(
    replay.map((x) => x.mint),
    o.replaySinceMs,
  )) {
    if (group.length && (group[0] as TradeRow).signature !== r.signature) flushGroup();
    group.push(r);
  }
  flushGroup();
  perf.span("restore.sync", performance.now() - t0);
  log.info(
    `restored ${tokens} tokens, replayed ${trades} trades for ${replay.length} tracked tokens in ${Math.round(performance.now() - t0)} ms`,
  );
  return { tokens, replayed: replay.length, trades };
}

function replayTrade(rec: TokenRecord, r: TradeRow, txBuyers: Set<string>): void {
  const isBuy = r.side === 0;
  const amount = BigInt(r.token_amount);
  const delta = isBuy ? amount : -amount;
  if (rec.holders) {
    rec.holders.applyDelta(r.trader, delta);
    if (isBuy) rec.holders.classifyBuy(r.trader, r.slot, txBuyers, BigInt(r.quote_amount));
  }
  rec.windows.add(r.block_time, r.amount_sol ?? 0, isBuy);
  const trade = rowToTrade(r);
  trade.tags = rec.holders ? rec.holders.tagsOf(r.trader) : [];
  const entry: TradeEntry = {
    trade,
    key: [r.slot, r.tx_index ?? 0, r.ev_index] as OrderKey,
    tsMs: r.block_time,
    volumeSol: r.amount_sol ?? 0,
    isBuy,
    holderDelta: rec.holders ? delta : 0n,
    curveAfter: null,
    poolAfter: null,
    priceSol: r.price_sol ?? 0,
    solUsd: null,
  };
  rec.trades.push(entry);
  if (rec.trades.length > 200) rec.trades.shift();
}
