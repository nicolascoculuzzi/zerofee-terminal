/** Test helpers: real fixtures, synthetic events, a fake resolver and mocked fetch. */
import type { Address } from "@solana/kit";
import { getAddressDecoder, getBase58Encoder } from "@solana/kit";
import {
  type AmmSwapEvent,
  type DecodedEvent,
  decodeLogEvents,
  decodeTransactionEvents,
  extractAmmPoolMints,
  type PumpCreateEvent,
  type PumpTradeEvent,
  TOKEN_2022_PROGRAM_ID,
  type TransactionEventInput,
  type TxInstruction,
} from "@zerofee/core";
import captured from "../../../packages/core/test/fixtures/event-txs.json";
import type { PoolInfo } from "../src/accounts/resolver";
import type { IngestTx } from "../src/ingest/types";
import type { ResolverLike } from "../src/market/state";

// ---------------------------------------------------------------------------------------------
// real mainnet fixtures (captured 2026-10-03 by packages/core/scripts/capture-event-fixtures.ts)
// ---------------------------------------------------------------------------------------------

export interface RpcJsonIx {
  programIdIndex: number;
  accounts: number[];
  data: string;
  stackHeight?: number | null;
}

export interface RpcJsonTx {
  slot: number;
  blockTime: number | null;
  version: number | "legacy";
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
    preTokenBalances?: {
      accountIndex: number;
      mint: string;
      owner: string;
      programId: string;
      uiTokenAmount: { amount: string; decimals: number };
    }[];
    postTokenBalances?: {
      accountIndex: number;
      mint: string;
      owner: string;
      programId: string;
      uiTokenAmount: { amount: string; decimals: number };
    }[];
    computeUnitsConsumed?: number;
  };
}

export const FIXTURES = (captured as unknown as { txs: { labels: string[]; signature: string; tx: RpcJsonTx }[] }).txs;

export function fixture(label: string): { signature: string; tx: RpcJsonTx } {
  const f = FIXTURES.find((t) => t.labels.includes(label));
  if (!f) throw new Error(`no fixture ${label}`);
  return f;
}

const b58 = getBase58Encoder();

export function eventInput(tx: RpcJsonTx): TransactionEventInput {
  const ix = (i: RpcJsonIx): TxInstruction => ({
    programIdIndex: i.programIdIndex,
    accounts: i.accounts,
    data: new Uint8Array(b58.encode(i.data)),
  });
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

/** IngestTx as the RPC logs source would build it (logs only, no keys). */
export function logsIngest(label: string, receivedAt?: number): IngestTx {
  const f = fixture(label);
  const events = decodeLogEvents(f.tx.meta.logMessages).events;
  return {
    signature: f.signature,
    slot: f.tx.slot,
    txIndex: null,
    blockTime: f.tx.blockTime,
    receivedAt: receivedAt ?? (f.tx.blockTime ?? 0) * 1000 + 800,
    sourceCreatedAt: null,
    source: "rpc-logs",
    events,
    signers: null,
    accountKeys: null,
    poolMints: [],
    tokenBalances: null,
  };
}

/** IngestTx as a gRPC source would build it (CPI events, keys, pool mints). */
export function grpcIngest(label: string, receivedAt?: number): IngestTx {
  const f = fixture(label);
  const input = eventInput(f.tx);
  return {
    signature: f.signature,
    slot: f.tx.slot,
    txIndex: 7,
    blockTime: f.tx.blockTime,
    receivedAt: receivedAt ?? (f.tx.blockTime ?? 0) * 1000 + 300,
    sourceCreatedAt: null,
    source: "yellowstone",
    events: decodeTransactionEvents(input).events,
    signers: input.accountKeys.slice(0, f.tx.transaction.message.header.numRequiredSignatures),
    accountKeys: [...input.accountKeys],
    poolMints: extractAmmPoolMints(input),
    tokenBalances: null,
  };
}

// ---------------------------------------------------------------------------------------------
// synthetic events
// ---------------------------------------------------------------------------------------------

const addressDecoder = getAddressDecoder();

/** Deterministic test addresses: 32 pseudo-random bytes derived from `tag` (valid pubkeys, nobody's keys). */
export function addr(tag: string): string {
  let h = 2166136261;
  for (const c of tag) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    h = (Math.imul(h, 1103515245) + 12345) >>> 0;
    bytes[i] = h >>> 24;
  }
  return addressDecoder.decode(bytes);
}

const DEFAULT = "11111111111111111111111111111111";

/** A tiny constant-product curve to generate consistent TradeEvents. */
export class FakeCurve {
  vToken = 1_073_000_000_000_000n;
  vQuote = 30_000_000_000n;
  rToken = 793_100_000_000_000n;
  rQuote = 0n;

  constructor(
    readonly mint: string,
    readonly creator: string,
    readonly bondingCurve = addr(`curve:${mint}`),
  ) {}

  create(ts: number, opts: Partial<PumpCreateEvent> = {}): PumpCreateEvent {
    return {
      kind: "pumpCreate",
      name: `Name ${this.mint.slice(0, 4)}`,
      symbol: this.mint.slice(0, 4).toUpperCase(),
      uri: "",
      mint: this.mint as Address,
      bondingCurve: this.bondingCurve as Address,
      user: this.creator as Address,
      creator: this.creator as Address,
      timestamp: BigInt(ts),
      virtualTokenReserves: this.vToken,
      virtualSolReserves: this.vQuote,
      realTokenReserves: this.rToken,
      tokenTotalSupply: 1_000_000_000_000_000n,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      isMayhemMode: false,
      isCashbackEnabled: false,
      quoteMint: DEFAULT as Address,
      virtualQuoteReserves: this.vQuote,
      creatorFeeBps: 0n,
      isHolderReward: false,
      ...opts,
    };
  }

  private event(user: string, isBuy: boolean, quoteAmount: bigint, tokenAmount: bigint, ts: number): PumpTradeEvent {
    return {
      kind: "pumpTrade",
      mint: this.mint as Address,
      quoteAmount,
      tokenAmount,
      isBuy,
      user: user as Address,
      timestamp: BigInt(ts),
      virtualQuoteReserves: this.vQuote,
      virtualTokenReserves: this.vToken,
      realQuoteReserves: this.rQuote,
      realTokenReserves: this.rToken,
      feeRecipient: DEFAULT as Address,
      feeBps: 95n,
      fee: 0n,
      creator: this.creator as Address,
      creatorFeeBps: 30n,
      creatorFee: 0n,
      trackVolume: false,
      ixName: isBuy ? "buy" : "sell",
      mayhemMode: false,
      cashbackFeeBps: 0n,
      cashback: 0n,
      buybackFeeBps: 0n,
      buybackFee: 0n,
      shareholders: [],
      quote: { mint: DEFAULT as Address, amount: quoteAmount, virtualReserves: this.vQuote, realReserves: this.rQuote },
      holderRewardsBps: 0n,
      holderRewards: 0n,
    };
  }

  /** Buys with `lamports` net quote; returns the event with post-trade reserves. */
  buy(user: string, lamports: bigint, ts: number): PumpTradeEvent {
    let tokens = (lamports * this.vToken) / (this.vQuote + lamports);
    if (tokens > this.rToken) tokens = this.rToken;
    this.vToken -= tokens;
    this.rToken -= tokens;
    this.vQuote += lamports;
    this.rQuote += lamports;
    return this.event(user, true, lamports, tokens, ts);
  }

  sell(user: string, tokens: bigint, ts: number): PumpTradeEvent {
    const lamports = (tokens * this.vQuote) / (this.vToken + tokens);
    this.vToken += tokens;
    this.rToken += tokens;
    this.vQuote -= lamports;
    this.rQuote -= lamports;
    return this.event(user, false, lamports, tokens, ts);
  }
}

let sigCounter = 0;

export function synthTx(slot: number, events: DecodedEvent[], o: Partial<IngestTx> = {}): IngestTx {
  const ts = events.find((e) => "timestamp" in e) as { timestamp: bigint } | undefined;
  return {
    signature: o.signature ?? `sig${++sigCounter}${"x".repeat(60)}`.slice(0, 88),
    slot,
    txIndex: o.txIndex ?? null,
    blockTime: null,
    receivedAt: o.receivedAt ?? (ts ? Number(ts.timestamp) * 1000 + 500 : Date.now()),
    sourceCreatedAt: null,
    source: "test",
    events,
    signers: null,
    accountKeys: o.accountKeys ?? null,
    poolMints: o.poolMints ?? [],
    tokenBalances: o.tokenBalances ?? null,
    ...o,
  };
}

export function ammSwap(o: Omit<Partial<AmmSwapEvent>, "pool"> & { pool: string; kind: "ammBuy" | "ammSell" }): AmmSwapEvent {
  return {
    timestamp: 1_791_048_946n,
    baseAmount: 1_000_000_000n,
    quoteLimit: 0n,
    userBaseReserves: 0n,
    userQuoteReserves: 0n,
    poolBaseReserves: 200_000_000_000_000n,
    poolQuoteReserves: 80_000_000_000n,
    quoteAmount: 400_000n,
    lpFeeBps: 20n,
    lpFee: 800n,
    protocolFeeBps: 5n,
    protocolFee: 200n,
    quoteAmountVault: 400_800n,
    userQuoteAmount: 401_000n,
    user: addr("amm-user") as Address,
    userBaseTokenAccount: DEFAULT as Address,
    userQuoteTokenAccount: DEFAULT as Address,
    protocolFeeRecipient: DEFAULT as Address,
    protocolFeeRecipientTokenAccount: DEFAULT as Address,
    coinCreator: addr("coin-creator") as Address,
    coinCreatorFeeBps: 95n,
    coinCreatorFee: 3_800n,
    ixName: "buy",
    cashbackFeeBps: 0n,
    cashback: 0n,
    buybackFeeBps: 0n,
    buybackFee: 0n,
    virtualQuoteReserves: 0n,
    canBoost: false,
    baseSupply: 1_000_000_000_000_000n,
    holderRewardsBps: 0n,
    holderRewards: 0n,
    ...o,
    pool: o.pool as Address,
  };
}

// ---------------------------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------------------------

export class FakeResolver implements ResolverLike {
  readonly pools = new Map<string, PoolInfo>();
  readonly requested = { pools: [] as string[], mints: [] as string[], curves: [] as string[] };

  learnPool(partial: Partial<PoolInfo> & { pool: string; baseMint: string; quoteMint: string }): PoolInfo {
    const prev = this.pools.get(partial.pool);
    const info = { ...emptyPool(partial.pool, partial.baseMint, partial.quoteMint), ...prev, ...stripNulls(partial) } as PoolInfo;
    this.pools.set(partial.pool, info);
    return info;
  }

  requestPool(pool: string): void {
    this.requested.pools.push(pool);
  }

  requestMint(mint: string): void {
    this.requested.mints.push(mint);
  }

  requestCurve(mint: string): void {
    this.requested.curves.push(mint);
  }
}

function stripNulls<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;
}

export function emptyPool(pool: string, baseMint: string, quoteMint: string): PoolInfo {
  return {
    pool,
    baseMint,
    quoteMint,
    index: null,
    creator: null,
    lpMint: null,
    lpSupply: null,
    poolBaseTokenAccount: null,
    poolQuoteTokenAccount: null,
    coinCreator: null,
    isMayhemMode: null,
    isCashbackCoin: null,
    creatorFeeBps: null,
    canEditCreatorFee: null,
    isHolderReward: null,
    isCanonical: null,
    baseDecimals: null,
    quoteDecimals: null,
    baseTokenProgram: null,
    quoteTokenProgram: null,
    baseSupply: null,
    fromAccount: false,
    updatedAt: 0,
  };
}

export interface MockCall {
  url: string;
  method: string;
  body: unknown;
}

/** fetch mock: `route(url, body)` returns [status, json] or a Response. */
export function mockFetch(route: (url: string, body: { method?: string; params?: unknown[] } | null) => [number, unknown] | Response) {
  const calls: MockCall[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let body: { method?: string; params?: unknown[] } | null = null;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = null;
      }
    }
    calls.push({ url, method: body?.method ?? init?.method ?? "GET", body });
    const r = route(url, body);
    if (r instanceof Response) return r;
    return new Response(JSON.stringify(r[1]), { status: r[0], headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}

export async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 3_000, stepMs = 10): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timed out");
    await Bun.sleep(stepMs);
  }
}
