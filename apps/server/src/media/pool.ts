/**
 * A small pool of worker processes for the image pipeline's CPU work (decode / resize / WebP encode with
 * Bun.Image, metadata JSON parsing), so the ingest and gateway event loop never runs it.
 *
 * Why processes and not Worker threads: Bun.Image does its work on Bun's process-wide thread pool, so a
 * Worker thread would only move the waiting, not the CPU; and only a process can be given a lower
 * scheduling priority. Each worker is started under `nice -n IMG_WORKER_NICE` (default 10), so under
 * contention the kernel runs ingest first. At most IMG_WORKERS (default 2) jobs run at once, one per worker.
 *
 * Backpressure: jobs wait in a priority queue (0 = someone is looking at it, 1 = new launches, 2 =
 * background). Past IMG_WORK_QUEUE waiting jobs, priority 1-2 work is refused at once ("busy"; prefetch is
 * dropped and done later on demand) while on-screen work may queue up to twice that.
 *
 * A worker that dies takes its job with it (the image is marked failed, `worker_crashed`: a decoder crash
 * is as permanent as a bomb) and is restarted. IMG_WORKERS=0 runs the same code inline, still one job at a
 * time (tests, or a host where spawning is not possible).
 */
import { join } from "node:path";
import { logger } from "../log";
import { SampleRing } from "../util/stats";
import type { ParsedMetadata } from "./extract";
import { type MasterResult, makeMaster, parseMetadataText, renderSize } from "./imageops";
import type { Priority } from "./pacer";
import type { SourceFormat } from "./sniff";

const log = logger("media");

export type WorkRequest =
  | { id: number; op: "master"; bytes: Uint8Array; format: SourceFormat; maxPixels: number; size: number }
  | { id: number; op: "render"; bytes: Uint8Array; size: number }
  | { id: number; op: "metadata"; text: string; gateways: readonly string[] };

export type WorkReply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };

type Payload = WorkRequest extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never;

export class PoolBusy extends Error {
  constructor() {
    super("busy");
    this.name = "PoolBusy";
  }
}

export interface PoolOptions {
  /** Worker processes (0: inline). */
  workers: number;
  /** nice(1) increment for the workers (0: same priority as the server). */
  nice: number;
  /** Waiting jobs beyond which priority 1-2 jobs are refused. */
  maxQueue: number;
  /** A job taking longer than this kills its worker (ms). */
  jobTimeoutMs?: number;
}

interface Job {
  id: number;
  prio: Priority;
  payload: Payload;
  resolve(v: unknown): void;
  reject(e: unknown): void;
  queuedAt: number;
}

interface Worker {
  proc: ReturnType<typeof Bun.spawn> | null;
  job: Job | null;
  timer: ReturnType<typeof setTimeout> | null;
  startedAt: number;
  /** Answered at least one job: an exit before that is a failed start, not a crash on an image. */
  answered: boolean;
}

const WORKER_PATH = join(import.meta.dir, "worker.ts");

export class WorkPool {
  private readonly lanes: [Job[], Job[], Job[]] = [[], [], []];
  private readonly workers: Worker[] = [];
  private inlineBusy = false;
  private nextId = 1;
  private stopped = false;
  private spawnFailures = 0;
  readonly stats = { jobs: 0, done: 0, failed: 0, dropped: 0, crashed: 0, restarts: 0, inline: 0 };
  /** Queue wait and run time per job (ms). */
  readonly timing = { wait: new SampleRing(5_000), run: new SampleRing(5_000) };

  constructor(private readonly o: PoolOptions) {
    for (let i = 0; i < o.workers; i++) this.workers.push({ proc: null, job: null, timer: null, startedAt: 0, answered: false });
  }

  /** Jobs waiting plus jobs running. */
  get load(): number {
    return this.queued + this.running;
  }

  get queued(): number {
    return this.lanes[0].length + this.lanes[1].length + this.lanes[2].length;
  }

  get running(): number {
    return this.workers.length ? this.workers.filter((w) => w.job).length : this.inlineBusy ? 1 : 0;
  }

  /** True when new priority 1-2 work would be refused. */
  get saturated(): boolean {
    return this.queued >= this.o.maxQueue;
  }

  master(bytes: Uint8Array, format: SourceFormat, maxPixels: number, size: number, prio: Priority): Promise<MasterResult> {
    return this.submit({ op: "master", bytes, format, maxPixels, size }, prio) as Promise<MasterResult>;
  }

  render(bytes: Uint8Array, size: number, prio: Priority): Promise<Uint8Array> {
    return this.submit({ op: "render", bytes, size }, prio) as Promise<Uint8Array>;
  }

  parseMetadata(text: string, gateways: readonly string[], prio: Priority): Promise<ParsedMetadata | null> {
    return this.submit({ op: "metadata", text, gateways }, prio) as Promise<ParsedMetadata | null>;
  }

  stop(): void {
    this.stopped = true;
    for (const w of this.workers) {
      if (w.timer) clearTimeout(w.timer);
      w.proc?.kill();
      w.proc = null;
    }
    for (const lane of this.lanes) for (const j of lane.splice(0)) j.reject(new PoolBusy());
  }

  private submit(payload: Payload, prio: Priority): Promise<unknown> {
    if (this.stopped) return Promise.reject(new PoolBusy());
    const limit = prio === 0 ? this.o.maxQueue * 2 : this.o.maxQueue;
    if (this.queued >= limit) {
      this.stats.dropped++;
      return Promise.reject(new PoolBusy());
    }
    this.stats.jobs++;
    return new Promise((resolve, reject) => {
      this.lanes[prio].push({ id: this.nextId++, prio, payload, resolve, reject, queuedAt: performance.now() });
      this.pump();
    });
  }

  private take(): Job | undefined {
    for (const lane of this.lanes) if (lane.length) return lane.shift();
    return undefined;
  }

  private pump(): void {
    if (!this.workers.length || this.spawnFailures >= 3) {
      if (this.inlineBusy) return;
      const job = this.take();
      if (!job) return;
      this.inlineBusy = true;
      this.stats.inline++;
      void this.runInline(job).finally(() => {
        this.inlineBusy = false;
        this.pump();
      });
      return;
    }
    for (const w of this.workers) {
      if (w.job) continue;
      const job = this.take();
      if (!job) return;
      this.dispatch(w, job);
    }
  }

  private async runInline(job: Job): Promise<void> {
    const t = performance.now();
    this.timing.wait.add(t - job.queuedAt);
    try {
      const p = job.payload;
      const v =
        p.op === "master"
          ? await makeMaster(p.bytes, p.format, p.maxPixels, p.size)
          : p.op === "render"
            ? await renderSize(p.bytes, p.size)
            : parseMetadataText(p.text, p.gateways);
      this.stats.done++;
      job.resolve(v);
    } catch (e) {
      this.stats.failed++;
      job.reject(e);
    } finally {
      this.timing.run.add(performance.now() - t);
    }
  }

  private spawn(w: Worker): boolean {
    try {
      const nice = this.o.nice > 0 ? Bun.which("nice") : null;
      const cmd = nice ? [nice, "-n", String(this.o.nice), process.execPath, WORKER_PATH] : [process.execPath, WORKER_PATH];
      const proc = Bun.spawn(cmd, {
        serialization: "advanced",
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
        ipc: (msg: WorkReply) => this.onReply(w, msg),
        onExit: (p) => this.onExit(w, p as unknown as ReturnType<typeof Bun.spawn>),
      });
      w.proc = proc;
      w.startedAt = Date.now();
      w.answered = false;
      return true;
    } catch (e) {
      this.spawnFailures++;
      log.warn(
        `image worker failed to start (${e instanceof Error ? e.message : e})${this.spawnFailures >= 3 ? "; running image work inline" : ""}`,
      );
      return false;
    }
  }

  private dispatch(w: Worker, job: Job): void {
    if (!w.proc && !this.spawn(w)) {
      this.lanes[job.prio].unshift(job);
      if (this.spawnFailures >= 3) this.pump();
      return;
    }
    w.job = job;
    const t = performance.now();
    this.timing.wait.add(t - job.queuedAt);
    (job as Job & { startedAt: number }).startedAt = t;
    w.timer = setTimeout(() => {
      log.warn(`image worker job ${job.payload.op} took over ${this.o.jobTimeoutMs ?? 30_000} ms; restarting the worker`);
      w.proc?.kill();
    }, this.o.jobTimeoutMs ?? 30_000);
    try {
      w.proc?.send({ id: job.id, ...job.payload });
    } catch (e) {
      this.finish(w);
      this.stats.failed++;
      job.reject(e);
      w.proc?.kill();
      w.proc = null;
    }
  }

  private finish(w: Worker): Job | null {
    const job = w.job;
    w.job = null;
    if (w.timer) clearTimeout(w.timer);
    w.timer = null;
    if (job) this.timing.run.add(performance.now() - ((job as Job & { startedAt?: number }).startedAt ?? job.queuedAt));
    return job;
  }

  private onReply(w: Worker, msg: WorkReply): void {
    w.answered = true;
    this.spawnFailures = 0;
    if (!w.job || w.job.id !== msg.id) return;
    const job = this.finish(w) as Job;
    if (msg.ok) {
      this.stats.done++;
      job.resolve(msg.value);
    } else {
      this.stats.failed++;
      job.reject(Object.assign(new Error(msg.error), { code: msg.error }));
    }
    this.pump();
  }

  private onExit(w: Worker, proc: ReturnType<typeof Bun.spawn>): void {
    if (w.proc !== proc && w.proc !== null) return;
    w.proc = null;
    const job = this.finish(w);
    if (this.stopped) {
      job?.reject(new PoolBusy());
      return;
    }
    this.stats.restarts++;
    if (!w.answered) {
      // it never came up (missing runtime, bad path ...): retry the job elsewhere; three in a row -> inline
      this.spawnFailures++;
      log.warn(`image worker exited before answering${this.spawnFailures >= 3 ? "; running image work inline" : ""}`);
      if (job) this.lanes[job.prio].unshift(job);
      setTimeout(() => this.pump(), this.spawnFailures >= 3 ? 0 : 200 * this.spawnFailures);
      return;
    }
    if (job) {
      this.stats.crashed++;
      log.warn(`image worker exited during a ${job.payload.op} job`);
      job.reject(Object.assign(new Error("worker_crashed"), { code: "worker_crashed" }));
    }
    // restart on demand (the next dispatch spawns), so a crash loop costs one spawn per job at most
    queueMicrotask(() => this.pump());
  }
}
