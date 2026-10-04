/**
 * Blockhash cache: fetch at `confirmed`, keep lastValidBlockHeight, refresh every 1-2 s so new txs
 * start with nearly the full ~150-block window (tx_landing_and_mev.md §7).
 */
import type { Rpc, SolanaRpcApi } from "@solana/kit";
import type { BlockhashInfo } from "./assemble";

export class BlockhashCache {
  private current: (BlockhashInfo & { fetchedAt: number }) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<BlockhashInfo> | null = null;

  constructor(
    private readonly rpc: Rpc<Pick<SolanaRpcApi, "getLatestBlockhash">>,
    private readonly maxAgeMs = 2_000,
  ) {}

  async refresh(): Promise<BlockhashInfo> {
    this.inflight ??= this.rpc
      .getLatestBlockhash({ commitment: "confirmed" })
      .send()
      .then(({ value }) => {
        this.current = { ...value, fetchedAt: Date.now() };
        return value;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** Returns a cached blockhash younger than maxAgeMs, else fetches. */
  async get(): Promise<BlockhashInfo> {
    if (this.current && Date.now() - this.current.fetchedAt < this.maxAgeMs) return this.current;
    return this.refresh();
  }

  start(intervalMs = 1_500): void {
    if (this.timer) return;
    void this.refresh().catch(() => {});
    this.timer = setInterval(() => void this.refresh().catch(() => {}), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
