/**
 * Dev history: a token's creator's EARLIER launches and how many of them migrated, from our own database
 * (tokens.creator, written by the storage writer). The creator is the one recorded at creation (the live
 * `bonding_curve.creator` can be rewritten by fee sharing). It is a lower bound: the database only covers
 * launches since the server started recording.
 *
 * Nothing here runs on the ingest path: launches and migrations are queued by MarketState hooks and
 * processed by `tick()` (one indexed SQLite read per creator, cached in an LRU).
 */
import type { LaunchRow } from "../storage/reader";
import { LruMap } from "../util/lru";
import type { TokenRecord } from "./token";

export interface LaunchStore {
  launchesBy(creator: string, limit?: number): LaunchRow[];
}

export interface DevHistoryTarget {
  readonly tokens: ReadonlyMap<string, TokenRecord>;
  setDevHistory(mint: string, launches: number, migrated: number): void;
}

interface Launch {
  t: number;
  migrated: boolean;
}

/** The dev identity used for history: creator at creation, else the live creator. */
export function creatorOf(rec: TokenRecord): string | null {
  return rec.creatorAtCreate ?? rec.creator;
}

/** When the launch happened: creation time, else when we first saw the token (it was created before that). */
function launchTime(rec: TokenRecord): number {
  return rec.createdAt ?? rec.firstSeenAt;
}

export class DevHistory {
  private readonly creators = new LruMap<string, Map<string, Launch>>(20_000);
  private readonly queue = new Set<string>();
  private readonly migrations = new Set<string>();
  readonly stats = { loads: 0, computed: 0 };

  constructor(
    private readonly store: LaunchStore | null,
    private readonly target: DevHistoryTarget,
    /** Launches loaded per creator (most recent first); serial launchers beyond this are capped. */
    private readonly maxLaunches = 5_000,
  ) {}

  /** A create event was applied. */
  onLaunch(rec: TokenRecord): void {
    this.queue.add(rec.mint);
  }

  /** A migration was applied. */
  onMigrate(rec: TokenRecord): void {
    this.migrations.add(rec.mint);
  }

  /** (Re)computes a token's history at the next tick (e.g. it became visible without one). */
  request(mint: string): void {
    this.queue.add(mint);
  }

  get pending(): number {
    return this.queue.size + this.migrations.size;
  }

  private launches(creator: string): Map<string, Launch> {
    let c = this.creators.get(creator);
    if (!c) {
      c = new Map();
      for (const r of this.store?.launchesBy(creator, this.maxLaunches) ?? []) c.set(r.mint, { t: r.t, migrated: r.migrated });
      this.creators.set(creator, c);
      this.stats.loads++;
    }
    return c;
  }

  private compute(rec: TokenRecord, launches: Map<string, Launch>): void {
    const t = launchTime(rec);
    let earlier = 0;
    let migrated = 0;
    for (const [mint, l] of launches) {
      if (mint === rec.mint || l.t >= t) continue;
      earlier++;
      if (l.migrated) migrated++;
    }
    this.target.setDevHistory(rec.mint, earlier, migrated);
    this.stats.computed++;
  }

  /** Processes queued work (at most `budget` token computations per call). */
  tick(budget = 500): void {
    for (const mint of this.migrations) {
      this.migrations.delete(mint);
      const rec = this.target.tokens.get(mint);
      const creator = rec ? creatorOf(rec) : null;
      if (!rec || !creator) continue;
      const launches = this.launches(creator);
      const t = launchTime(rec);
      const l = launches.get(mint);
      if (l) l.migrated = true;
      else launches.set(mint, { t, migrated: true });
      // the creator's later launches that are in memory now have one more migrated predecessor
      for (const [other, ol] of launches) if (ol.t > t && this.target.tokens.has(other)) this.queue.add(other);
    }
    let n = 0;
    for (const mint of this.queue) {
      if (n++ >= budget) break;
      this.queue.delete(mint);
      const rec = this.target.tokens.get(mint);
      const creator = rec ? creatorOf(rec) : null;
      if (!rec || !creator) continue;
      const launches = this.launches(creator);
      if (!launches.has(mint)) launches.set(mint, { t: launchTime(rec), migrated: rec.migrated });
      this.compute(rec, launches);
    }
  }
}
