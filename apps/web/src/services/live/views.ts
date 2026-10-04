/**
 * Live "views": one per UI topic, each turning one or more gateway topics (already sequenced by
 * GatewaySocket) into the UI's snapshot/delta stream (src/protocol.ts). A view numbers its own
 * output (snapshot and every delta +1), keeps the merged state, and hands a late subscriber a snapshot
 * of that state at the current number, so the UI's own seq check (state/subscribe.ts) always passes.
 *
 * Corrections (late or dead-slot events) rewrite history the UI cannot patch with a delta (a trade
 * dropped from the middle of the tape, an old candle), so a view answers them with a fresh snapshot.
 */
import type {
  ChainState,
  ErrorMessage,
  HealthResponse,
  TrackedTradeRow,
  TradeContext,
  Candle as WireCandle,
  OrdersSnapshot as WireOrdersSnapshot,
  TokenSummary as WireToken,
  Trade as WireTrade,
} from "@zerofee/protocol";
import type {
  Candle,
  CandlesSnapshot,
  DeltaData,
  MarketStatus,
  Order,
  PulseColumnId,
  ServerMessage,
  SnapshotData,
  Timeframe,
  TokenDetail,
  Topic,
  TrackedTrade,
  Trade,
  TradeRoute,
  WalletStatus,
} from "../../protocol";
import type { TopicHandler } from "../dataSource";
import { adaptCandle, adaptToken, adaptTrackedRow, adaptTrade, curveStateOf, isFullSummary, marketStatusOf, poolStateOf } from "./adapters";
import type { GatewaySocket, WireMessage } from "./socket";

/** What views need from the data source. */
export interface ViewHost {
  readonly socket: GatewaySocket;
  solUsd(): number;
  rememberToken(t: WireToken): void;
  token(mint: string): WireToken | undefined;
  /** Token decimals for amounts in base units (pump.fun mints all use 6 until the summary is known). */
  decimalsOf(mint: string): number;
  ownWallets(): ReadonlySet<string>;
  /** Total venue fee in bps for a trade context, once the trade engine has the program accounts. */
  feeBps(ctx: TradeContext): number | null;
  /** The last Jupiter route the trade engine quoted for a mint (labels, impact), if any. */
  route(mint: string): TradeRoute | null;
  /** Fee engine loaded, or a new route quoted: views recompute venue state. */
  onEngineReady(fn: () => void): () => void;
  chain(): ChainState | null;
  onChain(fn: (chain: ChainState) => void): () => void;
  health(): HealthResponse | null;
  onHealth(fn: (h: HealthResponse) => void): () => void;
  /** Adapter for the `orders` topic (the armed-orders module provides it). */
  adaptOrder(o: WireOrdersSnapshot["orders"][number]): Order;
  /** The raw orders, for reserved balances and the trade engine (snapshot = full replace). */
  noteOrders(upsert: WireOrdersSnapshot["orders"], remove: string[], replace: boolean): void;
  /** Adapter for `wallet:<address>` snapshots and deltas (the wallet module provides it). */
  walletView(address: string, emit: { snapshot(s: WalletStatus): void; delta(d: DeltaData<`wallet:${string}`>): void }): WireViewPart;
}

/** A wire subscription a composite view owns. */
export interface WireViewPart {
  onMessage(m: WireMessage): void;
  onError?(e: ErrorMessage): void;
  /** Current UI state, for late subscribers. */
  current(): WalletStatus | null;
  stop?(): void;
}

/** A view with its topic type erased (the data source keeps them in one map). */
export interface AnyView {
  // biome-ignore lint/suspicious/noExplicitAny: the topic type is erased here; LiveDataSource.subscribe pairs topics and handlers
  add(h: TopicHandler<any>): void;
  // biome-ignore lint/suspicious/noExplicitAny: as above
  remove(h: TopicHandler<any>): boolean;
}

export abstract class View<T extends Topic> implements AnyView {
  private seq = 0;
  private readonly handlers = new Set<TopicHandler<T>>();
  private started = false;

  constructor(
    readonly topic: T,
    protected readonly host: ViewHost,
  ) {}

  add(h: TopicHandler<T>): void {
    this.handlers.add(h);
    if (!this.started) {
      this.started = true;
      this.start();
      return;
    }
    const snap = this.current();
    if (snap !== null) h({ type: "snapshot", topic: this.topic, seq: this.seq, data: snap } as ServerMessage<T>);
  }

  /** Returns true when the last handler left (the view stopped). */
  remove(h: TopicHandler<T>): boolean {
    this.handlers.delete(h);
    if (this.handlers.size > 0) return false;
    this.stop();
    return true;
  }

  protected abstract start(): void;
  protected abstract stop(): void;
  /** The full current UI state, or null before the first snapshot. */
  protected abstract current(): SnapshotData<T> | null;

  protected emitSnapshot(data: SnapshotData<T>): void {
    this.seq++;
    this.emit({ type: "snapshot", topic: this.topic, seq: this.seq, data } as ServerMessage<T>);
  }

  protected emitDelta(data: DeltaData<T>): void {
    this.seq++;
    this.emit({ type: "delta", topic: this.topic, seq: this.seq, data } as ServerMessage<T>);
  }

  private emit(msg: ServerMessage<T>): void {
    for (const h of [...this.handlers]) h(msg);
  }
}

// ---------------------------------------------------------------------------------------------
// Pulse
// ---------------------------------------------------------------------------------------------

export class PulseView extends View<`pulse:${PulseColumnId}`> {
  private readonly cache = new Map<string, WireToken>();
  private ready = false;
  private off: (() => void) | null = null;

  constructor(
    private readonly column: PulseColumnId,
    host: ViewHost,
  ) {
    super(`pulse:${column}`, host);
  }

  protected start(): void {
    this.off = this.host.socket.subscribe(this.topic, { onMessage: (m) => this.onWire(m) });
  }

  protected stop(): void {
    this.off?.();
    this.off = null;
  }

  protected current() {
    return this.ready ? { tokens: [...this.cache.values()].map((t) => this.adapt(t)) } : null;
  }

  private adapt(t: WireToken) {
    return adaptToken(t, { solUsd: this.host.solUsd(), column: this.column });
  }

  private onWire(m: WireMessage): void {
    if (m.type === "snapshot") {
      const data = m.data as { tokens: WireToken[] };
      this.cache.clear();
      for (const t of data.tokens) {
        this.cache.set(t.mint, t);
        this.host.rememberToken(t);
      }
      this.ready = true;
      this.emitSnapshot({ tokens: data.tokens.map((t) => this.adapt(t)) });
      return;
    }
    if (m.type !== "delta") return;
    const data = m.data as { upsert: Partial<WireToken>[]; remove: string[] };
    const changed: WireToken[] = [];
    for (const patch of data.upsert) {
      const mint = patch.mint as string;
      const prev = this.cache.get(mint) ?? this.host.token(mint);
      const merged = prev ? ({ ...prev, ...patch } as WireToken) : isFullSummary(patch) ? patch : null;
      if (!merged) {
        // A patch for a token we never saw in full: our copy is out of step, start over.
        this.host.socket.resync(this.topic);
        return;
      }
      this.cache.set(mint, merged);
      this.host.rememberToken(merged);
      changed.push(merged);
    }
    for (const mint of data.remove) this.cache.delete(mint);
    this.emitDelta({ upsert: changed.map((t) => this.adapt(t)), remove: data.remove });
  }
}

// ---------------------------------------------------------------------------------------------
// Token detail: token:<mint> (summary) + tradectx:<mint> (curve / pool for the display quote)
// ---------------------------------------------------------------------------------------------

/** Wrapped SOL: trade contexts name it as the quote of SOL pairs. */
const WSOL = "So11111111111111111111111111111111111111112";

export class TokenView extends View<`token:${string}`> {
  private summary: WireToken | null = null;
  private ctx: TradeContext | null = null;
  /** The tradectx snapshot arrived (a null context then means the server has none: Jupiter fallback). */
  private ctxKnown = false;
  private offs: (() => void)[] = [];

  constructor(
    private readonly mint: string,
    host: ViewHost,
  ) {
    super(`token:${mint}`, host);
  }

  protected start(): void {
    const s = this.host.socket;
    this.offs.push(
      s.subscribe(`token:${this.mint}`, { onMessage: (m) => this.onToken(m) }),
      s.subscribe(`tradectx:${this.mint}`, { onMessage: (m) => this.onCtx(m) }),
      this.host.onEngineReady(() => this.pushVenue()),
    );
  }

  protected stop(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }

  protected current(): TokenDetail | null {
    return this.summary ? this.detail(this.summary) : null;
  }

  /**
   * Curve or pool for SOL-quoted coins the engine builds locally; otherwise (no trade context, or a quote
   * other than SOL) the Jupiter route the trade engine uses for them.
   */
  private venue(): Pick<TokenDetail, "curve" | "pool" | "route"> {
    const ctx = this.ctx;
    if (this.ctxKnown && (!ctx || ctx.quoteMint !== WSOL)) {
      const route: TradeRoute = this.host.route(this.mint) ?? {
        via: "jupiter",
        reason: ctx ? "quoted in a token other than SOL" : "no pump.fun curve or PumpSwap pool the server can price",
        labels: [],
        priceImpactPct: null,
      };
      return { curve: null, pool: null, route };
    }
    const fee = ctx ? this.host.feeBps(ctx) : null;
    if (!ctx || fee === null) return { curve: null, pool: null, route: null };
    return { curve: curveStateOf(ctx, fee), pool: poolStateOf(ctx, fee), route: null };
  }

  private detail(s: WireToken): TokenDetail {
    return {
      summary: adaptToken(s, { solUsd: this.host.solUsd() }),
      ...this.venue(),
      holders: [],
      topTraders: [],
      devLaunches: s.devLaunches ?? Number.NaN,
      devMigrations: s.devMigrated ?? Number.NaN,
    };
  }

  private onToken(m: WireMessage): void {
    if (m.type === "snapshot") {
      const s = m.data as WireToken | null;
      this.summary = s;
      if (s) {
        this.host.rememberToken(s);
        this.emitSnapshot(this.detail(s));
      }
      return;
    }
    if (m.type !== "delta") return;
    const patch = m.data as Partial<WireToken>;
    if (!this.summary) {
      if (!isFullSummary(patch)) {
        this.host.socket.resync(`token:${this.mint}`);
        return;
      }
      this.summary = patch;
      this.host.rememberToken(patch);
      this.emitSnapshot(this.detail(patch));
      return;
    }
    this.summary = { ...this.summary, ...patch } as WireToken;
    this.host.rememberToken(this.summary);
    this.emitDelta({ summary: adaptToken(this.summary, { solUsd: this.host.solUsd() }) });
  }

  private onCtx(m: WireMessage): void {
    if (m.type !== "snapshot" && m.type !== "delta") return;
    this.ctx = (m.data as TradeContext | null) ?? null;
    this.ctxKnown = true;
    this.pushVenue();
  }

  private pushVenue(): void {
    if (!this.summary) return;
    this.emitDelta(this.venue());
  }
}

// ---------------------------------------------------------------------------------------------
// Trade tape
// ---------------------------------------------------------------------------------------------

const TAPE_MAX = 400;

/** Newest first: slot, then position in the block, then event id. */
function tapeOrder(a: WireTrade, b: WireTrade): number {
  return b.slot - a.slot || (b.txIndex ?? 0) - (a.txIndex ?? 0) || b.blockTime - a.blockTime || (a.id < b.id ? 1 : -1);
}

/** A tracked wallet's trade on the token as a tape row (launches are not trades). */
function trackedAsTrade(r: TrackedTradeRow): WireTrade | null {
  if (r.kind === "create") return null;
  return {
    id: `tracked:${r.id}`,
    signature: r.signature,
    slot: r.slot,
    txIndex: null,
    mint: r.mint,
    venue: r.venue,
    side: r.kind,
    trader: r.trader,
    quoteAmount: "0",
    tokenAmount: r.tokenAmount,
    amountSol: r.amountSol,
    amountUsd: r.amountUsd,
    priceSol: r.priceSol,
    mcSol: r.mcSol,
    blockTime: r.blockTime,
    receivedAt: r.receivedAt,
    tags: [...r.marketTags],
  };
}

const TRACKED_TAPE_MAX = 200;

/**
 * `trades:<mint>`: the last TAPE_MAX trades, plus (signed in) the user's tracked wallets' older trades on the
 * token from `tracked:<mint>`, so the tape's Tracked filter and the chart's tracked markers reach further back
 * than the tape window. A trade both topics carry shows once.
 */
export class TradesView extends View<`trades:${string}`> {
  private list: WireTrade[] = [];
  private tracked: WireTrade[] = [];
  private ready = false;
  private off: (() => void) | null = null;
  private offTracked: (() => void) | null = null;

  constructor(
    private readonly mint: string,
    host: ViewHost,
  ) {
    super(`trades:${mint}`, host);
  }

  protected start(): void {
    this.off = this.host.socket.subscribe(this.topic, { onMessage: (m) => this.onWire(m) });
    // Signed out (or not offered) the topic answers an error: the tape alone then.
    this.offTracked = this.host.socket.subscribe(`tracked:${this.mint}`, { onMessage: (m) => this.onTracked(m), onError: () => {} });
  }

  protected stop(): void {
    this.off?.();
    this.off = null;
    this.offTracked?.();
    this.offTracked = null;
  }

  private adapt(t: WireTrade): Trade {
    return adaptTrade(t, { decimals: this.host.decimalsOf(this.mint), solUsd: this.host.solUsd(), own: this.host.ownWallets() });
  }

  /** The tape plus tracked trades it does not already hold, newest first. */
  private merged(): WireTrade[] {
    if (this.tracked.length === 0) return this.list;
    const seen = new Set(this.list.map((t) => `${t.signature}:${t.trader}`));
    const extra = this.tracked.filter((t) => !seen.has(`${t.signature}:${t.trader}`));
    return extra.length === 0 ? this.list : [...this.list, ...extra].sort(tapeOrder);
  }

  protected current() {
    return this.ready ? { trades: this.merged().map((t) => this.adapt(t)) } : null;
  }

  private onTracked(m: WireMessage): void {
    if (m.type === "snapshot") {
      const rows = (m.data as { rows: TrackedTradeRow[] }).rows;
      this.tracked = rows.flatMap((r) => trackedAsTrade(r) ?? []).slice(0, TRACKED_TAPE_MAX);
    } else if (m.type === "delta") {
      const fresh = [...(m.data as { rows: TrackedTradeRow[] }).rows].reverse().flatMap((r) => trackedAsTrade(r) ?? []);
      this.tracked = [...fresh, ...this.tracked].slice(0, TRACKED_TAPE_MAX);
    } else {
      const drop = new Set((m.data as { remove: string[] }).remove.map((id) => `tracked:${id}`));
      this.tracked = this.tracked.filter((t) => !drop.has(t.id));
    }
    if (this.ready) this.emitSnapshot({ trades: this.merged().map((t) => this.adapt(t)) });
  }

  private onWire(m: WireMessage): void {
    if (m.type === "snapshot") {
      this.list = [...(m.data as { trades: WireTrade[] }).trades].sort(tapeOrder).slice(0, TAPE_MAX);
      this.ready = true;
      this.emitSnapshot({ trades: this.merged().map((t) => this.adapt(t)) });
      return;
    }
    if (m.type === "delta") {
      // Oldest first on the wire; the UI wants newest first.
      const fresh = [...(m.data as { trades: WireTrade[] }).trades].reverse();
      const seen = new Set(this.list.map((t) => t.id));
      const added = fresh.filter((t) => !seen.has(t.id));
      if (!added.length) return;
      this.list = [...added, ...this.list].slice(0, TAPE_MAX);
      this.emitDelta({ trades: added.map((t) => this.adapt(t)) });
      return;
    }
    const corr = m.data as { remove: string[]; upsert: WireTrade[] };
    const drop = new Set([...corr.remove, ...corr.upsert.map((t) => t.id)]);
    this.list = [...this.list.filter((t) => !drop.has(t.id)), ...corr.upsert].sort(tapeOrder).slice(0, TAPE_MAX);
    this.emitSnapshot({ trades: this.merged().map((t) => this.adapt(t)) });
  }
}

// ---------------------------------------------------------------------------------------------
// Candles
// ---------------------------------------------------------------------------------------------

export class CandlesView extends View<`candles:${string}:${Timeframe}`> {
  private readonly byT = new Map<number, WireCandle>();
  private ready = false;
  private off: (() => void) | null = null;

  constructor(
    mint: string,
    private readonly tf: Timeframe,
    host: ViewHost,
  ) {
    super(`candles:${mint}:${tf}`, host);
  }

  protected start(): void {
    this.off = this.host.socket.subscribe(this.topic, { onMessage: (m) => this.onWire(m) });
  }

  protected stop(): void {
    this.off?.();
    this.off = null;
  }

  private all(): Candle[] {
    const sol = this.host.solUsd();
    return [...this.byT.values()].sort((a, b) => a.t - b.t).map((c) => adaptCandle(c, sol));
  }

  protected current(): CandlesSnapshot | null {
    return this.ready ? { tf: this.tf, candles: this.all() } : null;
  }

  private onWire(m: WireMessage): void {
    const candles = (m.data as { candles: WireCandle[] }).candles;
    if (m.type === "snapshot") {
      this.byT.clear();
      for (const c of candles) this.byT.set(c.t, c);
      this.ready = true;
      this.emitSnapshot({ tf: this.tf, candles: this.all() });
      return;
    }
    if (m.type === "delta") {
      for (const c of candles) this.byT.set(c.t, c);
      const sol = this.host.solUsd();
      this.emitDelta({ candles: [...candles].sort((a, b) => a.t - b.t).map((c) => adaptCandle(c, sol)) });
      return;
    }
    // Correction: rewritten buckets; a bucket left with no trades is gone.
    for (const c of candles) {
      if (c.n === 0) this.byT.delete(c.t);
      else this.byT.set(c.t, c);
    }
    this.emitSnapshot({ tf: this.tf, candles: this.all() });
  }
}

// ---------------------------------------------------------------------------------------------
// Market status: the data source's own `chain` subscription plus the /api/health poll
// ---------------------------------------------------------------------------------------------

const MARKET_EMIT_MS = 500;

export class MarketView extends View<"market"> {
  private offs: (() => void)[] = [];
  private last: MarketStatus | null = null;
  private lastAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(host: ViewHost) {
    super("market", host);
  }

  protected start(): void {
    this.offs.push(
      this.host.onChain(() => this.update()),
      this.host.onHealth(() => this.update()),
    );
    this.update();
  }

  protected stop(): void {
    for (const off of this.offs) off();
    this.offs = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  protected current(): MarketStatus | null {
    return this.last;
  }

  private update(): void {
    const chain = this.host.chain();
    if (!chain) return;
    if (!this.last) {
      this.last = marketStatusOf(chain, this.host.health());
      this.lastAt = Date.now();
      this.emitSnapshot(this.last);
      return;
    }
    // At most two updates a second: the status bar reads slot, SOL/USD and feed health.
    if (this.timer) return;
    const wait = Math.max(0, MARKET_EMIT_MS - (Date.now() - this.lastAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      const c = this.host.chain();
      if (!c) return;
      this.last = marketStatusOf(c, this.host.health());
      this.lastAt = Date.now();
      this.emitDelta(this.last);
    }, wait);
  }
}

// ---------------------------------------------------------------------------------------------
// User topics
// ---------------------------------------------------------------------------------------------

/** `orders`: the session user's armed orders. Signed out, the list is empty. */
export class OrdersView extends View<"orders"> {
  private readonly byId = new Map<string, Order>();
  private ready = false;
  private off: (() => void) | null = null;

  constructor(host: ViewHost) {
    super("orders", host);
  }

  protected start(): void {
    this.off = this.host.socket.subscribe("orders", { onMessage: (m) => this.onWire(m), onError: () => this.empty() });
  }

  protected stop(): void {
    this.off?.();
    this.off = null;
  }

  protected current() {
    return this.ready ? { orders: [...this.byId.values()] } : null;
  }

  private empty(): void {
    this.byId.clear();
    this.host.noteOrders([], [], true);
    this.ready = true;
    this.emitSnapshot({ orders: [] });
  }

  private onWire(m: WireMessage): void {
    if (m.type === "snapshot") {
      const orders = (m.data as WireOrdersSnapshot).orders;
      this.host.noteOrders(orders, [], true);
      this.byId.clear();
      for (const o of orders) this.byId.set(o.id, this.host.adaptOrder(o));
      this.ready = true;
      this.emitSnapshot({ orders: [...this.byId.values()] });
      return;
    }
    if (m.type !== "delta") return;
    const d = m.data as { upsert: WireOrdersSnapshot["orders"]; remove: string[] };
    this.host.noteOrders(d.upsert, d.remove, false);
    const upsert = d.upsert.map((o) => this.host.adaptOrder(o));
    for (const id of d.remove) this.byId.delete(id);
    for (const o of upsert) this.byId.set(o.id, o);
    this.emitDelta({ upsert, remove: d.remove });
  }
}

/** `wallet:<address>`: balances, positions and activity of one of the user's wallets. */
export class WalletView extends View<`wallet:${string}`> {
  private part: WireViewPart | null = null;
  private off: (() => void) | null = null;

  constructor(
    private readonly address: string,
    host: ViewHost,
  ) {
    super(`wallet:${address}`, host);
  }

  protected start(): void {
    const part = this.host.walletView(this.address, {
      snapshot: (s) => this.emitSnapshot(s),
      delta: (d) => this.emitDelta(d),
    });
    this.part = part;
    this.off = this.host.socket.subscribe(this.topic, { onMessage: (m) => part.onMessage(m), onError: (e) => part.onError?.(e) });
  }

  protected stop(): void {
    this.off?.();
    this.off = null;
    this.part?.stop?.();
    this.part = null;
  }

  protected current(): WalletStatus | null {
    return this.part?.current() ?? null;
  }
}

const TRACKED_MAX = 300;

/** `tracked`: trades and launches by the user's tracked wallets. Signed out, the feed is empty. */
export class TrackedView extends View<"tracked"> {
  private rows: TrackedTradeRow[] = [];
  private ready = false;
  private off: (() => void) | null = null;

  constructor(host: ViewHost) {
    super("tracked", host);
  }

  protected start(): void {
    this.off = this.host.socket.subscribe("tracked", { onMessage: (m) => this.onWire(m), onError: () => this.reset([]) });
  }

  protected stop(): void {
    this.off?.();
    this.off = null;
  }

  private adapt(r: TrackedTradeRow): TrackedTrade {
    const t = this.host.token(r.mint);
    return adaptTrackedRow(r, {
      decimals: t?.decimals ?? this.host.decimalsOf(r.mint),
      solUsd: this.host.solUsd(),
      token: t ? adaptToken(t, { solUsd: this.host.solUsd() }) : null,
    });
  }

  protected current() {
    return this.ready ? { items: this.rows.map((r) => this.adapt(r)) } : null;
  }

  private reset(rows: TrackedTradeRow[]): void {
    this.rows = rows.slice(0, TRACKED_MAX);
    this.ready = true;
    this.emitSnapshot({ items: this.rows.map((r) => this.adapt(r)) });
  }

  private onWire(m: WireMessage): void {
    if (m.type === "snapshot") {
      this.reset((m.data as { rows: TrackedTradeRow[] }).rows);
      return;
    }
    if (m.type === "delta") {
      const fresh = [...(m.data as { rows: TrackedTradeRow[] }).rows].reverse();
      this.rows = [...fresh, ...this.rows].slice(0, TRACKED_MAX);
      this.emitDelta({ items: fresh.map((r) => this.adapt(r)) });
      return;
    }
    const drop = new Set((m.data as { remove: string[] }).remove);
    this.reset(this.rows.filter((r) => !drop.has(r.id)));
  }
}

/** `social`: the gateway has no X tracker yet; the feed is empty and the UI says so. */
export class SocialView extends View<"social"> {
  constructor(host: ViewHost) {
    super("social", host);
  }

  protected start(): void {
    this.emitSnapshot({ posts: [] });
  }

  protected stop(): void {}

  protected current() {
    return { posts: [] };
  }
}
