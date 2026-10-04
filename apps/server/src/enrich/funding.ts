/**
 * Wallet funding (Helius funded-by): who sent a wallet its first SOL. Cached forever per wallet (that
 * transfer never changes): an in-memory LRU in front of the SQLite `wallet_funders` table, so a wallet is
 * looked up once per database. Lookups are budgeted by a token bucket and never run on the ingest path.
 *
 * Uses: insiders (wallets the creator funded within two hops) and the shared-funder bundle rule.
 * Exchange funders are ignored for clustering: thousands of unrelated users withdraw from one hot wallet.
 */
import type { WalletFunderRow } from "../storage/writer";
import { LruMap } from "../util/lru";
import type { HeliusClient } from "./helius";
import { HeliusError } from "./helius";
import type { TokenBucket } from "./limiter";

export interface FundingInfo {
  /** null = Helius found no incoming SOL transfer. */
  funder: string | null;
  funderName: string | null;
  funderType: string | null;
}

export interface FundingStore {
  get(wallet: string): WalletFunderRow | undefined;
  put(row: WalletFunderRow): void;
}

export function isExchangeFunder(f: FundingInfo): boolean {
  return f.funderType !== null && /exchange/i.test(f.funderType);
}

export class FundingService {
  private readonly memory = new LruMap<string, FundingInfo>(200_000);
  /** Set when Helius refused funded-by for this key (401/403: no key / free plan). */
  disabledReason: string | null = null;
  readonly stats = { lookups: 0, cacheHits: 0, notFound: 0, errors: 0 };

  constructor(
    private readonly client: HeliusClient | null,
    private readonly bucket: TokenBucket,
    private readonly store: FundingStore | null,
    private readonly now: () => number = Date.now,
  ) {
    if (!client) this.disabledReason = "no HELIUS_API_KEY";
  }

  get available(): boolean {
    return this.disabledReason === null;
  }

  /** Cached funding (memory, then SQLite); undefined = never looked up. No network. */
  cached(wallet: string): FundingInfo | undefined {
    const m = this.memory.get(wallet);
    if (m) return m;
    const row = this.store?.get(wallet);
    if (!row) return undefined;
    const info: FundingInfo = { funder: row.funder, funderName: row.funderName, funderType: row.funderType };
    this.memory.set(wallet, info);
    return info;
  }

  /** Funder usable for clustering: known, and not an exchange. */
  funderOf(wallet: string): string | null {
    const f = this.cached(wallet);
    return f?.funder && !isExchangeFunder(f) ? f.funder : null;
  }

  /**
   * Cached funding, or one budgeted lookup. Returns undefined when the budget is exhausted or the lookup
   * failed (try again later).
   */
  async resolve(wallet: string): Promise<FundingInfo | undefined> {
    const hit = this.cached(wallet);
    if (hit) {
      this.stats.cacheHits++;
      return hit;
    }
    if (!this.client || this.disabledReason || !this.bucket.take(1, this.now())) return undefined;
    this.stats.lookups++;
    try {
      const r = await this.client.fundedBy(wallet);
      const info: FundingInfo = r
        ? { funder: r.funder, funderName: r.funderName, funderType: r.funderType }
        : { funder: null, funderName: null, funderType: null };
      if (!r) this.stats.notFound++;
      this.memory.set(wallet, info);
      this.store?.put({
        wallet,
        funder: info.funder,
        funderName: info.funderName,
        funderType: info.funderType,
        amountLamports: r?.amountLamports ?? null,
        fundedAt: r?.fundedAt ?? null,
        slot: r?.slot ?? null,
        fetchedAt: this.now(),
      });
      return info;
    } catch (e) {
      this.stats.errors++;
      if (e instanceof HeliusError) {
        if (e.status === 401 || e.status === 403) this.disabledReason = `funded-by refused (HTTP ${e.status}; it needs a paid Helius plan)`;
        else if (e.status === 429) this.bucket.pause(60_000, this.now());
      }
      return undefined;
    }
  }
}
