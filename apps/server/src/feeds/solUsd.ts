/**
 * SOL/USD from Binance's public spot WebSocket (`solusdt@aggTrade`). Reconnects with backoff and rotates
 * through the configured URLs (stream.binance.com is geo-blocked in some regions; data-stream.binance.vision
 * is Binance's public market-data mirror). Binance drops connections every 24 h; Bun answers its pings.
 * https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams
 */
import type { SolUsdPrice } from "@zerofee/protocol";
import { logger } from "../log";
import { Backoff } from "../util/backoff";

const log = logger("sol-usd");

export interface SolUsdOptions {
  urls: string[];
  staleMs: number;
  WebSocketImpl?: typeof WebSocket;
  /** Recycle a silent socket after this long. */
  idleTimeoutMs?: number;
}

export class SolUsdFeed {
  price: number | null = null;
  updatedAt: number | null = null;
  readonly stats = { messages: 0, reconnects: 0, url: "", connected: false, lastError: null as string | null };
  private ws: WebSocket | null = null;
  private urlIndex = 0;
  private stopped = false;
  private readonly backoff = new Backoff(1_000, 60_000);
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private readonly listeners: ((p: SolUsdPrice) => void)[] = [];

  constructor(private readonly opts: SolUsdOptions) {}

  onPrice(fn: (p: SolUsdPrice) => void): void {
    this.listeners.push(fn);
  }

  start(): void {
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => {
      if (this.ws && this.stats.connected && Date.now() - this.lastMessageAt > (this.opts.idleTimeoutMs ?? 60_000)) this.ws.close();
    }, 10_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    if (this.stopped || this.opts.urls.length === 0) return;
    const url = this.opts.urls[this.urlIndex % this.opts.urls.length] as string;
    this.stats.url = url;
    const Impl = this.opts.WebSocketImpl ?? WebSocket;
    const ws = new Impl(url);
    this.ws = ws;
    let gotData = false;
    ws.onopen = () => {
      this.stats.connected = true;
      this.lastMessageAt = Date.now();
    };
    ws.onmessage = (ev) => {
      gotData = true;
      this.handle(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
    };
    ws.onerror = (ev) => {
      this.stats.lastError = (ev as ErrorEvent).message ?? "websocket error";
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.stats.connected = false;
      this.ws = null;
      if (this.stopped) return;
      if (!gotData)
        this.urlIndex++; // never delivered: try the next endpoint
      else this.backoff.reset();
      this.stats.reconnects++;
      const delay = this.backoff.next();
      log.warn(`disconnected from ${url}; reconnecting in ${delay} ms`);
      setTimeout(() => this.connect(), delay);
    };
  }

  /** Parses one stream message (raw or combined-stream envelope). Exposed for tests. */
  handle(raw: string, now = Date.now()): void {
    this.lastMessageAt = now;
    let m: { p?: string; c?: string; data?: { p?: string; c?: string } };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const body = m.data ?? m;
    const p = Number(body.p ?? body.c);
    if (!Number.isFinite(p) || p <= 0) return;
    this.stats.messages++;
    this.price = p;
    this.updatedAt = now;
    const snap = this.snapshot(now);
    if (snap) for (const fn of this.listeners) fn(snap);
  }

  snapshot(now = Date.now()): SolUsdPrice | null {
    if (this.price === null || this.updatedAt === null) return null;
    return { price: this.price, updatedAt: this.updatedAt, stale: now - this.updatedAt > this.opts.staleMs, source: "binance" };
  }

  /** Last price even if stale (values in SOL stay correct; USD views degrade gracefully). */
  current(): number | null {
    return this.price;
  }
}
