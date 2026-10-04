/**
 * Chain history reads for trade backfill and gap-fill: `getSignaturesForAddress` pages (newest first) over a
 * bonding curve or pool account, then `getTransaction` (json, maxSupportedTransactionVersion 1, confirmed) for
 * the signatures we do not hold yet. Our own chain reads are the source of truth; no indexer API is needed.
 *
 * maxSupportedTransactionVersion is 1, not 0: mainnet carries SIMD-0385 v1 transactions (NOTES.md,
 * 2026-10-03), which a 0 would refuse. Every v0 / legacy transaction is returned either way.
 *
 * Budget: one token bucket (`Pacer`) per reader, in calls per second, shared by every coin's backfill. The
 * public RPC answers 429 at about 2 getTransaction calls per second, so the default is low; a paid endpoint
 * (HISTORY_RPC_URL) takes a higher HISTORY_RPS and JSON-RPC batches (HISTORY_BATCH). A 429 pauses the reader
 * for the client's cooldown and the call is retried; `paused()` lets the live feed's own client pre-empt it.
 *
 * Optional (production): with a Helius key, `HeliusHistoryReader` adds `getTransactionsForAddress` full pages
 * (up to 100 parsed transactions per call). It is a speed-up only: the result is decoded by the same decoders.
 */
import type { RpcJsonTx } from "../ingest/jsonTx";
import { sleep } from "../util/backoff";
import { type RpcClient, RpcError } from "../util/rpc";

export interface SignatureInfo {
  signature: string;
  slot: number;
  /** Non-null for failed transactions (they carry no events). */
  err: unknown;
  /** Unix seconds; null when the node does not know it. */
  blockTime: number | null;
}

export interface FullPageEntry {
  info: SignatureInfo;
  tx: RpcJsonTx | null;
}

export interface HistoryReader {
  readonly name: string;
  /** Signatures per transactions() call (1 = no batching). */
  readonly batchSize: number;
  /** getSignaturesForAddress, newest first. `until`: stop at this signature (exclusive). */
  signatures(address: string, o: { before?: string; until?: string; limit?: number }): Promise<SignatureInfo[]>;
  /** getTransaction per signature, in input order; null when the node does not have it (yet). */
  transactions(signatures: readonly string[]): Promise<(RpcJsonTx | null)[]>;
  /** Optional: signatures and full transactions in one call (Helius getTransactionsForAddress). */
  fullPage?(address: string, o: { before?: string; until?: string }): Promise<{ entries: FullPageEntry[]; next: string | null }>;
  readonly stats: ReaderStats;
}

export interface ReaderStats {
  signaturePages: number;
  signatures: number;
  transactions: number;
  notFound: number;
  errors: number;
  rateLimited: number;
  retries: number;
  waitedMs: number;
  lastError: string | null;
}

/** Token bucket in calls per second. `take(n)` resolves once n calls may start; `paused()` holds everything. */
export class Pacer {
  private tokens: number;
  private last = Date.now();
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly perSec: number,
    private readonly paused: () => boolean = () => false,
    private readonly now: () => number = Date.now,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {
    this.tokens = Math.min(1, perSec);
  }

  /** Waits for `n` tokens (n may exceed the bucket size: it then waits for the deficit). Returns ms waited. */
  take(n = 1): Promise<number> {
    const run = this.chain.then(() => this.acquire(n));
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async acquire(n: number): Promise<number> {
    const t0 = this.now();
    if (!(this.perSec > 0)) return 0;
    for (;;) {
      if (this.paused()) {
        await this.wait(250);
        continue;
      }
      const now = this.now();
      this.tokens = Math.min(Math.max(1, this.perSec), this.tokens + ((now - this.last) * this.perSec) / 1000);
      this.last = now;
      const need = Math.min(n, Math.max(1, this.perSec));
      if (this.tokens >= need) {
        this.tokens -= n;
        return this.now() - t0;
      }
      await this.wait(Math.max(5, Math.ceil(((need - this.tokens) * 1000) / this.perSec)));
    }
  }
}

export interface RpcHistoryReaderOptions {
  rpc: RpcClient;
  perSec: number;
  batchSize?: number;
  /** Extra pause condition (e.g. the live feed's client is cooling down: live goes first). */
  paused?: () => boolean;
  maxRetries?: number;
  commitment?: "confirmed" | "finalized";
  name?: string;
}

const emptyStats = (): ReaderStats => ({
  signaturePages: 0,
  signatures: 0,
  transactions: 0,
  notFound: 0,
  errors: 0,
  rateLimited: 0,
  retries: 0,
  waitedMs: 0,
  lastError: null,
});

export class RpcHistoryReader implements HistoryReader {
  readonly name: string;
  readonly batchSize: number;
  readonly stats = emptyStats();
  protected readonly pacer: Pacer;

  constructor(protected readonly o: RpcHistoryReaderOptions) {
    this.name = o.name ?? "rpc";
    this.batchSize = Math.max(1, Math.min(100, o.batchSize ?? 1));
    this.pacer = new Pacer(o.perSec, () => o.rpc.coolingDown() || (o.paused?.() ?? false));
  }

  /** Runs `fn` under the pacer, retrying 429s / transient failures (after the client's cooldown). */
  protected async paced<T>(cost: number, fn: () => Promise<T>): Promise<T> {
    const max = this.o.maxRetries ?? 4;
    for (let attempt = 0; ; attempt++) {
      this.stats.waitedMs += await this.pacer.take(cost);
      try {
        return await fn();
      } catch (e) {
        const rpcErr = e instanceof RpcError ? e : null;
        if (rpcErr?.code === 429) this.stats.rateLimited++;
        this.stats.lastError = e instanceof Error ? e.message : String(e);
        // JSON-RPC errors other than rate limits / transport failures are final (bad params, unsupported version).
        const transient = !rpcErr || rpcErr.code === 429 || rpcErr.code === null || (rpcErr.code >= 500 && rpcErr.code < 600);
        if (!transient || attempt >= max) {
          this.stats.errors++;
          throw e;
        }
        this.stats.retries++;
        await sleep(Math.min(8_000, 400 * 2 ** attempt));
      }
    }
  }

  async signatures(address: string, o: { before?: string; until?: string; limit?: number }): Promise<SignatureInfo[]> {
    const cfg: Record<string, unknown> = { limit: Math.min(1_000, o.limit ?? 1_000), commitment: this.o.commitment ?? "confirmed" };
    if (o.before) cfg.before = o.before;
    if (o.until) cfg.until = o.until;
    const rows = await this.paced(1, () =>
      this.o.rpc.call<{ signature: string; slot: number; err: unknown; blockTime?: number | null }[]>("getSignaturesForAddress", [
        address,
        cfg,
      ]),
    );
    this.stats.signaturePages++;
    this.stats.signatures += rows.length;
    return rows.map((r) => ({ signature: r.signature, slot: r.slot, err: r.err ?? null, blockTime: r.blockTime ?? null }));
  }

  async transactions(signatures: readonly string[]): Promise<(RpcJsonTx | null)[]> {
    const out: (RpcJsonTx | null)[] = [];
    const cfg = { encoding: "json", maxSupportedTransactionVersion: 1, commitment: this.o.commitment ?? "confirmed" };
    for (let i = 0; i < signatures.length; i += this.batchSize) {
      const chunk = signatures.slice(i, i + this.batchSize);
      const res = await this.paced(chunk.length, () =>
        this.o.rpc.callBatch<RpcJsonTx | null>(
          "getTransaction",
          chunk.map((s) => [s, cfg]),
        ),
      );
      for (const r of res) {
        if (r instanceof RpcError) {
          this.stats.errors++;
          this.stats.lastError = r.message;
          out.push(null);
          continue;
        }
        this.stats.transactions++;
        if (!r) this.stats.notFound++;
        out.push(r);
      }
    }
    return out;
  }
}

/**
 * Helius `getTransactionsForAddress` (transactionDetails "full", newest first, up to 100 per call): signatures
 * and transactions in one paid call. Only built when HISTORY_HELIUS=true and a Helius key is configured; the
 * plain RPC methods stay available on the same endpoint (signatures(), transactions()).
 */
export class HeliusHistoryReader extends RpcHistoryReader {
  async fullPage(address: string, o: { before?: string; until?: string }): Promise<{ entries: FullPageEntry[]; next: string | null }> {
    const cfg: Record<string, unknown> = {
      transactionDetails: "full",
      sortOrder: "desc",
      limit: 100,
      encoding: "json",
      maxSupportedTransactionVersion: 1,
      commitment: this.o.commitment ?? "confirmed",
    };
    if (o.before) cfg.paginationToken = o.before;
    const r = await this.paced(1, () =>
      this.o.rpc.call<{ data?: (RpcJsonTx & { transactionIndex?: number })[]; paginationToken?: string | null }>(
        "getTransactionsForAddress",
        [address, cfg],
      ),
    );
    this.stats.signaturePages++;
    const entries: FullPageEntry[] = [];
    for (const tx of r.data ?? []) {
      const signature = tx.transaction?.signatures?.[0];
      if (!signature) continue;
      if (o.until && signature === o.until) return { entries, next: null };
      this.stats.signatures++;
      this.stats.transactions++;
      entries.push({ info: { signature, slot: tx.slot, err: tx.meta?.err ?? null, blockTime: tx.blockTime ?? null }, tx });
    }
    return { entries, next: r.paginationToken ?? null };
  }
}
