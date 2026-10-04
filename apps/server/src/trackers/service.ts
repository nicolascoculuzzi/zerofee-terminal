/**
 * Wallet tracker and copy-trade detection (SPEC Phases 6 and 8), on the shared feed.
 *
 * MarketState calls onTrade for every trade it records (curve and PumpSwap, including PumpSwap events
 * that waited for their pool), with the transaction it came from. Matching is two hash lookups (the
 * event's `user`, and the fee payer when the source has signers) against the WalletIndex, the
 * deduplicated union of every user's tracked wallets and copy-task leaders. A match then:
 *  - goes to the owners' `tracked` / `tracked:<mint>` topics (feed.ts),
 *  - goes to AlertEngine.onWalletActivity (buy / sell / launch alerts, min size, first buy),
 *  - and, when the wallet leads copy tasks and traded for itself, to the copy engine (copy.ts).
 * Launches by tracked wallets come from onTx (CreateEvent user / creator). Dead slots retract matches
 * and revoke copy signals raised from them. Nothing here blocks the ingest path: no database reads, no
 * awaits; persistence is write-behind.
 */
import {
  type CopySnapshot,
  type ParsedTopic,
  type TokenSummary,
  type TrackedSnapshot,
  type Trade,
  USER_LIMITS,
  type UserSettings,
} from "@zerofee/protocol";
import type { WalletActivity } from "../alerts/engine";
import type { Route } from "../api/router";
import type { ServerConfig } from "../config";
import type { PgDriver, UserStore } from "../db/pg";
import { toJson } from "../db/pg/driver";
import type { UserTopicHandler } from "../gateway/server";
import type { IngestTx } from "../ingest/types";
import { logger } from "../log";
import type { TokenRecord } from "../market/token";
import { CopyEngine, type CopyExitHook, copyTopic, type TokenView } from "./copy";
import { CopyRepo } from "./copyRepo";
import { feedTopic, type MatchedWallet, type MatchRecord, mintTopic, type Publisher, TrackedFeed } from "./feed";
import { balanceAround, isFirstBuy, WalletPositions } from "./positions";
import { trackerRoutes } from "./routes";
import { type TrackedInput, WalletIndex, type Watcher } from "./walletIndex";

const log = logger("trackers");

export type TrackerConfig = ServerConfig["trackers"];

/** What the trackers read from MarketState. */
export interface MarketLike {
  readonly tokens: ReadonlyMap<string, TokenRecord>;
  summary(mint: string): TokenSummary | null;
  recentTrades(mint: string, limit?: number): Trade[];
}

/** The alert engine's wallet hook. */
export interface WalletActivitySink {
  onWalletActivity(ev: WalletActivity): void;
}

export interface TrackerServiceOptions {
  cfg: TrackerConfig;
  db: PgDriver;
  store: UserStore;
  alerts: WalletActivitySink | null;
  now?: () => number;
  /** Armed-orders seam for tab-closed copy exits (orders engine). */
  exits?: CopyExitHook | null;
}

const FEED_SNAPSHOT = 100;
const MINT_SNAPSHOT = 300;

export class TrackerService {
  readonly index: WalletIndex;
  readonly positions: WalletPositions;
  readonly feed: TrackedFeed;
  readonly copy: CopyEngine;
  readonly repo: CopyRepo;
  private market: MarketLike | null = null;
  private solUsd: () => number | null = () => null;
  private readonly now: () => number;
  private readonly reloads = new Map<string, Promise<void>>();
  private timers: ReturnType<typeof setInterval>[] = [];
  readonly stats = { trades: 0, matchedTrades: 0, launches: 0, errors: 0 };

  constructor(private readonly o: TrackerServiceOptions) {
    this.now = o.now ?? Date.now;
    const c = o.cfg;
    this.index = new WalletIndex({ maxEntries: c.maxEntries, maxTrackedPerUser: USER_LIMITS.trackedWallets });
    this.positions = new WalletPositions(c.positions);
    this.feed = new TrackedFeed(this.index, {
      ringSize: c.feedRing,
      mintRingSize: c.mintRing,
      mintRings: c.mintRings,
      maxRowsPerFrame: c.maxRowsPerFrame,
      slotMemory: 1_000,
    });
    this.repo = new CopyRepo(o.db);
    this.copy = new CopyEngine({
      repo: this.repo,
      store: o.store,
      now: this.now,
      token: (mint) => this.tokenView(mint),
      recentTrades: (mint) => this.market?.recentTrades(mint, 200) ?? [],
      limits: c.copy,
      exits: o.exits ?? null,
      onLeadersChanged: (userId, leaders) => this.index.setLeaders(userId, leaders),
    });
  }

  attachMarket(market: MarketLike, solUsd: () => number | null): void {
    this.market = market;
    this.solUsd = solUsd;
  }

  attachHub(hub: Publisher): void {
    this.feed.attach(hub);
    this.copy.attach(hub);
  }

  // -------------------------------------------------------------------------------------------
  // loading
  // -------------------------------------------------------------------------------------------

  /** Loads every user's tracked wallets and copy tasks into memory (start-up). */
  async load(): Promise<void> {
    const t0 = performance.now();
    const rows = await this.o.db.query(
      "SELECT user_id, address, label, emoji, tags FROM tracked_wallets ORDER BY user_id, created_at, address",
    );
    const byUser = new Map<string, TrackedInput[]>();
    for (const r of rows) {
      const userId = String(r.user_id);
      let list = byUser.get(userId);
      if (!list) {
        list = [];
        byUser.set(userId, list);
      }
      list.push({ address: String(r.address), label: String(r.label), emoji: String(r.emoji), tags: toJson<string[]>(r.tags) ?? [] });
    }
    for (const [userId, list] of byUser) this.index.setTracked(userId, list);
    await this.copy.load();
    const s = this.index.stats;
    log.info(
      `wallet tracker: ${s.addresses} addresses (${s.entries} watchers, ${s.users} users) indexed in ${Math.round(performance.now() - t0)} ms` +
        (s.refused ? `, ${s.refused} refused over TRACKER_MAX_ENTRIES` : ""),
    );
  }

  /** Re-reads one user's tracked wallets after a REST change (serialized per user). */
  reloadTracked(userId: string): Promise<void> {
    const prev = this.reloads.get(userId) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        const rows = await this.o.db.query(
          "SELECT address, label, emoji, tags FROM tracked_wallets WHERE user_id = $1::uuid ORDER BY created_at, address",
          [userId],
        );
        this.index.setTracked(
          userId,
          rows.map((r) => ({
            address: String(r.address),
            label: String(r.label),
            emoji: String(r.emoji),
            tags: toJson<string[]>(r.tags) ?? [],
          })),
        );
      });
    this.reloads.set(userId, next);
    void next.finally(() => {
      if (this.reloads.get(userId) === next) this.reloads.delete(userId);
    });
    return next;
  }

  settingsChanged(userId: string, s: UserSettings): void {
    this.copy.setUserCaps(userId, { maxTradeSol: s.maxTradeSol, maxDailySol: s.maxDailySol });
  }

  blacklistChanged(userId: string): void {
    if (!this.copy.leadersOf(userId).length) return;
    void this.copy.loadUser(userId).catch((e) => log.warn(`blacklist reload failed: ${e instanceof Error ? e.message : e}`));
  }

  // -------------------------------------------------------------------------------------------
  // the hot path
  // -------------------------------------------------------------------------------------------

  /** Every trade MarketState records. Never throws. */
  onTrade(trade: Trade, tx: IngestTx): void {
    try {
      this.stats.trades++;
      this.copy.onAnyTrade(trade);
      const payer = tx.signers?.[0] ?? null;
      const byTrader = this.index.get(trade.trader);
      const byPayer = payer && payer !== trade.trader ? this.index.get(payer) : undefined;
      if (!byTrader && !byPayer) return;
      this.matched(trade, tx, byTrader, byPayer, payer);
    } catch (e) {
      this.stats.errors++;
      log.warn(`tracker match failed for ${trade.signature}: ${e instanceof Error ? e.message : e}`);
    }
  }

  private matched(
    trade: Trade,
    tx: IngestTx,
    byTrader: readonly Watcher[] | undefined,
    byPayer: readonly Watcher[] | undefined,
    payer: string | null,
  ): void {
    this.stats.matchedTrades++;
    const rec = this.market?.tokens.get(trade.mint);
    const balance = balanceAround(trade, tx.tokenBalances, rec?.holders ?? null, this.positions, !!byTrader);
    const firstBuy = isFirstBuy(trade, balance);
    const matched: MatchedWallet[] = [];
    if (byTrader) matched.push({ wallet: trade.trader, role: "trader" });
    if (byPayer && payer) matched.push({ wallet: payer, role: "feePayer" });
    const sol = this.solUsd();
    const m: MatchRecord = {
      key: trade.id,
      kind: trade.side,
      matched,
      trader: trade.trader,
      mint: trade.mint,
      symbol: rec?.symbol ?? "",
      name: rec?.name ?? "",
      image: rec?.image ?? null,
      launchpad: rec?.launchpad ?? (trade.venue === "pump" ? "pump" : "pumpswap"),
      venue: trade.venue,
      amountSol: trade.amountSol,
      amountUsd: trade.amountUsd,
      tokenAmount: trade.tokenAmount,
      priceSol: trade.priceSol,
      mcSol: trade.mcSol,
      mcUsd: sol ? trade.mcSol * sol : null,
      signature: trade.signature,
      slot: trade.slot,
      blockTime: trade.blockTime,
      receivedAt: trade.receivedAt,
      firstBuy,
      marketTags: trade.tags,
    };
    if (byTrader?.some((w) => w.tracked) || byPayer?.some((w) => w.tracked)) this.feed.add(m);
    if (this.o.alerts) {
      for (const mw of matched) {
        this.o.alerts.onWalletActivity({
          address: mw.wallet,
          kind: trade.side,
          mint: trade.mint,
          symbol: m.symbol,
          amountSol: trade.amountSol,
          signature: trade.signature,
          ts: trade.blockTime,
          firstBuy,
        });
      }
    }
    // Copy only the leader's own trades (a wallet paying fees for someone else is not a signal).
    if (byTrader?.some((w) => w.leader)) this.copy.onLeaderTrade({ leader: trade.trader, trade, balance, firstBuy });
  }

  /** Launches by tracked wallets (CreateEvent user / creator), after MarketState applied the tx. Never throws. */
  onTx(tx: IngestTx): void {
    try {
      tx.events.forEach((ev, i) => {
        if (ev.kind !== "pumpCreate") return;
        const matched: MatchedWallet[] = [];
        if (this.index.get(ev.user)?.some((w) => w.tracked)) matched.push({ wallet: ev.user, role: "trader" });
        if (ev.creator !== ev.user && this.index.get(ev.creator)?.some((w) => w.tracked))
          matched.push({ wallet: ev.creator, role: "trader" });
        if (!matched.length) return;
        this.stats.launches++;
        const rec = this.market?.tokens.get(ev.mint);
        const s = this.market?.summary(ev.mint) ?? null;
        const m: MatchRecord = {
          key: `${tx.signature}:create:${i}`,
          kind: "create",
          matched,
          trader: ev.user,
          mint: ev.mint,
          symbol: ev.symbol,
          name: ev.name,
          image: rec?.image ?? null,
          launchpad: "pump",
          venue: "pump",
          amountSol: 0,
          amountUsd: 0,
          tokenAmount: "0",
          priceSol: s?.priceSol ?? 0,
          mcSol: s?.mcSol ?? 0,
          mcUsd: s?.mcUsd ?? null,
          signature: tx.signature,
          slot: tx.slot,
          blockTime: Number(ev.timestamp) * 1000,
          receivedAt: tx.receivedAt,
          firstBuy: null,
          marketTags: ["dev"],
        };
        this.feed.add(m);
        for (const mw of matched) {
          this.o.alerts?.onWalletActivity({
            address: mw.wallet,
            kind: "create",
            mint: ev.mint,
            symbol: ev.symbol,
            amountSol: 0,
            signature: tx.signature,
            ts: m.blockTime,
          });
        }
      });
    } catch (e) {
      this.stats.errors++;
      log.warn(`tracker launch match failed for ${tx.signature}: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** A slot died (call before MarketState replays parked fork copies). */
  onDeadSlot(slot: number): void {
    try {
      this.feed.dropSlot(slot);
      this.copy.onDeadSlot(slot);
    } catch (e) {
      this.stats.errors++;
      log.warn(`tracker dead-slot handling failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Mints whose summary changed (Pulse flush): TP / SL of open copy positions. */
  onTokensChanged(mints: Iterable<string>): void {
    try {
      this.copy.onPrices(mints);
    } catch (e) {
      this.stats.errors++;
      log.warn(`copy TP/SL check failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Keeps a token in memory while a copy position on it is open. */
  watchesMint(mint: string): boolean {
    return this.copy.watchesMint(mint);
  }

  /** What the copy engine reads about a token (live summary + record flags). */
  tokenView(mint: string): TokenView | null {
    const m = this.market;
    if (!m) return null;
    const rec = m.tokens.get(mint);
    const s = m.summary(mint);
    if (!rec || !s) return null;
    return {
      mint,
      symbol: s.symbol,
      decimals: s.decimals,
      venue: rec.migrated || (!rec.curve && rec.poolState) ? "pumpswap" : "pump",
      priceSol: s.priceSol,
      mcSol: s.mcSol,
      mcUsd: s.mcUsd,
      liquiditySol: s.liquidity,
      liquidityUsd: s.liquidityUsd,
      createdAt: s.createdAt,
      creator: s.creator,
      onCurve: s.launchpad === "pump" && !s.complete && !s.migrated,
      curveComplete: s.complete && !s.migrated,
      dangerous: rec.dangers.length > 0,
    };
  }

  // -------------------------------------------------------------------------------------------
  // topics, routes, lifecycle
  // -------------------------------------------------------------------------------------------

  /** `tracked`, `tracked:<mint>` and `copy` for the gateway (signed-in sessions only). */
  topicHandlers(): Partial<Record<ParsedTopic["kind"], UserTopicHandler>> {
    return {
      tracked: {
        internal: (userId, p) => (p.kind === "tracked" && p.mint ? mintTopic(userId, p.mint) : feedTopic(userId)),
        snapshot: async (userId, p): Promise<TrackedSnapshot> => {
          const mint = p.kind === "tracked" ? p.mint : null;
          return { rows: this.feed.snapshot(userId, mint, mint ? MINT_SNAPSHOT : FEED_SNAPSHOT) };
        },
      },
      copy: {
        internal: (userId) => copyTopic(userId),
        snapshot: async (userId): Promise<CopySnapshot> => this.copySnapshot(userId),
      },
    };
  }

  async copySnapshot(userId: string): Promise<CopySnapshot> {
    const pending = this.copy.pendingOf(userId);
    const ids = new Set(pending.map((s) => s.id));
    const recent = (await this.repo.listSignals(userId, { limit: 50 })).filter((s) => !ids.has(s.id));
    return { tasks: this.copy.listTasks(userId), positions: this.copy.positions(userId), signals: [...pending, ...recent] };
  }

  routes(): Route[] {
    return trackerRoutes({ service: this, store: this.o.store });
  }

  start(): void {
    const every = (ms: number, what: string, fn: () => unknown) =>
      this.timers.push(
        setInterval(() => {
          try {
            void Promise.resolve(fn()).catch((e) => log.warn(`${what} failed: ${e instanceof Error ? e.message : e}`));
          } catch (e) {
            log.warn(`${what} failed: ${e instanceof Error ? e.message : e}`);
          }
        }, ms),
      );
    every(this.o.cfg.flushMs, "tracked feed flush", () => this.feed.flush());
    every(1_000, "copy signal sweep", () => this.copy.sweep());
    every(5_000, "copy state flush", () => this.copy.flushState());
    every(6 * 3_600_000, "copy decision log purge", () => this.repo.purgeSkipped(this.now() - this.o.cfg.skipRetentionDays * 86_400_000));
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.feed.flush();
    await this.copy.drain();
  }

  /** One-line health summary for the periodic log. */
  summary(): string {
    const s = this.index.stats;
    const c = this.copy.stats;
    return (
      `tracker ${s.addresses} addresses/${s.users} users, ${this.stats.matchedTrades} matches, feed ${this.feed.stats.frames} frames; ` +
      `copy ${this.copy.taskCount} tasks, ${c.buySignals} buys/${c.sellSignals} sells, ${c.skipped} skipped, ${this.copy.pendingCount} pending`
    );
  }
}
