/**
 * Test doubles for the live services: a scripted WebSocket and a manual clock. Used by the
 * apps/web live tests (bun test); not imported by app code.
 */
import {
  createSignerPolicy,
  MemoryStore,
  type MessageEndpoint,
  type SpendState,
  type StoredVault,
  startSignerWorker,
} from "@zerofee/signer";
import { decodeSignerConfig } from "./signerConfig";
import type { WorkerLike } from "./signerHost";
import type { Clock, SocketLike } from "./socket";

export class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: { type: string; topic: string }[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closedWith: number | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000): void {
    this.closedWith = code;
    this.readyState = 3;
  }

  // --- driving the socket from the test ---

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  /** Server -> client message. */
  push(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  snapshot(topic: string, seq: number, data: unknown): void {
    this.push({ type: "snapshot", topic, seq, data });
  }

  delta(topic: string, seq: number, data: unknown): void {
    this.push({ type: "delta", topic, seq, data });
  }

  correction(topic: string, seq: number, data: unknown, reason = "dead_slot"): void {
    this.push({ type: "correction", topic, seq, data, reason });
  }

  error(topic: string, code: string, message = code): void {
    this.push({ type: "error", topic, code, message });
  }

  /** The server (or the network) drops the connection. */
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  subscribes(topic?: string): number {
    return this.sent.filter((m) => m.type === "subscribe" && (!topic || m.topic === topic)).length;
  }

  unsubscribes(topic?: string): number {
    return this.sent.filter((m) => m.type === "unsubscribe" && (!topic || m.topic === topic)).length;
  }
}

/** Manual clock: timers fire only from advance(). */
export class ManualClock implements Clock {
  t = 1_700_000_000_000;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void; every: number | null }>();

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + ms, fn, every: null });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  setInterval(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + ms, fn, every: ms });
    return id;
  }

  clearInterval(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void; every: number | null }] | null = null;
      for (const entry of this.timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      const [id, timer] = next;
      this.t = timer.at;
      if (timer.every !== null) timer.at += timer.every;
      else this.timers.delete(id);
      timer.fn();
    }
    this.t = end;
  }

  get pending(): number {
    return this.timers.size;
  }
}

/** Collects every socket a GatewaySocket creates. */
export function socketFactory(): { sockets: FakeSocket[]; create: (url: string) => FakeSocket; last(): FakeSocket } {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    create: (url: string) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    last: () => {
      const s = sockets[sockets.length - 1];
      if (!s) throw new Error("no socket created");
      return s;
    },
  };
}

/**
 * An in-process signer "worker": the handlers the real worker entry starts (packages/signer's
 * startSignerWorker with the shipped createSignerPolicy and the config decoded from the worker name), over a
 * real MessageChannel (structured cloning, like a Web Worker). Fast KDF, for tests only.
 */
export function inProcessSignerFactory(stores?: { vault: MemoryStore<StoredVault>; spend: MemoryStore<SpendState> }) {
  const s = stores ?? { vault: new MemoryStore<StoredVault>(), spend: new MemoryStore<SpendState>() };
  const started: string[] = [];
  const stops: (() => void)[] = [];
  const factory = (name: string): WorkerLike => {
    started.push(name);
    const cfg = decodeSignerConfig(name);
    if (!cfg) throw new Error("bad config");
    const ch = new MessageChannel();
    ch.port1.start();
    ch.port2.start();
    const handle = startSignerWorker({
      policy: createSignerPolicy({ caps: { maxBuyLamports: BigInt(cfg.maxBuyLamports) } }),
      dailyCaps: { buyLamports: BigInt(cfg.dailyBuyLamports), feeLamports: BigInt(cfg.dailyFeeLamports) },
      vault: { kdfParams: { memoryKiB: 64, iterations: 1, parallelism: 1 }, allowWeakKdfForTesting: true, autoLockMs: cfg.autoLockMs },
      vaultStorage: s.vault,
      spendStorage: s.spend,
      endpoint: ch.port2 as unknown as MessageEndpoint,
    });
    const port = ch.port1 as unknown as MessageEndpoint;
    const terminate = () => {
      handle.stop();
      ch.port1.close();
      ch.port2.close();
    };
    stops.push(terminate);
    return Object.assign(Object.create(null), {
      postMessage: (m: unknown) => port.postMessage(m),
      addEventListener: (t: "message", l: (e: MessageEvent) => void) => port.addEventListener(t, l),
      removeEventListener: (t: "message", l: (e: MessageEvent) => void) => port.removeEventListener(t, l),
      terminate,
    }) as WorkerLike;
  };
  const stopAll = () => {
    for (const stop of stops.splice(0)) stop();
  };
  return { factory, started, stopAll };
}
