/**
 * Event-loop lag: a timer asks to run every `intervalMs`; how late it actually runs is the time the loop
 * was busy with something else (ingest decoding, JSON, a synchronous hash ...). Samples cover the last
 * few minutes (ring of 6 000 at 50 ms = 5 min). Reported in /metrics and /api/health.
 */
import { SampleRing } from "./stats";

export class LoopLagMonitor {
  readonly samples = new SampleRing(6_000);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private last = 0;
  max = 0;

  constructor(private readonly intervalMs = 50) {}

  start(): void {
    if (this.timer) return;
    this.last = performance.now();
    const tick = () => {
      const now = performance.now();
      const lag = Math.max(0, now - this.last - this.intervalMs);
      this.samples.add(lag);
      if (lag > this.max) this.max = lag;
      this.last = now;
      this.timer = setTimeout(tick, this.intervalMs);
      (this.timer as { unref?: () => void }).unref?.();
    };
    this.timer = setTimeout(tick, this.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** p50 / p99 over the retained window and the maximum since start, in ms (null before the first sample). */
  stats(): { p50: number | null; p99: number | null; max: number | null; samples: number } {
    const [p50, p99] = this.samples.percentiles([50, 99]);
    const r = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);
    return { p50: r(p50), p99: r(p99), max: this.samples.count ? r(this.max) : null, samples: this.samples.count };
  }
}
