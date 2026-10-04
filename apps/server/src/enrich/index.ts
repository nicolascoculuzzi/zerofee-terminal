/**
 * Enricher: fills the token metrics that need data beyond the ingest stream (Dex Paid, reconciled holders,
 * insiders, the funder half of the bundle rule, dev history). It never blocks ingest: a 1 s timer picks
 * work, network calls run asynchronously under per-service budgets, and results are merged into
 * MarketState with cheap synchronous setters.
 *
 * Only tokens likely to be shown get network work, in priority order:
 *   0 focused (a client has the token page open)   1 just appeared in DexScreener's paid-profiles feed
 *   2 listed in Pulse Final Stretch / Migrated      3 recently active (top ENRICH_ACTIVE_TOKENS by 5 m volume)
 *
 *                 focused   profile hit   listed          active
 *   Dex Paid      60 s      3 tries       5 min           15 min    (DEXSCREENER_RPM per 60 s window)
 *   holders       30 s      -             5 min           -         (RPC largest accounts or Helius DAS)
 *   funding       2 min     -             10 min          -         (Helius funded-by, insiders + bundles)
 */
import type { PulseColumn } from "@zerofee/protocol";
import { logger } from "../log";
import { creatorOf, DevHistory, type LaunchStore } from "../market/devHistory";
import type { PulseBoard } from "../market/pulse";
import type { MarketState } from "../market/state";
import type { TokenRecord } from "../market/token";
import { RpcClient, RpcError } from "../util/rpc";
import type { EnrichConfig } from "./config";
import { DexScreenerClient, DexScreenerError, dexPaidFrom } from "./dexscreener";
import { FundingService, type FundingStore, isExchangeFunder } from "./funding";
import { HeliusClient, HeliusError } from "./helius";
import { dasSnapshot, largestAccountsSnapshot } from "./holders";
import { TokenBucket } from "./limiter";

const log = logger("enrich");

type Prio = 0 | 1 | 2 | 3;

export interface EnricherDeps {
  cfg: EnrichConfig;
  market: MarketState;
  pulse: PulseBoard;
  /** Mints a client has open (token page topics). */
  focused(): Iterable<string>;
  launches: LaunchStore | null;
  fundingStore: FundingStore | null;
  fetchFn?: typeof fetch;
  /** RPC client for reconciliation reads (tests); default: a dedicated client on cfg.rpcUrl. */
  rpc?: RpcClient;
  now?(): number;
}

/** Mints behind a client's token-page topics (token:, trades:, tradectx:, candles:<mint>:<tf>). */
export function watchedMints(hub: { subscribed(prefix: string): Iterable<string> }): string[] {
  const out = new Set<string>();
  for (const prefix of ["token:", "trades:", "tradectx:"]) for (const t of hub.subscribed(prefix)) out.add(t.slice(prefix.length));
  for (const t of hub.subscribed("candles:")) out.add(t.slice(8, t.lastIndexOf(":")));
  return [...out];
}

const DEX_INTERVAL: Record<Prio, number> = { 0: 60_000, 1: 0, 2: 300_000, 3: 900_000 };
const PROFILE_RETRY_MS = 70_000;
const PROFILE_TRIES = 3;
const FUNDING_INTERVAL: Partial<Record<Prio, number>> = { 0: 120_000, 2: 600_000 };
const DAS_TOO_BIG_MS = 3_600_000;
const LARGEST_BACKOFF_MAX = 30 * 60_000;

export class Enricher {
  readonly devHistory: DevHistory;
  readonly funding: FundingService;
  readonly dex: DexScreenerClient | null;
  readonly helius: HeliusClient | null;
  private readonly rpc: RpcClient;
  private readonly dexBucket: TokenBucket;
  private readonly holdersBucket: TokenBucket;
  private readonly dasBucket: TokenBucket;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly dexChecked = new Map<string, number>();
  private readonly profileHits = new Map<string, { tries: number; nextAt: number }>();
  private profilesPolledAt = Number.NEGATIVE_INFINITY;
  private readonly holdersChecked = new Map<string, number>();
  private readonly dasTooBig = new Map<string, number>();
  private readonly fundingChecked = new Map<string, number>();
  private active: string[] = [];
  private activeAt = Number.NEGATIVE_INFINITY;
  private prunedAt = 0;
  private readonly largest = { until: 0, backoffMs: 60_000, reason: null as string | null };
  private dasDisabled: string | null = null;
  private readonly inFlight = { dex: 0, holders: 0, funding: 0 };
  readonly stats = {
    dexChecks: 0,
    dexPaid: 0,
    dexErrors: 0,
    profileHits: 0,
    rpcChecks: 0,
    dasScans: 0,
    dasPages: 0,
    holderErrors: 0,
    insiderRuns: 0,
    bundlesAdded: 0,
  };

  constructor(private readonly d: EnricherDeps) {
    const c = d.cfg;
    const now = this.now();
    this.devHistory = new DevHistory(d.launches, d.market);
    this.dex = c.dexscreener.enabled ? new DexScreenerClient({ baseUrl: c.dexscreener.baseUrl, fetchFn: d.fetchFn }) : null;
    this.dexBucket = TokenBucket.perWindow(c.dexscreener.rpm, c.dexscreener.burst, now);
    this.rpc = d.rpc ?? new RpcClient({ url: c.rpcUrl, fetchFn: d.fetchFn, maxConcurrent: 2, cooldownMs: 10_000 });
    this.holdersBucket = new TokenBucket(Math.min(4, c.holders.rpcPerMin), c.holders.rpcPerMin, now);
    this.helius = c.heliusApiKey
      ? new HeliusClient({ apiKey: c.heliusApiKey, rpcUrl: c.rpcUrl, apiUrl: c.heliusApiUrl, fetchFn: d.fetchFn })
      : null;
    this.dasBucket = new TokenBucket(Math.max(1, Math.min(c.das.maxPages, c.das.pagesPerMin)), c.das.pagesPerMin, now);
    if (this.helius && c.das.pagesPerMin <= 0) this.dasDisabled = "HELIUS_DAS_PAGES_PER_MIN=0";
    this.funding = new FundingService(
      c.fundedBy.perMin > 0 ? this.helius : null,
      new TokenBucket(Math.max(1, Math.min(5, c.fundedBy.perMin)), c.fundedBy.perMin, now),
      d.fundingStore,
      () => this.now(),
    );
    if (this.helius && c.fundedBy.perMin <= 0) this.funding.disabledReason = "HELIUS_FUNDED_BY_PER_MIN=0";
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  start(): void {
    this.timer ??= setInterval(() => this.tick(), 1_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // MarketState hooks (ingest path: queue only)
  onLaunch(rec: TokenRecord): void {
    this.devHistory.onLaunch(rec);
  }

  onMigrate(rec: TokenRecord): void {
    this.devHistory.onMigrate(rec);
  }

  funderOf(wallet: string): string | null {
    return this.funding.funderOf(wallet);
  }

  /** One scheduling pass. Exposed for tests. */
  tick(now = this.now()): void {
    try {
      const cands = this.candidates(now);
      for (const mint of cands.keys()) if (this.d.market.tokens.get(mint)?.devLaunches === null) this.devHistory.request(mint);
      this.devHistory.tick();
      this.scheduleDex(cands, now);
      this.scheduleHolders(cands, now);
      this.scheduleFunding(cands, now);
      if (now - this.prunedAt > 60_000) this.prune(now);
    } catch (e) {
      log.warn(`tick failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Mints worth network work, with their priority (lower = more urgent). */
  candidates(now: number): Map<string, Prio> {
    const c = new Map<string, Prio>();
    const tokens = this.d.market.tokens;
    const add = (mint: string, p: Prio) => {
      if (!tokens.has(mint)) return;
      const cur = c.get(mint);
      if (cur === undefined || p < cur) c.set(mint, p);
    };
    for (const mint of this.d.focused()) add(mint, 0);
    for (const [mint, h] of this.profileHits) if (h.nextAt <= now) add(mint, 1);
    for (const col of ["final", "migrated"] as PulseColumn[]) for (const s of this.d.pulse.snapshot(col)) add(s.mint, 2);
    if (now - this.activeAt >= 10_000) {
      this.active = this.recentlyActive(now);
      this.activeAt = now;
    }
    for (const mint of this.active) add(mint, 3);
    return c;
  }

  private recentlyActive(now: number): string[] {
    const n = this.d.cfg.activeTokens;
    if (n <= 0) return [];
    const top: [string, number][] = [];
    for (const rec of this.d.market.tokens.values()) {
      if ((rec.launchpad !== "pump" && rec.launchpad !== "launchlab") || rec.lastTradeAt === null || now - rec.lastTradeAt > 120_000)
        continue;
      const v = rec.windows.totals(now).volume5m;
      if (top.length < n || v > (top[top.length - 1] as [string, number])[1]) {
        top.push([rec.mint, v]);
        top.sort((a, b) => b[1] - a[1]);
        if (top.length > n) top.pop();
      }
    }
    return top.map(([m]) => m);
  }

  /** Due items (by interval) in priority order, never-checked first within a priority. */
  private due(cands: Map<string, Prio>, last: Map<string, number>, interval: (p: Prio) => number | undefined, now: number) {
    const out: { mint: string; p: Prio; last: number }[] = [];
    for (const [mint, p] of cands) {
      const iv = interval(p);
      if (iv === undefined) continue;
      const l = last.get(mint) ?? Number.MIN_SAFE_INTEGER;
      if (now - l >= iv) out.push({ mint, p, last: l });
    }
    return out.sort((a, b) => a.p - b.p || a.last - b.last);
  }

  // ---------------------------------------------------------------------------------------------
  // Dex Paid
  // ---------------------------------------------------------------------------------------------

  private scheduleDex(cands: Map<string, Prio>, now: number): void {
    const dex = this.dex;
    if (!dex) return;
    if (now - this.profilesPolledAt >= 60_000 && this.inFlight.dex < 2 && this.dexBucket.take(1, now)) {
      this.profilesPolledAt = now;
      this.inFlight.dex++;
      void this.pollProfiles(dex).finally(() => this.inFlight.dex--);
    }
    const tokens = this.d.market.tokens;
    for (const it of this.due(cands, this.dexChecked, (p) => DEX_INTERVAL[p], now)) {
      if (tokens.get(it.mint)?.dexPaid === true) continue;
      if (this.inFlight.dex >= 2 || !this.dexBucket.take(1, now)) break;
      this.dexChecked.set(it.mint, now);
      const hit = this.profileHits.get(it.mint);
      if (hit) {
        hit.tries++;
        hit.nextAt = now + PROFILE_RETRY_MS;
        if (hit.tries >= PROFILE_TRIES) this.profileHits.delete(it.mint);
      }
      this.inFlight.dex++;
      void this.checkDex(dex, it.mint).finally(() => this.inFlight.dex--);
    }
  }

  private async pollProfiles(dex: DexScreenerClient): Promise<void> {
    try {
      for (const mint of await dex.latestProfiles()) {
        const rec = this.d.market.tokens.get(mint);
        if (!rec || rec.dexPaid === true || this.profileHits.has(mint)) continue;
        this.profileHits.set(mint, { tries: 0, nextAt: 0 });
        this.stats.profileHits++;
      }
    } catch (e) {
      this.onDexError(e);
    }
  }

  private async checkDex(dex: DexScreenerClient, mint: string): Promise<void> {
    try {
      const r = dexPaidFrom(await dex.orders(mint));
      this.stats.dexChecks++;
      if (r.paid) {
        this.stats.dexPaid++;
        this.profileHits.delete(mint);
      }
      this.d.market.setDexPaid(mint, r.paid, r.paidAt);
    } catch (e) {
      this.onDexError(e);
    }
  }

  private onDexError(e: unknown): void {
    this.stats.dexErrors++;
    if (e instanceof DexScreenerError && e.status === 429) {
      this.dexBucket.pause(60_000, this.now());
      log.warn("DexScreener answered 429; pausing Dex Paid checks for 60 s");
    }
  }

  // ---------------------------------------------------------------------------------------------
  // holder reconciliation
  // ---------------------------------------------------------------------------------------------

  private scheduleHolders(cands: Map<string, Prio>, now: number): void {
    const h = this.d.cfg.holders;
    if (!h.enabled) return;
    const interval = (p: Prio) => (p === 0 ? h.focusedEveryMs : p === 2 ? h.listedEveryMs : undefined);
    for (const it of this.due(cands, this.holdersChecked, interval, now)) {
      if (this.inFlight.holders >= 1) break;
      const rec = this.d.market.tokens.get(it.mint);
      if (!rec?.holders) continue;
      const method = this.pickHolderMethod(rec, now);
      if (!method) break;
      this.holdersChecked.set(it.mint, now);
      this.inFlight.holders++;
      const run = method === "das" ? this.reconcileDas(rec) : this.reconcileLargest(rec.mint);
      void run.finally(() => this.inFlight.holders--);
    }
  }

  /** DAS when configured and affordable (full scan: exact holder count), else the RPC largest accounts. */
  private pickHolderMethod(rec: TokenRecord, now: number): "das" | "rpc" | null {
    const das = this.d.cfg.das;
    if (this.helius && !this.dasDisabled && (this.dasTooBig.get(rec.mint) ?? 0) <= now) {
      const pages = Math.max(1, Math.ceil(((rec.holders?.holderCount ?? 0) * 1.2) / das.pageSize));
      if (pages <= das.maxPages && this.dasBucket.available(now) >= pages) return "das";
    }
    if (now >= this.largest.until && this.holdersBucket.take(2, now)) return "rpc";
    return null;
  }

  private async reconcileLargest(mint: string): Promise<void> {
    try {
      const snap = await largestAccountsSnapshot(this.rpc, mint);
      this.d.market.applyHolderSnapshot(mint, snap.entries, {
        source: "rpc",
        at: this.now(),
        full: snap.complete,
        floor: snap.floor,
        slot: snap.slot,
      });
      this.stats.rpcChecks++;
      if (this.largest.reason) log.info("getTokenLargestAccounts works again");
      this.largest.backoffMs = 60_000;
      this.largest.reason = null;
    } catch (e) {
      this.stats.holderErrors++;
      if (e instanceof RpcError && (e.code === 429 || /too many requests/i.test(e.message))) {
        const ms = this.largest.backoffMs;
        this.largest.until = this.now() + ms;
        this.largest.backoffMs = Math.min(ms * 2, LARGEST_BACKOFF_MAX);
        const reason = `getTokenLargestAccounts rate-limited by the RPC (the public endpoint refuses it); retrying in ${Math.round(ms / 1000)} s`;
        if (this.largest.reason === null || ms >= LARGEST_BACKOFF_MAX) log.warn(reason);
        this.largest.reason = reason;
      } else log.debug(`holder reconciliation of ${mint} failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async reconcileDas(rec: TokenRecord): Promise<void> {
    const helius = this.helius as HeliusClient;
    const das = this.d.cfg.das;
    try {
      const r = await dasSnapshot(helius, rec.mint, {
        pageSize: das.pageSize,
        maxPages: das.maxPages,
        fallbackSlot: rec.lastSlot ?? 0,
        takePage: () => this.dasBucket.take(1, this.now()),
      });
      if (r === "budget") return;
      if (r === null) {
        // more holders than HELIUS_DAS_MAX_PAGES pages: use the largest accounts for this token for a while
        this.dasTooBig.set(rec.mint, this.now() + DAS_TOO_BIG_MS);
        this.holdersChecked.delete(rec.mint);
        return;
      }
      this.stats.dasScans++;
      this.stats.dasPages += r.pages;
      this.d.market.applyHolderSnapshot(rec.mint, r.entries, { source: "das", at: this.now(), full: true, slot: r.slot });
    } catch (e) {
      this.stats.holderErrors++;
      if (e instanceof HeliusError && (e.status === 401 || e.status === 403)) {
        this.dasDisabled = `DAS refused (HTTP ${e.status})`;
        log.warn(`Helius ${this.dasDisabled}; holder counts fall back to the RPC largest accounts`);
      } else if (e instanceof HeliusError && e.status === 429) this.dasBucket.pause(60_000, this.now());
      else log.debug(`DAS scan of ${rec.mint} failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // funding: insiders (creator-funded wallets within two hops) and shared-funder bundles
  // ---------------------------------------------------------------------------------------------

  private scheduleFunding(cands: Map<string, Prio>, now: number): void {
    if (!this.funding.available || this.inFlight.funding > 0) return;
    const next = this.due(cands, this.fundingChecked, (p) => FUNDING_INTERVAL[p], now).find(
      (it) => this.d.market.tokens.get(it.mint)?.holders,
    );
    if (!next) return;
    this.fundingChecked.set(next.mint, now);
    this.inFlight.funding++;
    void this.analyzeFunding(next.mint, next.p).finally(() => this.inFlight.funding--);
  }

  private async analyzeFunding(mint: string, p: Prio): Promise<void> {
    const rec = this.d.market.tokens.get(mint);
    const book = rec?.holders;
    if (!rec || !book) return;
    const devs = new Set(book.devWallets);
    const creator = creatorOf(rec);
    if (creator) devs.add(creator);
    const insiders: string[] = [];
    let complete = true;
    for (const [w] of book.topHolders(this.d.cfg.fundedBy.topHolders)) {
      if (devs.has(w)) continue;
      const f1 = await this.funding.resolve(w);
      if (!f1) {
        complete = false;
        break;
      }
      if (f1.funder && devs.has(f1.funder)) {
        insiders.push(w);
        continue;
      }
      if (!f1.funder || isExchangeFunder(f1)) continue;
      const f2 = await this.funding.resolve(f1.funder);
      if (!f2) {
        complete = false;
        break;
      }
      if (f2.funder && devs.has(f2.funder)) insiders.push(w);
    }
    if (!complete) {
      // out of budget: come back soon (cached wallets cost nothing on the next pass)
      this.fundingChecked.set(mint, this.now() - (FUNDING_INTERVAL[p] ?? 0) + 15_000);
      return;
    }
    this.d.market.setFundedInsiders(mint, insiders, this.now());
    this.stats.insiderRuns++;
    for (const w of book.crowdedCandidates().slice(0, 50)) if (!this.funding.cached(w) && !(await this.funding.resolve(w))) break;
    this.stats.bundlesAdded += this.d.market.recheckBundles(mint);
  }

  // ---------------------------------------------------------------------------------------------

  private prune(now: number): void {
    this.prunedAt = now;
    const tokens = this.d.market.tokens;
    for (const m of [this.dexChecked, this.holdersChecked, this.fundingChecked, this.dasTooBig])
      for (const k of [...m.keys()]) if (!tokens.has(k)) m.delete(k);
    for (const k of [...this.profileHits.keys()]) if (!tokens.has(k)) this.profileHits.delete(k);
  }

  /** Health lines (budgets, what ran, what is unavailable and why). */
  notes(): string[] {
    const c = this.d.cfg;
    const s = this.stats;
    const dex = this.dex
      ? `${s.dexChecks} orders checks, ${s.dexPaid} paid, ${s.profileHits} profile-feed hits, ${this.dex.stats.rateLimited} HTTP 429; budget ${c.dexscreener.rpm} per 60 s`
      : "off";
    const das = this.helius
      ? (this.dasDisabled ?? `${s.dasScans} DAS scans (${s.dasPages} pages, budget ${c.das.pagesPerMin} pages/min)`)
      : "DAS off (no HELIUS_API_KEY)";
    const funding = this.funding.available
      ? `${this.funding.stats.lookups} funded-by lookups (budget ${c.fundedBy.perMin}/min), ${s.insiderRuns} insider runs, ${s.bundlesAdded} bundlers from shared funders`
      : `off: ${this.funding.disabledReason} (insidersPct stays null)`;
    return [
      `enrich dex paid: ${dex}`,
      `enrich holders: ${s.rpcChecks} largest-accounts checks (budget ${c.holders.rpcPerMin} RPC calls/min), ${das}, ${s.holderErrors} errors${this.largest.reason ? `; ${this.largest.reason}` : ""}`,
      `enrich funding: ${funding}`,
      `enrich dev history: ${this.devHistory.stats.computed} computed, ${this.devHistory.stats.loads} creator loads, ${this.devHistory.pending} queued`,
    ];
  }
}
