/** Offline chain history for backfill tests: a fake getSignaturesForAddress / getTransaction over synthetic txs. */
import type { HistoryConfig } from "../src/config";
import type { HistoryReader, ReaderStats, SignatureInfo } from "../src/history/reader";
import type { RpcJsonTx } from "../src/ingest/jsonTx";
import type { IngestTx } from "../src/ingest/types";

export interface ChainTx {
  info: SignatureInfo;
  /** A synthetic IngestTx (decoded by `decodeFake`) or a real getTransaction JSON (decoded by ingestFromJsonTx). */
  tx: IngestTx | RpcJsonTx | null;
}

/** Wraps a synthetic IngestTx so it travels through the reader as an opaque "RpcJsonTx". */
const SYNTH = Symbol("synth");

export class FakeHistoryReader implements HistoryReader {
  readonly name = "fake";
  readonly stats: ReaderStats = {
    signaturePages: 0,
    signatures: 0,
    transactions: 0,
    notFound: 0,
    errors: 0,
    rateLimited: 0,
    retries: 0,
    waitedMs: 0,
    lastError: null,
  };
  /** Every getSignaturesForAddress call (address, before, until). */
  readonly calls: { address: string; before?: string; until?: string }[] = [];
  readonly fetched: string[] = [];
  private readonly bySig = new Map<string, ChainTx>();

  constructor(
    /** account -> its transactions, NEWEST FIRST (like the RPC). */
    readonly chain: Map<string, ChainTx[]>,
    readonly batchSize = 1,
    private readonly delayMs = 0,
  ) {
    for (const list of chain.values()) for (const c of list) this.bySig.set(c.info.signature, c);
  }

  /** Adds a newer transaction on top of an account's list. */
  push(address: string, c: ChainTx): void {
    const list = this.chain.get(address) ?? [];
    list.unshift(c);
    this.chain.set(address, list);
    this.bySig.set(c.info.signature, c);
  }

  async signatures(address: string, o: { before?: string; until?: string; limit?: number }): Promise<SignatureInfo[]> {
    if (this.delayMs) await Bun.sleep(this.delayMs);
    this.calls.push({ address, before: o.before, until: o.until });
    this.stats.signaturePages++;
    const list = this.chain.get(address) ?? [];
    let i = o.before ? list.findIndex((c) => c.info.signature === o.before) + 1 : 0;
    const out: SignatureInfo[] = [];
    for (; i < list.length && out.length < (o.limit ?? 1_000); i++) {
      const c = list[i] as ChainTx;
      if (o.until && c.info.signature === o.until) break;
      out.push(c.info);
    }
    this.stats.signatures += out.length;
    return out;
  }

  async transactions(signatures: readonly string[]): Promise<(RpcJsonTx | null)[]> {
    if (this.delayMs) await Bun.sleep(this.delayMs);
    return signatures.map((s) => {
      this.fetched.push(s);
      this.stats.transactions++;
      const c = this.bySig.get(s);
      if (!c?.tx) return null;
      return "events" in c.tx ? ({ [SYNTH]: c.tx } as unknown as RpcJsonTx) : c.tx;
    });
  }
}

/** HistoryDeps.decode for FakeHistoryReader's synthetic transactions. */
export function decodeFake(_signature: string, tx: RpcJsonTx, receivedAt: number): IngestTx | null {
  const synth = (tx as unknown as { [SYNTH]?: IngestTx })[SYNTH];
  return synth ? { ...synth, receivedAt, source: "backfill", txIndex: null } : null;
}

/** A chain entry from a synthetic tx (blockTime from its first timestamped event). */
export function chainTx(tx: IngestTx, err: unknown = null): ChainTx {
  const ts = tx.events.find((e) => "timestamp" in e) as { timestamp: bigint } | undefined;
  return { info: { signature: tx.signature, slot: tx.slot, err, blockTime: ts ? Number(ts.timestamp) : null }, tx };
}

export const HISTORY_CFG: HistoryConfig = {
  enabled: true,
  rpcUrl: "http://unused",
  rps: 1_000,
  batch: 1,
  concurrency: 1,
  maxTxPerCoin: 3_000,
  maxSignaturePages: 30,
  background: false,
  queueMax: 100,
  retainDays: 14,
  mergeEvery: 5,
  mergeMs: 0,
  gapDelayMs: 0,
  viewRefreshMs: 0,
  listedRefreshMs: 0,
  helius: false,
};
