/**
 * Real mainnet transactions and accounts behind the market-cap regression tests (test/fixtures/market-cap.json,
 * recorded by scripts/record-market-cap-fixtures.ts on 2026-10-04 from tokens a live public-RPC run flagged).
 */
import { type Address, getBase64Encoder } from "@solana/kit";
import {
  decodeBondingCurve,
  decodeLogEvents,
  decodeMint,
  decodePool,
  decodeTransactionEvents,
  extractAmmPoolMints,
  isCanonicalPumpPool,
} from "@zerofee/core";
import type { CurveResolved, MintResolved, PoolInfo } from "../src/accounts/resolver";
import type { IngestTx } from "../src/ingest/types";
import captured from "./fixtures/market-cap.json";
import { eventInput, type RpcJsonTx } from "./helpers";

interface AccountFixture {
  address: string;
  owner: string;
  data: string;
}

const DATA = captured as unknown as {
  accountsSlot: number;
  txs: { labels: string[]; signature: string; tx: RpcJsonTx }[];
  accounts: Record<string, AccountFixture>;
};

export function mcFixture(label: string): { signature: string; tx: RpcJsonTx } {
  const f = DATA.txs.find((t) => t.labels.includes(label));
  if (!f) throw new Error(`no market-cap fixture ${label}`);
  return f;
}

/** IngestTx as the RPC logs source builds it (logs only). */
export function mcLogs(label: string): IngestTx {
  const f = mcFixture(label);
  return {
    signature: f.signature,
    slot: f.tx.slot,
    txIndex: null,
    blockTime: f.tx.blockTime,
    receivedAt: (f.tx.blockTime ?? 0) * 1000 + 800,
    sourceCreatedAt: null,
    source: "rpc-logs",
    events: decodeLogEvents(f.tx.meta.logMessages).events,
    signers: null,
    accountKeys: null,
    poolMints: [],
    tokenBalances: null,
  };
}

/** IngestTx as a gRPC source builds it (event CPIs, account keys, pool -> mint from instruction accounts). */
export function mcGrpc(label: string): IngestTx {
  const f = mcFixture(label);
  const input = eventInput(f.tx);
  return {
    ...mcLogs(label),
    txIndex: 3,
    source: "yellowstone",
    events: decodeTransactionEvents(input).events,
    accountKeys: [...input.accountKeys],
    poolMints: extractAmmPoolMints(input),
  };
}

const b64 = getBase64Encoder();

export function mcAccount(label: string): { address: string; owner: Address; data: Uint8Array } {
  const a = DATA.accounts[label];
  if (!a) throw new Error(`no market-cap account fixture ${label}`);
  return { address: a.address, owner: a.owner as Address, data: new Uint8Array(b64.encode(a.data)) };
}

/** What the resolver reports for a mint account fixture. */
export function mintResolved(label: string): MintResolved {
  const a = mcAccount(label);
  const m = decodeMint(a.data, a.owner);
  return { mint: a.address, tokenProgram: m.tokenProgram, decimals: m.decimals, supply: m.supply, metadata: null, dangers: [] };
}

export function curveResolved(label: string, mint: string): CurveResolved {
  const a = mcAccount(label);
  return { mint, bondingCurve: a.address, curve: decodeBondingCurve(a.data) };
}

/** A pool record as the resolver completes it from the pool account and its two mint accounts. */
export async function poolResolved(
  label: string,
  base: MintResolved,
  quote: { decimals: number; tokenProgram: string },
): Promise<PoolInfo> {
  const a = mcAccount(label);
  const p = decodePool(a.data);
  return {
    pool: a.address,
    baseMint: p.baseMint,
    quoteMint: p.quoteMint,
    index: p.index,
    creator: p.creator,
    lpMint: p.lpMint,
    lpSupply: p.lpSupply.toString(),
    poolBaseTokenAccount: p.poolBaseTokenAccount,
    poolQuoteTokenAccount: p.poolQuoteTokenAccount,
    coinCreator: p.coinCreator,
    isMayhemMode: p.isMayhemMode,
    isCashbackCoin: p.isCashbackCoin,
    creatorFeeBps: p.creatorFeeBps.toString(),
    canEditCreatorFee: p.canEditCreatorFee,
    isHolderReward: p.isHolderReward,
    isCanonical: await isCanonicalPumpPool(p),
    baseDecimals: base.decimals,
    quoteDecimals: quote.decimals,
    baseTokenProgram: base.tokenProgram,
    quoteTokenProgram: quote.tokenProgram,
    baseSupply: base.supply.toString(),
    fromAccount: true,
    updatedAt: 0,
  };
}
