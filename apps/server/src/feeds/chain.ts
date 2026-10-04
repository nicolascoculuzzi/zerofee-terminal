/**
 * `chain` topic state: what a browser needs to stamp, price and tip a transaction it builds locally.
 *
 *  - Blockhash: RPC mode polls `getLatestBlockhash(confirmed)` every ~2 s. Yellowstone mode takes it
 *    from `blocks_meta` and publishes a slot's blockhash once that slot is CONFIRMED (a processed
 *    blockhash from a fork that dies would make transactions unlandable). lastValidBlockHeight =
 *    block height + 150 (core BLOCKHASH_VALID_BLOCKS), the same value getLatestBlockhash returns.
 *  - Priority fees: Helius getPriorityFeeEstimate when RPC_URL is Helius, else percentiles of
 *    getRecentPrioritizationFees over a hot pump account; refreshed every 10 s.
 *  - Jito tip floor: https://bundles.jito.wtf/api/v1/bundles/tip_floor every 10 s.
 *  - SOL/USD from the Binance feed.
 */
import {
  BLOCKHASH_VALID_BLOCKS,
  fetchHeliusPriorityFeeEstimate,
  fetchJitoTipFloor,
  JITO_TIP_FLOOR_URL,
  PUMP_FEE_RECIPIENTS,
  percentile,
  type TipFloor,
} from "@zerofee/core";
import type { ChainDelta, ChainState, HaltState, SolUsdPrice } from "@zerofee/protocol";
import type { BlockMeta, SlotStatus } from "../ingest/types";
import { logger } from "../log";
import type { RpcClient } from "../util/rpc";

const log = logger("chain");

export interface ChainPublisherOptions {
  rpc: RpcClient;
  /** "rpc": poll getLatestBlockhash; "stream": blockhash from Yellowstone blocks_meta. */
  blockhashMode: "rpc" | "stream";
  pollMs: number;
  feesEveryMs?: number;
  tipFloorEveryMs?: number;
  fetchFn?: typeof fetch;
  onChange(delta: ChainDelta): void;
}

export class ChainPublisher {
  readonly state: ChainState = {
    slot: null,
    blockhash: null,
    lastValidBlockHeight: null,
    blockhashSlot: null,
    blockhashUpdatedAt: null,
    priorityFees: null,
    jitoTipFloor: null,
    solUsd: null,
    halt: { halted: false, reason: null, since: null },
  };
  private readonly metas = new Map<number, BlockMeta>();
  private readonly confirmed = new Set<number>();
  private timers: ReturnType<typeof setInterval>[] = [];
  readonly stats = { blockhashPolls: 0, blockhashErrors: 0, feeErrors: 0, tipErrors: 0 };

  constructor(private readonly opts: ChainPublisherOptions) {}

  start(): void {
    const every = (ms: number, fn: () => Promise<void>) => {
      void fn();
      this.timers.push(setInterval(() => void fn(), ms));
    };
    if (this.opts.blockhashMode === "rpc") every(this.opts.pollMs, () => this.pollBlockhash());
    every(this.opts.feesEveryMs ?? 10_000, () => this.pollFees());
    every(this.opts.tipFloorEveryMs ?? 10_000, () => this.pollTipFloor());
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private set(delta: ChainDelta): void {
    let changed = false;
    for (const [k, v] of Object.entries(delta) as [keyof ChainState, unknown][]) {
      if (JSON.stringify(this.state[k]) !== JSON.stringify(v)) {
        (this.state as unknown as Record<string, unknown>)[k] = v;
        changed = true;
      } else delete (delta as Record<string, unknown>)[k];
    }
    if (changed) this.opts.onChange(delta);
  }

  onSlot(slot: number, status: SlotStatus): void {
    if (status === "processed" && (this.state.slot === null || slot > this.state.slot)) this.set({ slot });
    if (status === "confirmed" && this.opts.blockhashMode === "stream") {
      this.confirmed.add(slot);
      const meta = this.metas.get(slot);
      if (meta) this.publishMeta(meta);
      this.prune(slot);
    }
  }

  onBlockMeta(meta: BlockMeta): void {
    if (this.opts.blockhashMode !== "stream") return;
    this.metas.set(meta.slot, meta);
    if (this.confirmed.has(meta.slot)) this.publishMeta(meta);
  }

  private publishMeta(meta: BlockMeta): void {
    if (meta.blockHeight === null) return;
    if (this.state.blockhashSlot !== null && meta.slot <= this.state.blockhashSlot) return;
    this.set({
      blockhash: meta.blockhash,
      lastValidBlockHeight: meta.blockHeight + BLOCKHASH_VALID_BLOCKS,
      blockhashSlot: meta.slot,
      blockhashUpdatedAt: Date.now(),
    });
  }

  private prune(slot: number): void {
    for (const s of this.metas.keys()) if (s < slot - 300) this.metas.delete(s);
    for (const s of this.confirmed) if (s < slot - 300) this.confirmed.delete(s);
  }

  /** Kill-switch state (admin halt / resume); published on change, never throttled. */
  setHalt(halt: HaltState): void {
    this.set({ halt: { ...halt } });
  }

  setSolUsd(p: SolUsdPrice | null): void {
    if (!p) return;
    const prev = this.state.solUsd;
    // throttle: price moves of < 0.01% and freshness flips only
    if (prev && prev.stale === p.stale && Math.abs(prev.price - p.price) / prev.price < 0.0001 && p.updatedAt - prev.updatedAt < 5_000)
      return;
    this.set({ solUsd: p });
  }

  async pollBlockhash(): Promise<void> {
    if (this.opts.rpc.coolingDown()) return;
    try {
      const r = await this.opts.rpc.getLatestBlockhash("confirmed");
      this.stats.blockhashPolls++;
      if (r.value.blockhash !== this.state.blockhash) {
        this.set({
          blockhash: r.value.blockhash,
          lastValidBlockHeight: r.value.lastValidBlockHeight,
          blockhashSlot: r.context.slot,
          blockhashUpdatedAt: Date.now(),
        });
      }
    } catch (e) {
      this.stats.blockhashErrors++;
      log.debug(`blockhash poll failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  async pollFees(): Promise<void> {
    if (this.opts.rpc.coolingDown()) return;
    const url = this.opts.rpc.url;
    try {
      if (url.includes("helius-rpc.com")) {
        const [p50, p75, p95] = await Promise.all(
          (["eco", "fast", "turbo"] as const).map((preset) =>
            fetchHeliusPriorityFeeEstimate(url, [PUMP_FEE_RECIPIENTS[0] as string], preset, this.opts.fetchFn),
          ),
        );
        this.set({ priorityFees: { p50: Number(p50), p75: Number(p75), p95: Number(p95), source: "helius", updatedAt: Date.now() } });
        return;
      }
      // Every curve trade write-locks one of the 8 protocol fee recipients: sample them all.
      const lists = await Promise.all(PUMP_FEE_RECIPIENTS.slice(0, 4).map((a) => this.opts.rpc.getRecentPrioritizationFees([a])));
      const samples = lists.flat().map((r) => r.prioritizationFee);
      this.set({
        priorityFees: {
          p50: percentile(samples, 50),
          p75: percentile(samples, 75),
          p95: percentile(samples, 95),
          source: "rpc",
          updatedAt: Date.now(),
        },
      });
    } catch (e) {
      this.stats.feeErrors++;
      log.debug(`fee sampling failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  async pollTipFloor(): Promise<void> {
    try {
      const f: TipFloor = await fetchJitoTipFloor(this.opts.fetchFn ?? fetch, JITO_TIP_FLOOR_URL);
      this.set({
        jitoTipFloor: {
          p25: Number(f.p25),
          p50: Number(f.p50),
          p75: Number(f.p75),
          p95: Number(f.p95),
          p99: Number(f.p99),
          emaP50: Number(f.emaP50),
          updatedAt: Date.now(),
        },
      });
    } catch (e) {
      this.stats.tipErrors++;
      log.debug(`tip floor failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  snapshot(): ChainState {
    return { ...this.state, halt: { ...this.state.halt } };
  }
}
