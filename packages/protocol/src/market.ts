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
 *  - SOL-denominated values (`*Sol`, `liquidity`, `volume*`) are null when the token's quote has no known SOL
 *    value right now: an exotic quote mint (anything but SOL / wSOL and USDC), or a USDC pair before the
 *    server has a SOL/USD rate. The quote-unit values (`priceQuote`, `mcQuote`) stay known (they are null only
 *    until the token has reserves and its quote mint's decimals are known).
 *
 * Filtering on a nullable metric (Pulse filters, copy-trade filters, alerts): null is "unknown", not 0.
 * A token whose value is null does not satisfy a min or a max on that metric (it is excluded while the
 * filter is active), and an alert on it neither fires nor re-arms until the value is known again.
 */

/**
 * Where the token launched (or, for pool-only listings, where it trades):
 *  - "pump"       a pump.fun coin (bonding curve, then its canonical PumpSwap pool after migration);
 *  - "pumpswap"   a token the server only saw trading in a PumpSwap pool (not listed in Pulse);
 *  - "launchlab"  a Raydium LaunchLab coin (BONK.fun / letsbonk.fun, StonkFun, TRiX, Raydium's own launchpad):
 *                 bonding curve, then its Raydium CPMM pool after graduation. `TokenSummary.platform` names the
 *                 launchpad that runs the curve;
 *  - "cpmm"       a token only seen in a Raydium CPMM pool. Reserved: the server tracks CPMM pools of graduated
 *                 LaunchLab coins only (those keep "launchlab"), so it does not emit this value yet.
 * New values may be added; treat unknown ones as "other".
 */
export type Launchpad = "pump" | "pumpswap" | "launchlab" | "cpmm";

export interface TokenSocials {
  x: string | null;
  telegram: string | null;
  website: string | null;
}

/**
 * Where a token's holder balances were last reconciled from (see `TokenSummary.holdersSource`):
 *  - "trades": only our own trade-based book (live, but blind to wallet-to-wallet transfers);
 *  - "rpc": the 20 largest token accounts (`getTokenLargestAccounts`) corrected the biggest balances;
 *  - "das": a full token-account scan (Helius DAS `getTokenAccounts`) reset every balance.
 */
export type HoldersSource = "trades" | "rpc" | "das";

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
  /**
   * Launchpad label for LaunchLab coins, from the curve's PlatformConfig (its on-chain `name`): "letsbonk.fun",
   * "StonkFun", "TRiX", "Raydium" ... A display label only (fees and graduation always come from the live
   * accounts). null while unknown and for other launchpads; absent from servers that predate it.
   */
  platform?: string | null;
  /**
   * Normalized quote mint: wSOL for SOL pairs, USDC mint for USDC pairs, else the pair's own quote (LaunchLab
   * coins are often quoted in other tokens: xStocks, USD1, even pump.fun coins; their SOL values are null).
   */
  quoteMint: string;
  /** Owner program of the mint (Token or Token-2022). */
  tokenProgram: string | null;
  decimals: number;
  /** Total supply in UI units (1e9 for standard pump coins, 2e9 for mayhem). */
  supply: number;
  /**
   * Creation time (block time of the CreateEvent / LaunchLab PoolCreateEvent; LaunchLab events carry no timestamp,
   * so the block time when the source has it, else the server's receive time); null if creation was not observed.
   */
  createdAt: number | null;
  createdSlot: number | null;
  /** Live creator (`bonding_curve.creator` / `pool.coin_creator`; LaunchLab: the pool's `creator`). */
  creator: string | null;
  /**
   * Price in SOL per whole token. For non-SOL quotes this is converted (USDC via SOL/USD). null when the
   * price or the quote's SOL value is unknown (exotic quote mints; USDC before a SOL/USD rate) - use
   * priceQuote / mcQuote then. Never 0 for "unknown".
   */
  priceSol: number | null;
  priceUsd: number | null;
  /**
   * priceSol x supply (the real mint supply: 2B for mayhem coins). A standard SOL curve starts at ~28 SOL
   * (30 virtual SOL / 1.073B virtual tokens x 1B), a mayhem curve at ~56 SOL, but mayhem curves can then sit
   * far below either: the Mayhem agent's trades rewrite the curve's virtual SOL reserves (virtual minus real SOL
   * seen anywhere from 0.009 to 44.5 SOL instead of 30), so caps of 0.01-1 SOL are real there, not a feed error.
   */
  mcSol: number | null;
  mcUsd: number | null;
  /**
   * Price and market cap in quote-mint UI units: known whatever the quote's SOL value, null only while the
   * token has no reserves or its quote mint's decimals are still being looked up.
   */
  priceQuote: number | null;
  mcQuote: number | null;
  /**
   * Quote-side liquidity in SOL: real quote reserves on the curve (LaunchLab: the quote raised), the quote vault on
   * PumpSwap, the quote reserve net of fees owed on Raydium CPMM.
   */
  liquidity: number | null;
  liquidityUsd: number | null;
  /** Rolling volume in SOL. */
  volume5m: number | null;
  volume1h: number | null;
  volume24h: number | null;
  /** Rolling 24 h trade counts. */
  txns: number;
  buys: number;
  sells: number;
  /**
   * Wallets with a positive balance, excluding the curve, pool vaults and burn addresses. Tracked live from
   * trades and periodically reconciled against the chain (see `holdersSource`); null when the token's
   * history was not observed.
   */
  holders: number | null;
  /** % of supply held by the 10 largest holders, excluding the curve, pool vaults and burn addresses. */
  top10Pct: number | null;
  /**
   * Last reconciliation of the balances behind `holders`, `top10Pct`, `devPct`, `snipersPct`, `bundlersPct`
   * and `insidersPct`: "trades" = never reconciled (our trade-based book only); "rpc" = the 20 largest token
   * accounts corrected the biggest balances at `holdersCheckedAt` (top10Pct exact then, the holder count
   * still trade-based); "das" = a full token-account scan at `holdersCheckedAt` reset every balance (holder
   * count and top10Pct exact then). Trades after the reconciliation keep moving the numbers live.
   * Reconciled tokens: the focused token and the Final Stretch / Migrated lists. null when holders are null.
   */
  holdersSource: HoldersSource | null;
  /** When the holder balances were last reconciled against the chain (ms); null if never. */
  holdersCheckedAt: number | null;
  /** % of supply held by the dev wallets (live creator, plus the original creator if fee sharing rewrote it). */
  devPct: number | null;
  /** The dev wallets held tokens and now hold none (sold or moved everything). null when holders are null. */
  devSoldAll: boolean | null;
  /**
   * Earlier launches by this token's creator (the creator recorded at creation) that the server's database
   * saw, and how many of them migrated. A lower bound: the database only covers launches since the server
   * started recording. null when the creator is unknown.
   */
  devLaunches: number | null;
  devMigrated: number | null;
  /** % of supply held by snipers (non-dev wallets whose first buy landed within N slots of creation). */
  snipersPct: number | null;
  /**
   * % of supply held by insiders: holders who received tokens by transfer and never bought, plus wallets the
   * creator funded within two hops (funder = first incoming SOL transfer, from Helius `funded-by`).
   * null when the server has no HELIUS_API_KEY (or its plan lacks funded-by), when the token's history was
   * not observed, or until the token's top holders have been checked (only tokens likely to be shown are).
   */
  insidersPct: number | null;
  /**
   * % of supply held by bundlers: non-dev creation-slot co-buyers; N+ distinct buyers in one slot whose buy
   * sizes fall in a tight band or who share one funder (funder data optional); several wallets in one tx.
   */
  bundlersPct: number | null;
  /**
   * Distinct traders whose swap transactions paid a known terminal fee wallet (the server's curated,
   * source-cited registry: Axiom, GMGN, Photon, Trojan, Maestro ...). null when the ingest source lacks
   * account keys (the RPC logs feed); the Yellowstone feed has them.
   */
  proTraders: number | null;
  /**
   * 0..10000; 10000 once the curve is complete or migrated. pump: tokens sold / initial real token reserves;
   * LaunchLab: base sold / the curve's own total_base_sell (its graduation point).
   */
  bondingProgressBps: number;
  /** Curve completed (real token reserves hit 0), migration may still be pending. */
  complete: boolean;
  migrated: boolean;
  migratedAt: number | null;
  /**
   * Canonical PumpSwap pool after migration (or the pool a pool-only token trades in); for LaunchLab coins the
   * Raydium CPMM pool they graduated into (null while on the curve).
   */
  pool: string | null;
  socials: TokenSocials;
  /**
   * DexScreener "Dex Paid": `/orders/v1/solana/{mint}` lists an approved `tokenProfile` order. null = not
   * checked yet (only tokens likely to be shown are checked: the focused token, Final Stretch, Migrated and
   * recently active tokens, plus any token that appears in DexScreener's new-profiles feed).
   */
  dexPaid: boolean | null;
  /** Payment time of the approved token profile (ms), when `dexPaid` is true. */
  dexPaidAt: number | null;
  /** Highest mcSol seen while the server watched the token; null while no SOL value was ever known. */
  athMcSol: number | null;
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
/**
 * Where a trade executed: the pump.fun curve, a PumpSwap pool, a Raydium LaunchLab curve, or a Raydium CPMM pool
 * (where LaunchLab coins graduate). New values may be added.
 */
export type TradeVenue = "pump" | "pumpswap" | "launchlab" | "cpmm";
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
  /**
   * The trading wallet (pump / PumpSwap: the event's `user`; Raydium: the swap instruction's payer). "" when the
   * source could not attribute the trade: Raydium events carry no wallet, so the RPC logs feed only knows it once
   * it fetched the transaction (see RPC_LOGS_TX_FETCH_RPS); such trades do not move holder balances.
   */
  trader: string;
  /**
   * Quote amount in quote base units (lamports for SOL pairs), excluding fees: what entered or left the curve /
   * pool reserves (Raydium: trade, platform and creator fees removed; Token-2022 transfer fees excluded).
   */
  quoteAmount: string;
  /**
   * Token amount in base units. For Token-2022 coins with a transfer fee (StonkFun): what the trader received
   * (buys) or sent (sells), so the fee the token program withholds is on the pool's side of the amount.
   */
  tokenAmount: string;
  /** Quote amount in SOL (display); null when the quote's SOL value is unknown (see the header note). */
  amountSol: number | null;
  amountUsd: number | null;
  /** Post-trade price in SOL per whole token; null when unknown. */
  priceSol: number | null;
  /** Post-trade market cap in SOL (price x the token's supply); null when unknown. */
  mcSol: number | null;
  /**
   * Block time (event timestamp, 1 s resolution) in ms. Raydium events carry no timestamp: the block time when the
   * source knows it, else the server's receive time.
   */
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
  /** pump coin flags (false on Raydium venues). */
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  isHolderReward: boolean;
  /** Per-coin creator fee override in bps ("0" = schedule rate; "0" on Raydium venues, which use the rates below). */
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

/**
 * A Token-2022 TransferFeeConfig (core `TransferFeeConfig`): the token program withholds
 * min(amount x basisPoints / 10000, maximumFee) on every transfer, using `older` while the current epoch is below
 * `newer.epoch`. StonkFun coins carry 300 bps; xStock quotes may carry one too.
 */
export interface TransferFeeInfo {
  older: { epoch: string; maximumFee: string; basisPoints: number };
  newer: { epoch: string; maximumFee: string; basisPoints: number };
}

/**
 * Raydium LaunchLab bonding-curve trade inputs: everything @zerofee/core needs to quote and build a LaunchLab trade
 * (buildLaunchLabBuyInstructions / buildLaunchLabSellInstructions, quoteLaunchLab*, launchLabTradeParams), so the
 * browser can build without an RPC round trip. Maps onto core `LaunchLabPool` (+ GlobalConfig / PlatformConfig rates):
 *   pool keys     { globalConfig, platformConfig, baseMint: mint, quoteMint, baseVault, quoteVault, creator, tokenProgramFlag }
 *   curve state   { status, virtualBase, virtualQuote, realBase, realQuote, totalBaseSell, totalQuoteFundRaising }
 *   trade params  { curveType, protocolFeeRate, platformFeeRate, creatorFeeRate, shareFeeRate: 0 }
 *   transfer fees { base: baseTransferFee, quote: quoteTransferFee, epoch }
 * Rates are parts per million of the quote amount. The firewall only signs share_fee_rate 0 on the pool PDA
 * ["pool", base, quote] (verify `pool` against it before signing).
 */
export interface LaunchLabTradeContext extends TradeContextBase {
  venue: "launchlab";
  /** LaunchLab pool (PoolState) PDA ["pool", mint, quoteMint]. */
  pool: string;
  globalConfig: string;
  platformConfig: string;
  /** Launchpad label from the PlatformConfig (letsbonk.fun, StonkFun, TRiX, Raydium); display only. */
  platform: string | null;
  baseVault: string;
  quoteVault: string;
  /** PoolState.creator: the creator fee vault is PDA [creator, quoteMint]. */
  creator: string;
  /** PoolState.token_program_flag: bit 0 = base is Token-2022, bit 1 = quote is Token-2022. */
  tokenProgramFlag: number;
  /** 0 funding (tradable), 1 curve complete (waiting for migration), 2 migrated (trade on CPMM). */
  status: number;
  /** Where the coin graduates: 1 = Raydium CPMM (supported), 0 = Raydium AMM v4 (not built by core). */
  migrateType: number;
  virtualBase: string;
  virtualQuote: string;
  /** Base sold so far (grows on buys). */
  realBase: string;
  /** Quote raised so far, net of fees. */
  realQuote: string;
  /** The curve completes when realBase reaches this (bonding progress = realBase / totalBaseSell). */
  totalBaseSell: string;
  /** Graduation fund-raising target. */
  totalQuoteFundRaising: string;
  /** GlobalConfig.curve_type (only 0, constant product, exists on mainnet). */
  curveType: number;
  /** GlobalConfig.trade_fee_rate, PlatformConfig.fee_rate and PlatformConfig.creator_fee_rate (ppm). */
  protocolFeeRate: string;
  platformFeeRate: string;
  creatorFeeRate: string;
  /** Token-2022 transfer fees of the coin and the quote; null when the mint has none. */
  baseTransferFee: TransferFeeInfo | null;
  quoteTransferFee: TransferFeeInfo | null;
  /** Epoch the transfer fees were evaluated for (slot / 432,000); use the live Clock when it moved on. */
  epoch: string;
  /**
   * The CPMM pool the coin graduates into: PDA ["pool", PlatformConfig.cpswap_config, token0, token1] from the
   * LIVE PlatformConfig (core launchLabGraduationPoolContext). null until the PlatformConfig was read.
   */
  graduationPool: string | null;
  /** PlatformConfig.cpswap_config and platform_cp_creator (migration snipes are armed against them). */
  cpswapConfig: string | null;
  platformCpCreator: string | null;
}

/**
 * Raydium CPMM pool trade inputs (graduated LaunchLab coins): maps onto core `CpmmPoolKeys` / `CpmmPoolState`,
 * `cpmmFeeRates` and quoteCpmmSwapBaseInput / buildCpmmSwapInstructions. `token0Reserve` / `token1Reserve` are
 * the vault balances NET of the protocol, fund and creator fees the pool still owes (what the swap math prices
 * with): pass them as `vault0Amount` / `vault1Amount` with zero fees owed.
 */
export interface CpmmTradeContext extends TradeContextBase {
  venue: "cpmm";
  pool: string;
  ammConfig: string;
  /** PoolState.pool_creator (informational: no swap account derives from it). */
  poolCreator: string;
  token0Mint: string;
  token1Mint: string;
  token0Vault: string;
  token1Vault: string;
  token0Program: string;
  token1Program: string;
  /** Observation PDA ["observation", pool]. */
  observation: string;
  lpMint: string;
  /** Bit set = disabled: 1 deposit, 2 withdraw, 4 swap. */
  status: number;
  /** Swaps fail before this unix time. */
  openTime: string;
  /** 0 both tokens (creator fee on the input), 1 only token0, 2 only token1. */
  creatorFeeOn: number;
  enableCreatorFee: boolean;
  token0Reserve: string;
  token1Reserve: string;
  /** AmmConfig rates (ppm). creatorFeeRate applies only when enableCreatorFee (core cpmmFeeRates). */
  tradeFeeRate: string;
  protocolFeeRate: string;
  fundFeeRate: string;
  creatorFeeRate: string;
  baseTransferFee: TransferFeeInfo | null;
  quoteTransferFee: TransferFeeInfo | null;
  epoch: string;
  /** The LaunchLab pool the coin graduated from, and its launchpad label. */
  launchLabPool: string | null;
  platform: string | null;
}

export type TradeContext = CurveTradeContext | PoolTradeContext | LaunchLabTradeContext | CpmmTradeContext;
