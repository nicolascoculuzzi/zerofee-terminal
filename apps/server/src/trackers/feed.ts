/**
 * Delivery of matched trades to the users who track the wallet.
 *
 * Each match is stored once (MatchRecord: the trade plus which watched wallets matched) in two bounded
 * rings: a global one (the `tracked` snapshot) and one per mint (the `tracked:<mint>` chart markers,
 * LRU over mints). Rows are built per user on the way out, from the index's current labels, so a
 * relabelled or untracked wallet shows its new state in the next snapshot and memory does not grow
 * with the number of users.
 *
 * Live rows are batched per user topic and flushed every `flushMs` (the trade tape's cadence), capped
 * per frame; nothing is built for users without a subscribed socket. A dead slot removes its matches
 * from the rings and sends `correction { remove }` to the owners.
 */
import type { CorrectionReason, Launchpad, TrackedRowKind, TrackedTradeRow, TradeTag, TradeVenue } from "@zerofee/protocol";
import { LruMap } from "../util/lru";
import type { WalletIndex, Watcher } from "./walletIndex";

/** What the feed needs from the gateway's TopicHub. */
export interface Publisher {
  hasSubscribers(topic: string): boolean;
  publish(topic: string, type: "delta" | "correction", data: unknown, reason?: CorrectionReason, wireTopic?: string): boolean;
}

export interface MatchedWallet {
  wallet: string;
  role: "trader" | "feePayer";
}

/** One matched trade or launch, shared by every user who tracks one of its wallets. */
export interface MatchRecord {
  /** Trade id (`${signature}:${eventIndex}`) or `${signature}:create:${index}`. */
  key: string;
  kind: TrackedRowKind;
  matched: MatchedWallet[];
  trader: string;
  mint: string;
  symbol: string;
  name: string;
  image: string | null;
  launchpad: Launchpad;
  venue: TradeVenue;
  amountSol: number | null;
  amountUsd: number | null;
  tokenAmount: string;
  priceSol: number | null;
  mcSol: number | null;
  mcUsd: number | null;
  signature: string;
  slot: number;
  blockTime: number;
  receivedAt: number;
  firstBuy: boolean | null;
  marketTags: TradeTag[];
  dead?: boolean;
}

export interface FeedOptions {
  /** Matches kept for `tracked` snapshots. */
  ringSize: number;
  /** Matches kept per mint for `tracked:<mint>`, and how many mints. */
  mintRingSize: number;
  mintRings: number;
  /** Rows per topic per flush (older ones in the same frame are dropped and counted). */
  maxRowsPerFrame: number;
  /** Slots remembered for dead-slot corrections. */
  slotMemory: number;
}

export const feedTopic = (userId: string): string => `tracked@${userId}`;
export const mintTopic = (userId: string, mint: string): string => `tracked:${mint}@${userId}`;

/** Fixed-capacity ring, oldest overwritten first. */
class Ring<T> {
  private readonly buf: (T | undefined)[];
  private head = 0;
  private len = 0;

  constructor(readonly capacity: number) {
    this.buf = new Array(capacity);
  }

  push(v: T): void {
    this.buf[(this.head + this.len) % this.capacity] = v;
    if (this.len < this.capacity) this.len++;
    else this.head = (this.head + 1) % this.capacity;
  }

  /** Newest first. */
  *newest(): Generator<T> {
    for (let i = this.len - 1; i >= 0; i--) yield this.buf[(this.head + i) % this.capacity] as T;
  }

  get size(): number {
    return this.len;
  }
}

export function rowOf(m: MatchRecord, mw: MatchedWallet, w: Watcher): TrackedTradeRow {
  const t = w.tracked;
  return {
    id: `${m.key}:${mw.wallet}`,
    kind: m.kind,
    wallet: mw.wallet,
    role: mw.role,
    label: t?.label ?? "",
    emoji: t?.emoji ?? "",
    tag: t?.tag ?? "",
    walletTags: t?.tags ?? [],
    trader: m.trader,
    mint: m.mint,
    symbol: m.symbol,
    name: m.name,
    image: m.image,
    launchpad: m.launchpad,
    venue: m.venue,
    amountSol: m.amountSol,
    amountUsd: m.amountUsd,
    tokenAmount: m.tokenAmount,
    priceSol: m.priceSol,
    mcSol: m.mcSol,
    mcUsd: m.mcUsd,
    signature: m.signature,
    slot: m.slot,
    blockTime: m.blockTime,
    receivedAt: m.receivedAt,
    firstBuy: m.firstBuy,
    marketTags: m.marketTags,
  };
}

export class TrackedFeed {
  private readonly ring: Ring<MatchRecord>;
  private readonly byMint: LruMap<string, Ring<MatchRecord>>;
  private readonly bySlot = new Map<number, MatchRecord[]>();
  private readonly pending = new Map<string, { wire: string; rows: TrackedTradeRow[] }>();
  private hub: Publisher | null = null;
  readonly stats = { matches: 0, rows: 0, frames: 0, droppedRows: 0, corrections: 0 };

  constructor(
    private readonly index: WalletIndex,
    private readonly o: FeedOptions,
  ) {
    this.ring = new Ring(o.ringSize);
    this.byMint = new LruMap(o.mintRings);
  }

  attach(hub: Publisher): void {
    this.hub = hub;
  }

  get size(): number {
    return this.ring.size;
  }

  /** Stores a match and queues rows for the owners' subscribed topics. */
  add(m: MatchRecord): void {
    this.stats.matches++;
    this.ring.push(m);
    let mr = this.byMint.get(m.mint);
    if (!mr) {
      mr = new Ring(this.o.mintRingSize);
      this.byMint.set(m.mint, mr);
    }
    mr.push(m);
    let list = this.bySlot.get(m.slot);
    if (!list) {
      list = [];
      this.bySlot.set(m.slot, list);
      if (this.bySlot.size > this.o.slotMemory) this.bySlot.delete(this.bySlot.keys().next().value as number);
    }
    list.push(m);
    const hub = this.hub;
    if (!hub) return;
    for (const mw of m.matched) {
      for (const w of this.index.get(mw.wallet) ?? []) {
        if (!w.tracked) continue;
        const ft = feedTopic(w.userId);
        const mt = mintTopic(w.userId, m.mint);
        const toFeed = hub.hasSubscribers(ft);
        const toMint = hub.hasSubscribers(mt);
        if (!toFeed && !toMint) continue;
        const row = rowOf(m, mw, w);
        if (toFeed) this.queue(ft, "tracked", row);
        if (toMint) this.queue(mt, `tracked:${m.mint}`, row);
      }
    }
  }

  private queue(topic: string, wire: string, row: TrackedTradeRow): void {
    let p = this.pending.get(topic);
    if (!p) {
      p = { wire, rows: [] };
      this.pending.set(topic, p);
    }
    p.rows.push(row);
    this.stats.rows++;
  }

  /** Publishes the queued rows: one delta per topic, oldest first. */
  flush(): void {
    const hub = this.hub;
    if (!hub || !this.pending.size) return;
    for (const [topic, p] of this.pending) {
      let rows = p.rows;
      if (rows.length > this.o.maxRowsPerFrame) {
        this.stats.droppedRows += rows.length - this.o.maxRowsPerFrame;
        rows = rows.slice(-this.o.maxRowsPerFrame);
      }
      if (hub.publish(topic, "delta", { rows }, undefined, p.wire)) this.stats.frames++;
    }
    this.pending.clear();
  }

  /** Snapshot rows for one user: their tracked wallets' matches, newest first. */
  snapshot(userId: string, mint: string | null, limit: number): TrackedTradeRow[] {
    const src = mint ? this.byMint.peek(mint) : this.ring;
    const out: TrackedTradeRow[] = [];
    if (!src) return out;
    for (const m of src.newest()) {
      if (m.dead) continue;
      for (const mw of m.matched) {
        const w = this.index.watcher(userId, mw.wallet);
        if (!w?.tracked) continue;
        out.push(rowOf(m, mw, w));
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /** Matches of a slot that died: dropped from snapshots, owners get a correction. Returns them. */
  dropSlot(slot: number): MatchRecord[] {
    const list = this.bySlot.get(slot);
    if (!list) return [];
    this.bySlot.delete(slot);
    this.flush(); // rows already queued go out first, so the correction follows them
    const hub = this.hub;
    const removals = new Map<string, { wire: string; ids: string[] }>();
    for (const m of list) {
      m.dead = true;
      for (const mw of m.matched) {
        for (const w of this.index.get(mw.wallet) ?? []) {
          if (!w.tracked) continue;
          const id = `${m.key}:${mw.wallet}`;
          for (const [topic, wire] of [
            [feedTopic(w.userId), "tracked"],
            [mintTopic(w.userId, m.mint), `tracked:${m.mint}`],
          ] as const) {
            let r = removals.get(topic);
            if (!r) {
              r = { wire, ids: [] };
              removals.set(topic, r);
            }
            r.ids.push(id);
          }
        }
      }
    }
    if (hub) {
      for (const [topic, r] of removals) {
        if (hub.publish(topic, "correction", { remove: r.ids }, "dead_slot", r.wire)) this.stats.corrections++;
      }
    }
    return list;
  }
}
