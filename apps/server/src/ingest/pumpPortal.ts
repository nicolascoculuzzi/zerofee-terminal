/**
 * PumpPortalSource - optional discovery cross-check (PUMPPORTAL_ENABLED=true): PumpPortal's free
 * `subscribeNewToken` and `subscribeMigration` streams over ONE connection (their rule; extra
 * connections get banned for an hour). An API key may be required (PUMPPORTAL_API_KEY); it is appended
 * as `api-key` and never logged. Events only feed the Reconciler: the primary source stays the
 * single writer of market state.  https://pumpportal.fun/data-api/real-time
 */
import type { SourceHealth } from "@zerofee/protocol";
import { redactUrl } from "../config";
import { logger } from "../log";
import { Backoff } from "../util/backoff";

const log = logger("pumpportal");

export interface CrossCheckEvent {
  kind: "create" | "migrate";
  mint: string;
  signature: string | null;
  receivedAt: number;
}

export interface PumpPortalOptions {
  url: string;
  apiKey: string | null;
  WebSocketImpl?: typeof WebSocket;
}

export class PumpPortalSource {
  readonly name = "pumpportal";
  private ws: WebSocket | null = null;
  private stopped = false;
  private readonly backoff = new Backoff(2_000, 120_000);
  private onEvent: ((e: CrossCheckEvent) => void) | null = null;
  readonly stats = {
    connected: false,
    reconnects: 0,
    messages: 0,
    creates: 0,
    migrations: 0,
    lastMessageAt: null as number | null,
    lastError: null as string | null,
  };

  constructor(private readonly opts: PumpPortalOptions) {}

  private url(): string {
    const u = new URL(this.opts.url);
    if (this.opts.apiKey) u.searchParams.set("api-key", this.opts.apiKey);
    return u.toString();
  }

  start(onEvent: (e: CrossCheckEvent) => void): void {
    this.onEvent = onEvent;
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const Impl = this.opts.WebSocketImpl ?? WebSocket;
    const ws = new Impl(this.url());
    this.ws = ws;
    ws.onopen = () => {
      this.stats.connected = true;
      log.info(`connected to ${redactUrl(this.url())}`);
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      ws.send(JSON.stringify({ method: "subscribeMigration" }));
    };
    ws.onmessage = (ev) => this.handle(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
    ws.onerror = (ev) => {
      this.stats.lastError = (ev as ErrorEvent).message ?? "websocket error";
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.stats.connected = false;
      this.ws = null;
      if (this.stopped) return;
      this.stats.reconnects++;
      const delay = this.backoff.next();
      log.warn(`closed; reconnecting in ${delay} ms`);
      setTimeout(() => this.connect(), delay);
    };
  }

  /** Parses one message. Exposed for tests. */
  handle(raw: string, now = Date.now()): CrossCheckEvent | null {
    this.stats.messages++;
    this.stats.lastMessageAt = now;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw);
    } catch {
      return null;
    }
    const mint = typeof m.mint === "string" ? m.mint : null;
    const txType = String(m.txType ?? m.type ?? "").toLowerCase();
    if (!mint) return null;
    let kind: CrossCheckEvent["kind"] | null = null;
    if (txType === "create") kind = "create";
    else if (txType.includes("migrat")) kind = "migrate";
    if (!kind) return null;
    if (kind === "create") this.stats.creates++;
    else this.stats.migrations++;
    this.backoff.reset();
    const ev: CrossCheckEvent = { kind, mint, signature: typeof m.signature === "string" ? m.signature : null, receivedAt: now };
    this.onEvent?.(ev);
    return ev;
  }

  health(): SourceHealth {
    return {
      name: this.name,
      connected: this.stats.connected,
      reconnects: this.stats.reconnects,
      messages: this.stats.messages,
      lastMessageAt: this.stats.lastMessageAt,
      slot: null,
      dropped: 0,
      notes: [
        `creates ${this.stats.creates}, migrations ${this.stats.migrations}`,
        ...(this.stats.lastError ? [`last error: ${this.stats.lastError}`] : []),
      ],
    };
  }
}

/**
 * Matches launches / migrations seen by the primary feed against a cross-check feed. An event counts as
 * missed by one side if the other side has not seen it `windowMs` after the first sighting; lead time
 * (cross receive - primary receive) shows which feed is faster.
 */
export class Reconciler {
  private readonly primary = new Map<string, number>();
  private readonly cross = new Map<string, number>();
  readonly stats = { matched: 0, primaryOnly: 0, crossOnly: 0, leadMs: [] as number[] };

  constructor(private readonly windowMs = 30_000) {}

  private key(kind: string, mint: string): string {
    return `${kind}:${mint}`;
  }

  seenPrimary(kind: "create" | "migrate", mint: string, at: number): void {
    const k = this.key(kind, mint);
    const c = this.cross.get(k);
    if (c !== undefined) {
      this.cross.delete(k);
      this.stats.matched++;
      this.stats.leadMs.push(c - at);
    } else if (!this.primary.has(k)) this.primary.set(k, at);
  }

  seenCross(kind: "create" | "migrate", mint: string, at: number): void {
    const k = this.key(kind, mint);
    const p = this.primary.get(k);
    if (p !== undefined) {
      this.primary.delete(k);
      this.stats.matched++;
      this.stats.leadMs.push(at - p);
    } else if (!this.cross.has(k)) this.cross.set(k, at);
  }

  /** Ages out unmatched sightings. */
  sweep(now = Date.now()): void {
    for (const [k, t] of this.primary) {
      if (now - t > this.windowMs) {
        this.primary.delete(k);
        this.stats.primaryOnly++;
      }
    }
    for (const [k, t] of this.cross) {
      if (now - t > this.windowMs) {
        this.cross.delete(k);
        this.stats.crossOnly++;
      }
    }
    if (this.stats.leadMs.length > 10_000) this.stats.leadMs.splice(0, this.stats.leadMs.length - 10_000);
  }
}
