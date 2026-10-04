/**
 * YellowstoneSource - the production feed: one Yellowstone (Dragon's Mouth) gRPC subscription to
 * transactions that include the pump / PumpSwap / Raydium LaunchLab / Raydium CPMM programs
 * (`accountInclude`, which matches CPI'd programs too; vote=false, failed=false) at processed
 * commitment, plus `blocks_meta` (blockhash, block height, block time) and every slot status (to learn
 * confirmations and dead slots).
 *
 * Client: @triton-one/yellowstone-grpc 8.x (N-API). Verified under Bun 1.3.14 on darwin-arm64 against a
 * local mock Geyser server (test/yellowstone.test.ts): connect, bidirectional subscribe, x-token
 * header and streamed updates all work. Prebuilt binaries exist for darwin-x64/arm64 and
 * linux-x64-gnu/musl (not linux-arm64).
 *
 * Reconnect: exponential backoff, resubscribe with `fromSlot` a little before the last slot seen
 * (providers keep ~100-150 slots), replayed duplicates are dropped downstream by (signature, slot).
 * Keepalive: a ping every 15 s (Cloudflare-fronted endpoints close idle streams); the ping request
 * repeats the filters because every SubscribeRequest replaces the subscription.
 */
import type { Address } from "@solana/kit";
import Client, { type ChannelOptions, CommitmentLevel, type SubscribeRequest, type SubscribeUpdate } from "@triton-one/yellowstone-grpc";
import type { SourceHealth } from "@zerofee/protocol";
import { logger } from "../log";
import { Backoff, sleep } from "../util/backoff";
import type { IngestSink, Source } from "./types";
import { parseSubscribeUpdate } from "./yellowstoneParse";

const log = logger("yellowstone");

/** Structural slice of the client we use (lets tests inject a fake). */
export interface GeyserClientLike {
  connect(): Promise<void>;
  subscribe(): Promise<GeyserStreamLike>;
}

export interface GeyserStreamLike {
  on(event: "data", listener: (u: SubscribeUpdate) => void): unknown;
  on(event: "error", listener: (e: Error) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
  write(req: SubscribeRequest, cb?: (err?: Error | null) => void): boolean;
  destroy(err?: Error): unknown;
}

export interface YellowstoneSourceOptions {
  endpoint: string;
  xToken: string | null;
  commitment: "processed" | "confirmed";
  programs: readonly Address[];
  pingIntervalMs?: number;
  /** How many slots before the last seen slot to replay from after a reconnect. */
  replaySlots?: number;
  createClient?: (endpoint: string, xToken: string | undefined) => GeyserClientLike;
}

export function buildSubscribeRequest(
  opts: Pick<YellowstoneSourceOptions, "programs" | "commitment">,
  fromSlot?: number,
): SubscribeRequest {
  return {
    accounts: {},
    slots: { slots: { filterByCommitment: false } },
    transactions: {
      launchpads: { vote: false, failed: false, accountInclude: [...opts.programs], accountExclude: [], accountRequired: [] },
    },
    transactionsStatus: {},
    blocks: {},
    blocksMeta: { blockmeta: {} },
    entry: {},
    accountsDataSlice: [],
    blockFooter: {},
    commitment: opts.commitment === "confirmed" ? CommitmentLevel.CONFIRMED : CommitmentLevel.PROCESSED,
    ...(fromSlot !== undefined ? { fromSlot: String(fromSlot) } : {}),
  };
}

export class YellowstoneSource implements Source {
  readonly name = "yellowstone";
  private sink: IngestSink | null = null;
  private stopped = false;
  private stream: GeyserStreamLike | null = null;
  private readonly backoff = new Backoff(500, 30_000);
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingId = 1;
  private lastSlot: number | null = null;
  private readonly blockTimes = new Map<number, number>();
  readonly stats = {
    connected: false,
    reconnects: 0,
    updates: 0,
    txs: 0,
    failedTxs: 0,
    txsWithoutEvents: 0,
    decodeFailures: 0,
    blockMetas: 0,
    deadSlots: 0,
    pongs: 0,
    lastMessageAt: null as number | null,
    lastError: null as string | null,
  };

  constructor(private readonly opts: YellowstoneSourceOptions) {}

  start(sink: IngestSink): void {
    this.sink = sink;
    this.stopped = false;
    void this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.stream?.destroy();
    this.stream = null;
  }

  private createClient(): GeyserClientLike {
    if (this.opts.createClient) return this.opts.createClient(this.opts.endpoint, this.opts.xToken ?? undefined);
    const channel: ChannelOptions = { grpcMaxDecodingMessageSize: 64 * 1024 * 1024, grpcTcpNodelay: true };
    return new Client(this.opts.endpoint, this.opts.xToken ?? undefined, channel) as unknown as GeyserClientLike;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const startedAt = Date.now();
      try {
        await this.session();
      } catch (e) {
        this.stats.lastError = e instanceof Error ? e.message : String(e);
        log.warn(`stream failed: ${this.stats.lastError}`);
      }
      this.stats.connected = false;
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.stopped) break;
      if (Date.now() - startedAt > 60_000) this.backoff.reset();
      const delay = this.backoff.next();
      this.stats.reconnects++;
      log.warn(`reconnect #${this.stats.reconnects} in ${delay} ms (resume from slot ${this.resumeSlot() ?? "tip"})`);
      await sleep(delay);
    }
  }

  private resumeSlot(): number | undefined {
    return this.lastSlot === null ? undefined : Math.max(0, this.lastSlot - (this.opts.replaySlots ?? 8));
  }

  /** One connect + subscribe; resolves when the stream ends. */
  private async session(): Promise<void> {
    const client = this.createClient();
    await client.connect();
    const stream = await client.subscribe();
    this.stream = stream;
    const ended = new Promise<void>((resolve, reject) => {
      stream.on("data", (u: SubscribeUpdate) => this.onUpdate(u));
      stream.on("error", (e: Error) => reject(e));
      stream.on("end", () => resolve());
      stream.on("close", () => resolve());
    });
    await new Promise<void>((resolve, reject) =>
      stream.write(buildSubscribeRequest(this.opts, this.resumeSlot()), (err) => (err ? reject(err) : resolve())),
    );
    this.stats.connected = true;
    log.info(`subscribed (${this.opts.commitment}) to ${this.opts.programs.length} program(s)`);
    const base = buildSubscribeRequest(this.opts);
    this.pingTimer = setInterval(() => {
      stream.write({ ...base, ping: { id: this.pingId++ } });
    }, this.opts.pingIntervalMs ?? 15_000);
    try {
      await ended;
    } finally {
      this.stream = null;
      stream.destroy();
    }
  }

  /** Exposed for tests. */
  onUpdate(u: SubscribeUpdate): void {
    const now = Date.now();
    this.stats.updates++;
    this.stats.lastMessageAt = now;
    const p = parseSubscribeUpdate(u, now);
    switch (p.kind) {
      case "tx": {
        this.stats.txs++;
        if (this.lastSlot === null || p.tx.slot > this.lastSlot) this.lastSlot = p.tx.slot;
        for (const message of p.failures) {
          this.stats.decodeFailures++;
          this.sink?.decodeFailure?.({ source: this.name, signature: p.tx.signature, message });
        }
        // LaunchLab graduations (migrate_to_cpswap) emit no event: keep them for their instruction accounts.
        if (!p.tx.events.length && !p.tx.raydium?.migrations.length) {
          this.stats.txsWithoutEvents++;
          return;
        }
        p.tx.blockTime = this.blockTimes.get(p.tx.slot) ?? null;
        this.sink?.tx(p.tx);
        return;
      }
      case "failedTx":
        this.stats.failedTxs++;
        return;
      case "slot":
        if (p.status === "dead") this.stats.deadSlots++;
        if (p.status) this.sink?.slot?.(p.slot, p.status);
        return;
      case "blockMeta":
        this.stats.blockMetas++;
        if (p.meta.blockTime !== null) {
          this.blockTimes.set(p.meta.slot, p.meta.blockTime);
          if (this.blockTimes.size > 2_000) this.blockTimes.delete(this.blockTimes.keys().next().value as number);
        }
        this.sink?.blockMeta?.(p.meta);
        return;
      case "pong":
        this.stats.pongs++;
        return;
      default:
        return;
    }
  }

  health(): SourceHealth {
    return {
      name: this.name,
      connected: this.stats.connected,
      reconnects: this.stats.reconnects,
      messages: this.stats.updates,
      lastMessageAt: this.stats.lastMessageAt,
      slot: this.lastSlot,
      dropped: 0,
      notes: [
        `txs ${this.stats.txs} (failed ${this.stats.failedTxs}, without events ${this.stats.txsWithoutEvents}), decode failures ${this.stats.decodeFailures}`,
        `block metas ${this.stats.blockMetas}, dead slots ${this.stats.deadSlots}, pongs ${this.stats.pongs}`,
        ...(this.stats.lastError ? [`last error: ${this.stats.lastError}`] : []),
      ],
    };
  }
}
