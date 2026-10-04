/**
 * The firehose matcher's index (SPEC "Data layer": match signers in the firehose in memory against the
 * deduplicated union of all users' lists; no per-wallet subscriptions).
 *
 * One Map from address to the users watching it, so matching a trade's wallet is one hash lookup no
 * matter how many addresses are watched. An address appears once however many users watch it; each
 * watcher records why (a tracked wallet with its label, and/or the leader of one of the user's copy
 * tasks), and the address leaves the index when its last watcher goes (reference counting). The
 * service refreshes a user's part after every tracked-wallet or copy-task change.
 *
 * Memory is bounded: at most `maxTrackedPerUser` tracked wallets per user (the API's 10,000 cap,
 * re-checked here) and `maxEntries` watcher entries in total; entries past the global cap are refused
 * and counted (stats.refused) rather than growing without limit. About 370 bytes per watched address
 * with one watcher, ~480 with popular wallets shared by many users (scripts/tracker-bench.ts).
 */

export interface TrackedMeta {
  label: string;
  emoji: string;
  /** Emoji-free display name (plainTag). */
  tag: string;
  tags: string[];
}

export interface Watcher {
  readonly userId: string;
  readonly address: string;
  /** Set when the address is on the user's wallet tracker. */
  tracked: TrackedMeta | null;
  /** Set when the address leads one of the user's copy tasks. */
  leader: boolean;
}

export interface TrackedInput {
  address: string;
  label: string;
  emoji: string;
  tags: string[];
}

export interface WalletIndexOptions {
  maxEntries: number;
  maxTrackedPerUser: number;
}

export interface WalletIndexStats {
  addresses: number;
  entries: number;
  users: number;
  refused: number;
}

/** Pictographs, flags, skin tones, joiners and variation selectors: what an emoji-free tag leaves out. */
const PICTOGRAPHS = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|‍|︎|️|⃣/gu;

export function shortAddress(a: string): string {
  return a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

/** The label without emoji (for plain-text places), or a short address when nothing is left. */
export function plainTag(label: string, address: string): string {
  const t = label.replace(PICTOGRAPHS, "").replace(/\s+/g, " ").trim();
  return t || shortAddress(address);
}

export class WalletIndex {
  private readonly byAddress = new Map<string, Watcher[]>();
  private readonly byUser = new Map<string, Map<string, Watcher>>();
  private readonly trackedCount = new Map<string, number>();
  private entries = 0;
  private refused = 0;

  constructor(private readonly o: WalletIndexOptions) {}

  /** Watchers of `address` (O(1)); undefined when nobody watches it. */
  get(address: string): readonly Watcher[] | undefined {
    return this.byAddress.get(address);
  }

  has(address: string): boolean {
    return this.byAddress.has(address);
  }

  /** The user's watcher entry for an address, if any. */
  watcher(userId: string, address: string): Watcher | undefined {
    return this.byUser.get(userId)?.get(address);
  }

  /** True when the address is on the user's wallet tracker. */
  tracks(userId: string, address: string): boolean {
    return this.byUser.get(userId)?.get(address)?.tracked != null;
  }

  trackedOf(userId: string): number {
    return this.trackedCount.get(userId) ?? 0;
  }

  get stats(): WalletIndexStats {
    return { addresses: this.byAddress.size, entries: this.entries, users: this.byUser.size, refused: this.refused };
  }

  /**
   * Replaces the user's tracked wallets with `wallets` (first `maxTrackedPerUser` kept). Leader entries
   * are untouched. Returns how many entries were added, removed, updated and refused.
   */
  setTracked(userId: string, wallets: readonly TrackedInput[]): { added: number; removed: number; updated: number; refused: number } {
    const next = new Map<string, TrackedInput>();
    for (const w of wallets) {
      if (next.size >= this.o.maxTrackedPerUser) break;
      next.set(w.address, w);
    }
    const mine = this.byUser.get(userId);
    let added = 0;
    let removed = 0;
    let updated = 0;
    let refused = 0;
    if (mine) {
      for (const w of [...mine.values()]) {
        if (w.tracked && !next.has(w.address)) {
          w.tracked = null;
          removed++;
          this.release(w);
        }
      }
    }
    for (const input of next.values()) {
      const meta: TrackedMeta = {
        label: input.label,
        emoji: input.emoji,
        tag: plainTag(input.label, input.address),
        tags: input.tags,
      };
      const existing = this.byUser.get(userId)?.get(input.address);
      if (existing) {
        if (existing.tracked) updated++;
        else added++;
        existing.tracked = meta;
        continue;
      }
      const w = this.acquire(userId, input.address);
      if (!w) {
        refused++;
        continue;
      }
      w.tracked = meta;
      added++;
    }
    this.trackedCount.set(userId, next.size - refused);
    if (next.size - refused === 0) this.trackedCount.delete(userId);
    return { added, removed, updated, refused };
  }

  /** Replaces the set of addresses the user copies (copy-task leaders). */
  setLeaders(userId: string, leaders: Iterable<string>): void {
    const next = new Set(leaders);
    const mine = this.byUser.get(userId);
    if (mine) {
      for (const w of [...mine.values()]) {
        if (w.leader && !next.has(w.address)) {
          w.leader = false;
          this.release(w);
        }
      }
    }
    for (const address of next) {
      const existing = this.byUser.get(userId)?.get(address);
      if (existing) {
        existing.leader = true;
        continue;
      }
      const w = this.acquire(userId, address);
      if (w) w.leader = true;
    }
  }

  /** Drops everything the user watches. */
  removeUser(userId: string): void {
    const mine = this.byUser.get(userId);
    if (!mine) return;
    for (const w of [...mine.values()]) {
      w.tracked = null;
      w.leader = false;
      this.release(w);
    }
    this.trackedCount.delete(userId);
  }

  /** A new, empty watcher entry for (user, address), or null past the global cap. */
  private acquire(userId: string, address: string): Watcher | null {
    if (this.entries >= this.o.maxEntries) {
      this.refused++;
      return null;
    }
    const w: Watcher = { userId, address, tracked: null, leader: false };
    const list = this.byAddress.get(address);
    if (list) list.push(w);
    else this.byAddress.set(address, [w]);
    let mine = this.byUser.get(userId);
    if (!mine) {
      mine = new Map();
      this.byUser.set(userId, mine);
    }
    mine.set(address, w);
    this.entries++;
    return w;
  }

  /** Removes a watcher that no longer has a reason to exist; the address goes with its last watcher. */
  private release(w: Watcher): void {
    if (w.tracked || w.leader) return;
    const list = this.byAddress.get(w.address);
    if (list) {
      const i = list.indexOf(w);
      if (i >= 0) {
        list[i] = list[list.length - 1] as Watcher;
        list.pop();
      }
      if (!list.length) this.byAddress.delete(w.address);
    }
    const mine = this.byUser.get(w.userId);
    if (mine) {
      mine.delete(w.address);
      if (!mine.size) this.byUser.delete(w.userId);
    }
    this.entries--;
  }
}
