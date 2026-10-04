/**
 * Decoded pump.fun / PumpSwap events. Layouts: pump-sdk 2.0.0 vendored idl/pump.json and idl/pump_amm.json
 * (https://github.com/pump-fun/pump-public-docs/tree/main/idl). Events only ever gain trailing fields; fields an
 * older program version did not emit decode as 0 / false / "" / [] / default pubkey.
 * Raydium LaunchLab / CPMM events: idl/raydium_launchpad.json and idl/raydium_cp_swap.json (see ./raydium.ts).
 */
import type { Address } from "@solana/kit";

/** pump `CreateEvent` (`create` and `create_v2`). */
export interface PumpCreateEvent {
  kind: "pumpCreate";
  name: string;
  symbol: string;
  uri: string;
  mint: Address;
  bondingCurve: Address;
  /** Signer of the create instruction. */
  user: Address;
  /** Creator recorded on the curve at creation (fee sharing / holder rewards may rewrite it later). */
  creator: Address;
  timestamp: bigint;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  tokenTotalSupply: bigint;
  /** SPL Token for `create`, Token-2022 for `create_v2`. */
  tokenProgram: Address;
  isMayhemMode: boolean;
  isCashbackEnabled: boolean;
  /** `Pubkey::default()` (or wSOL) for SOL curves. */
  quoteMint: Address;
  virtualQuoteReserves: bigint;
  creatorFeeBps: bigint;
  isHolderReward: boolean;
}

export interface Shareholder {
  address: Address;
  shareBps: number;
}

/** Generalized quote-side amounts appended to pump `TradeEvent` in May 2026 (USDC curves). */
export interface PumpTradeQuoteFields {
  mint: Address;
  amount: bigint;
  virtualReserves: bigint;
  realReserves: bigint;
}

/** pump `TradeEvent` (every curve buy/sell variant). Reserves are POST-trade. */
export interface PumpTradeEvent {
  kind: "pumpTrade";
  mint: Address;
  /** Net quote (excl. fees) - `sol_amount`. */
  quoteAmount: bigint;
  tokenAmount: bigint;
  isBuy: boolean;
  user: Address;
  timestamp: bigint;
  /** Post-trade reserves (`virtual_sol_reserves` ...). */
  virtualQuoteReserves: bigint;
  virtualTokenReserves: bigint;
  realQuoteReserves: bigint;
  realTokenReserves: bigint;
  feeRecipient: Address;
  feeBps: bigint;
  fee: bigint;
  /** LIVE `bonding_curve.creator` at trade time. */
  creator: Address;
  creatorFeeBps: bigint;
  creatorFee: bigint;
  trackVolume: boolean;
  /** e.g. "buy", "sell", "buy_exact_sol_in", "buy_v2". */
  ixName: string;
  mayhemMode: boolean;
  cashbackFeeBps: bigint;
  cashback: bigint;
  buybackFeeBps: bigint;
  buybackFee: bigint;
  shareholders: Shareholder[];
  /** Trailing quote fields; null when the event predates them. */
  quote: PumpTradeQuoteFields | null;
  holderRewardsBps: bigint;
  holderRewards: bigint;
}

/** pump `CompleteEvent`: the curve's real token reserves hit zero (emitted inside the completing buy). */
export interface PumpCompleteEvent {
  kind: "pumpComplete";
  user: Address;
  mint: Address;
  bondingCurve: Address;
  timestamp: bigint;
  quoteMint: Address;
}

/** pump `CompletePumpAmmMigrationEvent`: `migrate` moved the curve's liquidity into a canonical PumpSwap pool. */
export interface PumpMigrationEvent {
  kind: "pumpMigrate";
  user: Address;
  mint: Address;
  mintAmount: bigint;
  solAmount: bigint;
  poolMigrationFee: bigint;
  bondingCurve: Address;
  timestamp: bigint;
  pool: Address;
  quoteMint: Address;
}

/** PumpSwap `CreatePoolEvent`. */
export interface AmmCreatePoolEvent {
  kind: "ammCreatePool";
  timestamp: bigint;
  index: number;
  creator: Address;
  baseMint: Address;
  quoteMint: Address;
  baseMintDecimals: number;
  quoteMintDecimals: number;
  baseAmountIn: bigint;
  quoteAmountIn: bigint;
  poolBaseAmount: bigint;
  poolQuoteAmount: bigint;
  minimumLiquidity: bigint;
  initialLiquidity: bigint;
  lpTokenAmountOut: bigint;
  poolBump: number;
  pool: Address;
  lpMint: Address;
  userBaseTokenAccount: Address;
  userQuoteTokenAccount: Address;
  coinCreator: Address;
  isMayhemMode: boolean;
  creatorFeeBps: bigint;
  canEditCreatorFee: boolean;
  isHolderReward: boolean;
}

/** PumpSwap `BuyEvent` / `SellEvent`. NOTE: carries the pool but NOT the base mint. */
export interface AmmSwapEvent {
  kind: "ammBuy" | "ammSell";
  timestamp: bigint;
  /** buy: base_amount_out; sell: base_amount_in. */
  baseAmount: bigint;
  /** buy: max_quote_amount_in; sell: min_quote_amount_out. */
  quoteLimit: bigint;
  userBaseReserves: bigint;
  userQuoteReserves: bigint;
  /** PRE-trade raw vault balances. */
  poolBaseReserves: bigint;
  poolQuoteReserves: bigint;
  /**
   * buy: quote_amount_in - pre-fee for `buy`, but the TOTAL paid incl. fees for `buy_exact_quote_in`;
   * sell: quote_amount_out (pre-fee).
   */
  quoteAmount: bigint;
  lpFeeBps: bigint;
  lpFee: bigint;
  protocolFeeBps: bigint;
  protocolFee: bigint;
  /** buy: quote_amount_in_with_lp_fee (what enters the quote vault); sell: quote_amount_out_without_lp_fee (what leaves it). */
  quoteAmountVault: bigint;
  /**
   * buy: user_quote_amount_in - total paid for `buy`, but the pre-fee amount for `buy_exact_quote_in` (the two
   * fields swap meaning; observed on a mainnet fork 2026-10-03, see docs/dev/FORK_TESTING.md); sell:
   * user_quote_amount_out (received).
   */
  userQuoteAmount: bigint;
  pool: Address;
  user: Address;
  userBaseTokenAccount: Address;
  userQuoteTokenAccount: Address;
  protocolFeeRecipient: Address;
  protocolFeeRecipientTokenAccount: Address;
  coinCreator: Address;
  coinCreatorFeeBps: bigint;
  coinCreatorFee: bigint;
  /** buy only ("" for sells). */
  ixName: string;
  cashbackFeeBps: bigint;
  cashback: bigint;
  buybackFeeBps: bigint;
  buybackFee: bigint;
  /** Signed Pool.virtual_quote_reserves at trade time (boost pools); effective quote = vault + this. */
  virtualQuoteReserves: bigint;
  canBoost: boolean;
  /** Base mint supply (0 when the event predates the field). */
  baseSupply: bigint;
  holderRewardsBps: bigint;
  holderRewards: bigint;
}

/**
 * Raydium LaunchLab `TradeEvent` (every buy/sell variant). Same discriminator as pump's `TradeEvent`: only
 * decoded when attributed to the LaunchLab program.
 */
export interface LaunchLabTradeEvent {
  kind: "launchlabTrade";
  pool: Address;
  totalBaseSell: bigint;
  virtualBase: bigint;
  virtualQuote: bigint;
  realBaseBefore: bigint;
  realQuoteBefore: bigint;
  realBaseAfter: bigint;
  realQuoteAfter: bigint;
  /** buy: quote into the vault (after the quote transfer fee); sell: base into the vault (after the transfer fee). */
  amountIn: bigint;
  /** buy: base out of the vault (before the base transfer fee); sell: quote out of the vault, net of fees. */
  amountOut: bigint;
  protocolFee: bigint;
  platformFee: bigint;
  creatorFee: bigint;
  shareFee: bigint;
  isBuy: boolean;
  /** Pool status after the trade (LAUNCHLAB_POOL_STATUS; 1 = curve complete, waiting for migration). */
  poolStatus: number;
  exactIn: boolean;
}

/** Raydium LaunchLab `PoolCreateEvent` (`initialize` / `initialize_v2` / `initialize_with_token_2022`). */
export interface LaunchLabPoolCreateEvent {
  kind: "launchlabPoolCreate";
  pool: Address;
  creator: Address;
  /** GlobalConfig the pool uses. */
  config: Address;
  decimals: number;
  name: string;
  symbol: string;
  uri: string;
  /** CurveParams variant: 0 constant, 1 fixed, 2 linear. */
  curveType: number;
  supply: bigint;
  /** Constant curves only (0 otherwise). */
  totalBaseSell: bigint;
  totalQuoteFundRaising: bigint;
  migrateType: number;
  totalLockedAmount: bigint;
  cliffPeriod: bigint;
  unlockPeriod: bigint;
  /** 0 quote token, 1 both tokens. */
  ammFeeOn: number;
}

/** Raydium CPMM `SwapEvent` (`swap_base_input` / `swap_base_output`). Logged only: CPMM has no event-CPI. */
export interface CpmmSwapEvent {
  kind: "cpmmSwap";
  pool: Address;
  /** Vault balances net of fees owed, before the swap. */
  inputVaultBefore: bigint;
  outputVaultBefore: bigint;
  /** Excluding transfer fees. */
  inputAmount: bigint;
  outputAmount: bigint;
  inputTransferFee: bigint;
  outputTransferFee: bigint;
  baseInput: boolean;
  inputMint: Address;
  outputMint: Address;
  tradeFee: bigint;
  creatorFee: bigint;
  creatorFeeOnInput: boolean;
}

export type RaydiumEvent = LaunchLabTradeEvent | LaunchLabPoolCreateEvent | CpmmSwapEvent;

export type DecodedEvent =
  | PumpCreateEvent
  | PumpTradeEvent
  | PumpCompleteEvent
  | PumpMigrationEvent
  | AmmCreatePoolEvent
  | AmmSwapEvent
  | RaydiumEvent;

export type DecodedEventKind = DecodedEvent["kind"];

/** A known discriminator whose body is malformed (truncated inside a required field, corrupt length prefix ...). */
export class EventDecodeError extends Error {
  constructor(
    readonly eventKind: DecodedEventKind,
    message: string,
  ) {
    super(`${eventKind}: ${message}`);
    this.name = "EventDecodeError";
  }
}
