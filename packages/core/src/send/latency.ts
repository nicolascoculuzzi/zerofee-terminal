/**
 * Per-trade latency record: received -> (quoted) -> built -> signed -> sent -> first ack -> landed.
 * Times are milliseconds relative to `receivedAt` (performance.now based), plus the epoch timestamp,
 * slot at send and landed slot (slot delta = 0-slot / 1-slot ...), and per-lane acks for win-rate stats.
 */
import type { LaneAck } from "./lane";
import { now } from "./lane";

export type LatencyStage = "stateLoaded" | "quoted" | "built" | "signed" | "simulated" | "sent" | "firstAck" | "landed";

export interface LatencyRecord {
  id: string;
  side: "buy" | "sell";
  venue: "pump" | "pumpswap" | "launchlab" | "cpmm";
  mint: string;
  dryRun: boolean;
  receivedAtEpochMs: number;
  /** ms since received, per stage reached. */
  stages: Partial<Record<LatencyStage, number>>;
  lanes: { lane: string; ok: boolean; sentMs: number; ackMs: number; error?: string; bundleId?: string }[];
  signature?: string;
  slotAtSend?: bigint;
  landedSlot?: bigint;
  slotDelta?: bigint;
  outcome?: string;
}

export class LatencyTracker {
  private readonly t0: number;
  readonly record: LatencyRecord;

  constructor(meta: Pick<LatencyRecord, "side" | "venue" | "mint" | "dryRun"> & { id?: string }) {
    this.t0 = now();
    this.record = {
      id: meta.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      side: meta.side,
      venue: meta.venue,
      mint: meta.mint,
      dryRun: meta.dryRun,
      receivedAtEpochMs: Date.now(),
      stages: {},
      lanes: [],
    };
  }

  /** Marks a stage at the current time (or at an explicit performance.now() timestamp). */
  mark(stage: LatencyStage, at: number = now()): number {
    const ms = Math.round((at - this.t0) * 100) / 100;
    this.record.stages[stage] = ms;
    return ms;
  }

  laneAck(ack: LaneAck): void {
    const rel = (t: number) => Math.round((t - this.t0) * 100) / 100;
    this.record.lanes.push({
      lane: ack.lane,
      ok: ack.ok,
      sentMs: rel(ack.sentAt),
      ackMs: rel(ack.ackAt),
      error: ack.error,
      bundleId: ack.bundleId,
    });
  }

  landed(slot: bigint | undefined, at?: number): void {
    this.mark("landed", at);
    this.record.landedSlot = slot;
    if (slot !== undefined && this.record.slotAtSend !== undefined) this.record.slotDelta = slot - this.record.slotAtSend;
  }

  /** Human-readable multi-line breakdown. */
  format(): string {
    const order: LatencyStage[] = ["stateLoaded", "quoted", "built", "signed", "simulated", "sent", "firstAck", "landed"];
    const lines = [`latency ${this.record.id} (${this.record.side} ${this.record.venue}${this.record.dryRun ? ", DRY RUN" : ""})`];
    let prev = 0;
    for (const s of order) {
      const v = this.record.stages[s];
      if (v === undefined) continue;
      lines.push(`  ${s.padEnd(12)} +${v.toFixed(1).padStart(8)} ms   (Δ ${(v - prev).toFixed(1)} ms)`);
      prev = v;
    }
    for (const l of this.record.lanes) {
      lines.push(
        `  lane ${l.lane}: ${l.ok ? "ok" : "FAIL"} sent +${l.sentMs.toFixed(1)} ack +${l.ackMs.toFixed(1)} ms${l.error ? ` (${l.error})` : ""}`,
      );
    }
    if (this.record.slotAtSend !== undefined) lines.push(`  slot at send ${this.record.slotAtSend}`);
    if (this.record.landedSlot !== undefined)
      lines.push(`  landed slot ${this.record.landedSlot} (Δ ${this.record.slotDelta ?? "?"} slots)`);
    if (this.record.outcome) lines.push(`  outcome ${this.record.outcome}`);
    return lines.join("\n");
  }
}
