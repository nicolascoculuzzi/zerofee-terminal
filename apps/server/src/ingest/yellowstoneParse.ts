/**
 * Yellowstone (Dragon's Mouth) SubscribeUpdate -> normalized ingest records. Pure, so it is unit-tested
 * with recorded updates (no paid endpoint needed).
 *
 * Transactions carry the full message + meta: events are decoded from the event-CPI inner instructions
 * (logs only as fallback), PumpSwap pool mints come from swap instruction accounts, signers from the
 * header, and absolute post-tx token balances from pre/post token balances.
 */
import { type Address, getAddressDecoder, getBase58Decoder } from "@solana/kit";
import type { SubscribeUpdate } from "@triton-one/yellowstone-grpc";
import { decodeTransactionEvents, extractAmmPoolMints, type TransactionEventInput, type TxInstruction } from "@zerofee/core";
import type { BlockMeta, IngestTx, SlotStatus, TokenBalanceUpdate } from "./types";

const addressDecoder = getAddressDecoder();
const base58 = getBase58Decoder();

/** geyser.proto SlotStatus numbering. */
const SLOT_STATUS: Record<number, SlotStatus | undefined> = { 0: "processed", 1: "confirmed", 2: "finalized", 6: "dead" };

export type ParsedUpdate =
  | { kind: "tx"; tx: IngestTx; failures: string[] }
  | { kind: "failedTx"; slot: number }
  | { kind: "slot"; slot: number; status: SlotStatus | null; deadError: string | null }
  | { kind: "blockMeta"; meta: BlockMeta }
  | { kind: "ping" }
  | { kind: "pong" }
  | { kind: "other" };

interface ProtoTokenBalance {
  accountIndex: number;
  mint: string;
  owner: string;
  uiTokenAmount?: { amount: string } | undefined;
}

/** Sums balances per (mint, owner); owners present only before the tx (closed accounts) read as 0. */
export function tokenBalancesFromMeta(pre: readonly ProtoTokenBalance[], post: readonly ProtoTokenBalance[]): TokenBalanceUpdate[] {
  const sums = new Map<string, TokenBalanceUpdate>();
  for (const b of post) {
    if (!b.owner || !b.mint) continue;
    const k = `${b.mint}:${b.owner}`;
    const amount = BigInt(b.uiTokenAmount?.amount ?? "0");
    const cur = sums.get(k);
    if (cur) cur.amount += amount;
    else sums.set(k, { mint: b.mint, owner: b.owner, amount });
  }
  // Accounts closed by the tx are absent from post balances: their owner now holds 0 of that mint.
  for (const b of pre) {
    if (!b.owner || !b.mint) continue;
    const k = `${b.mint}:${b.owner}`;
    if (!sums.has(k)) sums.set(k, { mint: b.mint, owner: b.owner, amount: 0n });
  }
  return [...sums.values()];
}

function ix(i: { programIdIndex: number; accounts: Uint8Array; data: Uint8Array }): TxInstruction {
  return { programIdIndex: i.programIdIndex, accounts: i.accounts, data: i.data };
}

export function parseSubscribeUpdate(u: SubscribeUpdate, receivedAt: number): ParsedUpdate {
  if (u.transaction) {
    const slot = Number(u.transaction.slot);
    const info = u.transaction.transaction;
    const tx = info?.transaction;
    const meta = info?.meta;
    const msg = tx?.message;
    if (!info || !tx || !meta || !msg) return { kind: "other" };
    if (meta.err && meta.err.err.length > 0) return { kind: "failedTx", slot };
    const accountKeys = [...msg.accountKeys, ...meta.loadedWritableAddresses, ...meta.loadedReadonlyAddresses].map(
      (k) => addressDecoder.decode(k) as Address,
    );
    const input: TransactionEventInput = {
      accountKeys,
      instructions: msg.instructions.map(ix),
      innerInstructions: meta.innerInstructionsNone
        ? null
        : meta.innerInstructions.map((g) => ({ index: g.index, instructions: g.instructions.map(ix) })),
      logs: meta.logMessagesNone ? null : meta.logMessages,
    };
    const r = decodeTransactionEvents(input);
    return {
      kind: "tx",
      failures: r.failureMessages,
      tx: {
        signature: base58.decode(info.signature),
        slot,
        txIndex: Number(info.index),
        blockTime: null,
        receivedAt,
        sourceCreatedAt: u.createdAt ? u.createdAt.getTime() : null,
        source: "yellowstone",
        events: r.events,
        signers: accountKeys.slice(0, msg.header?.numRequiredSignatures ?? 1),
        accountKeys,
        poolMints: r.events.some((e) => e.kind === "ammBuy" || e.kind === "ammSell") ? extractAmmPoolMints(input) : [],
        tokenBalances: tokenBalancesFromMeta(meta.preTokenBalances, meta.postTokenBalances),
        lamports: { pre: meta.preBalances, post: meta.postBalances },
      },
    };
  }
  if (u.slot) {
    return { kind: "slot", slot: Number(u.slot.slot), status: SLOT_STATUS[u.slot.status] ?? null, deadError: u.slot.deadError ?? null };
  }
  if (u.blockMeta) {
    const b = u.blockMeta;
    return {
      kind: "blockMeta",
      meta: {
        slot: Number(b.slot),
        blockhash: b.blockhash,
        blockHeight: b.blockHeight ? Number(b.blockHeight.blockHeight) : null,
        blockTime: b.blockTime ? Number(b.blockTime.timestamp) : null,
        parentSlot: b.parentSlot ? Number(b.parentSlot) : null,
      },
    };
  }
  if (u.ping) return { kind: "ping" };
  if (u.pong) return { kind: "pong" };
  return { kind: "other" };
}
