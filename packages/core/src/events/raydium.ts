/**
 * Raydium LaunchLab and CPMM event decoders, following the tolerance rules in ./decode.ts. They are only
 * tried for payloads attributed to the emitting program (decodeEventPayload with `program`): LaunchLab's
 * `TradeEvent` has the same discriminator as pump's, and CPMM's generically named `SwapEvent` is not unique
 * among AMMs either.
 *
 * LaunchLab emits each event twice (a `Program data:` log and an event-CPI, like pump); CPMM only logs
 * (`emit!`), so ./tx.ts always takes CPMM events from the logs.
 *
 * Layouts: idl/raydium_launchpad.json `TradeEvent` / `PoolCreateEvent` and idl/raydium_cp_swap.json
 * `SwapEvent` (https://github.com/raydium-io/raydium-idl, commit pinned in idl/RAYDIUM_SOURCE.json). Current
 * mainnet payloads are 147, 255 and 170 bytes (test/fixtures/raydium-mainnet.json).
 */
import { RAYDIUM_EVENT_DISCRIMINATORS } from "../constants";
import type { Reader } from "../util/bytes";
import { type DecoderTable, decodeWithTables, requireUpTo, str } from "./borsh";
import { type CpmmSwapEvent, EventDecodeError, type LaunchLabPoolCreateEvent, type LaunchLabTradeEvent } from "./types";

/** Corrupt-length guards for the PoolCreateEvent strings (the program writes them into token metadata). */
const MAX_NAME_BYTES = 256;
const MAX_URI_BYTES = 1024;

/** Required through `pool_status`; `exact_in` is tolerant. */
function decodeLaunchLabTrade(r: Reader): LaunchLabTradeEvent {
  const k = "launchlabTrade" as const;
  const pool = r.pubkey();
  const totalBaseSell = r.u64();
  const virtualBase = r.u64();
  const virtualQuote = r.u64();
  const realBaseBefore = r.u64();
  const realQuoteBefore = r.u64();
  const realBaseAfter = r.u64();
  const realQuoteAfter = r.u64();
  const amountIn = r.u64();
  const amountOut = r.u64();
  const protocolFee = r.u64();
  const platformFee = r.u64();
  const creatorFee = r.u64();
  const shareFee = r.u64();
  const direction = r.u8();
  const poolStatus = r.u8();
  requireUpTo(k, r, r.offset);
  if (direction > 1) throw new EventDecodeError(k, `unknown trade_direction ${direction}`);
  return {
    kind: k,
    pool,
    totalBaseSell,
    virtualBase,
    virtualQuote,
    realBaseBefore,
    realQuoteBefore,
    realBaseAfter,
    realQuoteAfter,
    amountIn,
    amountOut,
    protocolFee,
    platformFee,
    creatorFee,
    shareFee,
    isBuy: direction === 0, // TradeDirection::Buy
    poolStatus,
    exactIn: r.bool(),
  };
}

/** Required through the vesting params; `amm_fee_on` is tolerant. */
function decodeLaunchLabPoolCreate(r: Reader): LaunchLabPoolCreateEvent {
  const k = "launchlabPoolCreate" as const;
  const pool = r.pubkey();
  const creator = r.pubkey();
  const config = r.pubkey();
  // MintParams
  const decimals = r.u8();
  const name = str(k, r, MAX_NAME_BYTES);
  const symbol = str(k, r, MAX_NAME_BYTES);
  const uri = str(k, r, MAX_URI_BYTES);
  // CurveParams enum: 0 Constant{supply, total_base_sell, total_quote_fund_raising, migrate_type},
  // 1 Fixed / 2 Linear {supply, total_quote_fund_raising, migrate_type}.
  const curveType = r.u8();
  if (curveType > 2) throw new EventDecodeError(k, `unknown CurveParams variant ${curveType}`);
  const supply = r.u64();
  const totalBaseSell = curveType === 0 ? r.u64() : 0n;
  const totalQuoteFundRaising = r.u64();
  const migrateType = r.u8();
  // VestingParams
  const totalLockedAmount = r.u64();
  const cliffPeriod = r.u64();
  const unlockPeriod = r.u64();
  requireUpTo(k, r, r.offset);
  return {
    kind: k,
    pool,
    creator,
    config,
    decimals,
    name,
    symbol,
    uri,
    curveType,
    supply,
    totalBaseSell,
    totalQuoteFundRaising,
    migrateType,
    totalLockedAmount,
    cliffPeriod,
    unlockPeriod,
    ammFeeOn: r.u8(),
  };
}

/** Required through `base_input`; the mints, trade fee and creator-fee fields are tolerant. */
function decodeCpmmSwap(r: Reader): CpmmSwapEvent {
  const k = "cpmmSwap" as const;
  const pool = r.pubkey();
  const inputVaultBefore = r.u64();
  const outputVaultBefore = r.u64();
  const inputAmount = r.u64();
  const outputAmount = r.u64();
  const inputTransferFee = r.u64();
  const outputTransferFee = r.u64();
  const baseInput = r.bool();
  requireUpTo(k, r, r.offset);
  return {
    kind: k,
    pool,
    inputVaultBefore,
    outputVaultBefore,
    inputAmount,
    outputAmount,
    inputTransferFee,
    outputTransferFee,
    baseInput,
    inputMint: r.pubkey(),
    outputMint: r.pubkey(),
    tradeFee: r.u64(),
    creatorFee: r.u64(),
    creatorFeeOnInput: r.bool(),
  };
}

export const LAUNCHLAB_DECODERS: DecoderTable<LaunchLabTradeEvent | LaunchLabPoolCreateEvent> = [
  [RAYDIUM_EVENT_DISCRIMINATORS.launchLabTrade, decodeLaunchLabTrade],
  [RAYDIUM_EVENT_DISCRIMINATORS.launchLabPoolCreate, decodeLaunchLabPoolCreate],
];

export const CPMM_DECODERS: DecoderTable<CpmmSwapEvent> = [[RAYDIUM_EVENT_DISCRIMINATORS.cpmmSwap, decodeCpmmSwap]];

/**
 * Decodes a payload emitted by Raydium LaunchLab (TradeEvent or PoolCreateEvent); null for other events.
 * Same as decodeEventPayload(payload, RAYDIUM_LAUNCHLAB_PROGRAM_ID), typed. Throws EventDecodeError if malformed.
 */
export function decodeLaunchLabEventPayload(payload: Uint8Array): LaunchLabTradeEvent | LaunchLabPoolCreateEvent | null {
  return decodeWithTables([LAUNCHLAB_DECODERS], payload);
}

/**
 * Decodes a payload emitted by Raydium CPMM (SwapEvent); null for other events.
 * Same as decodeEventPayload(payload, RAYDIUM_CPMM_PROGRAM_ID), typed. Throws EventDecodeError if malformed.
 */
export function decodeCpmmEventPayload(payload: Uint8Array): CpmmSwapEvent | null {
  return decodeWithTables([CPMM_DECODERS], payload);
}
