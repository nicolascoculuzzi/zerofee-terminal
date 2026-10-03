/**
 * Per-token holder balances and the audit metrics built on them (SPEC.md "Token metric definitions").
 * Only created for tokens whose creation we observed; without the full history the numbers would be
 * fiction, so such tokens report null metrics.
 *
 * Balances move by trade deltas (logs source) or are set to absolute post-tx balances (gRPC meta).
 * Plain wallet-to-wallet transfers are not seen by a program-filtered feed, so a seller who received
 * tokens by transfer can go below zero: balances are clamped at 0.
 *
 *  - Snipers: non-dev buyers whose FIRST buy landed within `sniperSlots` slots of the creation slot.
 *  - Bundlers: non-dev creation-slot buyers; every buyer in a slot with >= `bundleMinBuyers` distinct
 *    buyers; and every buyer in a transaction that bought for >= 2 wallets.
 *  - Dev: the live creator plus the creator recorded at creation (fee sharing can rewrite the live one).
 *  - Top 10: largest balances, excluding the bonding curve, pool vaults/authorities and burn addresses.
 */

export interface MetricsConfig {
  sniperSlots: number;
  bundleMinBuyers: number;
}

export interface HolderMetrics {
  holders: number;
  top10Pct: number;
  devPct: number;
  snipersPct: number;
  bundlersPct: number;
}

/** Remember buyers of this many recent slots for the N-buyers-in-a-slot rule. */
const SLOT_MEMORY = 64;

export class HolderBook {
  readonly balances = new Map<string, bigint>();
  private readonly firstBuySlot = new Map<string, number>();
  readonly snipers = new Set<string>();
  readonly bundlers = new Set<string>();
  readonly devWallets = new Set<string>();
  readonly excluded = new Set<string>();
  private readonly buyersBySlot = new Map<number, Set<string>>();
  private positive = 0;
  private cached: { version: number; supply: bigint; metrics: HolderMetrics } | null = null;
  private version = 0;

  constructor(
    readonly createdSlot: number | null,
    private readonly cfg: MetricsConfig,
  ) {}

  addDev(wallet: string | null | undefined): void {
    if (wallet) {
      this.devWallets.add(wallet);
      this.snipers.delete(wallet);
      this.bundlers.delete(wallet);
      this.version++;
    }
  }

  exclude(account: string | null | undefined): void {
    if (!account || this.excluded.has(account)) return;
    if ((this.balances.get(account) ?? 0n) > 0n) this.positive--;
    this.excluded.add(account);
    this.version++;
  }

  get holderCount(): number {
    return this.positive;
  }

  balanceOf(wallet: string): bigint {
    return this.balances.get(wallet) ?? 0n;
  }

  private setBalance(wallet: string, next: bigint): void {
    const prev = this.balances.get(wallet) ?? 0n;
    const clamped = next < 0n ? 0n : next;
    if (clamped === prev) return;
    if (prev > 0n && clamped === 0n && !this.excluded.has(wallet)) this.positive--;
    if (prev === 0n && clamped > 0n && !this.excluded.has(wallet)) this.positive++;
    if (clamped === 0n) this.balances.delete(wallet);
    else this.balances.set(wallet, clamped);
    this.version++;
  }

  /** Applies a trade's token delta (+ buy, - sell). */
  applyDelta(wallet: string, delta: bigint): void {
    this.setBalance(wallet, (this.balances.get(wallet) ?? 0n) + delta);
  }

  /** Sets an absolute balance (from gRPC post-token-balances). */
  setAbsolute(wallet: string, amount: bigint): void {
    this.setBalance(wallet, amount);
  }

  /**
   * Classifies a buy for the sniper / bundler rules. `txBuyers` are the distinct buyers of the same
   * transaction (>= 2 means one tx bought for several wallets).
   */
  classifyBuy(wallet: string, slot: number, txBuyers: ReadonlySet<string>): void {
    if (this.devWallets.has(wallet)) return;
    const created = this.createdSlot;
    if (!this.firstBuySlot.has(wallet)) {
      this.firstBuySlot.set(wallet, slot);
      if (created !== null && slot >= created && slot - created <= this.cfg.sniperSlots) this.snipers.add(wallet);
    }
    if (created !== null && slot === created) this.bundlers.add(wallet);
    if (txBuyers.size >= 2) for (const b of txBuyers) if (!this.devWallets.has(b)) this.bundlers.add(b);
    let set = this.buyersBySlot.get(slot);
    if (!set) {
      set = new Set();
      this.buyersBySlot.set(slot, set);
      for (const s of this.buyersBySlot.keys()) if (s < slot - SLOT_MEMORY) this.buyersBySlot.delete(s);
    }
    set.add(wallet);
    if (set.size >= this.cfg.bundleMinBuyers) for (const b of set) if (!this.devWallets.has(b)) this.bundlers.add(b);
    this.version++;
  }

  private sumOf(wallets: Iterable<string>): bigint {
    let s = 0n;
    for (const w of wallets) if (!this.excluded.has(w)) s += this.balances.get(w) ?? 0n;
    return s;
  }

  /** Metrics as % of `supply` (base units). Cached until the next change. */
  metrics(supply: bigint): HolderMetrics {
    if (this.cached && this.cached.version === this.version && this.cached.supply === supply) return this.cached.metrics;
    const pct = (x: bigint) => (supply > 0n ? Number((x * 1_000_000n) / supply) / 10_000 : 0);
    // top 10 via a small sorted buffer (O(n log 10))
    const top: bigint[] = [];
    for (const [w, b] of this.balances) {
      if (this.excluded.has(w)) continue;
      if (top.length < 10) {
        top.push(b);
        top.sort((x, y) => (x < y ? 1 : x > y ? -1 : 0));
      } else if (b > (top[9] as bigint)) {
        top[9] = b;
        top.sort((x, y) => (x < y ? 1 : x > y ? -1 : 0));
      }
    }
    const metrics: HolderMetrics = {
      holders: this.positive,
      top10Pct: pct(top.reduce((s, b) => s + b, 0n)),
      devPct: pct(this.sumOf(this.devWallets)),
      snipersPct: pct(this.sumOf(this.snipers)),
      bundlersPct: pct(this.sumOf(this.bundlers)),
    };
    this.cached = { version: this.version, supply, metrics };
    return metrics;
  }

  /** Tag set for a trader (trade tape badges). */
  tagsOf(wallet: string): ("dev" | "sniper" | "bundler")[] {
    const tags: ("dev" | "sniper" | "bundler")[] = [];
    if (this.devWallets.has(wallet)) tags.push("dev");
    if (this.snipers.has(wallet)) tags.push("sniper");
    if (this.bundlers.has(wallet)) tags.push("bundler");
    return tags;
  }
}
