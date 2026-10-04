/**
 * `getTransaction` (encoding "json", maxSupportedTransactionVersion 1) -> IngestTx, with the same fields a
 * Yellowstone record carries: event-CPI decoding, account keys, signers, PumpSwap pool mints, Raydium
 * instruction accounts and absolute post-tx token balances. The RPC logs source uses it for Raydium
 * transactions (their events lack mints and wallets); tests build fixtures with it.
 */
import { type Address, getBase58Encoder } from "@solana/kit";
import { decodeTransactionEvents, extractAmmPoolMints, type TransactionEventInput, type TxInstruction } from "@zerofee/core";
import { extractRaydium } from "./raydium";
import type { IngestTx } from "./types";
import { tokenBalancesFromMeta } from "./yellowstoneParse";

export interface RpcJsonIx {
  programIdIndex: number;
  accounts: number[];
  data: string;
  stackHeight?: number | null;
}

export interface RpcJsonTokenBalance {
  accountIndex: number;
  mint: string;
  owner: string;
  programId?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

export interface RpcJsonTx {
  slot: number;
  blockTime: number | null;
  version?: number | "legacy";
  transaction: {
    signatures: string[];
    message: {
      accountKeys: string[];
      header: { numRequiredSignatures: number; numReadonlySignedAccounts: number; numReadonlyUnsignedAccounts: number };
      recentBlockhash: string;
      instructions: RpcJsonIx[];
      addressTableLookups?: { accountKey: string; writableIndexes: number[]; readonlyIndexes: number[] }[];
    };
  };
  meta: {
    err: unknown;
    fee: number;
    logMessages: string[];
    innerInstructions: { index: number; instructions: RpcJsonIx[] }[];
    loadedAddresses?: { writable: string[]; readonly: string[] };
    preTokenBalances?: RpcJsonTokenBalance[];
    postTokenBalances?: RpcJsonTokenBalance[];
    preBalances?: number[];
    postBalances?: number[];
    computeUnitsConsumed?: number;
  } | null;
}

const b58 = getBase58Encoder();

export function eventInputFromJson(tx: RpcJsonTx): TransactionEventInput {
  const ix = (i: RpcJsonIx): TxInstruction => ({
    programIdIndex: i.programIdIndex,
    accounts: i.accounts,
    data: new Uint8Array(b58.encode(i.data)),
  });
  const meta = tx.meta;
  return {
    accountKeys: [
      ...tx.transaction.message.accountKeys,
      ...(meta?.loadedAddresses?.writable ?? []),
      ...(meta?.loadedAddresses?.readonly ?? []),
    ] as Address[],
    instructions: tx.transaction.message.instructions.map(ix),
    innerInstructions: meta?.innerInstructions
      ? meta.innerInstructions.map((g) => ({ index: g.index, instructions: g.instructions.map(ix) }))
      : null,
    logs: meta?.logMessages ?? null,
  };
}

/** One executed transaction as an IngestTx (null when it failed or has no meta), plus its decode failures. */
export function ingestFromJsonTx(o: {
  signature: string;
  tx: RpcJsonTx;
  receivedAt: number;
  source: string;
  /** Overrides tx.slot (the slot the stream announced). */
  slot?: number;
}): { tx: IngestTx; failures: string[] } | null {
  const meta = o.tx.meta;
  if (!meta || meta.err) return null;
  const input = eventInputFromJson(o.tx);
  const r = decodeTransactionEvents(input);
  const post = meta.postTokenBalances ?? [];
  return {
    failures: r.failureMessages,
    tx: {
      signature: o.signature,
      slot: o.slot ?? o.tx.slot,
      txIndex: null,
      blockTime: o.tx.blockTime,
      receivedAt: o.receivedAt,
      sourceCreatedAt: null,
      source: o.source,
      events: r.events,
      signers: input.accountKeys.slice(0, o.tx.transaction.message.header.numRequiredSignatures),
      accountKeys: [...input.accountKeys],
      poolMints: r.events.some((e) => e.kind === "ammBuy" || e.kind === "ammSell") ? extractAmmPoolMints(input) : [],
      raydium: extractRaydium(
        input,
        r.events,
        post.map((b) => ({ accountIndex: b.accountIndex, amount: b.uiTokenAmount.amount })),
      ),
      tokenBalances: tokenBalancesFromMeta(meta.preTokenBalances ?? [], post),
      lamports: meta.preBalances && meta.postBalances ? { pre: meta.preBalances.map(String), post: meta.postBalances.map(String) } : null,
    },
  };
}
