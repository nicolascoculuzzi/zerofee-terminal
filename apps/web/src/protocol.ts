/**
 * Provisional WebSocket + REST protocol between the zerofee gateway and the web app.
 *
 * NOTE: these types will move to `packages/protocol` when the gateway (apps/server) is
 * built, so the server and the browser import one definition. Until then the web app's
 * MockDataSource / MockTradeService produce exactly these shapes, and the real
 * implementations only need to speak them.
 *
 * Wire rules (SPEC.md, "Data layer" > "Streaming"):
 * - The client sends `{ op: "subscribe", topics }`. For each topic the server answers with
 *   one `snapshot`, then sequenced `delta`s. `seq` increases by exactly 1 per message per
 *   topic; a gap means a lost message, and the client must resubscribe for a fresh snapshot.
 * - Lists (Pulse) coalesce to 4–10 Hz. The focused token's trade tape is flushed every
 *   50–100 ms. Corrections for late or dead-slot events arrive as ordinary deltas
 *   (`remove` entries or replaced items with the same id).
 * - Units: SOL amounts are decimal SOL; token amounts are UI amounts (decimals applied).
 *   The trade engine (`packages/core`) works in lamports/base units with bigint; this UI
 *   protocol is for display and quoting only, never for building transactions.
 * - Times are Unix milliseconds, except `Candle.time` (Unix seconds, bucket start).
 */

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export type Timeframe = "1s" | "15s" | "1m" | "5m" | "15m" | "1h";

export const TIMEFRAMES: readonly Timeframe[] = ["1s", "15s", "1m", "5m", "15m", "1h"];

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  "1s": 1,
  "15s": 15,
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
};

export type PulseColumnId = "new" | "final" | "migrated";

/** Launchpads shown in the Pulse "Protocols" filter. */
export type Launchpad =
  | "pump"
  | "mayhem"
  | "bonk"
  | "bags"
  | "stonkfun"
  | "launchlab"
  | "meteora_dbc"
  | "moonit"
  | "boop"
  | "heaven"
  | "other";

export type QuoteToken = "SOL" | "USDC" | "USD1" | "OTHER";

/** Where the token trades right now. */
export type Venue = "pump_curve" | "pumpswap" | "launchlab" | "raydium_cpmm" | "meteora_dbc" | "meteora_damm_v2" | "other";

/** Landing presets from SPEC.md "Landing presets". */
export type LandingPreset = "reduced" | "secure" | "fast";

/** Wallet labels the server attaches to holders, traders and trades. */
export type WalletTag = "you" | "dev" | "sniper" | "insider" | "bundler" | "pro" | "whale" | "tracked" | "kol" | "curve" | "pool";

// ---------------------------------------------------------------------------
// Topics and envelopes
// ---------------------------------------------------------------------------

export type Topic =
  | "pulse:new"
  | "pulse:final"
  | "pulse:migrated"
  | `token:${string}`
  | `trades:${string}`
  | `candles:${string}:${Timeframe}`
  | `wallet:${string}`
  | "orders"
  // Provisional additions, not yet in SPEC.md's topic list:
  /** SOL/USD, current slot and feed health. */
  | "market"
  /** Trades by wallets on this user's tracker list (matched server-side in the firehose). */
  | "tracked"
  /** X tracker posts for this user's handle list. */
  | "social";

export type SnapshotData<T extends Topic> = T extends `pulse:${string}`
  ? PulseSnapshot
  : T extends `token:${string}`
    ? TokenDetail
    : T extends `trades:${string}`
      ? TradesSnapshot
      : T extends `candles:${string}`
        ? CandlesSnapshot
        : T extends `wallet:${string}`
          ? WalletStatus
          : T extends "orders"
            ? OrdersSnapshot
            : T extends "market"
              ? MarketStatus
              : T extends "tracked"
                ? TrackedTradesSnapshot
                : T extends "social"
                  ? SocialSnapshot
                  : never;

export type DeltaData<T extends Topic> = T extends `pulse:${string}`
  ? PulseDelta
  : T extends `token:${string}`
    ? TokenDetailDelta
    : T extends `trades:${string}`
      ? TradesDelta
      : T extends `candles:${string}`
        ? CandlesDelta
        : T extends `wallet:${string}`
          ? WalletDelta
          : T extends "orders"
            ? OrdersDelta
            : T extends "market"
              ? MarketStatus
              : T extends "tracked"
                ? TrackedTradesDelta
                : T extends "social"
                  ? SocialDelta
                  : never;

/** Server-to-client envelope: `{ type: 'snapshot' | 'delta', topic, seq, data }`. */
export type ServerMessage<T extends Topic = Topic> =
  | { type: "snapshot"; topic: T; seq: number; ts?: number; data: SnapshotData<T> }
  | { type: "delta"; topic: T; seq: number; ts?: number; data: DeltaData<T> };

/** Client-to-server messages. */
export type ClientMessage = { op: "subscribe"; topics: Topic[] } | { op: "unsubscribe"; topics: Topic[] } | { op: "ping"; ts: number };

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export interface TokenSocials {
  /** X handle (without @) or a status URL. */
  x?: string;
  telegram?: string;
  website?: string;
}

/** Holder-composition metrics; definitions are published in-app (SPEC "Token metric definitions"). */
export interface TokenRisk {
  /** Top 10 holders' share of supply; excludes curve PDA, AMM vaults, burn addresses, lockers. */
  top10Pct: number | null;
  /** Creator wallet balance (live `bonding_curve.creator`) as % of supply. */
  devPct: number | null;
  /** True once the creator sold their whole position ("DS" on cards). */
  devSold: boolean;
  /** Non-dev buyers whose first buy landed within 3 slots of creation. */
  snipersPct: number | null;
  /** Transfer-only receivers plus wallets the creator funded within two hops. */
  insidersPct: number | null;
  /** Creation-slot co-buyers, same-slot funder/size clusters, multi-wallet txs. */
  bundlersPct: number | null;
}

/** Token-2022 extensions that let someone else move, freeze or block your tokens. */
export interface Token2022Flags {
  permanentDelegate: boolean;
  transferHook: boolean;
  pausable: boolean;
  nonTransferable: boolean;
  defaultFrozen: boolean;
}

export interface TokenSummary {
  mint: string;
  name: string;
  symbol: string;
  /** Metadata image (IPFS gateway URL). Null when unknown; the UI then draws a local avatar. */
  imageUri: string | null;
  launchpad: Launchpad;
  quote: QuoteToken;
  venue: Venue;
  column: PulseColumnId;
  createdAt: number;
  /** Creator wallet (from the live bonding_curve.creator). */
  creator: string;
  /** First SOL funder of the creator wallet (Helius funded-by), for the funding-wallet blacklist. */
  fundingWallet: string | null;
  socials: TokenSocials;
  supply: number;
  decimals: number;
  priceSol: number | null;
  priceUsd: number | null;
  marketCapSol: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  /** Volume in USD since creation (rolling 24 h for tokens older than a day). */
  volumeUsd: number | null;
  txns: number;
  buys: number;
  sells: number;
  holders: number | null;
  proTraders: number | null;
  /** 0..1, `1 − real_token_reserves_now / real_token_reserves_initial`; 1 once migrated. */
  bondingProgress: number;
  migratedAt: number | null;
  risk: TokenRisk;
  dexPaid: boolean;
  /** When the Dex Screener profile was paid (ms), while `dexPaid` is true (mirrors packages/protocol). */
  dexPaidAt: number | null;
  /** Share of LP tokens burned; null while on a bonding curve. */
  lpBurnedPct: number | null;
  /** Null for legacy SPL Token mints. */
  token2022: Token2022Flags | null;
  /** Total fees traders paid on this token: venue fees + priority fees + tips, in SOL. */
  feesPaidSol: number | null;
  /** Net buy since creation: SOL bought minus SOL sold, in USD (Pulse "NB", signed). */
  netBuyUsd: number | null;
  lastTradeAt: number;
  /** Price change over the last 5 minutes, %. */
  change5mPct: number | null;
}

export interface CurveState {
  virtualQuoteReserves: number;
  virtualTokenReserves: number;
  realQuoteReserves: number;
  realTokenReserves: number;
  initialRealTokenReserves: number;
  complete: boolean;
  /** Venue fee in basis points per side (pump.fun curve: 125 = 0.95% protocol + 0.30% creator). */
  feeBps: number;
}

export interface PoolState {
  /** Effective quote reserves (vault + signed virtual reserves for PumpSwap). */
  quoteReserves: number;
  baseReserves: number;
  feeBps: number;
  poolAddress: string;
}

export interface Holder {
  address: string;
  balance: number;
  /** Share of total supply, %. */
  pct: number;
  boughtSol: number;
  soldSol: number;
  /** Token amounts bought and sold over the holder's lifetime (UI amounts). */
  boughtTokens: number;
  soldTokens: number;
  buys: number;
  sells: number;
  firstBuyAt: number | null;
  /** Creator-funding source, when known. */
  fundedBy: string | null;
  tags: WalletTag[];
}

export interface TopTrader {
  address: string;
  boughtSol: number;
  soldSol: number;
  buys: number;
  sells: number;
  /** Remaining balance as % of supply. */
  holdingPct: number;
  /** Realized + unrealized PnL in SOL at the current price. */
  pnlSol: number;
  /** Sells against the average buy cost, SOL. */
  realizedPnlSol: number;
  /** Remaining balance at the current price against its average cost, SOL. */
  unrealizedPnlSol: number;
  firstBuyAt: number | null;
  lastTradeAt: number | null;
  tags: WalletTag[];
}

/** `token:<mint>` snapshot. */
export interface TokenDetail {
  summary: TokenSummary;
  curve: CurveState | null;
  pool: PoolState | null;
  /** Top holders, largest first (curve and pool accounts included and tagged). */
  holders: Holder[];
  topTraders: TopTrader[];
  /** Number of tokens this creator launched before. */
  devLaunches: number;
  /** How many of those migrated. */
  devMigrations: number;
}

/** `token:<mint>` delta: any subset, replacing the previous value. */
export interface TokenDetailDelta {
  summary?: TokenSummary;
  curve?: CurveState | null;
  pool?: PoolState | null;
  holders?: Holder[];
  topTraders?: TopTrader[];
}

// ---------------------------------------------------------------------------
// Pulse
// ---------------------------------------------------------------------------

export interface PulseSnapshot {
  tokens: TokenSummary[];
}

export interface PulseDelta {
  /** New or changed tokens (full summaries). */
  upsert: TokenSummary[];
  /** Mints that left this column (moved column, pruned, or corrected). */
  remove: string[];
}

// ---------------------------------------------------------------------------
// Trades and candles
// ---------------------------------------------------------------------------

export interface Trade {
  /** Signature + instruction index; unique per fill. */
  id: string;
  signature: string;
  mint: string;
  ts: number;
  slot: number;
  side: "buy" | "sell";
  solAmount: number | null;
  tokenAmount: number;
  priceSol: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  maker: string;
  tags: WalletTag[];
}

export interface TradesSnapshot {
  /** Newest first. */
  trades: Trade[];
}

export interface TradesDelta {
  /** Newest first. */
  trades: Trade[];
}

export interface Candle {
  /** Unix seconds, bucket start. */
  time: number;
  /** Price in SOL per token; a new bucket opens at the previous close. */
  open: number;
  high: number;
  low: number;
  close: number;
  volumeSol: number;
  buys: number;
  sells: number;
  /** SOL/USD at the bucket's close, for USD conversion. */
  solUsd: number;
}

export interface CandlesSnapshot {
  tf: Timeframe;
  /** Ascending by time. */
  candles: Candle[];
}

export interface CandlesDelta {
  /** The updated current bucket and any new buckets, ascending. */
  candles: Candle[];
}

// ---------------------------------------------------------------------------
// Wallets, positions, transactions
// ---------------------------------------------------------------------------

export interface Position {
  mint: string;
  symbol: string;
  name: string;
  imageUri: string | null;
  launchpad: Launchpad;
  boughtSol: number;
  soldSol: number;
  boughtTokens: number;
  soldTokens: number;
  holdingTokens: number;
  /** Weighted-average cost per token in SOL, base + priority fee + tip included. */
  avgEntryPriceSol: number;
  avgExitPriceSol: number | null;
  /** Cost basis of the tokens still held, SOL. */
  costBasisSol: number;
  realizedPnlSol: number;
  unrealizedPnlSol: number;
  valueSol: number;
  feesSol: number;
  openedAt: number;
  lastTradeAt: number;
  closed: boolean;
}

export interface ActivityItem {
  id: string;
  kind: "buy" | "sell" | "deposit" | "withdraw";
  mint: string | null;
  symbol: string | null;
  solAmount: number;
  tokenAmount: number | null;
  marketCapUsd: number | null;
  ts: number;
  signature: string;
}

/** `wallet:<address>` snapshot. */
export interface WalletStatus {
  address: string;
  solBalance: number;
  /** SOL reserved by armed orders (pre-signed buys, tips); not spendable. */
  reservedSol: number;
  nonceSlots: { used: number; total: number };
  positions: Position[];
  /** Newest first. */
  activity: ActivityItem[];
}

/** Confirmation pushed back over the wallet topic after `POST /api/tx`. */
export interface TxStatusUpdate {
  signature: string;
  status: "received" | "sent" | "landed" | "failed";
  slot: number | null;
  error: string | null;
  lanes: { lane: string; sentMs: number }[];
}

export interface WalletDelta {
  solBalance?: number;
  reservedSol?: number;
  nonceSlots?: { used: number; total: number };
  /** Changed positions only (full objects). */
  positions?: Position[];
  /** New activity items, newest first. */
  activity?: ActivityItem[];
  txs?: TxStatusUpdate[];
}

// ---------------------------------------------------------------------------
// Armed orders (SPEC "Armed orders")
// ---------------------------------------------------------------------------

export type OrderKind =
  | "limit_buy"
  | "limit_sell"
  | "take_profit"
  | "stop_loss"
  | "migration_buy"
  | "migration_sell"
  | "copy_buy"
  | "dev_snipe"
  /** Armed-order kinds of the live engine (@zerofee/core ArmedOrderKind) without a simulated twin. */
  | "trailing_stop"
  | "dca_tranche"
  | "dev_sell_exit";

/** `stale` = the pre-signed transactions can no longer land and the order needs re-arming. */
export type OrderStatus = "armed" | "submitted" | "filled" | "stale" | "cancelled" | "failed";

export interface OrderTrigger {
  /**
   * `mc` triggers on market cap (USD), `price` on SOL price, `migration` on graduation. Live armed
   * orders add `trailing` (value = trail %), `time` (value = not-before, ms) and `dev_sell`.
   */
  metric: "mc" | "price" | "migration" | "leader_buy" | "dev_launch" | "trailing" | "time" | "dev_sell";
  direction: "above" | "below" | null;
  value: number | null;
}

/** `tokens`: a fixed token amount (UI units), how live armed sells that are not full exits are sized. */
export type OrderSize = { kind: "sol"; sol: number } | { kind: "pct"; pct: number } | { kind: "tokens"; tokens: number };

/** One pre-signed variant on an order's min-out grid. */
export interface OrderVariant {
  /** Minimum output: tokens for buys, SOL for sells. */
  minOut: number;
  /** Jito tip this variant pays, SOL. */
  tipSol: number;
}

/**
 * One step in an order's life, oldest first: `armed`, `rearmed`, `triggered` (the server saw the
 * trigger cross), `attempt` (a variant handed to a lane), `filled`, `failed`, `stale`, `cancelled`.
 */
export interface OrderEvent {
  at: number;
  kind: string;
  /** Slot the step happened at, when known. */
  slot: number | null;
  /** Detail for the timeline ("Variant 3 of 6 via Jito", "pump.fun upgrade changed accounts"). */
  reason: string | null;
}

export interface Order {
  id: string;
  mint: string | null;
  symbol: string;
  kind: OrderKind;
  side: "buy" | "sell";
  trigger: OrderTrigger;
  size: OrderSize;
  status: OrderStatus;
  /** Why the order is stale or failed (program upgrade, migration, creator change, ALT closure…). */
  statusReason: string | null;
  /** True when pre-signed durable-nonce transactions let it run with the tab closed. */
  runsWithTabClosed: boolean;
  /** Set when the browser must stay open (the mint isn't known in advance, re-arming…). */
  needsBrowserReason: string | null;
  reservedSol: number;
  /** Durable-nonce slots used; a TP and its SL share one (OCO). */
  nonceSlots: number;
  /** The durable-nonce account the pre-signed transactions use; null when nothing is pre-signed. */
  nonceAccount: string | null;
  /** That account's slot number in the wallet's nonce pool ("#4"); OCO legs share it. */
  nonceIndex: number | null;
  ocoGroupId: string | null;
  landing: LandingPreset;
  /** Pre-signed min-out grid variants held by the server. */
  variants: number;
  /** The variants themselves (min out and tip); empty when the order is signed live. */
  grid: OrderVariant[];
  /** Timeline, oldest first. */
  events: OrderEvent[];
  /** Price (SOL) when the order was armed, for "distance to trigger". */
  armedPriceSol: number | null;
  createdAt: number;
  updatedAt: number;
  filledAt: number | null;
  /** Trigger seen to fill landed, ms (filled orders only). */
  fillLatencyMs: number | null;
  signature: string | null;
  fill: { solAmount: number; tokenAmount: number; priceSol: number } | null;
}

export interface OrdersSnapshot {
  orders: Order[];
}

export interface OrdersDelta {
  upsert: Order[];
  remove: string[];
}

// ---------------------------------------------------------------------------
// Market, trackers, social (provisional topics)
// ---------------------------------------------------------------------------

export interface FeedHealth {
  state: "connected" | "degraded" | "reconnecting" | "offline";
  /** Receive time minus slot time for the latest event, ms. */
  lagMs: number;
  /** Decoded events per second on the ingest stream. */
  eventsPerSec: number;
}

export interface MarketStatus {
  solUsd: number;
  slot: number;
  feed: FeedHealth;
}

/** Lightweight token info attached to tracker and social events. */
export interface TokenRef {
  mint: string;
  symbol: string;
  name: string;
  imageUri: string | null;
  launchpad: Launchpad;
  createdAt: number;
  marketCapUsd: number | null;
}

export interface TrackedTrade {
  trade: Trade;
  token: TokenRef;
}

export interface TrackedTradesSnapshot {
  /** Newest first. */
  items: TrackedTrade[];
}

export interface TrackedTradesDelta {
  items: TrackedTrade[];
}

export interface SocialPost {
  id: string;
  handle: string;
  displayName: string;
  verified: boolean;
  kind: "tweet" | "reply" | "quote" | "retweet" | "profile_update" | "follow";
  text: string;
  ts: number;
  /** Mints detected in the text (contract addresses or cashtags resolved server-side). */
  mentions: TokenRef[];
}

export interface SocialSnapshot {
  posts: SocialPost[];
}

export interface SocialDelta {
  posts: SocialPost[];
}

// ---------------------------------------------------------------------------
// REST shapes
// ---------------------------------------------------------------------------

/** Per-trade latency record (SPEC "Speed checklist"); offsets in ms from the click. */
export interface LatencyBreakdown {
  clickedAt: number;
  builtMs: number;
  signedMs: number;
  /** Server received the signed bytes. */
  receivedMs: number;
  /** Fan-out per landing lane. */
  lanes: { lane: string; sentMs: number }[];
  landedMs: number | null;
  slot: number | null;
}

/** `POST /api/tx`: the browser sends signed bytes; it never sends keys. */
export interface SubmitTxRequest {
  /** Base64 of the signed transaction. */
  tx: string;
  preset: LandingPreset;
  clientTiming: { clickedAt: number; builtAt: number; signedAt: number };
}

export interface SubmitTxResponse {
  signature: string;
  receivedAt: number;
  lanes: { lane: string; sentAt: number }[];
}

export interface WalletSearchHit {
  address: string;
  label: string | null;
  tags: WalletTag[];
  /** Tokens this wallet currently holds in the live set. */
  holdings: number;
}

export interface SearchResults {
  tokens: TokenSummary[];
  wallets: WalletSearchHit[];
}

export interface PnlPoint {
  /** Unix ms, start of day. */
  t: number;
  /** Cumulative PnL in SOL. */
  pnlSol: number;
}
