/**
 * Per-token holder balances and the audit metrics built on them (SPEC.md "Token metric definitions").
 * Only created for tokens whose creation we observed; without the full history the numbers would be
 * fiction, so such tokens report null metrics.
 *
 * Balances move by trade deltas (logs source) or are set to absolute post-tx balances (gRPC meta).
 * Plain wallet-to-wallet transfers are not seen by a program-filtered feed, so a seller who received
 * tokens by transfer can go below zero: balances are clamped at 0. Chain snapshots (the 20 largest
 * accounts, or a full DAS scan) reconcile the book periodically: `applySnapshot`.
 *
 *  - Snipers: non-dev buyers whose FIRST buy landed within `sniperSlots` slots of the creation slot.
 *  - Bundlers: non-dev creation-slot buyers; in a slot with >= `bundleMinBuyers` distinct buyers, every
 *    group of >= `bundleMinBuyers` of them whose buy sizes fall in a tight band (largest <= smallest x
 *    (1 + band)) or who share one funder (funder data optional: Helius funded-by); and every buyer in a
 *    transaction that bought for >= 2 wallets.
 *  - Insiders: holders that never bought (they received tokens by transfer), plus wallets the creator
 *    funded within two hops (supplied by the funding analysis). Reported only once that analysis ran.
 *  - Dev: the live creator plus the creator recorded at creation (fee sharing can rewrite the live one).
 *  - Top 10: largest balances, excluding the bonding curve, pool vaults/authorities and burn addresses.
 */

export interface MetricsConfig {
  sniperSlots: number;
  bundleMinBuyers: number;
  /** Tight size band for the N-buyers-in-one-slot rule, in bps: largest buy <= smallest x (1 + band). Default 1000. */
  bundleSizeBandBps?: number;
  /** Report insidersPct (needs the funding analysis: Helius funded-by). Default false (insidersPct stays null). */
  insiders?: boolean;
}

export interface HolderMetrics {
  holders: number;
  top10Pct: number;
  devPct: number;
  devSoldAll: boolean;
  snipersPct: number;
  bundlersPct: number;
  /** null until the insider analysis ran for this token (or when insiders are disabled). */
  insidersPct: number | null;
}

/** One owner's balance in a chain snapshot, as of `slot` (the read's context slot). */
export interface SnapshotEntry {
  owner: string;
  amount: bigint;
  slot: number;
}

export interface SnapshotOptions {
  source: "rpc" | "das";
  at: number;
  /**
   * true: the snapshot lists every holder (DAS scan); owners missing from it hold nothing.
   * false: it lists the largest accounts only; owners missing from it hold at most `floor`.
   */
  full: boolean;
  /** Smallest amount in a partial snapshot that was cut off (it returned its maximum number of accounts). */
  floor?: bigint;
  /** Net holder deltas of trades we applied after the snapshot slot (owner -> per-entry later deltas). */
  laterDelta(owner: string, slot: number): bigint;
  /** Owners with trades after the snapshot's oldest slot (their book balance may be newer than the snapshot). */
  tradedAfter: ReadonlySet<string>;
}

/** Remember buyers (and their buy sizes) of this many recent slots for the N-buyers-in-a-slot rule. */
const SLOT_MEMORY = 64;
/** Slots that reached N buyers are kept longer, so funder data that arrives later can still be applied. */
const CROWDED_SLOTS_MAX = 256;
const DEFAULT_BAND_BPS = 1_000;

/** Wallets in any group of >= `minSize` whose amounts lie within `bandBps` of the group's smallest. */
export function sizeBandMembers(buys: ReadonlyMap<string, bigint>, minSize: number, bandBps: number): Set<string> {
  const arr = [...buys].filter(([, a]) => a > 0n).sort((x, y) => (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
  const out = new Set<string>();
  const scale = 10_000n + BigInt(Math.max(0, Math.round(bandBps)));
  let lo = 0;
  for (let hi = 0; hi < arr.length; hi++) {
    const top = (arr[hi] as [string, bigint])[1];
    while (top * 10_000n > (arr[lo] as [string, bigint])[1] * scale) lo++;
    if (hi - lo + 1 >= minSize) for (let i = lo; i <= hi; i++) out.add((arr[i] as [string, bigint])[0]);
  }
  return out;
}

/** Wallets in any group of >= `minSize` that share one (non-exchange) funder. */
export function sharedFunderMembers(wallets: Iterable<string>, minSize: number, funderOf: (wallet: string) => string | null): Set<string> {
  const groups = new Map<string, string[]>();
  for (const w of wallets) {
    const f = funderOf(w);
    if (!f) continue;
    const g = groups.get(f);
    if (g) g.push(w);
    else groups.set(f, [w]);
  }
  const out = new Set<string>();
  for (const g of groups.values()) if (g.length >= minSize) for (const w of g) out.add(w);
  return out;
}

export class HolderBook {
  readonly balances = new Map<string, bigint>();
  private readonly firstBuySlot = new Map<string, number>();
  /** Every wallet that bought (dev included): "never bought" means not in here. */
  readonly buyers = new Set<string>();
  readonly snipers = new Set<string>();
  readonly bundlers = new Set<string>();
  readonly devWallets = new Set<string>();
  readonly excluded = new Set<string>();
  /** Wallets the creator funded within two hops (set by the funding analysis). */
  readonly fundedInsiders = new Set<string>();
  /** When the insider analysis last ran (null: never, insidersPct stays null). */
  insiderCheckedAt: number | null = null;
  /** Last chain reconciliation. */
  reconciledSource: "rpc" | "das" | null = null;
  reconciledAt: number | null = null;
  private readonly slotBuys = new Map<number, Map<string, bigint>>();
  private readonly crowded = new Map<number, Map<string, bigint>>();
  private devHeld = false;
  private positive = 0;
  private cached: { version: number; supply: bigint; metrics: HolderMetrics } | null = null;
  private version = 0;

  constructor(
    readonly createdSlot: number | null,
    private readonly cfg: MetricsConfig,
    /** Funder lookup for the shared-funder bundle rule: funder address, or null (unknown / none / exchange). */
    private readonly funderOf: ((wallet: string) => string | null) | null = null,
  ) {}

  addDev(wallet: string | null | undefined): void {
    if (wallet) {
      this.devWallets.add(wallet);
      this.snipers.delete(wallet);
      this.bundlers.delete(wallet);
      if ((this.balances.get(wallet) ?? 0n) > 0n) this.devHeld = true;
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
    if (clamped > 0n && this.devWallets.has(wallet)) this.devHeld = true;
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
   * transaction (>= 2 means one tx bought for several wallets); `quoteAmount` is the buy size in quote
   * base units (for the size-band rule).
   */
  classifyBuy(wallet: string, slot: number, txBuyers: ReadonlySet<string>, quoteAmount = 0n): void {
    this.buyers.add(wallet);
    if (this.devWallets.has(wallet)) return;
    const created = this.createdSlot;
    if (!this.firstBuySlot.has(wallet)) {
      this.firstBuySlot.set(wallet, slot);
      if (created !== null && slot >= created && slot - created <= this.cfg.sniperSlots) this.snipers.add(wallet);
    }
    if (created !== null && slot === created) this.bundlers.add(wallet);
    if (txBuyers.size >= 2) for (const b of txBuyers) if (!this.devWallets.has(b)) this.bundlers.add(b);
    let buys = this.slotBuys.get(slot);
    if (!buys) {
      buys = new Map();
      this.slotBuys.set(slot, buys);
      for (const s of this.slotBuys.keys()) if (s < slot - SLOT_MEMORY) this.slotBuys.delete(s);
    }
    buys.set(wallet, (buys.get(wallet) ?? 0n) + quoteAmount);
    if (buys.size >= this.cfg.bundleMinBuyers) {
      this.crowded.set(slot, buys);
      if (this.crowded.size > CROWDED_SLOTS_MAX) this.crowded.delete(this.crowded.keys().next().value as number);
      this.flagCrowded(buys);
    }
    this.version++;
  }

  /** The N-buyers-in-one-slot rule: flag tight size bands and shared funders. */
  private flagCrowded(buys: ReadonlyMap<string, bigint>): number {
    const n = this.cfg.bundleMinBuyers;
    let added = 0;
    const flag = (ws: Iterable<string>) => {
      for (const w of ws) {
        if (this.devWallets.has(w) || this.bundlers.has(w)) continue;
        this.bundlers.add(w);
        added++;
      }
    };
    flag(sizeBandMembers(buys, n, this.cfg.bundleSizeBandBps ?? DEFAULT_BAND_BPS));
    if (this.funderOf) flag(sharedFunderMembers(buys.keys(), n, this.funderOf));
    if (added) this.version++;
    return added;
  }

  /** Buyers of crowded slots (>= N distinct buyers) that are not bundlers yet: funder lookups may flag them. */
  crowdedCandidates(): string[] {
    const out = new Set<string>();
    for (const buys of this.crowded.values()) for (const w of buys.keys()) if (!this.bundlers.has(w) && !this.devWallets.has(w)) out.add(w);
    return [...out];
  }

  /** Re-runs the crowded-slot rule (new funder data arrived); returns how many bundlers were added. */
  recheckCrowded(): number {
    let added = 0;
    for (const buys of this.crowded.values()) added += this.flagCrowded(buys);
    return added;
  }

  /** Holders that never bought: they received the tokens by transfer. */
  transferRecipients(): string[] {
    const out: string[] = [];
    for (const w of this.balances.keys()) if (!this.buyers.has(w) && !this.excluded.has(w) && !this.devWallets.has(w)) out.push(w);
    return out;
  }

  /** The `n` largest non-excluded holders (owner, balance), largest first. */
  topHolders(n: number): [string, bigint][] {
    const top: [string, bigint][] = [];
    for (const [w, b] of this.balances) {
      if (this.excluded.has(w)) continue;
      if (top.length < n || b > (top[top.length - 1] as [string, bigint])[1]) {
        top.push([w, b]);
        top.sort((x, y) => (x[1] < y[1] ? 1 : x[1] > y[1] ? -1 : 0));
        if (top.length > n) top.pop();
      }
    }
    return top;
  }

  /** Records the result of the insider (funding) analysis. */
  setFundedInsiders(wallets: Iterable<string>, at: number): void {
    for (const w of wallets) this.fundedInsiders.add(w);
    this.insiderCheckedAt = at;
    this.version++;
  }

  /**
   * Reconciles the book with a chain snapshot. Each entry's amount is advanced by the deltas of trades we
   * applied after its slot. Owners missing from the snapshot (and without later trades) drop to 0 when the
   * snapshot is complete (DAS), or when it is the largest-accounts list and they claim more than its
   * smallest entry (they cannot hold that much: a transfer out we did not see). Returns the number of
   * balances that changed.
   */
  applySnapshot(entries: readonly SnapshotEntry[], o: SnapshotOptions): number {
    const before = this.version;
    const listed = new Set<string>();
    for (const e of entries) {
      listed.add(e.owner);
      if (this.excluded.has(e.owner)) continue;
      this.setBalance(e.owner, e.amount + o.laterDelta(e.owner, e.slot));
    }
    for (const [owner, bal] of [...this.balances]) {
      if (listed.has(owner) || o.tradedAfter.has(owner) || this.excluded.has(owner)) continue;
      if (o.full || (o.floor !== undefined && bal > o.floor)) this.setBalance(owner, 0n);
    }
    const changed = this.version - before;
    this.reconciledSource = o.source;
    this.reconciledAt = o.at;
    this.version++;
    return changed;
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
    const top = this.topHolders(10);
    const devBalance = this.sumOf(this.devWallets);
    let insidersPct: number | null = null;
    if (this.cfg.insiders && this.insiderCheckedAt !== null) {
      const insiders = new Set<string>(this.transferRecipients());
      for (const w of this.fundedInsiders) if (!this.devWallets.has(w)) insiders.add(w);
      insidersPct = pct(this.sumOf(insiders));
    }
    const metrics: HolderMetrics = {
      holders: this.positive,
      top10Pct: pct(top.reduce((s, [, b]) => s + b, 0n)),
      devPct: pct(devBalance),
      devSoldAll: this.devHeld && devBalance === 0n,
      snipersPct: pct(this.sumOf(this.snipers)),
      bundlersPct: pct(this.sumOf(this.bundlers)),
      insidersPct,
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
