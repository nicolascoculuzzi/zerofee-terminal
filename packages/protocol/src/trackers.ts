/**
 * Wallet tracker feed and copy trading (user topics + REST; session cookie required, mutations need an
 * allowed Origin).
 *
 * The server matches every decoded pump / PumpSwap / Raydium LaunchLab / Raydium CPMM trade against the
 * deduplicated union of all users' tracked wallets and copy-task leaders, in memory (SPEC "Data layer"). Raydium
 * events carry no wallet: the trader is the swap instruction's payer, known when the source has the transaction
 * (Yellowstone, or the RPC logs feed after it fetched it); unattributed trades (trader "") match nobody.
 * Matches are delivered on:
 *
 *   tracked              the session user's live feed: trades and launches by their tracked wallets
 *   tracked:<mint>       chart markers: the user's tracked-wallet trades on one token (longer history)
 *   copy                 copy-trade signals for the session user, plus task status / stats updates
 *
 * Copy trading never holds keys. The server evaluates each leader trade against the follower's tasks
 * (filters, sizing, caps, drift guard) and pushes a vetted, expiring signal; the browser builds the
 * trade from the `tradectx:<mint>` topic, its signer firewall checks it, the trading wallet signs it,
 * and the browser reports the outcome. Copy sells mirror the leader's sell fraction; TP / SL on copies
 * arrive as sell signals while the browser is open, and should also be armed as pre-signed orders
 * (SPEC "Armed orders": copy-trade sells after the buy fills run with the tab closed).
 *
 *   GET    /api/copy/tasks                     -> CopyTask[]
 *   POST   /api/copy/tasks                     CopyTaskInput -> CopyTask
 *   GET    /api/copy/tasks/:id                 -> CopyTask
 *   PATCH  /api/copy/tasks/:id                 CopyTaskPatch -> CopyTask
 *   DELETE /api/copy/tasks/:id                 -> { ok: true } (pending signals are revoked)
 *   POST   /api/copy/tasks/:id/pause           -> CopyTask (no new buys; sells and TP/SL keep working)
 *   POST   /api/copy/tasks/:id/resume          -> CopyTask
 *   GET    /api/copy/positions                 -> CopyPosition[] (open copy positions, all tasks)
 *   GET    /api/copy/signals?task=&limit=50    -> CopySignal[] (newest first, skipped included)
 *   POST   /api/copy/signals/:id/result        CopySignalResult -> CopySignal
 *   GET    /api/tracked-trades?mint=&limit=100 -> TrackedTradeRow[] (REST twin of the topic snapshots)
 */
import type { Launchpad, TradeTag, TradeVenue } from "./market";
import type { PresetSlot } from "./user";

// ---------------------------------------------------------------------------------------------
// tracked-wallet feed
// ---------------------------------------------------------------------------------------------

export type TrackedRowKind = "buy" | "sell" | "create";

/** One trade (or launch) by one of the user's tracked wallets, as the live feed and chart markers show it. */
export interface TrackedTradeRow {
  /** `${signature}:${eventIndex}:${wallet}`: unique per user feed. */
  id: string;
  kind: TrackedRowKind;
  /** The tracked wallet that matched. */
  wallet: string;
  /** trader: the trade's own wallet; feePayer: the wallet paid the fees for someone else's trade. */
  role: "trader" | "feePayer";
  /** The user's label for the wallet (may contain emoji), its emoji, and an emoji-free display tag. */
  label: string;
  emoji: string;
  /** Plain-text name for places that cannot render emoji: the label without pictographs, else a short address. */
  tag: string;
  /** The user's own tags for the wallet (wallet manager groups). */
  walletTags: string[];
  /** The trading wallet (event `user`; Raydium: the swap instruction's payer): equals `wallet` unless role is feePayer. */
  trader: string;
  mint: string;
  symbol: string;
  name: string;
  image: string | null;
  launchpad: Launchpad;
  venue: TradeVenue;
  /** Trade size in SOL (0 for launches; null when the token's quote has no known SOL value). */
  amountSol: number | null;
  amountUsd: number | null;
  /** Token amount in base units ("0" for launches). */
  tokenAmount: string;
  /** Post-trade price and market cap (SOL; USD when SOL/USD is known); null when unknown (see TokenSummary). */
  priceSol: number | null;
  mcSol: number | null;
  mcUsd: number | null;
  signature: string;
  slot: number;
  /** Block time (1 s resolution) and server receive time, ms. */
  blockTime: number;
  receivedAt: number;
  /**
   * The wallet's opening buy of this token: exact when the token's history was observed (holder book or
   * gRPC balances), otherwise "first buy since the server started watching this wallet". null for sells.
   */
  firstBuy: boolean | null;
  /** Market badges for the trader on this token (dev, sniper, bundler, pro). */
  marketTags: TradeTag[];
}

/** `tracked` / `tracked:<mint>` snapshot: newest first. */
export interface TrackedSnapshot {
  rows: TrackedTradeRow[];
}

/** New rows since the last frame, oldest first (prepend in order). */
export interface TrackedDelta {
  rows: TrackedTradeRow[];
}

/** Rows to drop: their transaction's slot died (fork). */
export interface TrackedCorrection {
  remove: string[];
}

// ---------------------------------------------------------------------------------------------
// copy trading
// ---------------------------------------------------------------------------------------------

export const COPY_LIMITS = {
  /** Copy tasks per user (GMGN allows 10 concurrent). */
  tasksPerUser: 20,
  blacklistPerTask: 200,
  /** Open copy positions per task. */
  positionsPerTask: 200,
} as const;

export type CopySizing =
  /** A fixed SOL amount per copied buy. */
  | { mode: "fixed"; sol: number }
  /** A percentage of the leader's buy (10 = 10% of a 10 SOL buy = 1 SOL), capped by maxPerBuySol. */
  | { mode: "ratio"; pct: number };

/** Inclusive bounds; null = no bound. */
export interface CopyRange {
  min: number | null;
  max: number | null;
}

export interface CopyValueRange extends CopyRange {
  currency: "usd" | "sol";
}

export interface CopyTaskConfig {
  sizing: CopySizing;
  /** Cap per copied buy (SOL), whatever the sizing mode. */
  maxPerBuySol: number;
  /** Lifetime spend cap of the task (SOL of buys: executed plus pending). */
  totalSpendLimitSol: number;
  /** Spend cap per UTC day (SOL of buys). */
  dailySpendLimitSol: number;
  /** Buy signals per UTC day. */
  dailyBuyLimit: number;
  /** Market cap at the leader's trade. An unknown market cap (null in TokenSummary) fails a min and a max. */
  mc: CopyValueRange;
  /**
   * Quote-side liquidity at the leader's trade (curve real reserves, or the pool's quote vault). Unknown
   * liquidity fails a min and a max.
   */
  liquidity: CopyValueRange;
  /** Token age in seconds at the leader's trade (unknown age passes a minimum and fails a maximum). */
  ageSec: CopyRange;
  /** The leader's buy size (SOL). */
  leaderSol: CopyRange;
  /** Skip tokens still on the pump.fun bonding curve. */
  excludeBondingCurve: boolean;
  /** Copy only the leader's opening buy of a token, not later adds. */
  onlyFirstBuy: boolean;
  /** Copied buys per token per copy position (1 = no duplicate buys); resets when the position closes. */
  maxBuysPerToken: number;
  /** Skip Token-2022 mints with danger extensions (permanent delegate, transfer hook, pausable...). */
  skipDangerousTokens: boolean;
  /** Mirror the leader's sells: sell the same fraction of the copy position as the leader sold of theirs. */
  copySells: boolean;
  /** Take profit / stop loss on copies, % from the copy position's average entry; null = off. */
  takeProfitPct: number | null;
  stopLossPct: number | null;
  /** Drift guard: skip when the price is already more than this % above the leader's average fill. */
  maxDriftPct: number;
  /** Slippage for the follower's trades (bps) and the trading preset (landing, fees) to use. */
  slippageBps: number;
  preset: PresetSlot;
  /** Never copy these tokens, or tokens launched by these devs (on top of the account blacklists). */
  blacklist: { mints: string[]; devs: string[] };
}

/** Defaults lean safe: small fixed size, caps on, a 10 s minimum token age, copy sells on. */
export const DEFAULT_COPY_CONFIG: CopyTaskConfig = {
  sizing: { mode: "fixed", sol: 0.05 },
  maxPerBuySol: 0.25,
  totalSpendLimitSol: 2,
  dailySpendLimitSol: 1,
  dailyBuyLimit: 20,
  mc: { min: null, max: null, currency: "usd" },
  liquidity: { min: null, max: null, currency: "sol" },
  ageSec: { min: 10, max: null },
  leaderSol: { min: null, max: null },
  excludeBondingCurve: false,
  onlyFirstBuy: false,
  maxBuysPerToken: 1,
  skipDangerousTokens: true,
  copySells: true,
  takeProfitPct: null,
  stopLossPct: null,
  maxDriftPct: 10,
  slippageBps: 1_500,
  preset: 1,
  blacklist: { mints: [], devs: [] },
};

export type CopyTaskStatus = "active" | "paused";

export interface CopyTaskStats {
  /** Actionable signals pushed (buys + sells). */
  buySignals: number;
  sellSignals: number;
  executed: number;
  failed: number;
  declined: number;
  expired: number;
  revoked: number;
  /** Leader trades the filters or caps skipped, by reason (CopySkipReason). */
  skipped: number;
  skippedByReason: Record<string, number>;
  /** Buys counted against the caps: executed fills plus pending reservations (SOL). */
  spentSol: number;
  spentTodaySol: number;
  buysToday: number;
  /** Realized PnL of copy positions from reported fills (SOL, weighted-average cost). */
  realizedPnlSol: number;
  /** Unrealized PnL of open copy positions at the live price; null when a price is unknown. */
  unrealizedPnlSol: number | null;
  openPositions: number;
  lastSignalAt: number | null;
}

export interface CopyTask {
  id: string;
  /** Wallet being copied. */
  leader: string;
  label: string;
  status: CopyTaskStatus;
  /** "user" when paused by the owner. */
  pausedReason: string | null;
  config: CopyTaskConfig;
  stats: CopyTaskStats;
  createdAt: number;
  updatedAt: number;
}

/** Nested objects (sizing, ranges, blacklist) are merged field by field over the defaults. */
export interface CopyTaskInput {
  leader: string;
  label?: string;
  /** Default "active". */
  status?: CopyTaskStatus;
  config?: CopyTaskConfigPatch;
}

export type CopyTaskConfigPatch = Partial<Omit<CopyTaskConfig, "mc" | "liquidity" | "ageSec" | "leaderSol" | "blacklist">> & {
  mc?: Partial<CopyValueRange>;
  liquidity?: Partial<CopyValueRange>;
  ageSec?: Partial<CopyRange>;
  leaderSol?: Partial<CopyRange>;
  blacklist?: Partial<CopyTaskConfig["blacklist"]>;
};

export interface CopyTaskPatch {
  label?: string;
  config?: CopyTaskConfigPatch;
}

/** An open copy position (what the task bought and has not sold yet, from reported fills). */
export interface CopyPosition {
  taskId: string;
  leader: string;
  mint: string;
  symbol: string;
  /** Base units held by this task's copies. */
  tokens: string;
  /** Remaining cost basis (SOL) and average entry price (SOL per whole token). */
  costSol: number;
  avgPriceSol: number | null;
  /** Copied buys in this position (maxBuysPerToken counts these, pending ones included). */
  buys: number;
  openedAt: number;
  realizedPnlSol: number;
  priceSol: number | null;
  unrealizedPnlSol: number | null;
}

export type CopySignalSide = "buy" | "sell";
/**
 * pending: pushed, waiting for the browser; executed: the browser reported a fill; failed: the trade
 * failed; declined: the browser refused (price moved past maxPriceSol, firewall, locked vault...);
 * expired: not acted on before expiresAt; revoked: withdrawn by the server (see CopyRevokeReason);
 * skipped: the leader trade did not pass the task's filters or caps (reason = CopySkipReason).
 */
export type CopySignalStatus = "pending" | "executed" | "failed" | "declined" | "expired" | "revoked" | "skipped";

export const COPY_SKIP_REASONS = [
  "blacklisted_token",
  "blacklisted_dev",
  "bonding_curve_excluded",
  "curve_complete",
  "token_danger",
  "token_unknown",
  "not_first_buy",
  "token_too_young",
  "token_too_old",
  "mc_below_min",
  "mc_above_max",
  "liquidity_below_min",
  "liquidity_above_max",
  "usd_price_unavailable",
  /** An MC / liquidity filter is set and the token's value is unknown (quote without a SOL value). */
  "mc_unknown",
  "liquidity_unknown",
  "leader_size_below_min",
  "leader_size_above_max",
  "max_buys_per_token",
  "max_positions",
  "price_unknown",
  "price_drift",
  "size_below_minimum",
  "total_limit",
  "daily_limit",
  "daily_buy_limit",
  "user_daily_limit",
  "leader_slot_cap",
] as const;
export type CopySkipReason = (typeof COPY_SKIP_REASONS)[number];

/** Why the server withdrew a pending signal. */
export type CopyRevokeReason = "leader_sold" | "leader_trade_rolled_back" | "task_paused" | "task_deleted" | "superseded";

/**
 * Why a sell signal was raised. A copy buy reported filled after the leader had already sold (the buy
 * was revoked as "leader_sold") raises a full exit with trigger "leader_sell" and reason
 * "leader_sold_before_fill".
 */
export type CopySellTrigger = "leader_sell" | "take_profit" | "stop_loss";

export interface CopySignal {
  id: string;
  taskId: string;
  side: CopySignalSide;
  status: CopySignalStatus;
  /** Skip, revoke, decline or failure reason. */
  reason: string | null;
  mint: string;
  symbol: string;
  venue: TradeVenue;
  leader: string;
  /** The leader trade this signal follows ("" for TP / SL exits, which follow the price, not a trade). */
  leaderSignature: string;
  leaderSlot: number;
  /** The leader's trade size in SOL; null when the token's quote has no known SOL value. */
  leaderSol: number | null;
  leaderTokenAmount: string;
  /** Leader's average fill price (SOL per whole token); null when not computable. */
  leaderPriceSol: number | null;
  /** Price and market cap when the server evaluated the signal; null when unknown. */
  priceSol: number | null;
  mcSol: number | null;
  mcUsd: number | null;
  /** buy: SOL to spend (already capped). */
  sizeSol: number | null;
  /** buy: do not pay more than this price per whole token (drift guard); the browser sets min-out from it. */
  maxPriceSol: number | null;
  slippageBps: number;
  preset: PresetSlot;
  /** buy: TP / SL to arm on the fill (% from entry), from the task config. */
  takeProfitPct: number | null;
  stopLossPct: number | null;
  /** sell: what raised it, the fraction of the copy position to sell (0-1] and the token amount by the server's records. */
  trigger: CopySellTrigger | null;
  sellFraction: number | null;
  sellTokenAmount: string | null;
  /** sell: how the leader's sell fraction was measured (balances, holders, tracked, unknown = full exit). */
  fractionSource: "balances" | "holders" | "tracked" | "unknown" | null;
  /** False when no browser of the user was subscribed to `copy` when the signal was raised. */
  delivered: boolean;
  createdAt: number;
  expiresAt: number | null;
  resolvedAt: number | null;
  /** Follower's transaction, SOL spent (buy) / received (sell) and tokens, once reported. */
  signature: string | null;
  filledSol: number | null;
  filledTokens: string | null;
  /** The follower's transaction was seen in the feed (amounts then come from chain data). */
  confirmed: boolean;
}

/** POST /api/copy/signals/:id/result. Report fills only after the transaction confirmed. */
export interface CopySignalResult {
  status: "executed" | "failed" | "declined";
  /** executed: the follower's transaction signature. */
  signature?: string;
  /** executed: SOL spent (buy, fees excluded) or received (sell). */
  solAmount?: number;
  /** executed: tokens bought or sold, base units. */
  tokenAmount?: string;
  /** failed / declined: short reason (e.g. "price_moved", "firewall", "slippage"). */
  reason?: string;
}

/** `copy` snapshot: the user's tasks, open positions, pending signals and recent decisions. */
export interface CopySnapshot {
  tasks: CopyTask[];
  positions: CopyPosition[];
  /** Pending first, then the most recent resolved / skipped ones (newest first). */
  signals: CopySignal[];
}

/** `copy` delta: upserted signals (new, or a status change), changed tasks and positions. */
export interface CopyDelta {
  signals?: CopySignal[];
  tasks?: CopyTask[];
  positions?: CopyPosition[];
  /** Positions closed (`${taskId}:${mint}`). */
  closedPositions?: string[];
  /** Tasks deleted. */
  removedTasks?: string[];
}
