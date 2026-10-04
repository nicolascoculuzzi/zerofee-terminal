/**
 * Ingest contract. A Source turns one upstream feed (RPC logs, Yellowstone gRPC, ...) into normalized
 * IngestTx records carrying decoded pump / PumpSwap / Raydium LaunchLab / Raydium CPMM events. The market
 * state is the single consumer.
 */
import type { AmmPoolMints, DecodedEvent } from "@zerofee/core";
import type { SourceHealth } from "@zerofee/protocol";
import type { RaydiumTxInfo } from "./raydium";

/** Post-transaction balance of one owner for one mint (sum of the owner's accounts listed in the tx meta). */
export interface TokenBalanceUpdate {
  mint: string;
  owner: string;
  amount: bigint;
}

export interface IngestTx {
  signature: string;
  slot: number;
  /** Position within the block when the source knows it (gRPC `index`), else null. */
  txIndex: number | null;
  /** Unix seconds when the source knows the block time (events carry their own timestamp too). */
  blockTime: number | null;
  /** Local receive time (ms). */
  receivedAt: number;
  /** When the upstream produced the update (Yellowstone `createdAt`), if known (ms). */
  sourceCreatedAt: number | null;
  source: string;
  /** Decoded events in emission order. */
  events: DecodedEvent[];
  /** Required signers (fee payer first) when the source has the message. */
  signers: string[] | null;
  /** Full account key list when the source has the message. */
  accountKeys: string[] | null;
  /** PumpSwap pool -> mint mappings recovered from instruction accounts. */
  poolMints: AmmPoolMints[];
  /**
   * Raydium facts from instruction accounts (mints, wallet, graduations), when the source has the full
   * transaction; absent / null for logs-only records (ingest/raydium.ts).
   */
  raydium?: RaydiumTxInfo | null;
  /** Absolute post-tx token balances, when the source has meta (lets holder tracking be exact). */
  tokenBalances: TokenBalanceUpdate[] | null;
  /**
   * Lamport balances before / after the tx, indexed like `accountKeys`, when the source has meta. Kept as the
   * source's decimal strings and parsed only where needed (did a known fee wallet get paid?).
   */
  lamports?: { pre: readonly string[]; post: readonly string[] } | null;
}

export type SlotStatus = "processed" | "confirmed" | "finalized" | "dead";

export interface BlockMeta {
  slot: number;
  blockhash: string;
  blockHeight: number | null;
  blockTime: number | null;
  parentSlot: number | null;
}

/**
 * Something happened that the source saw but could not decode into accounts: a LaunchLab graduation
 * (`migrate_to_cpswap`) in the logs feed, whose transaction could not be fetched. The market checks its
 * completed LaunchLab curves.
 */
export interface IngestHint {
  kind: "launchlabMigration";
  signature: string;
  slot: number;
}

export interface IngestSink {
  tx(tx: IngestTx): void;
  slot?(slot: number, status: SlotStatus): void;
  blockMeta?(meta: BlockMeta): void;
  decodeFailure?(info: { source: string; signature: string | null; message: string }): void;
  hint?(h: IngestHint): void;
}

export interface Source {
  readonly name: string;
  start(sink: IngestSink): void;
  stop(): Promise<void>;
  health(): SourceHealth;
}

/** Fixed-capacity FIFO; pushing into a full queue evicts the oldest item (counted as dropped). */
export class RingQueue<T> {
  private readonly buf: (T | undefined)[];
  private head = 0;
  private len = 0;
  dropped = 0;
  maxSeen = 0;

  constructor(readonly capacity: number) {
    this.buf = new Array(capacity);
  }

  push(v: T): void {
    if (this.len === this.capacity) {
      this.head = (this.head + 1) % this.capacity;
      this.len--;
      this.dropped++;
    }
    this.buf[(this.head + this.len) % this.capacity] = v;
    this.len++;
    if (this.len > this.maxSeen) this.maxSeen = this.len;
  }

  shift(): T | undefined {
    if (this.len === 0) return undefined;
    const v = this.buf[this.head];
    this.buf[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this.len--;
    return v;
  }

  get size(): number {
    return this.len;
  }
}
