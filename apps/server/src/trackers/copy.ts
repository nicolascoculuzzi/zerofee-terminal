/**
 * Copy trading (SPEC Phase 8, research notes section 4): evaluate each leader trade against the
 * followers' tasks and push vetted, expiring signals to their browsers. The server never holds keys and
 * never builds or sends a copy trade: the browser builds it from `tradectx:<mint>`, its signer firewall
 * checks it, the trading wallet signs it, and the browser reports the outcome.
 *
 * Leader buy -> for every active task on that leader, in order (first failure = skip reason):
 *   blacklists (task + account token/dev lists) -> tradable (curve complete = migrating) -> exclude
 *   bonding curve -> Token-2022 danger flags -> only first buy -> token age -> market cap -> liquidity ->
 *   leader size -> buys per token / open positions -> drift guard -> sizing (fixed or % of leader,
 *   capped per buy and by the account's maxTradeSol) -> caps (task daily buy count, task lifetime and
 *   daily spend, the account's maxDailySol across tasks; a buy shrinks to fit, or skips below the
 *   minimum) -> per-leader cap on copy volume per slot across all followers (pro rata when exceeded).
 *
 * Leader sell -> pending copy buys of that token are revoked ("leader_sold"); with copySells on and a
 * copy position open, a sell signal for the same fraction the leader sold (leader balance from gRPC
 * balances, the holder book, or the tracked trades; unknown = full exit). Pause stops new buys only:
 * sells and TP / SL keep protecting open positions.
 *
 * TP / SL: checked on every price change of a token with an open copy position; a hit pushes a full
 * exit signal. That needs the browser open. For tab-closed exits the browser should arm pre-signed
 * sells after a copy buy fills (SPEC "Armed orders": copy-trade sells after the buy fills), and
 * CopyExitHook lets the armed-orders engine fire a full exit when the leader leaves while no browser
 * of the follower is connected.
 *
 * Spend accounting: a pending buy reserves its size against every cap; the reservation is replaced by
 * the reported fill (executed) or released (failed, declined, expired, revoked). Fills reported by the
 * browser are cross-checked against the feed: when the follower's transaction shows up, the signal is
 * marked confirmed and the chain amounts replace the reported ones.
 */
import {
  COPY_LIMITS,
  type CopyPosition,
  type CopySellTrigger,
  type CopySignal,
  type CopySignalResult,
  type CopySkipReason,
  type CopyTask,
  type CopyTaskConfig,
  type CopyTaskStatus,
  DEFAULT_USER_SETTINGS,
  type Trade,
} from "@zerofee/protocol";
import type { UserStore } from "../db/pg";
import { logger } from "../log";
import { BoundedSet, LruMap } from "../util/lru";
import { type CopyRepo, type CopyTaskRow, emptyStats, type StoredPosition, type StoredStats } from "./copyRepo";
import type { Publisher } from "./feed";
import type { BalanceView } from "./positions";

const log = logger("copy");
const DAY_MS = 86_400_000;
const dayOf = (t: number): number => Math.floor(t / DAY_MS);
const round9 = (v: number): number => Math.round(v * 1e9) / 1e9;
const max0 = (v: bigint): bigint => (v < 0n ? 0n : v);

export const copyTopic = (userId: string): string => `copy@${userId}`;

/** What the engine reads about a token at evaluation time (from MarketState). */
export interface TokenView {
  mint: string;
  symbol: string;
  decimals: number;
  venue: "pump" | "pumpswap";
  priceSol: number;
  mcSol: number;
  mcUsd: number | null;
  liquiditySol: number;
  liquidityUsd: number | null;
  createdAt: number | null;
  creator: string | null;
  /** Still on the pump.fun bonding curve. */
  onCurve: boolean;
  /** Curve completed but not migrated yet: not tradable. */
  curveComplete: boolean;
  /** Token-2022 danger extensions. */
  dangerous: boolean;
}

/** A trade by a copy-task leader (the leader is the trade's own wallet). */
export interface LeaderTrade {
  leader: string;
  trade: Trade;
  balance: BalanceView;
  firstBuy: boolean | null;
}

/** Armed-orders seam for tab-closed copy exits (wired by the orders engine; optional). */
export interface CopyExitHook {
  /**
   * The leader sold while no browser of the follower was connected. Return true when a pre-signed exit
   * armed for this task and token was submitted. Only full exits can be armed safely (SPEC: never
   * ladder partial sells across nonces), so `full` says whether the leader left the token entirely.
   */
  leaderSold(ev: {
    userId: string;
    taskId: string;
    mint: string;
    leader: string;
    leaderSignature: string;
    fraction: number;
    full: boolean;
  }): boolean;
}

export interface CopyLimits {
  /** Copy volume per leader per slot across all followers (SOL). */
  leaderSlotCapSol: number;
  buyTtlMs: number;
  sellTtlMs: number;
  /** Smallest copy buy (SOL); smaller sizes are skipped. */
  minSol: number;
  /** Skipped-trade log rows per task per hour (counters always count). */
  skipLogPerHour: number;
  /** After an exit signal expires or is declined, wait this long before raising another (ms). */
  exitCooldownMs: number;
}

export interface CopyEngineOptions {
  repo: CopyRepo;
  store: UserStore;
  now: () => number;
  token: (mint: string) => TokenView | null;
  /** Recent trades of a token (confirms a reported fill that already went by). */
  recentTrades?: (mint: string) => readonly Trade[];
  limits: CopyLimits;
  exits?: CopyExitHook | null;
  /** The user's set of copied leaders changed (the matcher's index). */
  onLeadersChanged: (userId: string, leaders: string[]) => void;
}

interface PositionRt {
  mint: string;
  symbol: string;
  decimals: number;
  tokens: bigint;
  costSol: number;
  /** Copied buys this position cycle: executed plus pending. */
  buys: number;
  pendingBuys: number;
  pendingSellTokens: bigint;
  openedAt: number;
  realizedPnlSol: number;
  leaderTokens: bigint | null;
  exitSignalId: string | null;
  exitCooldownUntil: number;
}

interface TaskRt {
  id: string;
  userId: string;
  leader: string;
  label: string;
  status: CopyTaskStatus;
  pausedReason: string | null;
  config: CopyTaskConfig;
  createdAt: number;
  updatedAt: number;
  stats: StoredStats;
  spentSol: number;
  day: number;
  spentTodaySol: number;
  buysToday: number;
  positions: Map<string, PositionRt>;
  skipTokens: number;
  skipLast: number;
  statsDirty: boolean;
  stateDirty: boolean;
}

interface UserRt {
  day: number;
  spentToday: number;
  maxTradeSol: number;
  maxDailySol: number;
  blTokens: Set<string>;
  blDevs: Set<string>;
}

interface SignalRt {
  wire: CopySignal;
  task: TaskRt;
  /** Buy reservation still counted against the caps. */
  reserve: number;
  /** Day the reservation was counted in. */
  day: number;
  sellTokens: bigint;
  write: Promise<void>;
  /** A booked sell fill (undone when chain data corrects the report). */
  booked?: { sold: bigint; cost: number; realized: number };
}

export type ReportOutcome = { ok: true; signal: CopySignal } | { ok: false; status: 404 | 409 | 400; message: string };

/** Leader's average fill price in SOL per whole token, or null. */
export function leaderFillPrice(t: Trade, decimals: number): number | null {
  const tokens = Number(t.tokenAmount) / 10 ** decimals;
  if (!(tokens > 0) || !(t.amountSol > 0)) return null;
  return t.amountSol / tokens;
}

function ratio(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 1;
  return Number((part * 1_000_000_000n) / whole) / 1e9;
}

export class CopyEngine {
  private readonly tasks = new Map<string, TaskRt>();
  private readonly byLeader = new Map<string, TaskRt[]>();
  private readonly byUser = new Map<string, TaskRt[]>();
  private readonly byMint = new Map<string, Set<TaskRt>>();
  private readonly users = new Map<string, UserRt>();
  private readonly pending = new Map<string, SignalRt>();
  /** Resolved signals kept for late reports (a fill after expiry / revocation). */
  private readonly recent = new LruMap<string, SignalRt>(20_000);
  private readonly seen = new BoundedSet<string>(200_000);
  private readonly slotKeys = new Map<number, string[]>();
  private readonly leaderSlot = new Map<string, { slot: number; used: number }>();
  /** Follower signatures waiting for the feed to confirm them -> signal id. */
  private readonly sigWatch = new LruMap<string, string>(20_000);
  private readonly skipQueue = new Map<string, CopySignal[]>();
  private readonly inflight = new Set<Promise<void>>();
  /** Tasks whose stats changed since the last sweep (published there, off the signal's hot path). */
  private readonly dirtyTasks = new Set<TaskRt>();
  private hub: Publisher | null = null;
  readonly stats = { evaluations: 0, buySignals: 0, sellSignals: 0, skipped: 0, revoked: 0, expired: 0, confirmed: 0, writeErrors: 0 };

  constructor(private readonly o: CopyEngineOptions) {}

  attach(hub: Publisher): void {
    this.hub = hub;
  }

  get taskCount(): number {
    return this.tasks.size;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Leaders of every task (the matcher indexes them). */
  leadersOf(userId: string): string[] {
    return (this.byUser.get(userId) ?? []).map((t) => t.leader);
  }

  /** True while a copy position is open on the mint (keeps the token in memory for TP / SL). */
  watchesMint(mint: string): boolean {
    return this.byMint.has(mint);
  }

  // -------------------------------------------------------------------------------------------
  // loading and task lifecycle
  // -------------------------------------------------------------------------------------------

  /** Loads every task, their spend and positions, and the owners' caps and blacklists. */
  async load(): Promise<void> {
    const now = this.o.now();
    const expired = await this.o.repo.expirePending(now);
    const rows = await this.o.repo.listTasks();
    const spend = await this.o.repo.spend(dayOf(now) * DAY_MS);
    for (const row of rows) this.addTask(row, spend.get(row.id));
    for (const userId of this.byUser.keys()) {
      await this.loadUser(userId);
      this.o.onLeadersChanged(userId, this.leadersOf(userId));
    }
    log.info(
      `copy trading: ${this.tasks.size} tasks for ${this.byUser.size} users${expired ? `, ${expired} stale pending signals expired` : ""}`,
    );
  }

  private addTask(row: CopyTaskRow, spend?: { spentSol: number; spentTodaySol: number; buysToday: number }): TaskRt {
    const now = this.o.now();
    const t: TaskRt = {
      id: row.id,
      userId: row.userId,
      leader: row.leader,
      label: row.label,
      status: row.status,
      pausedReason: row.pausedReason,
      config: row.config,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      stats: row.stats,
      spentSol: spend?.spentSol ?? 0,
      day: dayOf(now),
      spentTodaySol: spend?.spentTodaySol ?? 0,
      buysToday: spend?.buysToday ?? 0,
      positions: new Map(),
      skipTokens: Math.min(20, this.o.limits.skipLogPerHour),
      skipLast: now,
      statsDirty: false,
      stateDirty: false,
    };
    for (const p of row.state.positions) {
      const pos: PositionRt = {
        mint: p.mint,
        symbol: p.symbol,
        decimals: this.o.token(p.mint)?.decimals ?? 6,
        tokens: BigInt(p.tokens),
        costSol: p.costSol,
        buys: p.buys,
        pendingBuys: 0,
        pendingSellTokens: 0n,
        openedAt: p.openedAt,
        realizedPnlSol: p.realizedPnlSol,
        leaderTokens: p.leaderTokens === null ? null : BigInt(p.leaderTokens),
        exitSignalId: null,
        exitCooldownUntil: 0,
      };
      if (pos.tokens > 0n) this.putPosition(t, pos);
    }
    this.tasks.set(t.id, t);
    this.listAdd(this.byLeader, t.leader, t);
    this.listAdd(this.byUser, t.userId, t);
    const user = this.users.get(t.userId);
    if (user) user.spentToday += t.spentTodaySol;
    return t;
  }

  private listAdd(map: Map<string, TaskRt[]>, key: string, t: TaskRt): void {
    const list = map.get(key);
    if (list) list.push(t);
    else map.set(key, [t]);
  }

  private listRemove(map: Map<string, TaskRt[]>, key: string, t: TaskRt): void {
    const list = map.get(key);
    if (!list) return;
    const next = list.filter((x) => x !== t);
    if (next.length) map.set(key, next);
    else map.delete(key);
  }

  /** (Re)loads an account's caps (settings) and blacklists. */
  async loadUser(userId: string): Promise<void> {
    const [settings, blacklists] = await Promise.all([this.o.store.prefs.getSettings(userId), this.o.store.prefs.listBlacklists(userId)]);
    const s = (settings ?? {}) as { maxTradeSol?: number; maxDailySol?: number };
    const now = this.o.now();
    const prev = this.users.get(userId);
    const today = (this.byUser.get(userId) ?? []).reduce((sum, t) => sum + (t.day === dayOf(now) ? t.spentTodaySol : 0), 0);
    this.users.set(userId, {
      day: dayOf(now),
      spentToday: prev && prev.day === dayOf(now) ? prev.spentToday : today,
      maxTradeSol: typeof s.maxTradeSol === "number" ? s.maxTradeSol : DEFAULT_USER_SETTINGS.maxTradeSol,
      maxDailySol: typeof s.maxDailySol === "number" ? s.maxDailySol : DEFAULT_USER_SETTINGS.maxDailySol,
      blTokens: new Set(blacklists.filter((b) => b.kind === "token").map((b) => b.value)),
      blDevs: new Set(blacklists.filter((b) => b.kind === "dev").map((b) => b.value)),
    });
  }

  /** Settings changed (maxTradeSol / maxDailySol). */
  setUserCaps(userId: string, caps: { maxTradeSol: number; maxDailySol: number }): void {
    const u = this.users.get(userId);
    if (!u) return;
    u.maxTradeSol = caps.maxTradeSol;
    u.maxDailySol = caps.maxDailySol;
  }

  private userRt(userId: string): UserRt {
    let u = this.users.get(userId);
    if (!u) {
      // Not loaded yet (a task created a moment ago): defaults until loadUser lands, blacklists empty.
      u = {
        day: dayOf(this.o.now()),
        spentToday: 0,
        maxTradeSol: DEFAULT_USER_SETTINGS.maxTradeSol,
        maxDailySol: DEFAULT_USER_SETTINGS.maxDailySol,
        blTokens: new Set(),
        blDevs: new Set(),
      };
      this.users.set(userId, u);
    }
    return u;
  }

  async createTask(
    userId: string,
    t: { leader: string; label: string; status: CopyTaskStatus; config: CopyTaskConfig },
  ): Promise<CopyTask> {
    const row = await this.o.repo.createTask(userId, t, this.o.now(), COPY_LIMITS.tasksPerUser);
    if (!this.users.has(userId)) await this.loadUser(userId);
    const rt = this.addTask(row);
    this.o.onLeadersChanged(userId, this.leadersOf(userId));
    const wire = this.taskWire(rt);
    this.publish(userId, { tasks: [wire] });
    return wire;
  }

  /** The user's task, or null (unknown or someone else's). */
  private own(userId: string, id: string): TaskRt | null {
    const t = this.tasks.get(id);
    return t && t.userId === userId ? t : null;
  }

  getTask(userId: string, id: string): CopyTask | null {
    const t = this.own(userId, id);
    return t ? this.taskWire(t) : null;
  }

  listTasks(userId: string): CopyTask[] {
    return (this.byUser.get(userId) ?? []).map((t) => this.taskWire(t));
  }

  async updateTask(userId: string, id: string, patch: { label?: string; config?: CopyTaskConfig }): Promise<CopyTask | null> {
    const t = this.own(userId, id);
    if (!t) return null;
    const row = await this.o.repo.updateTask(userId, id, patch, this.o.now());
    if (!row) return null;
    t.label = row.label;
    t.config = row.config;
    t.updatedAt = row.updatedAt;
    const wire = this.taskWire(t);
    this.publish(userId, { tasks: [wire] });
    return wire;
  }

  async setStatus(userId: string, id: string, status: CopyTaskStatus): Promise<CopyTask | null> {
    const t = this.own(userId, id);
    if (!t) return null;
    const row = await this.o.repo.updateTask(userId, id, { status, pausedReason: status === "paused" ? "user" : null }, this.o.now());
    if (!row) return null;
    t.status = row.status;
    t.pausedReason = row.pausedReason;
    t.updatedAt = row.updatedAt;
    if (status === "paused") {
      for (const s of [...this.pending.values()]) if (s.task === t && s.wire.side === "buy") this.resolve(s, "revoked", "task_paused");
    }
    const wire = this.taskWire(t);
    this.publish(userId, { tasks: [wire] });
    return wire;
  }

  async deleteTask(userId: string, id: string): Promise<boolean> {
    const t = this.own(userId, id);
    if (!t) return false;
    for (const s of [...this.pending.values()]) if (s.task === t) this.resolve(s, "revoked", "task_deleted");
    // Queued signal writes finish before the row (and its signals, by cascade) goes.
    await Promise.allSettled([...this.inflight]);
    if (!(await this.o.repo.deleteTask(userId, id))) return false;
    this.tasks.delete(id);
    this.listRemove(this.byLeader, t.leader, t);
    this.listRemove(this.byUser, t.userId, t);
    for (const mint of t.positions.keys()) this.byMint.get(mint)?.delete(t);
    for (const [mint, set] of this.byMint) if (!set.size) this.byMint.delete(mint);
    this.o.onLeadersChanged(userId, this.leadersOf(userId));
    this.publish(userId, { removedTasks: [id] });
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // leader trades
  // -------------------------------------------------------------------------------------------

  /** True when someone copies this wallet. */
  isLeader(address: string): boolean {
    return this.byLeader.has(address);
  }

  onLeaderTrade(ev: LeaderTrade): void {
    const tasks = this.byLeader.get(ev.leader);
    if (!tasks?.length) return;
    this.stats.evaluations++;
    const now = this.o.now();
    if (ev.trade.side === "sell") {
      for (const t of tasks) this.onLeaderSell(t, ev, now);
      return;
    }
    const token = this.o.token(ev.trade.mint);
    const amount = BigInt(ev.trade.tokenAmount);
    const wanted: { task: TaskRt; size: number; user: UserRt }[] = [];
    for (const task of tasks) {
      if (!this.remember(`${task.id}:${ev.trade.signature}:${ev.trade.mint}:buy`, ev.trade.slot)) continue; // duplicate delivery
      const pos = task.positions.get(ev.trade.mint);
      if (pos) pos.leaderTokens = ev.balance.after ?? (pos.leaderTokens ?? 0n) + amount;
      if (task.status !== "active") continue;
      const r = this.evaluateBuy(task, ev, token, now);
      if ("skip" in r) this.skip(task, ev, token, r.skip, now);
      else wanted.push({ task, size: r.size, user: r.user });
    }
    if (!wanted.length || !token) return;
    // SPEC "Limits": per-leader cap on copy volume per slot, shared pro rata by the followers.
    let ls = this.leaderSlot.get(ev.leader);
    if (!ls || ls.slot !== ev.trade.slot) {
      ls = { slot: ev.trade.slot, used: 0 };
      this.leaderSlot.set(ev.leader, ls);
      if (this.leaderSlot.size > 50_000) this.leaderSlot.delete(this.leaderSlot.keys().next().value as string);
    }
    const budget = Math.max(0, this.o.limits.leaderSlotCapSol - ls.used);
    const total = wanted.reduce((s, w) => s + w.size, 0);
    const f = total > budget ? budget / total : 1;
    for (const w of wanted) {
      const size = round9(w.size * f);
      if (size < this.o.limits.minSol) {
        this.skip(w.task, ev, token, "leader_slot_cap", now);
        continue;
      }
      ls.used += size;
      this.emitBuy(w.task, w.user, ev, token, size, now);
    }
  }

  /** Dedupe key for one leader event; returns false when already seen. */
  private remember(key: string, slot: number): boolean {
    if (!this.seen.add(key)) return false;
    let list = this.slotKeys.get(slot);
    if (!list) {
      list = [];
      this.slotKeys.set(slot, list);
      if (this.slotKeys.size > 1_000) this.slotKeys.delete(this.slotKeys.keys().next().value as number);
    }
    list.push(key);
    return true;
  }

  private rollDay(task: TaskRt, user: UserRt, now: number): void {
    const d = dayOf(now);
    if (task.day !== d) {
      task.day = d;
      task.spentTodaySol = 0;
      task.buysToday = 0;
    }
    if (user.day !== d) {
      user.day = d;
      user.spentToday = 0;
    }
  }

  private evaluateBuy(
    task: TaskRt,
    ev: LeaderTrade,
    token: TokenView | null,
    now: number,
  ): { size: number; user: UserRt } | { skip: CopySkipReason } {
    const c = task.config;
    const t = ev.trade;
    const user = this.userRt(task.userId);
    if (!token) return { skip: "token_unknown" };
    if (c.blacklist.mints.includes(t.mint) || user.blTokens.has(t.mint)) return { skip: "blacklisted_token" };
    if (token.creator && (c.blacklist.devs.includes(token.creator) || user.blDevs.has(token.creator))) return { skip: "blacklisted_dev" };
    if (token.curveComplete) return { skip: "curve_complete" };
    if (c.excludeBondingCurve && token.onCurve) return { skip: "bonding_curve_excluded" };
    if (c.skipDangerousTokens && token.dangerous) return { skip: "token_danger" };
    if (c.onlyFirstBuy && ev.firstBuy === false) return { skip: "not_first_buy" };
    const age = token.createdAt === null ? null : (now - token.createdAt) / 1000;
    if (c.ageSec.min !== null && age !== null && age < c.ageSec.min) return { skip: "token_too_young" };
    if (c.ageSec.max !== null && (age === null || age > c.ageSec.max)) return { skip: "token_too_old" };
    const mc = c.mc.currency === "usd" ? token.mcUsd : token.mcSol;
    const liq = c.liquidity.currency === "usd" ? token.liquidityUsd : token.liquiditySol;
    if ((c.mc.min !== null || c.mc.max !== null) && mc === null) return { skip: "usd_price_unavailable" };
    if (mc !== null && c.mc.min !== null && mc < c.mc.min) return { skip: "mc_below_min" };
    if (mc !== null && c.mc.max !== null && mc > c.mc.max) return { skip: "mc_above_max" };
    if ((c.liquidity.min !== null || c.liquidity.max !== null) && liq === null) return { skip: "usd_price_unavailable" };
    if (liq !== null && c.liquidity.min !== null && liq < c.liquidity.min) return { skip: "liquidity_below_min" };
    if (liq !== null && c.liquidity.max !== null && liq > c.liquidity.max) return { skip: "liquidity_above_max" };
    if (c.leaderSol.min !== null && t.amountSol < c.leaderSol.min) return { skip: "leader_size_below_min" };
    if (c.leaderSol.max !== null && t.amountSol > c.leaderSol.max) return { skip: "leader_size_above_max" };
    const pos = task.positions.get(t.mint);
    if (pos && pos.buys >= c.maxBuysPerToken) return { skip: "max_buys_per_token" };
    if (!pos && task.positions.size >= COPY_LIMITS.positionsPerTask) return { skip: "max_positions" };
    const fill = leaderFillPrice(t, token.decimals);
    if (fill === null || !(token.priceSol > 0)) return { skip: "price_unknown" };
    if ((token.priceSol / fill - 1) * 100 > c.maxDriftPct) return { skip: "price_drift" };
    let size = c.sizing.mode === "fixed" ? c.sizing.sol : (t.amountSol * c.sizing.pct) / 100;
    size = Math.min(size, c.maxPerBuySol, user.maxTradeSol);
    this.rollDay(task, user, now);
    if (task.buysToday >= c.dailyBuyLimit) return { skip: "daily_buy_limit" };
    let limitedBy: CopySkipReason | null = null;
    const rooms: [number, CopySkipReason][] = [
      [c.totalSpendLimitSol - task.spentSol, "total_limit"],
      [c.dailySpendLimitSol - task.spentTodaySol, "daily_limit"],
      [user.maxDailySol - user.spentToday, "user_daily_limit"],
    ];
    for (const [room, why] of rooms) {
      if (size > room) {
        size = room;
        limitedBy = why;
      }
    }
    if (!(size >= this.o.limits.minSol)) return { skip: limitedBy ?? "size_below_minimum" };
    return { size: round9(size), user };
  }

  private baseSignal(task: TaskRt, side: "buy" | "sell", mint: string, token: TokenView | null, now: number): CopySignal {
    return {
      id: crypto.randomUUID(),
      taskId: task.id,
      side,
      status: "pending",
      reason: null,
      mint,
      symbol: token?.symbol ?? "",
      venue: token?.venue ?? "pump",
      leader: task.leader,
      leaderSignature: "",
      leaderSlot: 0,
      leaderSol: 0,
      leaderTokenAmount: "0",
      leaderPriceSol: null,
      priceSol: token?.priceSol ?? 0,
      mcSol: token?.mcSol ?? 0,
      mcUsd: token?.mcUsd ?? null,
      sizeSol: null,
      maxPriceSol: null,
      slippageBps: task.config.slippageBps,
      preset: task.config.preset,
      takeProfitPct: null,
      stopLossPct: null,
      trigger: null,
      sellFraction: null,
      sellTokenAmount: null,
      fractionSource: null,
      delivered: false,
      createdAt: now,
      expiresAt: null,
      resolvedAt: null,
      signature: null,
      filledSol: null,
      filledTokens: null,
      confirmed: false,
    };
  }

  private withLeader(s: CopySignal, t: Trade, decimals: number): CopySignal {
    s.leaderSignature = t.signature;
    s.leaderSlot = t.slot;
    s.leaderSol = t.amountSol;
    s.leaderTokenAmount = t.tokenAmount;
    s.leaderPriceSol = leaderFillPrice(t, decimals);
    s.venue = t.venue;
    return s;
  }

  private emitBuy(task: TaskRt, user: UserRt, ev: LeaderTrade, token: TokenView, size: number, now: number): void {
    const c = task.config;
    const s = this.withLeader(this.baseSignal(task, "buy", ev.trade.mint, token, now), ev.trade, token.decimals);
    s.sizeSol = size;
    s.maxPriceSol = s.leaderPriceSol === null ? null : s.leaderPriceSol * (1 + c.maxDriftPct / 100);
    s.takeProfitPct = c.takeProfitPct;
    s.stopLossPct = c.stopLossPct;
    s.expiresAt = now + this.o.limits.buyTtlMs;
    task.spentSol = round9(task.spentSol + size);
    task.spentTodaySol = round9(task.spentTodaySol + size);
    task.buysToday++;
    user.spentToday = round9(user.spentToday + size);
    let pos = task.positions.get(s.mint);
    if (!pos) {
      pos = {
        mint: s.mint,
        symbol: token.symbol,
        decimals: token.decimals,
        tokens: 0n,
        costSol: 0,
        buys: 0,
        pendingBuys: 0,
        pendingSellTokens: 0n,
        openedAt: now,
        realizedPnlSol: 0,
        leaderTokens: ev.balance.after ?? BigInt(ev.trade.tokenAmount),
        exitSignalId: null,
        exitCooldownUntil: 0,
      };
      this.putPosition(task, pos);
    }
    pos.buys++;
    pos.pendingBuys++;
    task.stats.buySignals++;
    this.stats.buySignals++;
    this.raise(task, s, size, 0n, ev.trade.signature);
  }

  private onLeaderSell(task: TaskRt, ev: LeaderTrade, now: number): void {
    const t = ev.trade;
    if (!this.remember(`${task.id}:${t.signature}:${t.mint}:sell`, t.slot)) return;
    for (const s of [...this.pending.values()]) {
      if (s.task === task && s.wire.side === "buy" && s.wire.mint === t.mint) this.resolve(s, "revoked", "leader_sold");
    }
    const pos = task.positions.get(t.mint);
    if (!pos) return;
    const sold = BigInt(t.tokenAmount);
    // The leader's sold share as an exact ratio num/den (1/1 = full exit).
    let num = 1n;
    let den = 1n;
    let source: CopySignal["fractionSource"];
    const b = ev.balance;
    if (b.source && b.before !== null && b.before > 0n) {
      if (b.after !== 0n) {
        num = sold < b.before ? sold : b.before;
        den = b.before;
      }
      source = b.source;
    } else if (pos.leaderTokens !== null && pos.leaderTokens > 0n) {
      num = sold < pos.leaderTokens ? sold : pos.leaderTokens;
      den = pos.leaderTokens;
      source = "tracked";
    } else {
      source = "unknown";
    }
    const fraction = ratio(num, den);
    pos.leaderTokens = b.after ?? (pos.leaderTokens === null ? null : max0(pos.leaderTokens - sold));
    task.stateDirty = true;
    if (!task.config.copySells) return;
    const available = pos.tokens - pos.pendingSellTokens;
    if (available <= 0n) return;
    const full = num >= den;
    const tokens = full ? available : (available * num) / den;
    if (tokens <= 0n) return;
    const token = this.o.token(t.mint);
    const s = this.withLeader(this.baseSignal(task, "sell", t.mint, token, now), t, token?.decimals ?? pos.decimals);
    s.trigger = "leader_sell";
    s.sellFraction = Math.round(fraction * 1e6) / 1e6;
    s.sellTokenAmount = tokens.toString();
    s.fractionSource = source;
    s.symbol ||= pos.symbol;
    this.emitSell(task, pos, s, tokens, t.signature, now);
    if (!s.delivered && this.o.exits) {
      try {
        const fired = this.o.exits.leaderSold({
          userId: task.userId,
          taskId: task.id,
          mint: t.mint,
          leader: task.leader,
          leaderSignature: t.signature,
          fraction,
          full,
        });
        if (fired) log.info(`armed exit fired for task ${task.id} on ${t.mint}`);
      } catch (e) {
        log.warn(`armed exit hook failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  private emitSell(task: TaskRt, pos: PositionRt, s: CopySignal, tokens: bigint, keySignature: string, now: number): void {
    s.expiresAt = now + this.o.limits.sellTtlMs;
    pos.pendingSellTokens += tokens;
    task.stats.sellSignals++;
    this.stats.sellSignals++;
    this.raise(task, s, 0, tokens, keySignature);
  }

  /** Registers, publishes (immediately: latency matters) and persists a pending signal. */
  private raise(task: TaskRt, s: CopySignal, reserve: number, sellTokens: bigint, keySignature: string): void {
    task.stats.lastSignalAt = s.createdAt;
    task.statsDirty = true;
    task.stateDirty = true;
    const topic = copyTopic(task.userId);
    s.delivered = this.hub?.hasSubscribers(topic) ?? false;
    const rt: SignalRt = { wire: s, task, reserve, day: dayOf(s.createdAt), sellTokens, write: Promise.resolve() };
    this.pending.set(s.id, rt);
    this.recent.set(s.id, rt);
    this.publish(task.userId, { signals: [{ ...s }] });
    this.dirtyTasks.add(task);
    this.persist(rt, () => this.o.repo.insertSignal(task.userId, { ...s }, keySignature));
  }

  private skip(task: TaskRt, ev: LeaderTrade, token: TokenView | null, reason: CopySkipReason, now: number): void {
    task.stats.skipped++;
    task.stats.skippedByReason[reason] = (task.stats.skippedByReason[reason] ?? 0) + 1;
    task.statsDirty = true;
    this.dirtyTasks.add(task);
    this.stats.skipped++;
    // The decision log is rate limited per task; the counters above always count.
    const perMs = this.o.limits.skipLogPerHour / 3_600_000;
    task.skipTokens = Math.min(20, task.skipTokens + (now - task.skipLast) * perMs);
    task.skipLast = now;
    if (task.skipTokens < 1) return;
    task.skipTokens -= 1;
    const s = this.withLeader(this.baseSignal(task, ev.trade.side, ev.trade.mint, token, now), ev.trade, token?.decimals ?? 6);
    s.status = "skipped";
    s.reason = reason;
    s.resolvedAt = now;
    const list = this.skipQueue.get(task.userId);
    if (list) list.push(s);
    else this.skipQueue.set(task.userId, [s]);
    this.persistRaw(() => this.o.repo.insertSignal(task.userId, s, ev.trade.signature));
  }

  // -------------------------------------------------------------------------------------------
  // TP / SL, expiry, dead slots
  // -------------------------------------------------------------------------------------------

  /** Prices of these mints changed: check TP / SL of open copy positions. */
  onPrices(mints: Iterable<string>): void {
    const now = this.o.now();
    for (const mint of mints) {
      const set = this.byMint.get(mint);
      if (!set) continue;
      const token = this.o.token(mint);
      if (!token || !(token.priceSol > 0)) continue;
      for (const task of set) {
        const c = task.config;
        if (c.takeProfitPct === null && c.stopLossPct === null) continue;
        const pos = task.positions.get(mint);
        if (!pos || pos.tokens <= 0n || pos.exitSignalId || now < pos.exitCooldownUntil) continue;
        const avg = this.avgPrice(pos);
        if (avg === null) continue;
        const pnl = (token.priceSol / avg - 1) * 100;
        let trigger: CopySellTrigger | null = null;
        if (c.takeProfitPct !== null && pnl >= c.takeProfitPct) trigger = "take_profit";
        else if (c.stopLossPct !== null && pnl <= -c.stopLossPct) trigger = "stop_loss";
        if (!trigger) continue;
        const available = pos.tokens - pos.pendingSellTokens;
        if (available <= 0n) continue;
        const s = this.baseSignal(task, "sell", mint, token, now);
        s.trigger = trigger;
        s.reason = trigger;
        s.sellFraction = 1;
        s.sellTokenAmount = available.toString();
        pos.exitSignalId = s.id;
        this.emitSell(task, pos, s, available, `exit:${s.id}`, now);
      }
    }
  }

  private avgPrice(pos: PositionRt): number | null {
    const whole = Number(pos.tokens) / 10 ** pos.decimals;
    return whole > 0 && pos.costSol > 0 ? pos.costSol / whole : null;
  }

  /** Expires pending signals past their deadline; publishes skipped-trade records. */
  sweep(): void {
    const now = this.o.now();
    for (const s of [...this.pending.values()]) {
      if (s.wire.expiresAt !== null && s.wire.expiresAt <= now) {
        this.stats.expired++;
        this.resolve(s, "expired", null);
      }
    }
    for (const [userId, list] of this.skipQueue) this.publish(userId, { signals: list });
    this.skipQueue.clear();
    for (const t of this.dirtyTasks) if (this.tasks.has(t.id)) this.publish(t.userId, { tasks: [this.taskWire(t)] });
    this.dirtyTasks.clear();
  }

  /** A slot died: signals raised from leader trades in it are revoked, and a fork replay may signal again. */
  onDeadSlot(slot: number): void {
    for (const s of [...this.pending.values()]) {
      if (s.wire.leaderSlot === slot && s.wire.leaderSignature) {
        this.stats.revoked++;
        this.resolve(s, "revoked", "leader_trade_rolled_back");
      }
    }
    for (const key of this.slotKeys.get(slot) ?? []) this.seen.delete(key);
    this.slotKeys.delete(slot);
  }

  /** Withdraws or settles a pending signal and releases what it held. */
  private resolve(s: SignalRt, status: "expired" | "revoked" | "failed" | "declined", reason: string | null): void {
    if (s.wire.status !== "pending") return;
    const now = this.o.now();
    this.pending.delete(s.wire.id);
    s.wire.status = status;
    s.wire.reason = reason;
    s.wire.resolvedAt = now;
    const task = s.task;
    const pos = task.positions.get(s.wire.mint);
    if (s.wire.side === "buy") {
      this.release(s);
      if (pos) {
        pos.pendingBuys = Math.max(0, pos.pendingBuys - 1);
        pos.buys = Math.max(0, pos.buys - 1);
        this.maybeClose(task, pos);
      }
    } else if (pos) {
      pos.pendingSellTokens = max0(pos.pendingSellTokens - s.sellTokens);
      if (pos.exitSignalId === s.wire.id) {
        pos.exitSignalId = null;
        pos.exitCooldownUntil = now + this.o.limits.exitCooldownMs;
      }
    }
    task.stats[status]++;
    task.statsDirty = true;
    this.dirtyTasks.add(task);
    this.publish(task.userId, { signals: [{ ...s.wire }] });
    this.persist(s, () => this.o.repo.updateSignal({ ...s.wire }));
  }

  /** Releases a pending buy's reservation from every cap. */
  private release(s: SignalRt): void {
    if (s.reserve <= 0) return;
    const task = s.task;
    const user = this.userRt(task.userId);
    task.spentSol = Math.max(0, round9(task.spentSol - s.reserve));
    if (task.day === s.day) {
      task.spentTodaySol = Math.max(0, round9(task.spentTodaySol - s.reserve));
      task.buysToday = Math.max(0, task.buysToday - 1);
    }
    if (user.day === s.day) user.spentToday = Math.max(0, round9(user.spentToday - s.reserve));
    s.reserve = 0;
  }

  private putPosition(task: TaskRt, pos: PositionRt): void {
    task.positions.set(pos.mint, pos);
    let set = this.byMint.get(pos.mint);
    if (!set) {
      set = new Set();
      this.byMint.set(pos.mint, set);
    }
    set.add(task);
  }

  /** Drops a position with nothing held and nothing pending. */
  private maybeClose(task: TaskRt, pos: PositionRt): void {
    if (pos.tokens > 0n || pos.pendingBuys > 0) return;
    task.positions.delete(pos.mint);
    const set = this.byMint.get(pos.mint);
    set?.delete(task);
    if (set && !set.size) this.byMint.delete(pos.mint);
    task.stateDirty = true;
    this.publish(task.userId, { closedPositions: [`${task.id}:${pos.mint}`] });
  }

  // -------------------------------------------------------------------------------------------
  // results reported by the browser, and feed confirmations
  // -------------------------------------------------------------------------------------------

  /** Applies the browser's report for one of the user's signals. */
  async report(userId: string, id: string, r: CopySignalResult): Promise<ReportOutcome> {
    let s = this.pending.get(id) ?? this.recent.peek(id) ?? null;
    if (!s) {
      const stored = await this.o.repo.getSignal(userId, id);
      const task = stored ? this.tasks.get(stored.taskId) : undefined;
      if (!stored || !task) return { ok: false, status: 404, message: "no such signal" };
      s = {
        wire: stored,
        task,
        reserve: 0,
        day: dayOf(stored.createdAt),
        sellTokens: BigInt(stored.sellTokenAmount ?? "0"),
        write: Promise.resolve(),
      };
      this.recent.set(id, s);
    }
    if (s.task.userId !== userId) return { ok: false, status: 404, message: "no such signal" };
    if (s.wire.status === "skipped") return { ok: false, status: 409, message: "skipped trades cannot be reported" };
    if (r.status === "executed") {
      if (s.wire.status === "executed") return { ok: false, status: 409, message: "already reported as executed" };
      if (s.wire.status === "failed" || s.wire.status === "declined")
        return { ok: false, status: 409, message: `already reported as ${s.wire.status}` };
      this.applyFill(s, r);
      return { ok: true, signal: { ...s.wire } };
    }
    if (s.wire.status === r.status) return { ok: true, signal: { ...s.wire } };
    if (s.wire.status !== "pending") return { ok: false, status: 409, message: `signal is ${s.wire.status}` };
    this.resolve(s, r.status, r.reason ?? null);
    return { ok: true, signal: { ...s.wire } };
  }

  private applyFill(s: SignalRt, r: CopySignalResult): void {
    const now = this.o.now();
    const task = s.task;
    const prior = s.wire.status;
    const priorReason = s.wire.reason;
    const wasPending = prior === "pending";
    if (wasPending) this.pending.delete(s.wire.id);
    // An expired or revoked signal the browser executed anyway: it counts as executed, not as both.
    else if (prior === "expired" || prior === "revoked") task.stats[prior] = Math.max(0, task.stats[prior] - 1);
    const chain = r.signature
      ? this.o.recentTrades?.(s.wire.mint).find((t) => t.signature === r.signature && t.side === s.wire.side)
      : undefined;
    const sol = chain ? chain.amountSol : (r.solAmount as number);
    const tokens = BigInt(chain ? chain.tokenAmount : (r.tokenAmount as string));
    s.wire.status = "executed";
    s.wire.reason = null;
    s.wire.resolvedAt = now;
    s.wire.signature = r.signature ?? null;
    s.wire.filledSol = sol;
    s.wire.filledTokens = tokens.toString();
    s.wire.confirmed = !!chain;
    if (chain) this.stats.confirmed++;
    else if (r.signature) this.sigWatch.set(r.signature, s.wire.id);
    task.stats.executed++;
    this.bookFill(s, sol, tokens, wasPending);
    task.statsDirty = true;
    task.stateDirty = true;
    this.publish(task.userId, { signals: [{ ...s.wire }], tasks: [this.taskWire(task)], positions: this.positionWires(task, s.wire.mint) });
    this.persist(s, () => this.o.repo.updateSignal({ ...s.wire }));
    // The buy landed after the leader had already sold: follow them out (fraction unknown = full exit).
    if (s.wire.side === "buy" && prior === "revoked" && priorReason === "leader_sold" && task.config.copySells) {
      const pos = task.positions.get(s.wire.mint);
      const available = pos ? pos.tokens - pos.pendingSellTokens : 0n;
      if (pos && available > 0n) {
        const exit = this.baseSignal(task, "sell", s.wire.mint, this.o.token(s.wire.mint), now);
        exit.trigger = "leader_sell";
        exit.reason = "leader_sold_before_fill";
        exit.sellFraction = 1;
        exit.sellTokenAmount = available.toString();
        exit.fractionSource = "unknown";
        exit.symbol ||= pos.symbol;
        this.emitSell(task, pos, exit, available, `exit:${exit.id}`, now);
      }
    }
  }

  private newPosition(mint: string, symbol: string): PositionRt {
    return {
      mint,
      symbol,
      decimals: this.o.token(mint)?.decimals ?? 6,
      tokens: 0n,
      costSol: 0,
      buys: 0,
      pendingBuys: 0,
      pendingSellTokens: 0n,
      openedAt: this.o.now(),
      realizedPnlSol: 0,
      leaderTokens: null,
      exitSignalId: null,
      exitCooldownUntil: 0,
    };
  }

  /** Adds `dSol` of buy spend to the task's and the account's counters (today's only on the signal's day). */
  private addSpend(s: SignalRt, dSol: number): void {
    const task = s.task;
    const user = this.userRt(task.userId);
    task.spentSol = Math.max(0, round9(task.spentSol + dSol));
    if (task.day === s.day) task.spentTodaySol = Math.max(0, round9(task.spentTodaySol + dSol));
    if (user.day === s.day) user.spentToday = Math.max(0, round9(user.spentToday + dSol));
  }

  /** Books a reported (or chain-confirmed) fill into the task's spend and position. */
  private bookFill(s: SignalRt, sol: number, tokens: bigint, wasPending: boolean): void {
    const task = s.task;
    const mint = s.wire.mint;
    let pos = task.positions.get(mint);
    if (s.wire.side === "buy") {
      // A pending buy's reservation becomes the actual fill; a late one is new spend (and a new buy).
      this.addSpend(s, sol - (wasPending ? s.reserve : 0));
      s.reserve = 0;
      if (!wasPending && task.day === s.day) task.buysToday++;
      if (!pos) {
        pos = this.newPosition(mint, s.wire.symbol);
        this.putPosition(task, pos);
      }
      if (wasPending) pos.pendingBuys = Math.max(0, pos.pendingBuys - 1);
      else pos.buys++;
      pos.tokens += tokens;
      pos.costSol += sol;
      this.maybeClose(task, pos);
      return;
    }
    if (!pos) return;
    if (wasPending) pos.pendingSellTokens = max0(pos.pendingSellTokens - s.sellTokens);
    if (pos.exitSignalId === s.wire.id) pos.exitSignalId = null;
    this.bookSale(s, pos, sol, tokens);
    this.maybeClose(task, pos);
  }

  /** Weighted-average cost: the sold share of the cost basis leaves, the rest of the proceeds is realized PnL. */
  private bookSale(s: SignalRt, pos: PositionRt, sol: number, tokens: bigint): void {
    const sold = tokens > pos.tokens ? pos.tokens : tokens;
    const cost = pos.tokens > 0n ? pos.costSol * ratio(sold, pos.tokens) : 0;
    const realized = sol - cost;
    pos.costSol = Math.max(0, pos.costSol - cost);
    pos.tokens -= sold;
    pos.realizedPnlSol += realized;
    s.task.stats.realizedPnlSol = round9(s.task.stats.realizedPnlSol + realized);
    s.booked = { sold, cost, realized };
  }

  /** Replaces a reported fill with the chain's amounts. */
  private correctFill(s: SignalRt, sol: number, tokens: bigint): void {
    const task = s.task;
    const pos = task.positions.get(s.wire.mint);
    const reportedSol = s.wire.filledSol ?? 0;
    const reportedTokens = BigInt(s.wire.filledTokens ?? "0");
    if (s.wire.side === "buy") {
      this.addSpend(s, sol - reportedSol);
      if (pos) {
        pos.tokens = max0(pos.tokens + tokens - reportedTokens);
        pos.costSol = Math.max(0, pos.costSol + sol - reportedSol);
        this.maybeClose(task, pos);
      }
      return;
    }
    const b = s.booked;
    if (!pos || !b) return;
    pos.tokens += b.sold;
    pos.costSol += b.cost;
    pos.realizedPnlSol -= b.realized;
    task.stats.realizedPnlSol = round9(task.stats.realizedPnlSol - b.realized);
    this.bookSale(s, pos, sol, tokens);
    this.maybeClose(task, pos);
  }

  /** Every decoded trade: confirms follower fills reported earlier (chain amounts replace the reported ones). */
  onAnyTrade(t: Trade): void {
    const id = this.sigWatch.peek(t.signature);
    if (id === undefined) return;
    const s = this.recent.peek(id);
    if (s?.wire.status !== "executed" || s.wire.confirmed || t.side !== s.wire.side || t.mint !== s.wire.mint) return;
    this.sigWatch.delete(t.signature);
    if (s.wire.filledSol !== t.amountSol || s.wire.filledTokens !== t.tokenAmount) {
      this.correctFill(s, t.amountSol, BigInt(t.tokenAmount));
      s.wire.filledSol = t.amountSol;
      s.wire.filledTokens = t.tokenAmount;
    }
    s.wire.confirmed = true;
    this.stats.confirmed++;
    s.task.stateDirty = true;
    this.publish(s.task.userId, {
      signals: [{ ...s.wire }],
      tasks: [this.taskWire(s.task)],
      positions: this.positionWires(s.task, s.wire.mint),
    });
    this.persist(s, () => this.o.repo.updateSignal({ ...s.wire }));
  }

  // -------------------------------------------------------------------------------------------
  // wire views, publishing and persistence
  // -------------------------------------------------------------------------------------------

  private positionWire(task: TaskRt, pos: PositionRt): CopyPosition {
    const token = this.o.token(pos.mint);
    const price = token && token.priceSol > 0 ? token.priceSol : null;
    const whole = Number(pos.tokens) / 10 ** pos.decimals;
    return {
      taskId: task.id,
      leader: task.leader,
      mint: pos.mint,
      symbol: pos.symbol || token?.symbol || "",
      tokens: pos.tokens.toString(),
      costSol: round9(pos.costSol),
      avgPriceSol: this.avgPrice(pos),
      buys: pos.buys,
      openedAt: pos.openedAt,
      realizedPnlSol: round9(pos.realizedPnlSol),
      priceSol: price,
      unrealizedPnlSol: price === null ? null : round9(price * whole - pos.costSol),
    };
  }

  private positionWires(task: TaskRt, mint: string): CopyPosition[] | undefined {
    const pos = task.positions.get(mint);
    return pos && pos.tokens > 0n ? [this.positionWire(task, pos)] : undefined;
  }

  positions(userId: string): CopyPosition[] {
    const out: CopyPosition[] = [];
    for (const t of this.byUser.get(userId) ?? [])
      for (const p of t.positions.values()) if (p.tokens > 0n) out.push(this.positionWire(t, p));
    return out;
  }

  taskWire(t: TaskRt): CopyTask {
    let unrealized: number | null = 0;
    let open = 0;
    for (const p of t.positions.values()) {
      if (p.tokens <= 0n) continue;
      open++;
      const w = this.positionWire(t, p);
      unrealized = unrealized === null || w.unrealizedPnlSol === null ? null : unrealized + w.unrealizedPnlSol;
    }
    const s = t.stats;
    const today = t.day === dayOf(this.o.now());
    return {
      id: t.id,
      leader: t.leader,
      label: t.label,
      status: t.status,
      pausedReason: t.pausedReason,
      config: t.config,
      stats: {
        buySignals: s.buySignals,
        sellSignals: s.sellSignals,
        executed: s.executed,
        failed: s.failed,
        declined: s.declined,
        expired: s.expired,
        revoked: s.revoked,
        skipped: s.skipped,
        skippedByReason: { ...s.skippedByReason },
        spentSol: round9(t.spentSol),
        spentTodaySol: today ? round9(t.spentTodaySol) : 0,
        buysToday: today ? t.buysToday : 0,
        realizedPnlSol: round9(s.realizedPnlSol),
        unrealizedPnlSol: unrealized === null ? null : round9(unrealized),
        openPositions: open,
        lastSignalAt: s.lastSignalAt,
      },
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }

  /** The user's pending signals (newest first). */
  pendingOf(userId: string): CopySignal[] {
    return [...this.pending.values()]
      .filter((s) => s.task.userId === userId)
      .map((s) => ({ ...s.wire }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  private publish(userId: string, delta: Record<string, unknown>): void {
    const clean = Object.fromEntries(Object.entries(delta).filter(([, v]) => v !== undefined));
    this.hub?.publish(copyTopic(userId), "delta", clean, undefined, "copy");
  }

  /** Serializes writes per signal (the insert lands before its updates). */
  private persist(s: SignalRt, fn: () => Promise<void>): void {
    const p = s.write.then(fn).catch((e) => {
      this.stats.writeErrors++;
      log.warn(`copy signal ${s.wire.id} not saved: ${e instanceof Error ? e.message : e}`);
    });
    s.write = p;
    this.track(p);
  }

  private persistRaw(fn: () => Promise<void>): void {
    this.track(
      fn().catch((e) => {
        this.stats.writeErrors++;
        log.warn(`copy decision not saved: ${e instanceof Error ? e.message : e}`);
      }),
    );
  }

  private track(p: Promise<void>): void {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  /** Writes dirty task state (positions) and counters. */
  async flushState(): Promise<void> {
    const writes: Promise<void>[] = [];
    for (const t of this.tasks.values()) {
      if (t.stateDirty) {
        t.stateDirty = false;
        const positions: StoredPosition[] = [...t.positions.values()]
          .filter((p) => p.tokens > 0n)
          .map((p) => ({
            mint: p.mint,
            symbol: p.symbol,
            tokens: p.tokens.toString(),
            costSol: p.costSol,
            buys: p.buys - p.pendingBuys,
            openedAt: p.openedAt,
            realizedPnlSol: p.realizedPnlSol,
            leaderTokens: p.leaderTokens === null ? null : p.leaderTokens.toString(),
          }));
        writes.push(this.o.repo.saveState(t.id, { positions }));
      }
      if (t.statsDirty) {
        t.statsDirty = false;
        writes.push(this.o.repo.saveStats(t.id, { ...emptyStats(), ...t.stats }));
      }
    }
    const results = await Promise.allSettled(writes);
    for (const r of results) {
      if (r.status === "rejected") {
        this.stats.writeErrors++;
        log.warn(`copy task state not saved: ${r.reason}`);
      }
    }
  }

  /** Waits for queued signal writes (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
    await this.flushState();
  }
}
