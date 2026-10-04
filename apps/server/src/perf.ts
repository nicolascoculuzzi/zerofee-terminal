/**
 * Performance instrumentation: where the time goes between a block and a browser.
 *
 *  - Event-loop lag: `perf.loop`, the process's one LoopLagMonitor (util/loopLag.ts; a 20 ms timer measures
 *    how late it fires). /api/health and /metrics read the same monitor.
 *  - Stages: latency of each hop of the pipeline, per event (ms):
 *      detect.trade / detect.launch   block time -> socket receive (block time is floored to 1 s)
 *      rpc.afterSlot                  slotNotification -> logs notification for that slot (RPC logs only)
 *      ingest.queue                   socket receive -> decode start (time spent queued behind other work)
 *      ingest.decode / market.apply   per transaction (CPU, sub-millisecond)
 *      gateway.pulseWait              first MarketState change -> Pulse publish of that token
 *      gateway.tapeWait               socket receive -> trade tape publish
 *      e2e.tradePublish / e2e.launchPublish   block time -> gateway publish
 *  - Spans: duration of every named piece of synchronous work (flushes, restore batches, enrichment ticks,
 *    snapshot serialisation...). `perSecMs` is how much of each second it takes on average since start.
 *
 * GET /api/perf serves `perf.report()`; `bun run perf` (apps/server/scripts/perf.ts) prints it as a table.
 * Recording is a ring-buffer write: cheap enough to stay on in production.
 */
import type { PerfResponse, PerfStat } from "@zerofee/protocol";
import { LoopLagMonitor } from "./util/loopLag";
import { SampleRing } from "./util/stats";

class Span {
  readonly ring = new SampleRing(4_096);
  count = 0;
  totalMs = 0;
  maxMs = 0;

  add(ms: number): void {
    this.ring.add(ms);
    this.count++;
    this.totalMs += ms;
    if (ms > this.maxMs) this.maxMs = ms;
  }
}

const round = (v: number | null, d = 1): number | null => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

function statOf(ring: SampleRing, count: number, max: number | null): PerfStat {
  const [p50, p90, p99] = ring.percentiles([50, 90, 99]);
  return { count, p50: round(p50, 2), p90: round(p90, 2), p99: round(p99, 2), max: round(max, 2) };
}

export class Perf {
  private readonly stages = new Map<string, { ring: SampleRing; count: number; max: number }>();
  private readonly spans = new Map<string, Span>();
  /** The event-loop lag monitor (20 ms timer, last 5 min). */
  readonly loop = new LoopLagMonitor(20, 15_000);
  private startedAt = Date.now();
  /** Stage sources owned by other modules (rings they already keep), read at report time. */
  private readonly external = new Map<string, () => PerfStat | null>();

  /** Starts the event-loop lag monitor (idempotent). */
  start(): void {
    if (this.loop.running) return;
    this.startedAt = Date.now();
    this.loop.start();
  }

  stop(): void {
    this.loop.stop();
  }

  /** Records one latency sample (ms) for a pipeline stage. */
  stage(name: string, ms: number): void {
    if (!Number.isFinite(ms)) return;
    let s = this.stages.get(name);
    if (!s) {
      s = { ring: new SampleRing(20_000), count: 0, max: 0 };
      this.stages.set(name, s);
    }
    s.ring.add(ms);
    s.count++;
    if (ms > s.max) s.max = ms;
  }

  /** A stage whose samples another module keeps (e.g. MarketState's detection latency ring). */
  externalStage(name: string, read: () => PerfStat | null): void {
    this.external.set(name, read);
  }

  /** Records the duration (ms) of a named piece of synchronous work. */
  span(name: string, ms: number): void {
    let s = this.spans.get(name);
    if (!s) {
      s = new Span();
      this.spans.set(name, s);
    }
    s.add(ms);
  }

  /** Runs `fn`, recording its duration under `name`. */
  time<T>(name: string, fn: () => T): T {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      this.span(name, performance.now() - t0);
    }
  }

  report(): PerfResponse {
    const uptimeSec = Math.max(1, (Date.now() - this.startedAt) / 1000);
    const stages: Record<string, PerfStat> = {};
    for (const [name, read] of this.external) {
      const s = read();
      if (s) stages[name] = s;
    }
    for (const [name, s] of this.stages) stages[name] = statOf(s.ring, s.count, s.max);
    const spans: PerfResponse["spans"] = {};
    for (const [name, s] of [...this.spans].sort((a, b) => b[1].totalMs - a[1].totalMs)) {
      spans[name] = { ...statOf(s.ring, s.count, s.maxMs), totalMs: Math.round(s.totalMs), perSecMs: round(s.totalMs / uptimeSec, 2) ?? 0 };
    }
    const l = this.loop.stats();
    return {
      at: Date.now(),
      uptimeSec: Math.round(uptimeSec),
      loop: { ...l, p50: round(l.p50, 1), p90: round(l.p90, 1), p99: round(l.p99, 1), max: round(l.max, 1) },
      stages,
      spans,
    };
  }

  /** Clears every sample (benchmarks call it after warm-up). */
  reset(): void {
    this.stages.clear();
    this.spans.clear();
    this.loop.reset();
    this.startedAt = Date.now();
  }

  /** One log line: loop lag and the worst offenders. */
  summary(): string {
    const r = this.report();
    const top = Object.entries(r.spans)
      .slice(0, 4)
      .map(([k, v]) => `${k} ${v.perSecMs}ms/s max ${v.max}`)
      .join(", ");
    return `loop lag p50/p99/max ${r.loop.p50}/${r.loop.p99}/${r.loop.max} ms, stalls>100ms ${r.loop.stallsOver100ms}; busiest: ${top || "-"}`;
  }
}

/** Process-wide instance (one server per process; tests may reset it). */
export const perf = new Perf();

/** PerfStat of a ring another module owns. */
export function ringStat(ring: SampleRing): PerfStat | null {
  if (ring.count === 0) return null;
  const [p50, p90, p99, max] = ring.percentiles([50, 90, 99, 100]);
  return { count: ring.total, p50: round(p50, 2), p90: round(p90, 2), p99: round(p99, 2), max: round(max, 2) };
}
