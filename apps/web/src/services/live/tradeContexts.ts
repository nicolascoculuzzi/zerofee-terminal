/**
 * Trade inputs per mint for the trade engine: the streamed `tradectx:<mint>` (snapshot, then a full context
 * per delta as reserves move) and the token summary. A mint stays subscribed for a while after its last
 * trade, so a sell right after a buy (or a second click) quotes from fresh reserves with no round trip; the
 * token page's own subscription shares the same socket topic.
 *
 * The first trade of a mint waits briefly for the snapshot, then falls back to GET /api/tokens/:mint. A null
 * context means the server has none for the coin (the Jupiter fallback decides what that means).
 */
import type { TokenResponse, TradeContext, TokenSummary as WireToken } from "@zerofee/protocol";
import { ApiError, api } from "./api";
import type { WireListener } from "./socket";

export interface TradeInputs {
  ctx: TradeContext | null;
  token: WireToken | null;
}

export interface TradeContextsHost {
  socket: { subscribe(topic: string, listener: WireListener): () => void };
  token(mint: string): WireToken | undefined;
  rememberToken(t: WireToken): void;
}

export interface TradeContextsOptions {
  /** Mints kept subscribed at most (least recently used go first). */
  max?: number;
  /** Unsubscribe after this long without a trade. */
  idleMs?: number;
  /** How long a cold mint waits for the socket snapshot before asking REST. */
  waitMs?: number;
  fetchToken?: (mint: string) => Promise<TokenResponse | null>;
  now?: () => number;
}

interface Entry {
  ready: boolean;
  failed: boolean;
  ctx: TradeContext | null;
  usedAt: number;
  off: () => void;
  waiters: (() => void)[];
}

async function fetchTokenRest(mint: string): Promise<TokenResponse | null> {
  try {
    return await api<TokenResponse>(`/api/tokens/${encodeURIComponent(mint)}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

export class UnknownTokenError extends Error {}

export class TradeContexts {
  private readonly entries = new Map<string, Entry>();
  private readonly max: number;
  private readonly idleMs: number;
  private readonly waitMs: number;
  private readonly fetchToken: (mint: string) => Promise<TokenResponse | null>;
  private readonly now: () => number;

  constructor(
    private readonly host: TradeContextsHost,
    o: TradeContextsOptions = {},
  ) {
    this.max = o.max ?? 8;
    this.idleMs = o.idleMs ?? 3 * 60_000;
    this.waitMs = o.waitMs ?? 2_500;
    this.fetchToken = o.fetchToken ?? fetchTokenRest;
    this.now = o.now ?? Date.now;
  }

  /** The context the stream holds right now (undefined = not subscribed or no snapshot yet). */
  peek(mint: string): TradeContext | null | undefined {
    const e = this.entries.get(mint);
    return e?.ready ? e.ctx : undefined;
  }

  async get(mint: string): Promise<TradeInputs> {
    this.evict(mint);
    const e = this.entries.get(mint) ?? this.open(mint);
    e.usedAt = this.now();
    if (!e.ready && !e.failed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.waitMs);
        e.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const token = this.host.token(mint) ?? null;
    if (e.ready && (e.ctx || token)) return { ctx: e.ctx, token };
    // No snapshot in time (or the topic failed), or no summary to fall back on: ask REST.
    const res = await this.fetchToken(mint);
    if (!res) throw new UnknownTokenError("The server doesn't know this coin.");
    this.host.rememberToken(res.token);
    return { ctx: e.ready ? e.ctx : res.tradeContext, token: res.token };
  }

  close(): void {
    for (const e of this.entries.values()) e.off();
    this.entries.clear();
  }

  private open(mint: string): Entry {
    const entry: Entry = { ready: false, failed: false, ctx: null, usedAt: this.now(), off: () => {}, waiters: [] };
    const wake = () => {
      for (const w of entry.waiters.splice(0)) w();
    };
    entry.off = this.host.socket.subscribe(`tradectx:${mint}`, {
      onMessage: (m) => {
        if (m.type !== "snapshot" && m.type !== "delta") return;
        entry.ctx = (m.data as TradeContext | null) ?? null;
        entry.ready = true;
        entry.failed = false;
        wake();
      },
      onError: () => {
        entry.failed = true;
        wake();
      },
    });
    this.entries.set(mint, entry);
    return entry;
  }

  /** Drops idle mints and, past the cap, the least recently used (never `keep`). */
  private evict(keep: string): void {
    const t = this.now();
    for (const [mint, e] of this.entries) {
      if (mint !== keep && t - e.usedAt > this.idleMs) {
        e.off();
        this.entries.delete(mint);
      }
    }
    while (this.entries.size >= this.max && !this.entries.has(keep)) {
      let oldest: string | null = null;
      let at = Number.POSITIVE_INFINITY;
      for (const [mint, e] of this.entries) {
        if (e.usedAt < at) {
          at = e.usedAt;
          oldest = mint;
        }
      }
      if (oldest === null) break;
      this.entries.get(oldest)?.off();
      this.entries.delete(oldest);
    }
  }
}
