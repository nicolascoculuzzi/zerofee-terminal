/**
 * Startup restore, in two phases so the server serves data right away:
 *
 *  1. `restoreMarket` (synchronous, before the gateway listens): reload recent token records. Pulse lists,
 *     token pages and search work from the first request.
 *  2. `replayHolders` (asynchronous, after ingest started): rebuild what lives only in memory (holder books,
 *     rolling windows, the trade ring) by replaying stored trades, one token at a time in time-boxed slices
 *     that yield to the event loop, so live ingest never waits behind it. Only trades received before this
 *     process started are replayed (live trades are already applied); replayed entries go in front of the
 *     live ones in the ring.
 *
 * Holder tracking is restored only for tokens created within `replayHours` (their full trade history is in
 * the trades table); older tokens come back with untracked (null) audit metrics and windows that refill
 * from live trades. Until a token's replay ran, its holder metrics count live trades only.
 */
import { RAYDIUM_CPMM_AUTHORITY, RAYDIUM_LAUNCHLAB_AUTHORITY } from "@zerofee/core";
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

export interface RestoreResult {
  tokens: number;
  /** Tokens whose holder books the replay rebuilds. */
  replayed: number;
  /** Records waiting for `replayHolders`. */
  pending: TokenRecord[];
}

/** Phase 1: token records only (fast). */
export function restoreMarket(market: MarketState, reader: StorageReader, o: RestoreOptions): RestoreResult {
  const t0 = performance.now();
  const pending: TokenRecord[] = [];
  let tokens = 0;
  for (const row of reader.tokensSince(o.sinceMs)) {
    try {
      const { rec, hadHolders } = deserializeRecord(row.state, o.now);
      if (hadHolders && rec.createdAt !== null && rec.createdAt >= o.replaySinceMs) {
        rec.holders = market.newHolderBook(rec.createdSlot);
        rec.holders.exclude(rec.bondingCurve);
        rec.holders.exclude(rec.pool);
        if (rec.launchpad === "launchlab") {
          // LaunchLab / CPMM vaults are owned by the programs' authorities.
          rec.holders.exclude(RAYDIUM_LAUNCHLAB_AUTHORITY);
          rec.holders.exclude(RAYDIUM_CPMM_AUTHORITY);
        }
        rec.holders.addDev(rec.creatorAtCreate);
        rec.holders.addDev(rec.creator);
        pending.push(rec);
      }
      market.restore(rec);
      tokens++;
    } catch (e) {
      log.warn(`skipping ${row.mint}: ${e instanceof Error ? e.message : e}`);
    }
  }
  const ms = performance.now() - t0;
  perf.span("restore.tokens", ms);
  log.info(`restored ${tokens} tokens in ${Math.round(ms)} ms; replaying trades for ${pending.length} tracked tokens in the background`);
  return { tokens, replayed: pending.length, pending };
}

export interface ReplayOptions {
  replaySinceMs: number;
  /** Trades received at or after this time are live (already applied): not replayed. */
  receivedBefore: number;
  /** Work per slice before yielding to the event loop (ms). */
  sliceMs?: number;
  /** Yield between slices (tests pass a synchronous no-op). */
  yieldFn?: () => Promise<void>;
  /** Stop early (server shutdown). */
  cancelled?: () => boolean;
}

const nextTick = () => new Promise<void>((r) => setImmediate(r));

/** Phase 2: replays stored trades into the pending records' holder books, windows and trade rings. */
export async function replayHolders(
  market: MarketState,
  reader: StorageReader,
  pending: readonly TokenRecord[],
  o: ReplayOptions,
): Promise<{ tokens: number; trades: number; ms: number }> {
  const started = performance.now();
  const sliceMs = o.sliceMs ?? 8;
  const yieldFn = o.yieldFn ?? nextTick;
  let trades = 0;
  let tokens = 0;
  let sliceStart = performance.now();
  for (const rec of pending) {
    if (o.cancelled?.()) break;
    // the token may have been evicted or replaced meanwhile
    if (market.tokens.get(rec.mint) !== rec || !rec.holders) continue;
    let t0 = performance.now();
    const entries: TradeEntry[] = [];
    let group: TradeRow[] = [];
    let groups = 0;
    const flushGroup = () => {
      if (!group.length) return;
      const buyers = new Set(group.filter((r) => r.side === 0).map((r) => r.trader));
      for (const r of group) entries.push(replayTrade(rec, r, buyers));
      group = [];
    };
    // A busy token has thousands of trades: read and apply them in slices too (at transaction boundaries).
    for (const r of reader.iterateTradesOf(rec.mint, o.replaySinceMs, o.receivedBefore)) {
      if (group.length && (group[0] as TradeRow).signature !== r.signature) {
        flushGroup();
        if ((++groups & 63) === 0 && performance.now() - sliceStart >= sliceMs) {
          perf.span("restore.replaySlice", performance.now() - t0);
          await yieldFn();
          sliceStart = t0 = performance.now();
          if (o.cancelled?.() || market.tokens.get(rec.mint) !== rec) break;
        }
      }
      group.push(r);
    }
    flushGroup();
    if (entries.length) {
      // replayed trades are older than anything live: they go first, the ring keeps its newest 200
      const ring = entries.concat(rec.trades);
      rec.trades = ring.length > 200 ? ring.slice(ring.length - 200) : ring;
      market.touchToken(rec.mint);
    }
    trades += entries.length;
    tokens++;
    perf.span("restore.replaySlice", performance.now() - t0);
    if (performance.now() - sliceStart >= sliceMs) {
      await yieldFn();
      sliceStart = performance.now();
    }
  }
  const ms = Math.round(performance.now() - started);
  log.info(`replayed ${trades} trades for ${tokens} tracked tokens in ${ms} ms (in the background)`);
  return { tokens, trades, ms };
}

function replayTrade(rec: TokenRecord, r: TradeRow, txBuyers: Set<string>): TradeEntry {
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
  return {
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
}
