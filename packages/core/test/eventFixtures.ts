/**
 * Real mainnet transactions captured by scripts/capture-event-fixtures.ts on 2026-10-03 (getTransaction,
 * json encoding, slimmed). Each entry carries every label it was captured for.
 */
import { type Address, getBase58Encoder } from "@solana/kit";
import type { TransactionEventInput, TxInstruction } from "../src";
import captured from "./fixtures/event-txs.json";

export interface RpcJsonInstruction {
  programIdIndex: number;
  accounts: number[];
  data: string;
  stackHeight?: number | null;
}

export interface RpcJsonTransaction {
  slot: number;
  blockTime: number | null;
  version: number | "legacy";
  transaction: {
    signatures: string[];
    message: {
      accountKeys: string[];
      header: { numRequiredSignatures: number; numReadonlySignedAccounts: number; numReadonlyUnsignedAccounts: number };
      recentBlockhash: string;
      instructions: RpcJsonInstruction[];
      addressTableLookups?: { accountKey: string; writableIndexes: number[]; readonlyIndexes: number[] }[];
    };
  };
  meta: {
    err: unknown;
    fee: number;
    logMessages: string[];
    innerInstructions: { index: number; instructions: RpcJsonInstruction[] }[];
    loadedAddresses?: { writable: string[]; readonly: string[] };
    preTokenBalances?: unknown[];
    postTokenBalances?: unknown[];
    computeUnitsConsumed?: number;
  };
}

export interface CapturedTx {
  labels: string[];
  signature: string;
  tx: RpcJsonTransaction;
}

export const CAPTURED = captured as unknown as { capturedAt: string; rpc: string; txs: CapturedTx[] };

export function fixtureTx(label: string): CapturedTx {
  const t = CAPTURED.txs.find((x) => x.labels.includes(label));
  if (!t) throw new Error(`no fixture labelled ${label}`);
  return t;
}

const b58 = getBase58Encoder();

function ix(i: RpcJsonInstruction): TxInstruction {
  return { programIdIndex: i.programIdIndex, accounts: i.accounts, data: new Uint8Array(b58.encode(i.data)) };
}

/** RPC JSON transaction -> the decoder input shape (account keys incl. loaded ALT addresses). */
export function toEventInput(tx: RpcJsonTransaction): TransactionEventInput {
  return {
    accountKeys: [
      ...tx.transaction.message.accountKeys,
      ...(tx.meta.loadedAddresses?.writable ?? []),
      ...(tx.meta.loadedAddresses?.readonly ?? []),
    ] as Address[],
    instructions: tx.transaction.message.instructions.map(ix),
    innerInstructions: tx.meta.innerInstructions.map((g) => ({ index: g.index, instructions: g.instructions.map(ix) })),
    logs: tx.meta.logMessages,
  };
}
