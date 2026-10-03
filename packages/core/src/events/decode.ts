/**
 * Borsh decoders for the pump.fun / PumpSwap events a market-data feed needs. Input is the event payload
 * `disc(8) + borsh`, as found in `Program data: <base64>` log lines or after the 8-byte EVENT_IX_TAG of an
 * event-CPI inner instruction.
 *
 * Tolerance rules (events only gain trailing fields):
 *  - fields after the last *required* one may be missing and decode as 0 / false / "" / [] / default pubkey;
 *  - bytes after the last known field are ignored;
 *  - a payload that ends inside a required field, or a corrupt String/Vec length, throws EventDecodeError.
 */
import type { Address } from "@solana/kit";
import { EVENT_DISCRIMINATORS, PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID } from "../constants";
import { Reader, startsWith } from "../util/bytes";
import {
  type AmmCreatePoolEvent,
  type AmmSwapEvent,
  type DecodedEvent,
  type DecodedEventKind,
  EventDecodeError,
  type PumpCompleteEvent,
  type PumpCreateEvent,
  type PumpMigrationEvent,
  type PumpTradeEvent,
  type Shareholder,
} from "./types";

const DISC_LEN = 8;
/** pump caps name/symbol/uri at 32/13/200 characters (COIN_CREATION.md); allow UTF-8 headroom. */
const MAX_NAME_BYTES = 256;
const MAX_URI_BYTES = 1024;
const MAX_IX_NAME_BYTES = 64;
const MAX_SHAREHOLDERS = 64;

function requireUpTo(kind: DecodedEventKind, r: Reader, end: number): void {
  if (end > r.length) throw new EventDecodeError(kind, `payload ends at ${r.length} inside required fields (need ${end})`);
}

function str(kind: DecodedEventKind, r: Reader, max: number): string {
  try {
    return r.string(max);
  } catch (e) {
    throw new EventDecodeError(kind, e instanceof Error ? e.message : String(e));
  }
}

function decodePumpCreate(r: Reader): PumpCreateEvent {
  const k = "pumpCreate" as const;
  const name = str(k, r, MAX_NAME_BYTES);
  const symbol = str(k, r, MAX_NAME_BYTES);
  const uri = str(k, r, MAX_URI_BYTES);
  const mint = r.pubkey();
  const bondingCurve = r.pubkey();
  const user = r.pubkey();
  const creator = r.pubkey();
  const timestamp = r.i64();
  const virtualTokenReserves = r.u64();
  const virtualSolReserves = r.u64();
  const realTokenReserves = r.u64();
  const tokenTotalSupply = r.u64();
  requireUpTo(k, r, r.offset);
  return {
    kind: k,
    name,
    symbol,
    uri,
    mint,
    bondingCurve,
    user,
    creator,
    timestamp,
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    tokenTotalSupply,
    tokenProgram: r.pubkey(),
    isMayhemMode: r.bool(),
    isCashbackEnabled: r.bool(),
    quoteMint: r.pubkey(),
    virtualQuoteReserves: r.u64(),
    creatorFeeBps: r.u64(),
    isHolderReward: r.bool(),
  };
}

function decodePumpTrade(r: Reader): PumpTradeEvent {
  const k = "pumpTrade" as const;
  const mint = r.pubkey();
  const quoteAmount = r.u64();
  const tokenAmount = r.u64();
  const isBuy = r.bool();
  const user = r.pubkey();
  const timestamp = r.i64();
  const virtualQuoteReserves = r.u64();
  const virtualTokenReserves = r.u64();
  const realQuoteReserves = r.u64();
  const realTokenReserves = r.u64();
  requireUpTo(k, r, r.offset);
  const feeRecipient = r.pubkey();
  const feeBps = r.u64();
  const fee = r.u64();
  const creator = r.pubkey();
  const creatorFeeBps = r.u64();
  const creatorFee = r.u64();
  const trackVolume = r.bool();
  r.u64(); // total_unclaimed_tokens
  r.u64(); // total_claimed_tokens
  r.u64(); // current_sol_volume
  r.i64(); // last_update_timestamp
  const ixName = str(k, r, MAX_IX_NAME_BYTES);
  const mayhemMode = r.bool();
  const cashbackFeeBps = r.u64();
  const cashback = r.u64();
  const buybackFeeBps = r.u64();
  const buybackFee = r.u64();
  const shareholders: Shareholder[] = [];
  if (r.has(4)) {
    const n = r.u32();
    if (n > MAX_SHAREHOLDERS || !r.has(n * 34)) throw new EventDecodeError(k, `implausible shareholders length ${n}`);
    for (let i = 0; i < n; i++) shareholders.push({ address: r.pubkey(), shareBps: r.u16() });
  } else {
    r.skip(4);
  }
  // quote_mint + quote_amount + virtual_quote_reserves + real_quote_reserves
  const hasQuote = r.has(32 + 8 * 3);
  const quoteMint = r.pubkey();
  const quoteAmountQ = r.u64();
  const virtualQuote = r.u64();
  const realQuote = r.u64();
  return {
    kind: k,
    mint,
    quoteAmount,
    tokenAmount,
    isBuy,
    user,
    timestamp,
    virtualQuoteReserves,
    virtualTokenReserves,
    realQuoteReserves,
    realTokenReserves,
    feeRecipient,
    feeBps,
    fee,
    creator,
    creatorFeeBps,
    creatorFee,
    trackVolume,
    ixName,
    mayhemMode,
    cashbackFeeBps,
    cashback,
    buybackFeeBps,
    buybackFee,
    shareholders,
    quote: hasQuote ? { mint: quoteMint, amount: quoteAmountQ, virtualReserves: virtualQuote, realReserves: realQuote } : null,
    holderRewardsBps: r.u64(),
    holderRewards: r.u64(),
  };
}

function decodePumpComplete(r: Reader): PumpCompleteEvent {
  const k = "pumpComplete" as const;
  const user = r.pubkey();
  const mint = r.pubkey();
  const bondingCurve = r.pubkey();
  requireUpTo(k, r, r.offset);
  return { kind: k, user, mint, bondingCurve, timestamp: r.i64(), quoteMint: r.pubkey() };
}

function decodePumpMigration(r: Reader): PumpMigrationEvent {
  const k = "pumpMigrate" as const;
  const user = r.pubkey();
  const mint = r.pubkey();
  const mintAmount = r.u64();
  const solAmount = r.u64();
  const poolMigrationFee = r.u64();
  const bondingCurve = r.pubkey();
  const timestamp = r.i64();
  const pool = r.pubkey();
  requireUpTo(k, r, r.offset);
  return { kind: k, user, mint, mintAmount, solAmount, poolMigrationFee, bondingCurve, timestamp, pool, quoteMint: r.pubkey() };
}

function decodeAmmCreatePool(r: Reader): AmmCreatePoolEvent {
  const k = "ammCreatePool" as const;
  const timestamp = r.i64();
  const index = r.u16();
  const creator = r.pubkey();
  const baseMint = r.pubkey();
  const quoteMint = r.pubkey();
  const baseMintDecimals = r.u8();
  const quoteMintDecimals = r.u8();
  const baseAmountIn = r.u64();
  const quoteAmountIn = r.u64();
  const poolBaseAmount = r.u64();
  const poolQuoteAmount = r.u64();
  const minimumLiquidity = r.u64();
  const initialLiquidity = r.u64();
  const lpTokenAmountOut = r.u64();
  const poolBump = r.u8();
  const pool = r.pubkey();
  requireUpTo(k, r, r.offset);
  return {
    kind: k,
    timestamp,
    index,
    creator,
    baseMint,
    quoteMint,
    baseMintDecimals,
    quoteMintDecimals,
    baseAmountIn,
    quoteAmountIn,
    poolBaseAmount,
    poolQuoteAmount,
    minimumLiquidity,
    initialLiquidity,
    lpTokenAmountOut,
    poolBump,
    pool,
    lpMint: r.pubkey(),
    userBaseTokenAccount: r.pubkey(),
    userQuoteTokenAccount: r.pubkey(),
    coinCreator: r.pubkey(),
    isMayhemMode: r.bool(),
    creatorFeeBps: r.u64(),
    canEditCreatorFee: r.bool(),
    isHolderReward: r.bool(),
  };
}

function decodeAmmSwap(r: Reader, isBuy: boolean): AmmSwapEvent {
  const k = isBuy ? ("ammBuy" as const) : ("ammSell" as const);
  const timestamp = r.i64();
  const baseAmount = r.u64();
  const quoteLimit = r.u64();
  const userBaseReserves = r.u64();
  const userQuoteReserves = r.u64();
  const poolBaseReserves = r.u64();
  const poolQuoteReserves = r.u64();
  const quoteAmount = r.u64();
  const lpFeeBps = r.u64();
  const lpFee = r.u64();
  const protocolFeeBps = r.u64();
  const protocolFee = r.u64();
  const quoteAmountVault = r.u64();
  const userQuoteAmount = r.u64();
  const pool = r.pubkey();
  const user = r.pubkey();
  requireUpTo(k, r, r.offset);
  const userBaseTokenAccount = r.pubkey();
  const userQuoteTokenAccount = r.pubkey();
  const protocolFeeRecipient = r.pubkey();
  const protocolFeeRecipientTokenAccount = r.pubkey();
  const coinCreator = r.pubkey();
  const coinCreatorFeeBps = r.u64();
  const coinCreatorFee = r.u64();
  let ixName = "";
  if (isBuy) {
    r.bool(); // track_volume
    r.u64(); // total_unclaimed_tokens
    r.u64(); // total_claimed_tokens
    r.u64(); // current_sol_volume
    r.i64(); // last_update_timestamp
    r.u64(); // min_base_amount_out
    ixName = str(k, r, MAX_IX_NAME_BYTES);
  }
  return {
    kind: k,
    timestamp,
    baseAmount,
    quoteLimit,
    userBaseReserves,
    userQuoteReserves,
    poolBaseReserves,
    poolQuoteReserves,
    quoteAmount,
    lpFeeBps,
    lpFee,
    protocolFeeBps,
    protocolFee,
    quoteAmountVault,
    userQuoteAmount,
    pool,
    user,
    userBaseTokenAccount,
    userQuoteTokenAccount,
    protocolFeeRecipient,
    protocolFeeRecipientTokenAccount,
    coinCreator,
    coinCreatorFeeBps,
    coinCreatorFee,
    ixName,
    cashbackFeeBps: r.u64(),
    cashback: r.u64(),
    buybackFeeBps: r.u64(),
    buybackFee: r.u64(),
    virtualQuoteReserves: r.i128(),
    canBoost: r.bool(),
    baseSupply: r.u64(),
    holderRewardsBps: r.u64(),
    holderRewards: r.u64(),
  };
}

type Decoder = (r: Reader) => DecodedEvent;

const PUMP_DECODERS: [Uint8Array, Decoder][] = [
  [EVENT_DISCRIMINATORS.pumpTrade, decodePumpTrade],
  [EVENT_DISCRIMINATORS.pumpCreate, decodePumpCreate],
  [EVENT_DISCRIMINATORS.pumpComplete, decodePumpComplete],
  [EVENT_DISCRIMINATORS.pumpCompleteAmmMigration, decodePumpMigration],
];

const AMM_DECODERS: [Uint8Array, Decoder][] = [
  [EVENT_DISCRIMINATORS.ammBuy, (r) => decodeAmmSwap(r, true)],
  [EVENT_DISCRIMINATORS.ammSell, (r) => decodeAmmSwap(r, false)],
  [EVENT_DISCRIMINATORS.ammCreatePool, decodeAmmCreatePool],
];

/** Programs whose events this module decodes. */
export const EVENT_PROGRAMS: readonly Address[] = [PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID];

export function isEventProgram(program: Address | null | undefined): boolean {
  return program === PUMP_PROGRAM_ID || program === PUMP_AMM_PROGRAM_ID;
}

/**
 * Decodes an event payload (`disc(8) + borsh`).
 *
 * `program` is the program that emitted it. Pass it whenever it is known: discriminators of generically
 * named events collide across Anchor programs (Raydium LaunchLab also emits a `TradeEvent`), so with a
 * program only that program's layouts are tried and other programs yield null. `null`/omitted = unknown
 * emitter (legacy behaviour: match on the discriminator alone).
 *
 * Returns null for unknown discriminators; throws EventDecodeError for a known one whose body is malformed.
 */
export function decodeEventPayload(payload: Uint8Array, program?: Address | null): DecodedEvent | null {
  if (payload.length < DISC_LEN) return null;
  let tables: [Uint8Array, Decoder][][];
  if (program === PUMP_PROGRAM_ID) tables = [PUMP_DECODERS];
  else if (program === PUMP_AMM_PROGRAM_ID) tables = [AMM_DECODERS];
  else if (program == null) tables = [PUMP_DECODERS, AMM_DECODERS];
  else return null;
  for (const table of tables) {
    for (const [disc, decode] of table) {
      if (startsWith(payload, disc)) return decode(new Reader(payload, DISC_LEN));
    }
  }
  return null;
}
