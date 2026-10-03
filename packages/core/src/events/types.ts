/**
 * Decoded pump.fun / PumpSwap events. Layouts: pump-sdk 2.0.0 vendored idl/pump.json and idl/pump_amm.json
 * (https://github.com/pump-fun/pump-public-docs/tree/main/idl). Events only ever gain trailing fields; fields an
 * older program version did not emit decode as 0 / false / "" / [] / default pubkey.
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
  /** buy: quote_amount_in (pre-fee); sell: quote_amount_out (pre-fee). */
  quoteAmount: bigint;
  lpFeeBps: bigint;
  lpFee: bigint;
  protocolFeeBps: bigint;
  protocolFee: bigint;
  /** buy: quote_amount_in_with_lp_fee (what enters the quote vault); sell: quote_amount_out_without_lp_fee (what leaves it). */
  quoteAmountVault: bigint;
  /** buy: user_quote_amount_in (total paid); sell: user_quote_amount_out (received). */
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

export type DecodedEvent = PumpCreateEvent | PumpTradeEvent | PumpCompleteEvent | PumpMigrationEvent | AmmCreatePoolEvent | AmmSwapEvent;

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
