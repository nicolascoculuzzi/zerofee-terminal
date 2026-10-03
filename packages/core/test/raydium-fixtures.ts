/** Offline Raydium LaunchLab / CPMM mainnet snapshot (captured by scripts/capture-raydium-fixtures.ts). */
import { type Address, address, getBase64Encoder } from "@solana/kit";
import { EVENT_IX_TAG, MAINNET_SLOTS_PER_EPOCH } from "../src";
import type { FixtureAccount } from "./fixtures";
import snapshot from "./fixtures/raydium-mainnet.json";

const b64 = getBase64Encoder();
const bytes = (s: string) => new Uint8Array(b64.encode(s));

export function rfixture(addr: string): FixtureAccount {
  const a = (snapshot.accounts as Record<string, { owner: string; lamports: string; data: string }>)[addr];
  if (!a) throw new Error(`raydium fixture account ${addr} missing`);
  return { address: address(addr), owner: address(a.owner), lamports: BigInt(a.lamports), data: bytes(a.data) };
}

export interface CapturedInstruction {
  where: string;
  programId: Address;
  accounts: Address[];
  data: Uint8Array;
}

export interface CapturedTx {
  signature: string;
  slot: number;
  /** Epoch the tx executed in (mainnet: slot / 432,000) - selects the Token-2022 transfer fee. */
  epoch: bigint;
  feePayer: Address;
  instructions: CapturedInstruction[];
  logs: string[];
  preTokenBalances: { account: string; mint: string; owner?: string; amount: string }[];
  postTokenBalances: { account: string; mint: string; owner?: string; amount: string }[];
}

type RawTx = Omit<CapturedTx, "epoch" | "instructions" | "feePayer"> & {
  feePayer: string;
  instructions: { where: string; programId: string; accounts: string[]; data: string }[];
};

export type TxLabel = keyof typeof snapshot.transactions;

export function rtx(label: TxLabel): CapturedTx {
  const t = (snapshot.transactions as unknown as Record<string, RawTx>)[label];
  if (!t) throw new Error(`raydium fixture tx ${label} missing`);
  return {
    ...t,
    feePayer: address(t.feePayer),
    epoch: BigInt(t.slot) / MAINNET_SLOTS_PER_EPOCH,
    instructions: t.instructions.map((i) => ({
      where: i.where,
      programId: address(i.programId),
      accounts: i.accounts.map((a) => address(a)),
      data: bytes(i.data),
    })),
  };
}

const startsWithBytes = (d: Uint8Array, p: Uint8Array) => d.length >= p.length && p.every((b, i) => d[i] === b);

/** First instruction of `programId` whose data starts with `disc` (top-level or inner). */
export function findIx(tx: CapturedTx, programId: Address, disc: Uint8Array): CapturedInstruction {
  const ix = tx.instructions.find((i) => i.programId === programId && startsWithBytes(i.data, disc));
  if (!ix) throw new Error(`${tx.signature}: no instruction with that discriminator`);
  return ix;
}

/** Event-CPI payloads (data after EVENT_IX_TAG) self-invoked by `programId`. */
export function eventCpiPayloads(tx: CapturedTx, programId: Address): Uint8Array[] {
  return tx.instructions.filter((i) => i.programId === programId && startsWithBytes(i.data, EVENT_IX_TAG)).map((i) => i.data.subarray(8));
}

/** u64 LE argument `index` (0-based) after the 8-byte discriminator. */
export function u64Arg(data: Uint8Array, index: number): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(8 + index * 8, true);
}

/** Token balance delta of `account` in a captured tx (post - pre; missing = 0). */
export function tokenDelta(tx: CapturedTx, account: string): bigint {
  const pre = tx.preTokenBalances.find((b) => b.account === account)?.amount ?? "0";
  const post = tx.postTokenBalances.find((b) => b.account === account)?.amount ?? "0";
  return BigInt(post) - BigInt(pre);
}

export const RAYDIUM_SNAPSHOT_SLOT = snapshot.slot;
