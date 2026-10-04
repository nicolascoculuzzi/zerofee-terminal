/**
 * Client-side performance marks and latency samples (apps/web/scripts/perf-load.ts reads the marks).
 *
 * Marks (performance.mark, once each): `zf:boot` (entry evaluated), `zf:services` (data layer ready),
 * `zf:ws-open`, `zf:ws-first-snapshot`, `zf:skeleton` (skeleton rows mounted), `zf:pulse-data` (first
 * Pulse row with real data rendered).
 *
 * Samples (ms): `publishToReceive` (gateway publish -> socket message, from the envelope's `ts`; needs
 * roughly synced clocks), `receiveToPaint` (Pulse delta received -> next frame painted with it), and
 * `frame` (rAF-to-rAF interval while the Pulse page is open: 16.7 ms = 60 fps).
 *
 * `zfPerf()` in the console prints a table; `?perf` in the URL (or localStorage zf:perf = 1) logs it
 * every 10 s.
 */

const once = new Set<string>();

export function mark(name: string): void {
  if (once.has(name)) return;
  once.add(name);
  try {
    performance.mark(name);
  } catch {
    // performance.mark is unavailable (very old browsers, tests): marks are best effort
  }
}

class Ring {
  private readonly buf: number[] = [];
  private i = 0;
  count = 0;
  constructor(private readonly cap = 2_000) {}
  add(v: number): void {
    if (!Number.isFinite(v)) return;
    if (this.buf.length < this.cap) this.buf.push(v);
    else this.buf[this.i] = v;
    this.i = (this.i + 1) % this.cap;
    this.count++;
  }
  stat(): { n: number; p50: number | null; p90: number | null; p99: number | null; max: number | null } {
    const s = [...this.buf].sort((a, b) => a - b);
    const q = (p: number) =>
      s.length ? Math.round((s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] as number) * 10) / 10 : null;
    return { n: this.count, p50: q(50), p90: q(90), p99: q(99), max: s.length ? Math.round((s[s.length - 1] as number) * 10) / 10 : null };
  }
}

export const samples = {
  publishToReceive: new Ring(),
  receiveToPaint: new Ring(),
  frame: new Ring(3_600),
};

/** Pulse frame sampler: on while a Pulse view is mounted. */
let frameRaf = 0;
let frameUsers = 0;
let lastFrame = 0;
export function trackFrames(): () => void {
  frameUsers++;
  if (frameUsers === 1 && typeof requestAnimationFrame === "function") {
    lastFrame = 0;
    const loop = (t: number) => {
      if (lastFrame) samples.frame.add(t - lastFrame);
      lastFrame = t;
      frameRaf = requestAnimationFrame(loop);
    };
    frameRaf = requestAnimationFrame(loop);
  }
  return () => {
    frameUsers--;
    if (frameUsers === 0) cancelAnimationFrame(frameRaf);
  };
}

/** Records receive -> paint for a batch first received at `receivedAt` (performance.now()), applied now. */
export function notePainted(receivedAt: number): void {
  if (typeof requestAnimationFrame !== "function") return;
  // the next frame paints this commit; a timeout queued from its callback runs right after that paint
  requestAnimationFrame(() => setTimeout(() => samples.receiveToPaint.add(performance.now() - receivedAt), 0));
}

export function report(): Record<string, unknown> {
  const marks: Record<string, number> = {};
  for (const e of performance.getEntriesByType("mark")) if (e.name.startsWith("zf:")) marks[e.name] = Math.round(e.startTime);
  for (const e of performance.getEntriesByType("paint")) marks[e.name] = Math.round(e.startTime);
  const frame = samples.frame.stat();
  const long = samples.frame.count ? frame : null;
  return {
    marks,
    publishToReceive: samples.publishToReceive.stat(),
    receiveToPaint: samples.receiveToPaint.stat(),
    frame: long,
    fps: frame.p50 ? Math.round(1000 / frame.p50) : null,
  };
}

declare global {
  interface Window {
    zfPerf?: () => Record<string, unknown>;
  }
}

if (typeof window !== "undefined") {
  window.zfPerf = () => {
    const r = report();
    console.table({
      publishToReceive: r.publishToReceive,
      receiveToPaint: r.receiveToPaint,
      frame: r.frame ?? {},
    });
    console.table(r.marks);
    return r;
  };
  let enabled = false;
  try {
    enabled = new URLSearchParams(location.search).has("perf") || localStorage.getItem("zf:perf") === "1";
  } catch {
    enabled = false;
  }
  if (enabled) setInterval(() => console.info("[zf perf]", JSON.stringify(report())), 10_000);
}
