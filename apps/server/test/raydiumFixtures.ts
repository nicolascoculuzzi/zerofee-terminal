/**
 * Real Raydium LaunchLab / CPMM mainnet transactions and accounts for the server tests, reused from core's
 * offline snapshot (packages/core/test/fixtures/raydium-mainnet.json, captured by
 * packages/core/scripts/capture-raydium-fixtures.ts). The snapshot keeps each transaction's Raydium
 * instructions (with their top-level / inner position), logs and token balances; this module rebuilds the
 * IngestTx a gRPC source (event-CPIs, account keys, instruction accounts, token balances) or the RPC logs
 * source (logs only) would produce from it.
 */
import { type Address, address, getBase58Decoder } from "@solana/kit";
import {
  type CpmmAmmConfig,
  type CpmmPool,
  decodeCpmmAmmConfig,
  decodeCpmmPool,
  decodeLaunchLabGlobalConfig,
  decodeLaunchLabPlatformConfig,
  decodeLaunchLabPool,
  decodeLogEvents,
  decodeMint,
  decodeTokenAccount,
  decodeTransactionEvents,
  type LaunchLabGlobalConfig,
  type LaunchLabPlatformConfig,
  type LaunchLabPool,
  type TransactionEventInput,
  type TxInstruction,
} from "@zerofee/core";
import { rfixture, rtx, type TxLabel } from "../../../packages/core/test/raydium-fixtures";
import type { AccountFetcher } from "../src/accounts/raydium";
import type { AccountCallback } from "../src/accounts/resolver";
import type { RpcJsonTx } from "../src/ingest/jsonTx";
import { extractRaydium } from "../src/ingest/raydium";
import type { IngestTx, TokenBalanceUpdate } from "../src/ingest/types";
import type { RpcAccount } from "../src/util/rpc";

export type { TxLabel } from "../../../packages/core/test/raydium-fixtures";
export { rfixture, rtx } from "../../../packages/core/test/raydium-fixtures";

const PLACEHOLDER = address("ComputeBudget111111111111111111111111111111");
const b58 = getBase58Decoder();

/** The pieces of a source record rebuilt from the snapshot. */
export function raydiumTxInput(label: TxLabel): { input: TransactionEventInput; tokenBalances: TokenBalanceUpdate[]; signers: string[] } {
  const t = rtx(label);
  const keys: Address[] = [];
  const index = (a: Address): number => {
    let i = keys.indexOf(a);
    if (i < 0) {
      keys.push(a);
      i = keys.length - 1;
    }
    return i;
  };
  index(t.feePayer);
  const top: TxInstruction[] = [];
  const inner = new Map<number, TxInstruction[]>();
  for (const ix of t.instructions) {
    const m = /^(top|inner)(\d+)$/.exec(ix.where);
    if (!m) throw new Error(`${label}: unexpected position ${ix.where}`);
    const at = Number(m[2]);
    const compiled: TxInstruction = { programIdIndex: index(ix.programId), accounts: ix.accounts.map(index), data: ix.data };
    if (m[1] === "top") top[at] = compiled;
    else inner.set(at, [...(inner.get(at) ?? []), compiled]);
  }
  const placeholder: TxInstruction = { programIdIndex: index(PLACEHOLDER), accounts: [], data: new Uint8Array(0) };
  const n = Math.max(top.length, ...[...inner.keys()].map((k) => k + 1));
  const instructions = Array.from({ length: n }, (_v, i) => top[i] ?? placeholder);
  // Token balances: (mint, owner) sums like the gRPC parser; owners only present before the tx read as 0.
  const sums = new Map<string, TokenBalanceUpdate>();
  for (const b of t.postTokenBalances) {
    if (!b.owner) continue;
    index(address(b.account));
    const k = `${b.mint}:${b.owner}`;
    const cur = sums.get(k);
    if (cur) cur.amount += BigInt(b.amount);
    else sums.set(k, { mint: b.mint, owner: b.owner, amount: BigInt(b.amount) });
  }
  for (const b of t.preTokenBalances) {
    if (!b.owner) continue;
    const k = `${b.mint}:${b.owner}`;
    if (!sums.has(k)) sums.set(k, { mint: b.mint, owner: b.owner, amount: 0n });
  }
  return {
    input: {
      accountKeys: keys,
      instructions,
      innerInstructions: [...inner.entries()].sort((a, b) => a[0] - b[0]).map(([i, list]) => ({ index: i, instructions: list })),
      logs: t.logs,
    },
    tokenBalances: [...sums.values()],
    signers: [t.feePayer],
  };
}

export interface IngestOptions {
  receivedAt?: number;
  slot?: number;
  signature?: string;
  txIndex?: number | null;
}

/** IngestTx as a gRPC source builds it (or the RPC logs source after re-reading the transaction). */
export function raydiumGrpc(label: TxLabel, o: IngestOptions = {}): IngestTx {
  const t = rtx(label);
  const { input, tokenBalances, signers } = raydiumTxInput(label);
  const events = decodeTransactionEvents(input).events;
  const post = t.postTokenBalances.map((b) => ({ accountIndex: input.accountKeys.indexOf(address(b.account)), amount: b.amount }));
  return {
    signature: o.signature ?? t.signature,
    slot: o.slot ?? t.slot,
    txIndex: o.txIndex === undefined ? 5 : o.txIndex,
    blockTime: null,
    receivedAt: o.receivedAt ?? 1_791_000_000_000,
    sourceCreatedAt: null,
    source: "yellowstone",
    events,
    signers,
    accountKeys: [...input.accountKeys],
    poolMints: [],
    raydium: extractRaydium(input, events, post),
    tokenBalances,
  };
}

/** The snapshot transaction as `getTransaction` (json, v1) returns it: what the RPC logs source re-reads. */
export function raydiumJsonTx(label: TxLabel): RpcJsonTx {
  const t = rtx(label);
  const { input } = raydiumTxInput(label);
  const keys: string[] = [...input.accountKeys];
  const ix = (i: TxInstruction) => ({
    programIdIndex: i.programIdIndex,
    accounts: Array.from(i.accounts ?? []),
    data: b58.decode(i.data),
  });
  const balances = (list: typeof t.postTokenBalances) =>
    list
      .filter((b) => keys.includes(b.account))
      .map((b) => ({
        accountIndex: keys.indexOf(b.account),
        mint: b.mint,
        owner: b.owner ?? "",
        uiTokenAmount: { amount: b.amount, decimals: 0 },
      }));
  return {
    slot: t.slot,
    blockTime: 1_791_000_000,
    version: 0,
    transaction: {
      signatures: [t.signature],
      message: {
        accountKeys: keys,
        header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
        recentBlockhash: "11111111111111111111111111111111",
        instructions: (input.instructions ?? []).map(ix),
      },
    },
    meta: {
      err: null,
      fee: 5_000,
      logMessages: t.logs,
      innerInstructions: (input.innerInstructions ?? []).map((g) => ({ index: g.index, instructions: g.instructions.map(ix) })),
      preTokenBalances: balances(t.preTokenBalances),
      postTokenBalances: balances(t.postTokenBalances),
    },
  };
}

/** IngestTx as the RPC logs source builds it without a fetch (logs only: no accounts, no wallet). */
export function raydiumLogs(label: TxLabel, o: IngestOptions = {}): IngestTx {
  const t = rtx(label);
  return {
    signature: o.signature ?? t.signature,
    slot: o.slot ?? t.slot,
    txIndex: null,
    blockTime: null,
    receivedAt: o.receivedAt ?? 1_791_000_000_000,
    sourceCreatedAt: null,
    source: "rpc-logs",
    events: decodeLogEvents(t.logs).events,
    signers: null,
    accountKeys: null,
    poolMints: [],
    tokenBalances: null,
  };
}

// ---------------------------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------------------------

/**
 * The resolver's raw-account reads served from the snapshot (missing accounts read as null), queued like
 * the real batches until `flush()`.
 */
export class FixtureFetcher implements AccountFetcher {
  private queue: { address: string; cb: AccountCallback }[] = [];
  readonly requested: string[] = [];
  /** Overrides (null = missing) and extra accounts. */
  readonly accounts = new Map<string, RpcAccount | null>();

  requestAccount(address: string, cb: AccountCallback): void {
    this.requested.push(address);
    this.queue.push({ address, cb });
  }

  lookup(address: string): RpcAccount | null {
    if (this.accounts.has(address)) return this.accounts.get(address) ?? null;
    try {
      const f = rfixture(address);
      return { address: f.address, owner: f.owner, lamports: f.lamports, data: f.data };
    } catch {
      return null;
    }
  }

  /** Answers every queued read, including the ones those answers trigger (PDA derivations are async). */
  async flush(): Promise<void> {
    let quiet = 0;
    for (let round = 0; round < 200 && quiet < 5; round++) {
      const q = this.queue.splice(0);
      for (const { address, cb } of q) cb(this.lookup(address));
      await Bun.sleep(3);
      quiet = q.length || this.queue.length ? 0 : quiet + 1;
    }
  }
}

/** LaunchLab pools in the snapshot (see packages/core/test/armedRaydiumKit.ts). */
export const LL = {
  /** letsbonk.fun, SOL pair (traded by bonkBuy). */
  bonk: "6kgXHSnUa2g9n2VH6aGL9GYBEuQJYxVLwNzSsgNqmrYo",
  /** StonkFun SOL pair, Token-2022 base with a 3% transfer fee (stonkFeeBuy / stonkFeeSell). */
  stonkFee: "2mVGHRxDWc5ckj93LgwzcBhZVbzi1QNWf3SWXumfKKX2",
  /** TRiX SOL pair (trixBuy / trixSell). */
  trix: "G5WBxuD4cEjRSVvbxodNtJ7ruDatqwSQwNCMxdFdozZY",
  /** StonkFun pair quoted in a Token-2022 xStock (stonkXstockSell). */
  stonkXstock: "EkvuyEhr2JHmgMnoNQGzBYw8mAAqgB7W6BBQAkpVTnBS",
  /** letsbonk.fun coin that graduated into CPMM.bonk (tx "migrate"). */
  graduated: "yBtLj7s4aWFuBgSZCE5JpU6LoY6rofRui8cRmgbjT4S",
} as const;

export const CPMM = {
  /** wSOL / 7dmcQ9Ty… the graduated letsbonk coin (cpmmBonkBuy / cpmmBonkSell). */
  bonk: "92WCdsbayLJNUFAL3EQypWJLTL8gvmSpXMh6qZxo6PHh",
  /** wSOL / 9RcvjFss… a graduated StonkFun coin, Token-2022 with a 3% fee (cpmmStonk*). */
  stonk: "F5MuM3C8PanScX296quAoNcLYGjtt8pN7JkBM3qsiK6Z",
} as const;

export const llPool = (p: string): LaunchLabPool => decodeLaunchLabPool(rfixture(p).data);
export const llGlobal = (a: string): LaunchLabGlobalConfig => decodeLaunchLabGlobalConfig(rfixture(a).data);
export const llPlatform = (a: string): LaunchLabPlatformConfig => decodeLaunchLabPlatformConfig(rfixture(a).data);
export const cpmmPoolOf = (p: string): CpmmPool => decodeCpmmPool(rfixture(p).data);
export const ammConfigOf = (a: string): CpmmAmmConfig => decodeCpmmAmmConfig(rfixture(a).data);
export const vaultAmount = (a: string): bigint => decodeTokenAccount(rfixture(a).data).amount;
export const mintOf = (m: string) => decodeMint(rfixture(m).data, rfixture(m).owner);
