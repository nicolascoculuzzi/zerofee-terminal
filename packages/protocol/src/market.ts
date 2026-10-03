/**
 * Market data shapes: token summaries (Pulse cards, token header), trades, candles and trade contexts.
 *
 * Encoding conventions (JSON on the wire):
 *  - Addresses are base58 strings.
 *  - Exact on-chain integers (u64/i128 base units: reserves, amounts) are DECIMAL STRINGS (no bigint in JSON).
 *  - Display values are JS numbers: prices and market caps in SOL (non-SOL quotes are converted at the
 *    current SOL/USD rate), USD values, percentages in 0-100.
 *  - Times are epoch milliseconds.
 *  - `null` means "not known / not computed by this deployment", never zero.
 */

/** Where the token trades / launched. More launchpads (LaunchLab, Meteora DBC) arrive in later phases. */
export type Launchpad = "pump" | "pumpswap";

export interface TokenSocials {
  x: string | null;
  telegram: string | null;
  website: string | null;
}

/**
 * Everything a Pulse card, the Pulse filters and the token header need. Metric definitions follow
 * SPEC.md "Token metric definitions"; see the server's /api/health `metrics` block for the live config.
 */
export interface TokenSummary {
  mint: string;
  /** "" until the CreateEvent (or metadata bootstrap) is seen. */
  name: string;
  symbol: string;
  /** Image URL from the metadata JSON (IPFS URLs rewritten to a public gateway); null until fetched. */
  image: string | null;
  description: string | null;
  launchpad: Launchpad;
  /** Normalized quote mint: wSOL for SOL pairs, USDC mint for USDC pairs. */
  quoteMint: string;
  /** Owner program of the mint (Token or Token-2022). */
  tokenProgram: string | null;
  decimals: number;
  /** Total supply in UI units (1e9 for standard pump coins, 2e9 for mayhem). */
  supply: number;
  /** Creation time (block time of the CreateEvent); null if creation was not observed. */
  createdAt: number | null;
  createdSlot: number | null;
  /** Live creator (`bonding_curve.creator` / `pool.coin_creator`). */
  creator: string | null;
  /**
   * Price in SOL per whole token. For non-SOL quotes this is converted (USDC via SOL/USD); it is 0 when
   * the quote's SOL value is unknown (exotic quote mints) - use priceQuote / mcQuote then.
   */
  priceSol: number;
  priceUsd: number | null;
  mcSol: number;
  mcUsd: number | null;
  /** Price and market cap in quote-mint UI units (always known). */
  priceQuote: number;
  mcQuote: number;
  /** Quote-side liquidity in SOL: real quote reserves on the curve, the quote vault on PumpSwap. */
  liquidity: number;
  liquidityUsd: number | null;
  /** Rolling volume in SOL. */
  volume5m: number;
  volume1h: number;
  volume24h: number;
  /** Rolling 24 h trade counts. */
  txns: number;
  buys: number;
  sells: number;
  /** Wallets with a positive balance (tracked from trades); null when the token's history was not observed. */
  holders: number | null;
  /** % of supply held by the 10 largest holders, excluding the curve, pool vaults and burn addresses. */
  top10Pct: number | null;
  /** % of supply held by the dev wallets (live creator, plus the original creator if fee sharing rewrote it). */
  devPct: number | null;
  /** % of supply held by snipers (non-dev wallets whose first buy landed within N slots of creation). */
  snipersPct: number | null;
  /** % of supply held by insiders. null: needs transfer/funding data (not computed yet). */
  insidersPct: number | null;
  /** % of supply held by bundlers (creation-slot co-buyers, N+ distinct buyers in one slot, multi-wallet txs). */
  bundlersPct: number | null;
  /** Distinct traders routing through known terminal fee wallets; null when the source lacks account keys. */
  proTraders: number | null;
  /** 0..10000; 10000 once the curve is complete or migrated. */
  bondingProgressBps: number;
  /** Curve completed (real token reserves hit 0), migration may still be pending. */
  complete: boolean;
  migrated: boolean;
  migratedAt: number | null;
  /** Canonical PumpSwap pool after migration (or the pool a pool-only token trades in). */
  pool: string | null;
  socials: TokenSocials;
  /** DexScreener "Dex Paid"; null = not checked. */
  dexPaid: boolean | null;
  athMcSol: number;
  isMayhem: boolean;
  lastTradeAt: number | null;
  /** Last time any field changed. */
  updatedAt: number;
}

/** Partial update of a token; always carries the mint. A token entering a list is sent in full. */
export type TokenPatch = Partial<TokenSummary> & { mint: string };

/** `pulse:*` snapshot. Order: new = newest first; final = highest progress first; migrated = most recent first. */
export interface PulseSnapshot {
  tokens: TokenSummary[];
}

/** `pulse:*` delta: upserts (full summary for tokens new to the list, patches otherwise) and removals. */
export interface PulseDelta {
  upsert: TokenPatch[];
  remove: string[];
}

export type TradeSide = "buy" | "sell";
export type TradeVenue = "pump" | "pumpswap";
export type TradeTag = "dev" | "sniper" | "bundler" | "pro";

export interface Trade {
  /** `${signature}:${eventIndex}` - unique per trade event. */
  id: string;
  signature: string;
  slot: number;
  /** Position in the block when the source knows it (gRPC), else null. */
  txIndex: number | null;
  mint: string;
  venue: TradeVenue;
  side: TradeSide;
  trader: string;
  /** Quote amount in quote base units (lamports for SOL pairs), excluding fees. */
  quoteAmount: string;
  /** Token amount in base units. */
  tokenAmount: string;
  /** Quote amount in SOL (display). */
  amountSol: number;
  amountUsd: number | null;
  /** Post-trade price in SOL per whole token. */
  priceSol: number;
  /** Post-trade market cap in SOL. */
  mcSol: number;
  /** Block time (event timestamp, 1 s resolution) in ms. */
  blockTime: number;
  /** When the server received it (ms). receivedAt - blockTime = detection latency (+/- 1 s). */
  receivedAt: number;
  tags: TradeTag[];
}

/** `trades:<mint>` snapshot: most recent trades, newest first. */
export interface TradesSnapshot {
  trades: Trade[];
}

/** `trades:<mint>` delta: new trades since the last frame, oldest first (prepend in order). */
export interface TradesDelta {
  trades: Trade[];
}

/** `trades:<mint>` correction: trades to drop (dead slot / fork) and trades to insert out of order. */
export interface TradesCorrection {
  remove: string[];
  upsert: Trade[];
}

/**
 * One OHLCV bucket. OHLC is the price in SOL per whole token; market-cap candles are `price * supply`
 * (supply is in the candles snapshot and constant for launchpad coins). `solUsd` is the SOL/USD rate at
 * the bucket's last update, for USD charts.
 */
export interface Candle {
  /** Bucket start (ms). */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Volume in SOL. */
  v: number;
  /** Number of trades. */
  n: number;
  solUsd: number | null;
}

export interface CandlesSnapshot {
  /** Supply in UI units: multiply OHLC by it for market-cap candles. */
  supply: number;
  /** Oldest first. */
  candles: Candle[];
}

/** Upserts of the open bucket(s), oldest first. */
export interface CandlesDelta {
  candles: Candle[];
}

/** Rewritten historical buckets after late or dead-slot events. */
export interface CandlesCorrection {
  candles: Candle[];
}

interface TradeContextBase {
  mint: string;
  /** Owner program of the mint - pass it as the base token program. */
  tokenProgram: string;
  decimals: number;
  /** Total supply in base units. */
  supply: string;
  /** Normalized quote mint (wSOL for SOL). */
  quoteMint: string;
  quoteTokenProgram: string;
  quoteDecimals: number;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  isHolderReward: boolean;
  /** Per-coin creator fee override in bps ("0" = schedule rate). */
  creatorFeeBps: string;
  /** Slot of the event that produced these reserves. */
  slot: number;
  updatedAt: number;
}

/**
 * Bonding-curve trade inputs (maps onto @zerofee/core `BondingCurve`). Global / FeeConfig are
 * program-wide and come from GET /api/program-accounts.
 */
export interface CurveTradeContext extends TradeContextBase {
  venue: "pump";
  bondingCurve: string;
  virtualTokenReserves: string;
  virtualQuoteReserves: string;
  realTokenReserves: string;
  realQuoteReserves: string;
  tokenTotalSupply: string;
  complete: boolean;
  /** LIVE creator: derive creator_vault from this, never from the CreateEvent. */
  creator: string;
  /** creator_vault PDA derived from `creator` (pump "creator-vault" seed). */
  creatorVault: string;
  /** Set when the curve completed: trading moves to the pool once `migrated` flips. */
  migrated: boolean;
  pool: string | null;
}

/** PumpSwap pool trade inputs (maps onto @zerofee/core `Pool` + `AmmReserves`). */
export interface PoolTradeContext extends TradeContextBase {
  venue: "pumpswap";
  pool: string;
  poolIndex: number;
  /** pool.creator (== pool_authority PDA of the mint for canonical pump pools). */
  poolCreator: string;
  isCanonical: boolean;
  lpMint: string;
  lpSupply: string;
  poolBaseTokenAccount: string;
  poolQuoteTokenAccount: string;
  /** Raw base vault balance (post last trade). */
  baseReserve: string;
  /** Raw quote vault balance (post last trade). */
  quoteVaultReserve: string;
  /** Signed Pool.virtual_quote_reserves; effective quote reserve = quoteVaultReserve + this. */
  virtualQuoteReserves: string;
  /** LIVE pool.coin_creator. */
  coinCreator: string;
  /** PumpSwap "creator_vault" PDA of coinCreator. */
  coinCreatorVaultAuthority: string;
  canEditCreatorFee: boolean;
}

export type TradeContext = CurveTradeContext | PoolTradeContext;
