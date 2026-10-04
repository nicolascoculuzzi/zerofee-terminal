/**
 * Transaction-level event extraction for sources that deliver the full transaction (Yellowstone gRPC,
 * `getTransaction`). pump, PumpSwap and Raydium LaunchLab emit every event twice: a `Program data:` log line
 * AND an Anchor event-CPI (a self-invocation whose data is EVENT_IX_TAG + disc + borsh). We decode the CPI
 * copy (logs can be truncated) and fall back to logs only when no CPI event is found, so nothing is counted
 * twice. Raydium CPMM only logs (LOG_ONLY_EVENT_PROGRAMS), so its events always come from the logs: after a
 * successful CPI pass they are appended behind the CPI-decoded events.
 */
import type { Address } from "@solana/kit";
import { EVENT_IX_TAG, PUMP_AMM_IX, PUMP_AMM_PROGRAM_ID } from "../constants";
import { startsWith } from "../util/bytes";
import { decodeEventPayload, isEventProgram, LOG_ONLY_EVENT_PROGRAMS } from "./decode";
import { decodeLogEvents } from "./logs";
import { type DecodedEvent, EventDecodeError } from "./types";

export interface TxInstruction {
  programIdIndex: number;
  /** Indexes into the full account key list (absent when a source omits them). */
  accounts?: ArrayLike<number>;
  data: Uint8Array;
}

export interface TxInnerInstructionGroup {
  /** Index of the top-level instruction these were invoked from. */
  index: number;
  instructions: readonly TxInstruction[];
}

export interface TransactionEventInput {
  /** Full account key list: static keys, then loaded writable, then loaded readonly addresses. */
  accountKeys: readonly Address[];
  /** Top-level instructions (only needed for {@link extractAmmPoolMints}). */
  instructions?: readonly TxInstruction[];
  /** null/undefined when the source did not provide inner instructions. */
  innerInstructions?: readonly TxInnerInstructionGroup[] | null;
  logs?: readonly string[] | null;
}

export interface TransactionEventsResult {
  events: DecodedEvent[];
  /** "cpi" when event-CPIs were found (log-only programs' events may still have been merged from the logs). */
  via: "cpi" | "logs" | "none";
  failures: number;
  failureMessages: string[];
  /**
   * Logs were truncated, so events read from them may be missing: all events when via = "logs", the
   * log-only programs' events when via = "cpi".
   */
  truncated: boolean;
}

/**
 * Decodes the events of one executed transaction (EVENT_PROGRAMS), in emission order; with via = "cpi",
 * events of log-only programs (Raydium CPMM) follow the CPI-decoded ones in their own log order.
 */
export function decodeTransactionEvents(tx: TransactionEventInput): TransactionEventsResult {
  const events: DecodedEvent[] = [];
  const failureMessages: string[] = [];
  if (tx.innerInstructions) {
    const groups = [...tx.innerInstructions].sort((a, b) => a.index - b.index);
    for (const g of groups) {
      for (const ix of g.instructions) {
        const program = tx.accountKeys[ix.programIdIndex];
        if (!program || !isEventProgram(program) || !startsWith(ix.data, EVENT_IX_TAG)) continue;
        try {
          const ev = decodeEventPayload(ix.data.subarray(EVENT_IX_TAG.length), program);
          if (ev) events.push(ev);
        } catch (e) {
          if (!(e instanceof EventDecodeError)) throw e;
          failureMessages.push(e.message);
        }
      }
    }
    if (events.length || failureMessages.length) {
      let truncated = false;
      if (tx.logs?.length) {
        const r = decodeLogEvents(tx.logs, LOG_ONLY_EVENT_PROGRAMS);
        events.push(...r.events);
        failureMessages.push(...r.failureMessages);
        truncated = r.truncated;
      }
      return { events, via: "cpi", failures: failureMessages.length, failureMessages, truncated };
    }
  }
  if (tx.logs?.length) {
    const r = decodeLogEvents(tx.logs);
    return {
      events: r.events,
      via: r.events.length ? "logs" : "none",
      failures: r.failures,
      failureMessages: r.failureMessages,
      truncated: r.truncated,
    };
  }
  return { events, via: "none", failures: 0, failureMessages, truncated: false };
}

export interface AmmPoolMints {
  pool: Address;
  baseMint: Address;
  quoteMint: Address;
  baseTokenProgram?: Address;
  quoteTokenProgram?: Address;
}

const AMM_SWAP_DISCRIMINATORS = [PUMP_AMM_IX.buy, PUMP_AMM_IX.buyExactQuoteIn, PUMP_AMM_IX.sell];

/**
 * PumpSwap Buy/Sell events carry the pool but not the base mint. When the transaction's instructions are
 * available, the swap instruction's account list gives it: buy / buy_exact_quote_in / sell all start
 * `pool, user, global_config, base_mint, quote_mint, ...` with the token programs at 11 / 12
 * (idl/pump_amm.json). Scans top-level and inner instructions.
 */
export function extractAmmPoolMints(tx: TransactionEventInput): AmmPoolMints[] {
  const out = new Map<Address, AmmPoolMints>();
  const visit = (ix: TxInstruction) => {
    if (tx.accountKeys[ix.programIdIndex] !== PUMP_AMM_PROGRAM_ID || !ix.accounts || ix.accounts.length < 13) return;
    if (!AMM_SWAP_DISCRIMINATORS.some((d) => startsWith(ix.data, d))) return;
    const key = (i: number) => tx.accountKeys[ix.accounts![i] as number];
    const pool = key(0);
    const baseMint = key(3);
    const quoteMint = key(4);
    if (!pool || !baseMint || !quoteMint || out.has(pool)) return;
    out.set(pool, { pool, baseMint, quoteMint, baseTokenProgram: key(11), quoteTokenProgram: key(12) });
  };
  for (const ix of tx.instructions ?? []) visit(ix);
  for (const g of tx.innerInstructions ?? []) for (const ix of g.instructions) visit(ix);
  return [...out.values()];
}
