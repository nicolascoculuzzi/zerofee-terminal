/**
 * Event-loop lag: a timer asks to run every `intervalMs`; how late it actually runs is the time the loop
 * was busy with something else (ingest decoding, JSON, a synchronous hash ...). Everything on the process
 * shares the loop, so a lag spike delays socket reads (detection latency), decoding and every flush at once.
 *
 * One monitor per process: `perf.loop` (src/perf.ts) owns it and every report reads it: GET /api/perf
 * (`loop`), GET /api/health (`eventLoopLag`) and /metrics (`zerofee_event_loop_lag_seconds`). Samples cover
 * the last `capacity * intervalMs` (15 000 at 20 ms = 5 min); the maximum and the stall counters run since
 * start (or the last `reset()`).
 */
import { SampleRing } from "./stats";

export interface LoopLagStats {
  intervalMs: number;
  samples: number;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  /** Worst lag since start, ms (null before the first sample). */
  max: number | null;
  stallsOver50ms: number;
  stallsOver100ms: number;
  stallsOver500ms: number;
  /** When the worst lag happened (epoch ms), null before any lag. */
  worstAt: number | null;
}

export class LoopLagMonitor {
  readonly samples: SampleRing;
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = 0;
  private max = 0;
  private worstAt = 0;
  private over50 = 0;
  private over100 = 0;
  private over500 = 0;

  constructor(
    readonly intervalMs = 20,
    capacity = 15_000,
  ) {
    this.samples = new SampleRing(capacity);
  }

  /** Starts sampling (idempotent). */
  start(): void {
    if (this.timer) return;
    this.last = performance.now();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  private tick(): void {
    const now = performance.now();
    const lag = Math.max(0, now - this.last - this.intervalMs);
    this.last = now;
    this.samples.add(lag);
    if (lag > this.max) {
      this.max = lag;
      this.worstAt = Date.now();
    }
    if (lag > 50) this.over50++;
    if (lag > 100) this.over100++;
    if (lag > 500) this.over500++;
  }

  /** Percentiles over the retained window, rounded to 0.01 ms. */
  stats(): LoopLagStats {
    const [p50, p90, p99] = this.samples.percentiles([50, 90, 99]);
    const r = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);
    return {
      intervalMs: this.intervalMs,
      samples: this.samples.count,
      p50: r(p50),
      p90: r(p90),
      p99: r(p99),
      max: this.samples.count ? r(this.max) : null,
      stallsOver50ms: this.over50,
      stallsOver100ms: this.over100,
      stallsOver500ms: this.over500,
      worstAt: this.worstAt || null,
    };
  }

  /** Clears every sample and counter (benchmarks call it after warm-up). */
  reset(): void {
    this.samples.reset();
    this.max = 0;
    this.worstAt = 0;
    this.over50 = 0;
    this.over100 = 0;
    this.over500 = 0;
    this.last = performance.now();
  }
}
