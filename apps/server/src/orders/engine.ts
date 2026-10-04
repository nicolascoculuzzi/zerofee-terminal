/**
 * The armed-orders engine (SPEC "Armed orders", Phase 5). It holds every order whose nonces are still
 * unconsumed and:
 *
 *  - triggers: on every ingested transaction touching a mint with open orders (and on a periodic sweep
 *    for time triggers and quiet markets) it quotes the order from live market state (liveQuoteOut, the
 *    same math the browser armed with) and runs evaluateTrigger;
 *  - submits: the chosen variant goes ONLY to the protected lane (Jito bundleOnly). The "submitted"
 *    transition is persisted BEFORE the bytes leave, so a crash can never leave a sent variant without
 *    its miss window. DRY_RUN simulates instead and the order stays "submitted (dry run)";
 *  - watches nonces: batched getMultipleAccounts polling (fast for nonces with an attempt in flight, slow
 *    for the rest). When a nonce advanced, the consuming signature is resolved (signaturesOnNonce +
 *    getSignatureStatuses, then the nonce account's history) and `nonce-consumed` is applied, with the
 *    value the nonce held, to every order bound to it (OCO partners, ladder attempts);
 *  - misses: an attempt that has not landed within `missSlots` gets `submit-missed`, which fires its
 *    pre-signed cancel (a leaked nonce transaction is a permanent option); fired cancels are re-sent
 *    until their nonce advances;
 *  - staleness: migration, creator changes, rotated fee recipients, coin flags, lookup tables and the pump
 *    interface version feed detectStaleness: definitive findings make the order stale (cancels fire),
 *    the rest become flags; both notify the user, who re-arms from the browser;
 *  - kill switches: the admin halt stops submissions and fires every stored cancel; Panic fires one user's.
 *
 * Every transition goes through the core status machine (applyArmedOrderEvent) inside a per-order serial
 * queue, is persisted (optimistic version check), published on the user's `orders` topic, and its effects
 * (fire-cancel, notify) run afterwards.
 */
import type { Address, AddressesByLookupTableAddress } from "@solana/kit";
import {
  type ArmedMarketEvent,
  type ArmedOrder,
  type ArmedOrderEffect,
  type ArmedOrderEvent,
  type ArmedSafetyPolicy,
  ArmedTransitionError,
  type ArmedVariant,
  applyArmedOrderEvent,
  armedNotional,
  classifyStaleness,
  currentInterfaceVersion,
  detectStaleness,
  evaluateTrigger,
  findAssociatedTokenAddress,
  hasReservedBalance,
  isAttemptOpen,
  isTerminalStatus,
  type LookupTableState,
  liveQuoteOut,
  marketEventFromDecoded,
  type NonceSlotSnapshot,
  nonceKey,
  reservationHeld,
  type SignedTx,
  signaturesOnNonce,
  type TriggerDecision,
  type TriggerPolicy,
  type TriggerState,
} from "@zerofee/core";
import type { HaltState, Order, OrdersDelta } from "@zerofee/protocol";
import type { OrderEvent } from "../alerts/engine";
import type { IngestTx } from "../ingest/types";
import { logger } from "../log";
import type { CopyExitHook } from "../trackers/copy";
import { type ChainReader, isConfirmed, lookupTableState, nonceSnapshot, tokenAmount } from "./chain";
import type { OrdersConfig } from "./config";
import type { SendReport, Submitter } from "./lanes";
import type { OrderMarket } from "./market";
import type { ArmedOrdersRepo, OrderEventWrite, StoredOrder } from "./repo";
import { orderView } from "./view";

const log = logger("orders");

/** Resolution tries (one per poll) before a nonce advance without a known signature counts as foreign. */
const FOREIGN_AFTER_TRIES = 3;
/** ...and the hard limit when not even the nonce account's history names a transaction. */
const FOREIGN_TIMEOUT_MS = 60_000;
/** OCO partners fire the same cancel bytes: send them once. */
const CANCEL_DEDUPE_MS = 1_000;
/** A held order (insufficient balance) is reported at most this often. */
const HOLD_REPORT_MS = 5 * 60_000;
const BALANCE_CHECK_TIMEOUT_MS = 1_500;
const LOOKUP_REFRESH_MS = 60_000;

export interface HaltSource {
  readonly state: HaltState;
  isHalted(): boolean;
  onChange(fn: (s: HaltState) => void): void;
}

export interface OrderEngineDeps {
  cfg: OrdersConfig;
  repo: ArmedOrdersRepo;
  market: OrderMarket;
  chain: ChainReader;
  submitter: Submitter;
  /** Publishes an `orders` delta to one user's sockets. */
  publish(userId: string, delta: OrdersDelta): void;
  /** Off-app notification (AlertEngine.onOrderEvent). */
  notify(ev: OrderEvent): void;
  halt?: HaltSource | null;
  /** Pool -> base mint, for PumpSwap events (they name the pool, not the mint). */
  baseMintOfPool?(pool: string): string | undefined;
  /**
   * Operator lookup-table contents. Given: used as is (tests, pinned deployments). Omitted: the tables in
   * `cfg.lookupTables` are read from chain and refreshed.
   */
  lookupTables?: AddressesByLookupTableAddress;
  /** Latest pump interface version (IDL watcher). Default: the one this build was written against. */
  interfaceVersion?: () => string;
  now?: () => number;
}

/** The transaction that consumed a nonce generation; `owner` is the order whose variant it is. */
interface Consumer {
  signature: string;
  success: boolean;
  slot: number | null;
  owner: string | undefined;
}

interface Tracked {
  userId: string;
  order: ArmedOrder;
  state: TriggerState;
  dryRun: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
  /** Serial queue: every transition of this order runs after the previous one. */
  tail: Promise<void>;
  /** A submission job is queued or running. */
  firing: boolean;
  stateDirty: boolean;
  statePersistedAt: number;
  /** Live submission inside its miss window (re-sent every resendMs). */
  inFlight: { attempt: number; variantId: string; wire: string; at: number; lastSentAt: number } | null;
  /** Last trigger hold reason (debugging and the hold report). */
  lastHold: string | null;
  heldReportedAt: number;
}

export interface EngineStats {
  evaluations: number;
  submissions: number;
  simulated: number;
  sendFailures: number;
  cancelsSent: number;
  nonceConsumed: number;
  missed: number;
  stale: number;
  pollErrors: number;
}

export class OrderEngine implements CopyExitHook {
  private readonly orders = new Map<string, Tracked>();
  private readonly byMint = new Map<string, Set<string>>();
  private readonly byNonce = new Map<string, Set<string>>();
  private readonly resolving = new Map<string, { since: number; tries: number; running: boolean }>();
  private readonly cancelSentAt = new Map<string, number>();
  private readonly lastNonceValue = new Map<string, string | null>();
  private tables: AddressesByLookupTableAddress | null;
  private tableStates: Record<string, LookupTableState | null> | null = null;
  private lastSlot: number | null = null;
  private tablesRetryAt = 0;
  /** Every configured operator table was found at the last refresh. */
  private tablesComplete = false;
  private timers: ReturnType<typeof setInterval>[] = [];
  /** Queued transitions and background sends (settle() waits for them). */
  private readonly work = new Set<Promise<unknown>>();
  private busy = { hot: false, cold: false, stale: false, tables: false };
  private started = false;
  readonly now: () => number;
  readonly stats: EngineStats = {
    evaluations: 0,
    submissions: 0,
    simulated: 0,
    sendFailures: 0,
    cancelsSent: 0,
    nonceConsumed: 0,
    missed: 0,
    stale: 0,
    pollErrors: 0,
  };

  constructor(private readonly d: OrderEngineDeps) {
    this.now = d.now ?? Date.now;
    this.tables = d.lookupTables ?? null;
  }

  get dryRun(): boolean {
    return this.d.submitter.dryRun;
  }

  get cfg(): OrdersConfig {
    return this.d.cfg;
  }

  // -------------------------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------------------------

  /** Loads every open order, subscribes to the kill switch and starts the loops (`timers: false` in tests). */
  async start(o: { timers?: boolean } = {}): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const s of await this.d.repo.loadOpen()) this.track(s);
    await this.refreshLookupTables();
    this.d.halt?.onChange((s) => {
      if (s.halted) void this.haltAll(s.reason).catch((e) => log.error(`halt: firing cancels failed: ${errText(e)}`));
    });
    if (this.d.halt?.isHalted()) await this.haltAll(this.d.halt.state.reason);
    log.info(
      `armed orders: ${this.orders.size} open, ${this.dryRun ? "DRY_RUN (simulate, never send)" : "LIVE (Jito bundle-only)"}, ` +
        `lookup tables ${this.d.cfg.lookupTables.length ? this.d.cfg.lookupTables.join(",") : this.tables ? "(given)" : "(none)"}`,
    );
    if (o.timers === false) return;
    const every = (ms: number, fn: () => Promise<unknown> | unknown) =>
      this.timers.push(
        setInterval(() => {
          void Promise.resolve()
            .then(fn)
            .catch((e) => log.warn(`orders loop failed: ${errText(e)}`));
        }, ms),
      );
    every(this.d.cfg.hotPollMs, () => this.pollNonces("hot"));
    every(this.d.cfg.coldPollMs, () => this.pollNonces("all"));
    every(this.d.cfg.sweepMs, () => this.sweep());
    every(this.d.cfg.stalenessMs, () => this.checkStaleness());
    if (!this.d.lookupTables && this.d.cfg.lookupTables.length) every(LOOKUP_REFRESH_MS, () => this.refreshLookupTables());
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await Promise.race([this.settle(), Bun.sleep(2_000)]);
    await this.flushStates(true);
  }

  /** Resolves once every queued transition and background send has finished (tests, shutdown). */
  async settle(): Promise<void> {
    while (this.work.size) await Promise.allSettled([...this.work]);
  }

  private background<T>(p: Promise<T>): Promise<T> {
    this.work.add(p);
    void p.then(
      () => this.work.delete(p),
      () => this.work.delete(p),
    );
    return p;
  }

  // -------------------------------------------------------------------------------------------
  // tracking
  // -------------------------------------------------------------------------------------------

  /** Starts watching a stored order (no-op when all its nonces are consumed). */
  private track(s: StoredOrder): Tracked | null {
    if (!reservationHeld(s.order)) return null;
    const existing = this.orders.get(s.order.id);
    if (existing) return existing;
    const t: Tracked = {
      userId: s.userId,
      order: s.order,
      state: s.triggerState,
      dryRun: s.dryRun,
      version: s.version,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      tail: Promise.resolve(),
      firing: false,
      stateDirty: false,
      statePersistedAt: this.now(),
      inFlight: null,
      lastHold: null,
      heldReportedAt: 0,
    };
    this.orders.set(s.order.id, t);
    addTo(this.byMint, s.order.mint, s.order.id);
    for (const a of s.order.attempts) addTo(this.byNonce, nonceKey(a.nonce.account, a.nonce.value), s.order.id);
    return t;
  }

  private untrack(t: Tracked): void {
    const id = t.order.id;
    if (this.orders.get(id) !== t) return;
    this.orders.delete(id);
    removeFrom(this.byMint, t.order.mint, id);
    for (const a of t.order.attempts) removeFrom(this.byNonce, nonceKey(a.nonce.account, a.nonce.value), id);
  }

  /** Orders the intake just stored: watch, publish, check staleness and evaluate right away. */
  admit(stored: readonly StoredOrder[]): Order[] {
    const views: Order[] = [];
    for (const s of stored) {
      const t = this.track(s);
      const view = orderView(s.order, s.triggerState, { createdAt: s.createdAt, updatedAt: s.updatedAt, dryRun: s.dryRun });
      views.push(view);
      if (!t) continue;
      this.d.publish(t.userId, { upsert: [view], remove: [] });
    }
    for (const s of stored) {
      const t = this.orders.get(s.order.id);
      if (!t) continue;
      this.checkOrderStaleness(t);
      this.evaluate(t, undefined, this.now());
    }
    return views;
  }

  /** Orders whose nonces are not all consumed, for one user (intake checks, limits). */
  openOrdersOf(userId: string): ArmedOrder[] {
    return [...this.orders.values()].filter((t) => t.userId === userId).map((t) => t.order);
  }

  /** Keeps the token in the market's memory while an order may trigger on it. */
  watches(mint: string): boolean {
    for (const id of this.byMint.get(mint) ?? []) {
      const t = this.orders.get(id);
      if (t && !isTerminalStatus(t.order.status)) return true;
    }
    return false;
  }

  get openCount(): number {
    return this.orders.size;
  }

  /** The policy intake validates against (DEFAULT_ARMED_SAFETY_POLICY shape, server values). */
  policy(): ArmedSafetyPolicy {
    const c = this.d.cfg;
    return {
      maxGridDepthBps: c.maxGridDepthBps,
      maxArmedNotionalLamports: c.maxNotionalLamports,
      maxBuyLamports: c.maxBuyLamports,
      maxTipLamports: c.maxTipLamports,
      maxPriorityFeeLamports: c.maxPriorityFeeLamports,
      maxVariantsPerNonce: c.maxVariantsPerNonce,
      maxBuyVariants: c.maxBuyVariants,
      maxAttempts: c.maxAttempts,
    };
  }

  /** Operator lookup tables (null until loaded from chain). */
  lookupTables(): AddressesByLookupTableAddress | null {
    return this.tables;
  }

  armedNotional(userId: string): bigint {
    return armedNotional(this.openOrdersOf(userId));
  }

  // -------------------------------------------------------------------------------------------
  // transitions
  // -------------------------------------------------------------------------------------------

  /** Runs `job` after every earlier job of the same order. */
  private run<T>(t: Tracked, job: () => Promise<T>): Promise<T> {
    const next = t.tail.then(job);
    t.tail = next.then(
      () => undefined,
      (e) => log.error(`order ${t.order.id}: ${errText(e)}`),
    );
    this.background(t.tail);
    return next;
  }

  /**
   * Applies one status-machine event: persist (with the events that explain it), publish, run effects.
   * Must run inside the order's queue. Returns false when the event changed nothing.
   */
  private async apply(t: Tracked, event: ArmedOrderEvent, extra: OrderEventWrite[] = []): Promise<boolean> {
    if (this.orders.get(t.order.id) !== t) return false;
    let res: { order: ArmedOrder; effects: ArmedOrderEffect[] };
    try {
      res = applyArmedOrderEvent(t.order, event);
    } catch (e) {
      if (e instanceof ArmedTransitionError) {
        log.warn(`order ${t.order.id}: ${e.message}`);
        return false;
      }
      throw e;
    }
    if (res.order === t.order && res.effects.length === 0) return false;
    const now = this.now();
    try {
      t.version = await this.d.repo.saveState(
        { userId: t.userId, order: res.order, triggerState: t.state, dryRun: t.dryRun, version: t.version, createdAt: t.createdAt },
        [describe(event, this.d.cfg), ...extra],
        now,
      );
    } catch (e) {
      // Cancels are the safety net (halt, staleness, misses): fire them even when the database is down.
      // The nonce monitor reconciles the order once its nonces advance.
      for (const eff of res.effects)
        if (eff.type === "fire-cancel") void this.background(this.fireCancel(t, eff.cancel, eff.nonce, "database unavailable"));
      throw e;
    }
    t.order = res.order;
    t.updatedAt = now;
    t.stateDirty = false;
    t.statePersistedAt = now;
    if (!t.order.attempts.some((a) => a.status === "submitted")) t.inFlight = null;
    this.publishView(t);
    for (const eff of res.effects) {
      if (eff.type === "fire-cancel") void this.background(this.fireCancel(t, eff.cancel, eff.nonce));
      else this.notifyUser(t, eff);
    }
    if (!reservationHeld(t.order)) this.untrack(t);
    return true;
  }

  private view(t: Tracked): Order {
    return orderView(t.order, t.state, { createdAt: t.createdAt, updatedAt: t.updatedAt, dryRun: t.dryRun });
  }

  private publishView(t: Tracked): void {
    try {
      this.d.publish(t.userId, { upsert: [this.view(t)], remove: [] });
    } catch (e) {
      log.warn(`publishing order ${t.order.id} failed: ${errText(e)}`);
    }
  }

  private notifyUser(t: Tracked, eff: Extract<ArmedOrderEffect, { type: "notify" }>): void {
    const o = t.order;
    try {
      this.d.notify({
        userId: t.userId,
        orderId: o.id,
        kind: o.kind,
        status: o.status,
        event: eff.kind,
        mint: o.mint,
        symbol: this.d.market.symbol(o.mint) ?? undefined,
        side: o.side,
        signature: o.attempts.find((a) => a.status === "landed-ok" || a.status === "landed-failed")?.consumedBy ?? null,
        detail: eff.message,
      });
    } catch (e) {
      log.warn(`order notification failed: ${errText(e)}`);
    }
  }

  private async fireCancel(t: Tracked, cancel: SignedTx, nonce: Address, why = "fired"): Promise<void> {
    const now = this.now();
    const last = this.cancelSentAt.get(cancel.signature);
    if (last !== undefined && now - last < CANCEL_DEDUPE_MS) return;
    this.cancelSentAt.set(cancel.signature, now);
    const report = await this.d.submitter.sendCancel(cancel);
    this.stats.cancelsSent++;
    if (!report.ok) log.warn(`order ${t.order.id}: cancel of nonce ${nonce} not accepted: ${report.error}`);
    await this.d.repo
      .appendEvents(
        t.order.id,
        t.order.status,
        [
          {
            type: "cancel-fired",
            message: `${report.dryRun ? "simulated" : "sent"} the pre-signed cancel of nonce ${short(nonce)} (${why})`,
            detail: { nonce, signature: cancel.signature, ...reportDetail(report) },
          },
        ],
        this.now(),
      )
      .catch((e) => log.warn(`order ${t.order.id}: cancel event not saved: ${errText(e)}`));
  }

  // -------------------------------------------------------------------------------------------
  // triggers
  // -------------------------------------------------------------------------------------------

  private halted(): boolean {
    return this.d.halt?.isHalted() === true;
  }

  private triggerPolicy(t: Tracked): TriggerPolicy {
    const floor = this.d.market.jitoTipFloorLamports();
    const policy: TriggerPolicy = { safetyMarginBps: this.d.cfg.safetyMarginBps };
    if (floor === null) return policy;
    // Prefer the cheapest tip level that pays at least the live landed-tip median.
    const levels = new Map<number, bigint>();
    for (const a of t.order.attempts) for (const v of a.variants) levels.set(v.tipLevel, v.tipLamports);
    const fit = [...levels.entries()].filter(([, tip]) => tip >= floor).sort((a, b) => a[0] - b[0])[0];
    return fit ? { ...policy, tipLevel: fit[0] } : { ...policy, tipLevel: Math.max(...levels.keys()) };
  }

  /** A nonce generation with an attempt in flight on any order (OCO partners share one). */
  private nonceBusy(key: string, except?: Tracked): boolean {
    for (const id of this.byNonce.get(key) ?? []) {
      const o = this.orders.get(id);
      if (!o) continue;
      if (o !== except && o.firing) return true;
      if (
        o.order.attempts.some(
          (a) => nonceKey(a.nonce.account, a.nonce.value) === key && (a.status === "submitted" || a.status === "cancelling"),
        )
      )
        return true;
    }
    return false;
  }

  /** Evaluates one order now. Synchronous (called from the ingest path); submissions are queued. */
  private evaluate(t: Tracked, events: readonly ArmedMarketEvent[] | undefined, nowMs: number): TriggerDecision | null {
    const o = t.order;
    if (o.status !== "armed" && !events?.length) return null;
    this.stats.evaluations++;
    const q = this.d.market.quote(o.mint);
    let live: bigint | null = null;
    if (q?.market) {
      try {
        live = liveQuoteOut(o.side, o.amount, q.market);
      } catch (e) {
        log.debug(`order ${o.id}: quote failed: ${errText(e)}`);
      }
    }
    const venue = q?.venue ?? (o.frozen.venues[0]?.venue as ArmedVariant["venue"]);
    let decision: TriggerDecision;
    try {
      decision = evaluateTrigger(
        o,
        t.state,
        { liveQuoteOut: live, venue, nowMs, ...(events?.length ? { events } : {}) },
        this.triggerPolicy(t),
      );
    } catch (e) {
      log.warn(`order ${o.id}: trigger evaluation failed: ${errText(e)}`);
      return null;
    }
    if (!sameState(decision.state, t.state)) {
      t.state = decision.state;
      t.stateDirty = true;
    }
    if (!decision.fire) {
      t.lastHold = decision.reason;
      return decision;
    }
    if (t.firing || this.halted()) return decision;
    const attempt = o.attempts[decision.attempt];
    if (!attempt || this.nonceBusy(nonceKey(attempt.nonce.account, attempt.nonce.value), t)) return decision;
    t.firing = true;
    const fire = decision as Extract<TriggerDecision, { fire: true }>;
    void this.run(t, async () => {
      try {
        await this.submit(t, fire);
      } finally {
        t.firing = false;
      }
    });
    return decision;
  }

  /** Ingest hook: called for every decoded transaction, after MarketState applied it. Never throws. */
  onIngestTx(tx: IngestTx): void {
    if (this.orders.size === 0) return;
    try {
      const events = new Map<string, ArmedMarketEvent[]>();
      const touched = new Set<string>();
      const baseMintOfPool = (p: string) => this.d.baseMintOfPool?.(p) as Address | undefined;
      for (const ev of tx.events) {
        const me = marketEventFromDecoded(ev, { slot: BigInt(tx.slot), baseMintOfPool });
        const mint = me?.mint ?? mintOfEvent(ev, baseMintOfPool);
        if (!mint || !this.byMint.has(mint)) continue;
        touched.add(mint);
        if (me) events.set(mint, [...(events.get(mint) ?? []), me]);
      }
      const now = this.now();
      for (const mint of touched) {
        for (const id of this.byMint.get(mint) ?? []) {
          const t = this.orders.get(id);
          if (t) this.evaluate(t, events.get(mint), now);
        }
      }
    } catch (e) {
      log.error(`orders ingest hook failed: ${errText(e)}`);
    }
  }

  /**
   * CopyExitHook (trackers/copy.ts): a copy-trade leader sold while no browser of the follower was
   * connected. The browser arms a copy position's tab-closed exit as a full-exit dev-sell-exit order on
   * the leader (trigger `dev-sell`, creator = the leader); on a FULL leader exit that order's sticky
   * flag is set and it is evaluated now, so it submits through the protected path like any trigger.
   * Partial leader sells return false: only full exits can be armed safely (never ladder partial sells).
   * Returns true when an exit was fired.
   */
  leaderSold(ev: Parameters<CopyExitHook["leaderSold"]>[0]): boolean {
    if (!ev.full) return false;
    let fired = false;
    const now = this.now();
    for (const id of this.byMint.get(ev.mint) ?? []) {
      const t = this.orders.get(id);
      const o = t?.order;
      if (!t || !o || t.userId !== ev.userId || o.status !== "armed" || o.side !== "sell" || !o.fullExit) continue;
      if (o.trigger.type !== "dev-sell" || o.trigger.creator !== ev.leader) continue;
      if (!t.state.devSold) {
        t.state = { ...t.state, devSold: true };
        t.stateDirty = true;
      }
      if (this.evaluate(t, undefined, now)?.fire && t.firing) fired = true;
    }
    return fired;
  }

  /** Re-evaluates every armed order (time triggers, quiet markets) and persists trigger states. */
  async sweep(): Promise<void> {
    const now = this.now();
    for (const t of [...this.orders.values()]) if (t.order.status === "armed") this.evaluate(t, undefined, now);
    // Intake needs the operator tables: retry soon while any has not loaded.
    if (!this.d.lookupTables && !this.tablesComplete && this.d.cfg.lookupTables.length && now >= this.tablesRetryAt) {
      void this.background(this.refreshLookupTables());
    }
    await this.flushStates(false);
  }

  private async flushStates(force: boolean): Promise<void> {
    const now = this.now();
    const jobs: Promise<void>[] = [];
    for (const t of this.orders.values()) {
      if (!t.stateDirty || (!force && now - t.statePersistedAt < this.d.cfg.statePersistMs)) continue;
      t.stateDirty = false;
      t.statePersistedAt = now;
      jobs.push(
        this.run(t, async () => {
          await this.d.repo.saveTriggerState({
            order: t.order,
            triggerState: t.state,
            dryRun: t.dryRun,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
          });
          if (t.order.trigger.type === "trailing") this.publishView(t);
        }).catch((e) => {
          t.stateDirty = true;
          log.warn(`order ${t.order.id}: trigger state not saved: ${errText(e)}`);
        }),
      );
    }
    await Promise.all(jobs);
  }

  // -------------------------------------------------------------------------------------------
  // submission
  // -------------------------------------------------------------------------------------------

  private async submit(t: Tracked, d: Extract<TriggerDecision, { fire: true }>): Promise<void> {
    if (this.orders.get(t.order.id) !== t || this.halted()) return;
    const attempt = t.order.attempts[d.attempt];
    if (t.order.status !== "armed" || attempt?.status !== "live" || !attempt.variants.some((v) => v.id === d.variant.id)) return;
    if (this.nonceBusy(nonceKey(attempt.nonce.account, attempt.nonce.value), t)) return;

    const balance = await this.checkBalance(t);
    if (balance.ok === false) {
      if (balance.definitive) {
        this.stats.stale++;
        await this.apply(t, { type: "stale", reason: balance.reason });
      } else await this.reportHold(t, balance.reason);
      return;
    }
    if (this.halted()) return;

    const slot = this.slot();
    const dry = this.d.submitter.dryRun;
    t.dryRun = t.dryRun || dry;
    const applied = await this.apply(
      t,
      { type: "submitted", attempt: d.attempt, variantId: d.variant.id, ...(slot !== null ? { slot: BigInt(slot) } : {}) },
      [
        {
          type: "submitted",
          message: `trigger fired: live quote out ${d.liveQuoteOut}, variant min-out ${d.variant.minOut}, tip ${d.variant.tipLamports}`,
          detail: { liveQuoteOut: d.liveQuoteOut, minOut: d.variant.minOut, tipLamports: d.variant.tipLamports, variantId: d.variant.id },
        },
      ],
    );
    if (!applied) return;
    this.stats.submissions++;
    const now = this.now();
    if (!dry) t.inFlight = { attempt: d.attempt, variantId: d.variant.id, wire: d.variant.tx.wireBase64, at: now, lastSentAt: now };
    const report = await this.d.submitter.sendVariant(d.variant.tx.wireBase64);
    if (dry) this.stats.simulated++;
    else if (!report.ok) this.stats.sendFailures++;
    await this.d.repo
      .appendEvents(
        t.order.id,
        t.order.status,
        [
          {
            type: dry ? "simulated" : report.ok ? "sent" : "send-failed",
            message: dry
              ? `DRY_RUN: simulated ${d.variant.id} instead of sending (${report.simulation ? (report.simulation.err ? `would fail: ${JSON.stringify(report.simulation.err)}` : `ok, ${report.simulation.unitsConsumed ?? "?"} CU`) : report.error})`
              : report.ok
                ? `sent ${d.variant.id} to ${report.lanes
                    .filter((l) => l.ok)
                    .map((l) => l.lane)
                    .join(", ")}`
                : `no lane accepted ${d.variant.id} (${report.error}); the cancel fires after the miss window`,
            detail: { variantId: d.variant.id, signature: d.variant.tx.signature, ...reportDetail(report) },
          },
        ],
        this.now(),
      )
      .catch((e) => log.warn(`order ${t.order.id}: send event not saved: ${errText(e)}`));
  }

  /**
   * Pre-submit balance check (SPEC: the wallet must still hold the SOL or tokens). Best effort: when the
   * read fails the order is submitted anyway (an unfired stop-loss is worse than a rare failed landing).
   */
  private async checkBalance(t: Tracked): Promise<{ ok: true } | { ok: false; reason: string; definitive: boolean }> {
    const o = t.order;
    try {
      const ata = await findAssociatedTokenAddress(o.wallet, o.mint, o.frozen.baseTokenProgram);
      const res = await withTimeout(this.d.chain.accounts([o.wallet, ata]), BALANCE_CHECK_TIMEOUT_MS);
      this.observeSlot(res.slot);
      const lamports = res.accounts[0]?.lamports ?? 0n;
      const tokens = tokenAmount(res.accounts[1] ?? null);
      if (o.side === "sell") {
        const f = classifyStaleness(detectStaleness(o, { walletTokenBalance: tokens })).stale;
        if (f) return { ok: false, reason: `${f.reason}: ${f.detail}`, definitive: true };
      }
      const r = hasReservedBalance(o, { lamports, tokens });
      return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? "insufficient balance", definitive: false };
    } catch (e) {
      log.warn(`order ${o.id}: balance check skipped (${errText(e)})`);
      return { ok: true };
    }
  }

  private async reportHold(t: Tracked, reason: string): Promise<void> {
    t.lastHold = reason;
    const now = this.now();
    if (now - t.heldReportedAt < HOLD_REPORT_MS) return;
    t.heldReportedAt = now;
    await this.d.repo
      .appendEvents(
        t.order.id,
        t.order.status,
        [{ type: "held", message: `trigger met but not submitted: ${reason}`, detail: { reason } }],
        now,
      )
      .catch(() => {});
    try {
      this.d.notify({
        userId: t.userId,
        orderId: t.order.id,
        kind: t.order.kind,
        status: t.order.status,
        event: "held",
        mint: t.order.mint,
        symbol: this.d.market.symbol(t.order.mint) ?? undefined,
        side: t.order.side,
        signature: null,
        detail: reason,
      });
    } catch {
      /* notification failures never block the engine */
    }
  }

  // -------------------------------------------------------------------------------------------
  // nonce monitor
  // -------------------------------------------------------------------------------------------

  private observeSlot(slot: number | null | undefined): void {
    if (typeof slot === "number" && Number.isFinite(slot) && (this.lastSlot === null || slot > this.lastSlot)) this.lastSlot = slot;
  }

  /** Best known current slot (ingest stream or the latest RPC context). */
  slot(): number | null {
    const a = this.d.market.slot();
    const b = this.lastSlot;
    if (a === null) return b;
    if (b === null) return a;
    return Math.max(a, b);
  }

  /**
   * One monitor pass. `hot`: nonces with an attempt submitted or cancelling (plus miss detection and
   * re-sends); `all`: every open nonce (foreign advances, closed slots).
   */
  async pollNonces(scope: "hot" | "all"): Promise<void> {
    const flag = scope === "hot" ? "hot" : "cold";
    if (this.busy[flag]) return;
    this.busy[flag] = true;
    try {
      const bound = new Map<string, { t: Tracked; a: ArmedOrder["attempts"][number] }[]>();
      for (const t of this.orders.values()) {
        for (const a of t.order.attempts) {
          if (!isAttemptOpen(a) || (scope === "hot" && a.status === "live")) continue;
          const list = bound.get(a.nonce.account) ?? [];
          list.push({ t, a });
          bound.set(a.nonce.account, list);
        }
      }
      if (bound.size === 0) return;
      const accounts = [...bound.keys()];
      let res: Awaited<ReturnType<ChainReader["accounts"]>>;
      try {
        res = await this.d.chain.accounts(accounts);
      } catch (e) {
        this.stats.pollErrors++;
        log.debug(`nonce poll failed: ${errText(e)}`);
        return;
      }
      this.observeSlot(res.slot);
      const now = this.now();
      const consumed = new Set<string>();
      const missing = new Set<string>();
      const unchanged = new Set<string>();
      accounts.forEach((account, i) => {
        const snap = nonceSnapshot(res.accounts[i] ?? null);
        this.recordSlotValue(account, snap, now);
        for (const { t, a } of bound.get(account) ?? []) {
          const key = nonceKey(a.nonce.account, a.nonce.value);
          if (!snap || snap.authority !== t.order.wallet) missing.add(key);
          else if (snap.value !== a.nonce.value) consumed.add(key);
          else unchanged.add(key);
        }
      });
      const jobs: Promise<void>[] = [];
      for (const key of consumed) jobs.push(this.resolve(key, false));
      for (const key of missing) jobs.push(this.resolve(key, true));
      await Promise.all(jobs);
      if (scope === "hot") {
        this.detectMisses(res.slot, now, unchanged);
        this.resend(now, unchanged);
      }
    } finally {
      this.busy[flag] = false;
    }
  }

  private recordSlotValue(account: string, snap: NonceSlotSnapshot | null, now: number): void {
    const value = snap?.value ?? null;
    if (this.lastNonceValue.get(account) === value && this.lastNonceValue.has(account)) return;
    this.lastNonceValue.set(account, value);
    void this.d.repo.observeSlot(account, { value, missing: snap === null, now }).catch(() => {});
  }

  /**
   * A nonce generation advanced (or its account vanished): find the consuming transaction and apply
   * `nonce-consumed` to every order bound to that generation.
   */
  private async resolve(key: string, missing: boolean): Promise<void> {
    const entry = this.resolving.get(key) ?? { since: this.now(), tries: 0, running: false };
    if (entry.running) return;
    entry.running = true;
    entry.tries++;
    this.resolving.set(key, entry);
    const [nonce, value] = splitKey(key);
    try {
      const ids = [...(this.byNonce.get(key) ?? [])];
      const bound = ids
        .map((id) => this.orders.get(id))
        .filter(
          (t): t is Tracked =>
            !!t && t.order.attempts.some((a) => a.nonce.account === nonce && a.nonce.value === value && isAttemptOpen(a)),
        );
      if (bound.length === 0) {
        this.resolving.delete(key);
        return;
      }
      const candidates = signaturesOnNonce(
        bound.map((t) => t.order),
        nonce as Address,
        value,
      );
      const statuses = await this.d.chain.signatureStatuses(candidates.map((c) => c.signature));
      let found: Consumer | null = null;
      for (const [i, c] of candidates.entries()) {
        const st = statuses[i] ?? null;
        if (isConfirmed(st)) {
          found = { signature: c.signature, success: st.err === null, slot: st.slot, owner: c.kind === "variant" ? c.orderId : undefined };
          break;
        }
      }
      if (!found) {
        const history = await this.d.chain.signaturesForAddress(nonce, 10).catch(() => []);
        const ours = history.find((h) => candidates.some((c) => c.signature === h.signature));
        if (ours) {
          const c = candidates.find((x) => x.signature === ours.signature);
          found = {
            signature: ours.signature,
            success: ours.err === null,
            slot: ours.slot,
            owner: c?.kind === "variant" ? c.orderId : undefined,
          };
        } else if (missing) {
          // Closed (or handed to another authority) without one of our transactions: the variants are dead.
          // Stale first (status, cancels of the order's other nonces, notification), then close the attempt:
          // no consumption will ever be seen on an account that no longer exists.
          this.resolving.delete(key);
          const reason = `nonce-missing: nonce ${short(nonce)} is gone or no longer controlled by the wallet`;
          await Promise.all(
            bound.map((t) =>
              this.run(t, async () => {
                this.stats.stale++;
                await this.apply(t, { type: "stale", reason });
                await this.apply(t, {
                  type: "nonce-consumed",
                  nonce: nonce as Address,
                  nonceValue: value,
                  signature: `closed:${nonce}`,
                  success: false,
                });
              }).catch(() => {}),
            ),
          );
          return;
        } else if (entry.tries >= FOREIGN_AFTER_TRIES && history[0]) {
          found = { signature: history[0].signature, success: history[0].err === null, slot: history[0].slot, owner: undefined };
        } else if (this.now() - entry.since >= FOREIGN_TIMEOUT_MS) {
          found = { signature: `unknown:${nonce}:${value}`, success: true, slot: null, owner: undefined };
        }
      }
      if (!found) return; // not visible yet: retry on the next poll
      const f: Consumer = found;
      this.resolving.delete(key);
      this.stats.nonceConsumed++;
      await Promise.all(
        bound.map((t) =>
          this.run(t, () =>
            this.apply(t, {
              type: "nonce-consumed",
              nonce: nonce as Address,
              nonceValue: value,
              signature: f.signature,
              success: f.success,
              ...(f.slot !== null ? { slot: BigInt(f.slot) } : {}),
              ...(f.owner && f.owner !== t.order.id ? { bySiblingOrderId: f.owner } : {}),
            }),
          ).catch(() => {}),
        ),
      );
    } catch (e) {
      log.debug(`resolving nonce ${short(nonce)} failed (retrying): ${errText(e)}`);
    } finally {
      entry.running = false;
    }
  }

  /** Submitted attempts whose nonce is still unchanged after the miss window: fire their cancel. */
  private detectMisses(readSlot: number, now: number, unchanged: Set<string>): void {
    const window = this.d.cfg.missSlots;
    for (const t of [...this.orders.values()]) {
      if (t.dryRun) continue; // a simulation never lands: nothing to cancel
      for (const a of t.order.attempts) {
        if (a.status !== "submitted" || !unchanged.has(nonceKey(a.nonce.account, a.nonce.value))) continue;
        const bySlot = a.submittedAtSlot !== undefined && BigInt(readSlot) >= a.submittedAtSlot + BigInt(window);
        const startedAt = t.inFlight?.attempt === a.index ? t.inFlight.at : t.updatedAt;
        const byTime = now - startedAt >= window * this.d.cfg.slotMs * 2;
        if (!bySlot && !byTime) continue;
        this.stats.missed++;
        void this.run(t, () => this.apply(t, { type: "submit-missed", attempt: a.index })).catch(() => {});
      }
    }
  }

  /** Re-sends in-window variants (protected lane) and fired cancels whose nonce has not advanced. */
  private resend(now: number, unchanged: Set<string>): void {
    if (this.d.submitter.dryRun) return;
    for (const t of this.orders.values()) {
      for (const a of t.order.attempts) {
        const key = nonceKey(a.nonce.account, a.nonce.value);
        if (!unchanged.has(key)) continue;
        if (a.status === "submitted" && t.inFlight?.attempt === a.index && now - t.inFlight.lastSentAt >= this.d.cfg.resendMs) {
          t.inFlight.lastSentAt = now;
          void this.background(this.d.submitter.sendVariant(t.inFlight.wire).catch(() => undefined));
        }
        if (a.status === "cancelling") {
          const last = this.cancelSentAt.get(a.nonce.cancel.signature) ?? 0;
          if (now - last >= this.d.cfg.cancelRetryMs)
            void this.background(this.fireCancel(t, a.nonce.cancel, a.nonce.account, "re-sent: the nonce has not advanced yet"));
        }
      }
    }
    if (this.cancelSentAt.size > 10_000) {
      for (const [sig, at] of this.cancelSentAt) if (now - at > 3_600_000) this.cancelSentAt.delete(sig);
    }
  }

  // -------------------------------------------------------------------------------------------
  // staleness
  // -------------------------------------------------------------------------------------------

  /**
   * Operator tables are read at FINALIZED commitment: Agave's scheduler resolves lookups against the
   * root bank, so entries added in the last ~32 slots make every transaction using them drop silently at
   * sanitization (measured on the mainnet fork). Intake only accepts contents transactions can use.
   */
  private async refreshLookupTables(): Promise<void> {
    const addrs = this.d.cfg.lookupTables;
    if (this.d.lookupTables || addrs.length === 0 || this.busy.tables) return;
    this.busy.tables = true;
    this.tablesRetryAt = this.now() + 5_000;
    try {
      const res = await this.d.chain.accounts(addrs, "finalized");
      const contents: AddressesByLookupTableAddress = {};
      const states: Record<string, LookupTableState | null> = {};
      addrs.forEach((a, i) => {
        const st = lookupTableState(res.accounts[i] ?? null);
        states[a] = st;
        if (st) contents[a as Address] = st.addresses;
      });
      this.tables = contents;
      this.tableStates = states;
      this.tablesComplete = addrs.every((a) => states[a]);
      if (!this.tablesComplete) log.warn(`operator lookup table(s) not found (finalized): ${addrs.filter((a) => !states[a]).join(", ")}`);
    } catch (e) {
      log.warn(`operator lookup tables not loaded: ${errText(e)}`);
    } finally {
      this.busy.tables = false;
    }
  }

  private checkOrderStaleness(t: Tracked): void {
    const o = t.order;
    if (isTerminalStatus(o.status)) return;
    const findings = detectStaleness(o, {
      ...this.d.market.coinFacts(o.mint),
      ...this.d.market.recipients(),
      interfaceVersion: this.d.interfaceVersion?.() ?? currentInterfaceVersion(),
      ...(this.tableStates ? { lookupTables: this.tableStates as Record<Address, LookupTableState | null> } : {}),
      ...(this.slot() !== null ? { currentSlot: BigInt(this.slot() as number) } : {}),
    });
    const { stale, flags } = classifyStaleness(findings);
    if (stale) {
      this.stats.stale++;
      void this.run(t, () => this.apply(t, { type: "stale", reason: `${stale.reason}: ${stale.detail}` })).catch(() => {});
      return;
    }
    for (const f of flags) {
      if (o.flags?.includes(f.reason)) continue;
      void this.run(t, () =>
        this.apply(t, { type: "flag", reason: f.reason }, [{ type: "flag", message: f.detail, detail: { finding: f.reason } }]),
      ).catch(() => {});
    }
  }

  async checkStaleness(): Promise<void> {
    if (this.busy.stale) return;
    this.busy.stale = true;
    try {
      for (const t of [...this.orders.values()]) this.checkOrderStaleness(t);
      await Promise.allSettled([...this.orders.values()].map((t) => t.tail));
    } finally {
      this.busy.stale = false;
    }
  }

  // -------------------------------------------------------------------------------------------
  // cancels, Panic, halt
  // -------------------------------------------------------------------------------------------

  /** Orders of the same user sharing an open nonce generation with `t` (OCO partners), `t` first. */
  private group(t: Tracked): Tracked[] {
    const out = new Set<Tracked>([t]);
    for (const a of t.order.attempts) {
      if (!isAttemptOpen(a)) continue;
      for (const id of this.byNonce.get(nonceKey(a.nonce.account, a.nonce.value)) ?? []) {
        const o = this.orders.get(id);
        if (o && o.userId === t.userId) out.add(o);
      }
    }
    return [...out];
  }

  /**
   * User cancel: fires the order's pre-signed cancel(s). OCO partners share the nonce, so they are
   * cancelled with it. Null when the user has no such open order.
   */
  async cancel(userId: string, id: string): Promise<Order[] | null> {
    const t = this.orders.get(id);
    if (!t || t.userId !== userId) return null;
    const group = this.group(t);
    await Promise.all(
      group.map((g) =>
        this.run(g, () =>
          this.apply(g, { type: "cancel-requested", reason: g === t ? "cancelled by the user" : `cancelled with its OCO partner ${id}` }),
        ),
      ),
    );
    return group.map((g) => this.view(g));
  }

  /** Panic: cancels every open order of the user. */
  async panic(userId: string): Promise<{ cancelled: number; orders: Order[] }> {
    const targets = [...this.orders.values()].filter((t) => t.userId === userId);
    const before = new Map(targets.map((t) => [t, t.order.status]));
    await Promise.allSettled(targets.map((t) => this.run(t, () => this.apply(t, { type: "cancel-requested", reason: "panic" }))));
    const cancelled = targets.filter(
      (t) => !isTerminalStatus(before.get(t) as ArmedOrder["status"]) && t.order.status === "cancelled",
    ).length;
    return { cancelled, orders: targets.map((t) => this.view(t)) };
  }

  /** Admin kill switch: no more submissions (evaluate/submit check the halt) and every stored cancel fires. */
  async haltAll(reason: string | null): Promise<number> {
    const targets = [...this.orders.values()];
    log.warn(`HALT: firing the cancels of ${targets.length} armed orders`);
    await Promise.allSettled(
      targets.map((t) =>
        this.run(t, () => this.apply(t, { type: "cancel-requested", reason: `admin halt${reason ? `: ${reason}` : ""}` })),
      ),
    );
    return targets.length;
  }
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function addTo(map: Map<string, Set<string>>, key: string, id: string): void {
  const set = map.get(key) ?? new Set<string>();
  set.add(id);
  map.set(key, set);
}

function removeFrom(map: Map<string, Set<string>>, key: string, id: string): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(id);
  if (!set.size) map.delete(key);
}

/** The coin an ingested event is about (PumpSwap swaps name the pool). */
function mintOfEvent(ev: IngestTx["events"][number], baseMintOfPool: (pool: string) => string | undefined): string | undefined {
  switch (ev.kind) {
    case "pumpCreate":
    case "pumpTrade":
    case "pumpComplete":
    case "pumpMigrate":
      return ev.mint;
    case "ammCreatePool":
      return ev.baseMint;
    case "ammBuy":
    case "ammSell":
      return baseMintOfPool(ev.pool);
  }
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf(":");
  return [key.slice(0, i), key.slice(i + 1)];
}

function sameState(a: TriggerState, b: TriggerState): boolean {
  return a.highWater === b.highWater && a.migrated === b.migrated && a.devSold === b.devSold;
}

function short(s: string): string {
  return s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function reportDetail(r: SendReport): Record<string, unknown> {
  return {
    dryRun: r.dryRun,
    ok: r.ok,
    lanes: r.lanes,
    ...(r.simulation
      ? {
          simulation: {
            err: r.simulation.err,
            unitsConsumed: r.simulation.unitsConsumed,
            slot: r.simulation.slot,
            logs: r.simulation.logs.slice(-20),
          },
        }
      : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_r, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    }),
  ]);
}

/** The history record of a status-machine event. */
function describe(e: ArmedOrderEvent, cfg: OrdersConfig): OrderEventWrite {
  switch (e.type) {
    case "submitted":
      return {
        type: "submitted",
        message: `submitted ${e.variantId}`,
        detail: { attempt: e.attempt, variantId: e.variantId, slot: e.slot ?? null },
      };
    case "nonce-consumed":
      return {
        type: "nonce-consumed",
        message: `nonce ${short(e.nonce)} consumed by ${short(e.signature)} (${e.success ? "executed" : "failed"})${e.bySiblingOrderId ? `, OCO partner ${e.bySiblingOrderId}` : ""}`,
        detail: {
          nonce: e.nonce,
          nonceValue: e.nonceValue,
          signature: e.signature,
          success: e.success,
          slot: e.slot ?? null,
          bySiblingOrderId: e.bySiblingOrderId ?? null,
        },
      };
    case "submit-missed":
      return {
        type: "submit-missed",
        message: `attempt ${e.attempt} did not land within ${cfg.missSlots} slots: firing its cancel`,
        detail: { attempt: e.attempt },
      };
    case "cancel-requested":
      return { type: "cancel-requested", message: e.reason, detail: {} };
    case "stale":
      return { type: "stale", message: e.reason, detail: {} };
    case "flag":
      return { type: "flag", message: e.reason, detail: {} };
  }
}
