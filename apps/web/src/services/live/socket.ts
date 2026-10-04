/**
 * One WebSocket to the gateway (`/ws`), speaking packages/protocol's envelope:
 *   client -> server  { type: "subscribe" | "unsubscribe", topic }
 *   server -> client  { type: "snapshot" | "delta" | "correction", topic, seq, data } | { type: "error", ... }
 *
 * What this layer guarantees to its listeners, per topic:
 *  - a snapshot first; deltas and corrections only after it, with seq exactly last + 1;
 *  - stale messages (seq <= last) are dropped; a gap (seq > last + 1) drops the topic back to
 *    "awaiting snapshot" and re-sends `subscribe`, which the server answers with a fresh snapshot;
 *  - after a reconnect every topic is subscribed again and starts over with a snapshot;
 *  - several listeners can share a topic; a new listener on a live topic re-requests the snapshot
 *    (the protocol's cheap resync), so everyone ends up on the same numbers.
 *
 * Outgoing messages are paced under the server's per-connection limit (RATE_LIMIT_WS_MSG_RPS, 30/s with
 * a burst of 60), and a subscribe that is still queued when its last listener leaves is simply dropped.
 * Reconnects back off exponentially with jitter. A socket that goes quiet while topics are subscribed
 * (the `chain` topic ticks several times a second) is treated as dead and reopened.
 */
import type { ClientMessage, CorrectionMessage, DeltaMessage, ErrorMessage, SnapshotMessage } from "@zerofee/protocol";
import { mark, samples } from "../../lib/perf";

export type WireMessage = SnapshotMessage | DeltaMessage | CorrectionMessage;

export interface WireListener {
  onMessage(message: WireMessage): void;
  /** The server refused or failed the topic (unauthorized, unavailable, forbidden...). */
  onError?(error: ErrorMessage): void;
}

export type SocketState = "connecting" | "live" | "offline";

/** The subset of the browser WebSocket this class uses (tests pass a fake). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface GatewaySocketOptions {
  url: string | (() => string);
  createSocket?: (url: string) => SocketLike;
  clock?: Clock;
  random?: () => number;
  /** Reconnect backoff bounds (ms). */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Consecutive failed connects after which the state reads "offline" (it keeps retrying). */
  offlineAfter?: number;
  /** Client messages per second (token bucket; the server allows 30/s). */
  maxMessagesPerSec?: number;
  burst?: number;
  /** No message for this long while topics are subscribed = a dead socket. */
  staleMs?: number;
}

/** Close code the gateway uses when the session behind a socket was revoked or expired. */
export const WS_CLOSE_SESSION_ENDED = 4401;

const OPEN = 1;

interface TopicEntry {
  listeners: Set<WireListener>;
  /** Seq of the last applied message; null while waiting for a snapshot. */
  lastSeq: number | null;
  /** A subscribe went out on the current connection (so leaving needs an unsubscribe). */
  sent: boolean;
}

export class GatewaySocket {
  private socket: SocketLike | null = null;
  private readonly topics = new Map<string, TopicEntry>();
  private readonly queue: ClientMessage[] = [];
  private readonly stateListeners = new Set<(state: SocketState) => void>();
  private readonly sessionEndListeners = new Set<() => void>();
  private stateValue: SocketState = "connecting";
  private failures = 0;
  private reconnectTimer: unknown = null;
  private drainTimer: unknown = null;
  private watchdog: unknown = null;
  private tokens: number;
  private lastRefill: number;
  private lastMessageAt = 0;
  private closed = false;
  private readonly clock: Clock;
  readonly stats = { connects: 0, reconnects: 0, gaps: 0, stale: 0, sent: 0, received: 0, staleSockets: 0 };

  constructor(private readonly o: GatewaySocketOptions) {
    this.clock = o.clock ?? systemClock;
    this.tokens = o.burst ?? 20;
    this.lastRefill = this.clock.now();
  }

  get state(): SocketState {
    return this.stateValue;
  }

  onState(listener: (state: SocketState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** The server closed the socket because its session ended (sign-out elsewhere, expiry). */
  onSessionEnded(listener: () => void): () => void {
    this.sessionEndListeners.add(listener);
    return () => this.sessionEndListeners.delete(listener);
  }

  /** Opens the socket (idempotent). */
  connect(): void {
    if (this.closed || this.socket) return;
    this.open();
  }

  /**
   * Drops the current socket and opens a new one right away, e.g. after sign-in or sign-out: the
   * gateway resolves the session cookie at the upgrade, so user topics need a fresh socket.
   */
  reconnect(): void {
    if (this.closed) return;
    this.failures = 0;
    this.clearReconnect();
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onclose = null;
      s.onmessage = null;
      s.onerror = null;
      s.onopen = null;
      try {
        s.close(1000, "reconnect");
      } catch {
        // already closed
      }
    }
    this.resetTopics();
    this.open();
  }

  subscribe(topic: string, listener: WireListener): () => void {
    let entry = this.topics.get(topic);
    if (!entry) {
      entry = { listeners: new Set(), lastSeq: null, sent: false };
      this.topics.set(topic, entry);
    } else {
      // Late joiner: everyone gets a fresh snapshot so the new listener starts from one too.
      entry.lastSeq = null;
    }
    entry.listeners.add(listener);
    this.enqueueSubscribe(topic);
    this.connect();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const e = this.topics.get(topic);
      if (!e) return;
      e.listeners.delete(listener);
      if (e.listeners.size > 0) return;
      this.topics.delete(topic);
      this.dropQueued(topic, "subscribe");
      if (e.sent) this.enqueue({ type: "unsubscribe", topic: topic as ClientMessage["topic"] });
    };
  }

  /** Asks for a fresh snapshot of a topic (e.g. a view found its cache inconsistent). */
  resync(topic: string): void {
    const e = this.topics.get(topic);
    if (!e) return;
    e.lastSeq = null;
    this.enqueueSubscribe(topic);
  }

  close(): void {
    this.closed = true;
    this.clearReconnect();
    if (this.drainTimer !== null) this.clock.clearTimeout(this.drainTimer);
    this.drainTimer = null;
    this.stopWatchdog();
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onclose = null;
      try {
        s.close(1000, "closed");
      } catch {
        // already closed
      }
    }
    this.topics.clear();
    this.queue.length = 0;
    this.setState("offline");
  }

  // -------------------------------------------------------------------------------------------
  // connection
  // -------------------------------------------------------------------------------------------

  private open(): void {
    const url = typeof this.o.url === "function" ? this.o.url() : this.o.url;
    let s: SocketLike;
    try {
      s = this.o.createSocket ? this.o.createSocket(url) : (new WebSocket(url) as unknown as SocketLike);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = s;
    if (this.stateValue !== "offline") this.setState("connecting");
    s.onopen = () => {
      if (this.socket !== s) return;
      this.stats.connects++;
      if (this.stats.connects > 1) this.stats.reconnects++;
      this.failures = 0;
      this.lastMessageAt = this.clock.now();
      mark("zf:ws-open");
      this.setState("live");
      // Fresh connection: every topic starts over from a snapshot.
      this.queue.length = 0;
      for (const [topic, e] of this.topics) {
        e.lastSeq = null;
        e.sent = false;
        this.queue.push({ type: "subscribe", topic: topic as ClientMessage["topic"] });
      }
      this.startWatchdog();
      this.drain();
    };
    s.onmessage = (ev) => {
      if (this.socket !== s) return;
      this.lastMessageAt = this.clock.now();
      this.onRaw(ev.data);
    };
    s.onclose = (ev) => {
      if (this.socket !== s) return;
      this.socket = null;
      this.stopWatchdog();
      this.resetTopics();
      if (ev.code === WS_CLOSE_SESSION_ENDED) for (const l of this.sessionEndListeners) l();
      this.scheduleReconnect();
    };
    s.onerror = () => {
      // onclose follows; nothing to do here.
    };
  }

  private resetTopics(): void {
    for (const e of this.topics.values()) {
      e.lastSeq = null;
      e.sent = false;
    }
    this.queue.length = 0;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return;
    this.failures++;
    if (this.failures >= (this.o.offlineAfter ?? 3)) this.setState("offline");
    else this.setState("connecting");
    const min = this.o.minBackoffMs ?? 500;
    const max = this.o.maxBackoffMs ?? 30_000;
    const base = Math.min(max, min * 2 ** Math.min(this.failures - 1, 16));
    const delay = Math.round(base * (0.5 + (this.o.random ?? Math.random)() * 0.5));
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed && !this.socket) this.open();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) this.clock.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    const staleMs = this.o.staleMs ?? 20_000;
    this.watchdog = this.clock.setInterval(
      () => {
        const s = this.socket;
        if (!s || this.topics.size === 0) return;
        if (this.clock.now() - this.lastMessageAt > staleMs) {
          this.stats.staleSockets++;
          // Treat as a drop: the next socket resubscribes everything.
          s.onclose?.({ code: 4000, reason: "stale" });
          try {
            s.close(4000, "stale");
          } catch {
            // already closed
          }
        }
      },
      Math.max(1_000, Math.floor(staleMs / 4)),
    );
  }

  private stopWatchdog(): void {
    if (this.watchdog !== null) this.clock.clearInterval(this.watchdog);
    this.watchdog = null;
  }

  private setState(state: SocketState): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    for (const l of this.stateListeners) l(state);
  }

  // -------------------------------------------------------------------------------------------
  // inbound
  // -------------------------------------------------------------------------------------------

  private onRaw(raw: unknown): void {
    this.stats.received++;
    let msg: WireMessage | ErrorMessage;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer));
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "error") {
      const topic = msg.topic;
      if (!topic) return;
      const e = this.topics.get(topic);
      if (!e) return;
      // The server never holds a refused subscription.
      e.sent = false;
      if (msg.code === "rate_limited" || msg.code === "too_many_subscriptions") {
        // Transient: ask again shortly (other views may have left by then).
        this.clock.setTimeout(() => {
          if (this.topics.get(topic) === e && !e.sent) this.enqueueSubscribe(topic);
        }, 1_500);
        return;
      }
      for (const l of [...e.listeners]) l.onError?.(msg);
      return;
    }
    if (msg.type !== "snapshot" && msg.type !== "delta" && msg.type !== "correction") return;
    const e = this.topics.get(msg.topic);
    if (!e) return; // unsubscribed meanwhile
    if (msg.type === "snapshot") {
      e.lastSeq = msg.seq;
      mark("zf:ws-first-snapshot");
    } else {
      if (msg.ts !== undefined) samples.publishToReceive.add(Date.now() - msg.ts);
      if (e.lastSeq === null) return; // before the (re)snapshot
      if (msg.seq <= e.lastSeq) {
        this.stats.stale++;
        return;
      }
      if (msg.seq !== e.lastSeq + 1) {
        this.stats.gaps++;
        e.lastSeq = null;
        this.enqueueSubscribe(msg.topic);
        return;
      }
      e.lastSeq = msg.seq;
    }
    for (const l of [...e.listeners]) l.onMessage(msg);
  }

  // -------------------------------------------------------------------------------------------
  // outbound (paced)
  // -------------------------------------------------------------------------------------------

  private enqueueSubscribe(topic: string): void {
    if (this.queue.some((m) => m.type === "subscribe" && m.topic === topic)) return;
    this.dropQueued(topic, "unsubscribe");
    this.enqueue({ type: "subscribe", topic: topic as ClientMessage["topic"] });
  }

  private dropQueued(topic: string, type: ClientMessage["type"]): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const m = this.queue[i];
      if (m && m.type === type && m.topic === topic) this.queue.splice(i, 1);
    }
  }

  private enqueue(msg: ClientMessage): void {
    this.queue.push(msg);
    this.drain();
  }

  private refill(): void {
    const now = this.clock.now();
    const rate = this.o.maxMessagesPerSec ?? 20;
    const burst = this.o.burst ?? 20;
    this.tokens = Math.min(burst, this.tokens + ((now - this.lastRefill) / 1000) * rate);
    this.lastRefill = now;
  }

  private drain(): void {
    if (this.drainTimer !== null) return;
    const s = this.socket;
    if (!s || s.readyState !== OPEN) return;
    this.refill();
    while (this.queue.length > 0 && this.tokens >= 1) {
      const msg = this.queue.shift() as ClientMessage;
      if (msg.type === "subscribe") {
        const e = this.topics.get(msg.topic);
        if (!e) continue; // left before it went out
        e.sent = true;
      }
      this.tokens -= 1;
      this.stats.sent++;
      s.send(JSON.stringify(msg));
    }
    if (this.queue.length > 0) {
      const rate = this.o.maxMessagesPerSec ?? 20;
      const wait = Math.ceil(((1 - this.tokens) / rate) * 1000);
      this.drainTimer = this.clock.setTimeout(
        () => {
          this.drainTimer = null;
          this.drain();
        },
        Math.max(5, wait),
      );
    }
  }
}
