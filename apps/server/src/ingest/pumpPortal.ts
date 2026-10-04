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
import { BoundedSet } from "../util/lru";

const log = logger("pumpportal");

export interface CrossCheckEvent {
  kind: "create" | "migrate";
  mint: string;
  signature: string | null;
  /** PumpPortal's venue tag: "pump" (pump.fun creates), "pump-amm" (migrations), "bonk" (LetsBonk / LaunchLab) ... */
  pool: string | null;
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
    /** Events per PumpPortal venue tag (`${kind}:${pool}`). */
    byPool: {} as Record<string, number>,
    /** Messages that were neither a create nor a migration (subscription acks, unknown shapes). */
    ignored: 0,
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
    let kind: CrossCheckEvent["kind"] | null = null;
    if (txType === "create") kind = "create";
    else if (txType.includes("migrat")) kind = "migrate";
    if (!mint || !kind) {
      if (++this.stats.ignored <= 5) log.debug(`ignored message: ${raw.slice(0, 300)}`);
      return null;
    }
    if (kind === "create") this.stats.creates++;
    else this.stats.migrations++;
    const pool = typeof m.pool === "string" ? m.pool : null;
    this.stats.byPool[`${kind}:${pool ?? "?"}`] = (this.stats.byPool[`${kind}:${pool ?? "?"}`] ?? 0) + 1;
    this.backoff.reset();
    const ev: CrossCheckEvent = {
      kind,
      mint,
      signature: typeof m.signature === "string" ? m.signature : null,
      pool,
      receivedAt: now,
    };
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
        `creates ${this.stats.creates}, migrations ${this.stats.migrations}, ignored ${this.stats.ignored}`,
        `by venue tag ${JSON.stringify(this.stats.byPool)}`,
        ...(this.stats.lastError ? [`last error: ${this.stats.lastError}`] : []),
      ],
    };
  }
}

/** What a feed knew when it saw the event (kept for mismatch classification). */
export interface SightingInfo {
  signature?: string | null;
  slot?: number | null;
  /** PumpPortal venue tag ("pump", "pump-amm", "bonk", ...). */
  pool?: string | null;
  /** Free-form facts that help explain a mismatch (quote mint, mayhem, token program, feed state ...). */
  detail?: Record<string, unknown>;
}

export interface Mismatch {
  kind: "create" | "migrate";
  mint: string;
  /** The feed that saw it: "primary" (us) or "cross" (PumpPortal). */
  side: "primary" | "cross";
  at: number;
  info: SightingInfo;
}

interface Sighting {
  at: number;
  info: SightingInfo;
}

const MISMATCH_RING = 500;

/**
 * Matches launches / migrations seen by the primary feed against a cross-check feed.
 *
 *  - matched: both feeds saw it within `windowMs`; lead time (cross receive - primary receive) shows
 *    which feed is faster.
 *  - late: the counterpart arrived after `windowMs` but within `graceMs` more. Counted separately, so a
 *    slow feed shows up as latency instead of as one miss on each side.
 *  - primaryOnly / crossOnly: still unmatched after `windowMs + graceMs`. Each one is kept in `mismatches`
 *    (and passed to `onMismatch`) with what the feed knew, for classification.
 *  - repeats: a second sighting of an event already seen (fork re-delivery of the same transaction, a
 *    duplicate message) is ignored instead of opening a new, never-matched entry.
 *
 * `sweep()` must run periodically (the app runs it on a timer).
 */
export class Reconciler {
  private readonly primary = new Map<string, Sighting>();
  private readonly cross = new Map<string, Sighting>();
  private readonly expiredPrimary = new Map<string, Sighting>();
  private readonly expiredCross = new Map<string, Sighting>();
  private readonly done = new BoundedSet<string>(100_000);
  readonly stats = { matched: 0, late: 0, primaryOnly: 0, crossOnly: 0, repeats: 0, leadMs: [] as number[] };
  readonly mismatches: Mismatch[] = [];
  onMismatch: ((m: Mismatch) => void) | null = null;

  constructor(
    private readonly windowMs = 30_000,
    private readonly graceMs = 300_000,
  ) {}

  private key(kind: string, mint: string): string {
    return `${kind}:${mint}`;
  }

  get pending(): number {
    return this.primary.size + this.cross.size + this.expiredPrimary.size + this.expiredCross.size;
  }

  seenPrimary(kind: "create" | "migrate", mint: string, at: number, info: SightingInfo = {}): void {
    this.seen("primary", kind, mint, at, info);
  }

  seenCross(kind: "create" | "migrate", mint: string, at: number, info: SightingInfo = {}): void {
    this.seen("cross", kind, mint, at, info);
  }

  private seen(side: "primary" | "cross", kind: "create" | "migrate", mint: string, at: number, info: SightingInfo): void {
    const k = this.key(kind, mint);
    if (this.done.has(k)) {
      this.stats.repeats++;
      return;
    }
    const [own, ownExpired, other, otherExpired] =
      side === "primary"
        ? [this.primary, this.expiredPrimary, this.cross, this.expiredCross]
        : [this.cross, this.expiredCross, this.primary, this.expiredPrimary];
    const o = other.get(k);
    if (o) {
      other.delete(k);
      this.done.add(k);
      this.stats.matched++;
      this.stats.leadMs.push(side === "primary" ? o.at - at : at - o.at);
      return;
    }
    if (otherExpired.has(k)) {
      otherExpired.delete(k);
      this.done.add(k);
      this.stats.late++;
      return;
    }
    if (own.has(k) || ownExpired.has(k)) {
      this.stats.repeats++;
      return;
    }
    own.set(k, { at, info });
  }

  /** Moves sightings past the window to the grace set and finalizes the ones past the grace period. */
  sweep(now = Date.now()): void {
    const age = (live: Map<string, Sighting>, expired: Map<string, Sighting>) => {
      for (const [k, s] of live) {
        if (now - s.at <= this.windowMs) continue;
        live.delete(k);
        expired.set(k, s);
      }
    };
    age(this.primary, this.expiredPrimary);
    age(this.cross, this.expiredCross);
    const finalize = (expired: Map<string, Sighting>, side: "primary" | "cross") => {
      for (const [k, s] of expired) {
        if (now - s.at <= this.windowMs + this.graceMs) continue;
        expired.delete(k);
        this.done.add(k);
        if (side === "primary") this.stats.primaryOnly++;
        else this.stats.crossOnly++;
        const i = k.indexOf(":");
        const m: Mismatch = { kind: k.slice(0, i) as Mismatch["kind"], mint: k.slice(i + 1), side, at: s.at, info: s.info };
        this.mismatches.push(m);
        if (this.mismatches.length > MISMATCH_RING) this.mismatches.splice(0, this.mismatches.length - MISMATCH_RING);
        this.onMismatch?.(m);
      }
    };
    finalize(this.expiredPrimary, "primary");
    finalize(this.expiredCross, "cross");
    if (this.stats.leadMs.length > 10_000) this.stats.leadMs.splice(0, this.stats.leadMs.length - 10_000);
  }
}
