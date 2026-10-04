/**
 * DataSource over the real gateway: one WebSocket (GatewaySocket: snapshots, sequenced deltas, gap
 * resync, reconnect with backoff) plus REST for search and health. Each UI topic is served by a view
 * (views.ts) that adapts packages/protocol shapes into the UI's view models (adapters.ts).
 *
 * Always on: the `chain` topic (SOL/USD, slot, blockhash, priority fees, Jito tip floor, kill switch:
 * the trade engine reads it too) and a /api/health poll (feed health, DRY_RUN).
 */
import type {
  ChainDelta,
  ChainState,
  HealthResponse,
  SearchResponse,
  TradeContext,
  Order as WireOrder,
  TokenSummary as WireToken,
} from "@zerofee/protocol";
import type { DeltaData, PnlPoint, PulseColumnId, SearchResults, Timeframe, TokenSummary, Topic, WalletStatus } from "../../protocol";
import { useBackend } from "../../state/backend";
import type { DataSource, FeedConnectionState, TopicHandler } from "../dataSource";
import { adaptToken, columnOf } from "./adapters";
import { api } from "./api";
import { adaptOrder } from "./orderAdapter";
import { GatewaySocket, type GatewaySocketOptions, type WireMessage } from "./socket";
import {
  type AnyView,
  CandlesView,
  MarketView,
  OrdersView,
  PulseView,
  SocialView,
  TokenView,
  TrackedView,
  TradesView,
  type ViewHost,
  WalletView,
  type WireViewPart,
} from "./views";
import { WalletModel } from "./walletModel";

const HEALTH_POLL_MS = 10_000;
const TOKEN_CACHE_MAX = 5_000;
/** Every pump.fun / PumpSwap coin uses 6 decimals; the summary overrides this once known. */
const PUMP_DECIMALS = 6;
const REVALUE_MS = 2_000;

export interface LiveDataSourceOptions {
  socket?: Partial<GatewaySocketOptions> & Pick<GatewaySocketOptions, "url">;
  /** Health poll period (ms); 0 disables it (tests). */
  healthPollMs?: number;
}

export class LiveDataSource implements DataSource, ViewHost {
  readonly socket: GatewaySocket;
  private readonly views = new Map<string, AnyView>();
  private readonly tokens = new Map<string, WireToken>();
  private tokensVersion = 0;
  private own = new Set<string>();
  private chainState: ChainState | null = null;
  private healthState: HealthResponse | null = null;
  private readonly chainListeners = new Set<(c: ChainState) => void>();
  private readonly healthListeners = new Set<(h: HealthResponse) => void>();
  private readonly engineListeners = new Set<() => void>();
  private readonly connListeners = new Set<(s: FeedConnectionState) => void>();
  private feeEngine: ((ctx: TradeContext) => number | null) | null = null;
  private readonly wireOrders = new Map<string, WireOrder>();
  private readonly walletModels = new Map<string, WalletModel>();
  private nonceIndexFn: ((account: string) => number | null) | null = null;
  private nonceTotals = new Map<string, number>();
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private offChain: (() => void) | null = null;

  constructor(o: LiveDataSourceOptions) {
    this.socket = new GatewaySocket({ ...o.socket, url: o.socket?.url ?? "" });
    this.socket.onState((s) => {
      const state = this.getConnectionState();
      for (const l of this.connListeners) l(state);
      if (s === "live") void this.pollHealth();
    });
    this.offChain = this.socket.subscribe("chain", { onMessage: (m) => this.applyChain(m) });
    const every = o.healthPollMs ?? HEALTH_POLL_MS;
    if (every > 0) {
      void this.pollHealth();
      this.healthTimer = setInterval(() => void this.pollHealth(), every);
    }
  }

  // -------------------------------------------------------------------------------------------
  // DataSource
  // -------------------------------------------------------------------------------------------

  subscribe<T extends Topic>(topic: T, handler: TopicHandler<T>): () => void {
    let view = this.views.get(topic);
    if (!view) {
      view = this.createView(topic);
      this.views.set(topic, view);
    }
    const v = view;
    const h = handler;
    v.add(h);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (v.remove(h) && this.views.get(topic) === v) this.views.delete(topic);
    };
  }

  getConnectionState(): FeedConnectionState {
    const s = this.socket.state;
    return s === "live" ? "live" : s === "connecting" ? "connecting" : "offline";
  }

  onConnectionState(listener: (state: FeedConnectionState) => void): () => void {
    this.connListeners.add(listener);
    return () => this.connListeners.delete(listener);
  }

  async search(query: string, limit = 20): Promise<SearchResults> {
    const q = query.trim();
    if (!q) return { tokens: [], wallets: [] };
    const res = await api<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}&limit=${Math.min(50, Math.max(1, limit))}`);
    for (const t of res.tokens) this.rememberToken(t);
    return { tokens: res.tokens.map((t) => adaptToken(t, { solUsd: this.solUsd(), column: columnOf(t) })), wallets: [] };
  }

  /** Tracked wallets live on the server (REST); the tracker sync (trackerSync.ts) handles membership. */
  async setTrackedWallets(_addresses: string[]): Promise<void> {}

  /** The gateway has no X tracker yet. */
  async setTrackedHandles(_handles: string[]): Promise<void> {}

  /** Other wallets' positions are not served by the gateway. */
  async getWallet(_address: string): Promise<WalletStatus | null> {
    return null;
  }

  /** Daily PnL history is not served by the gateway. */
  async getPnlHistory(_address: string, _range: "7d" | "30d" | "max"): Promise<PnlPoint[]> {
    return [];
  }

  close(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    this.offChain?.();
    this.socket.close();
  }

  // -------------------------------------------------------------------------------------------
  // live-only API (wallet and trade services)
  // -------------------------------------------------------------------------------------------

  /** The user's own wallets: their trades get the "you" tag. */
  setOwnWallets(addresses: readonly string[]): void {
    this.own = new Set(addresses);
  }

  /** The trade engine plugs in the venue fee computation once it has the program accounts. */
  setFeeEngine(fn: ((ctx: TradeContext) => number | null) | null): void {
    this.feeEngine = fn;
    for (const l of this.engineListeners) l();
  }

  /** Nonce slot numbers (the wallet's derived slots) and how many exist on chain, from the order engine. */
  setNonceInfo(indexOf: ((account: string) => number | null) | null, totals: Map<string, number>): void {
    this.nonceIndexFn = indexOf;
    this.nonceTotals = totals;
  }

  /** The wallet model behind `wallet:<address>`, while a view of it is open (balances for sells). */
  wallet(address: string): WalletModel | null {
    return this.walletModels.get(address) ?? null;
  }

  orders(): ReadonlyMap<string, WireOrder> {
    return this.wireOrders;
  }

  // -------------------------------------------------------------------------------------------
  // ViewHost
  // -------------------------------------------------------------------------------------------

  solUsd(): number {
    return this.chainState?.solUsd?.price ?? Number.NaN;
  }

  rememberToken(t: WireToken): void {
    if (this.tokens.size >= TOKEN_CACHE_MAX && !this.tokens.has(t.mint)) {
      const oldest = this.tokens.keys().next().value;
      if (oldest !== undefined) this.tokens.delete(oldest);
    }
    this.tokens.delete(t.mint); // re-insert: most recent last
    this.tokens.set(t.mint, t);
    this.tokensVersion++;
  }

  token(mint: string): WireToken | undefined {
    return this.tokens.get(mint);
  }

  /** UI summary of a cached token (column derived). */
  tokenSummary(mint: string): TokenSummary | null {
    const t = this.tokens.get(mint);
    return t ? adaptToken(t, { solUsd: this.solUsd() }) : null;
  }

  decimalsOf(mint: string): number {
    return this.tokens.get(mint)?.decimals ?? PUMP_DECIMALS;
  }

  ownWallets(): ReadonlySet<string> {
    return this.own;
  }

  feeBps(ctx: TradeContext): number | null {
    return this.feeEngine ? this.feeEngine(ctx) : null;
  }

  onEngineReady(fn: () => void): () => void {
    this.engineListeners.add(fn);
    return () => this.engineListeners.delete(fn);
  }

  chain(): ChainState | null {
    return this.chainState;
  }

  onChain(fn: (chain: ChainState) => void): () => void {
    this.chainListeners.add(fn);
    return () => this.chainListeners.delete(fn);
  }

  health(): HealthResponse | null {
    return this.healthState;
  }

  onHealth(fn: (h: HealthResponse) => void): () => void {
    this.healthListeners.add(fn);
    return () => this.healthListeners.delete(fn);
  }

  adaptOrder(o: WireOrder) {
    const t = this.tokens.get(o.mint);
    return adaptOrder(o, {
      decimals: t?.decimals ?? PUMP_DECIMALS,
      symbol: t?.symbol || `${o.mint.slice(0, 4)}…`,
      nonceIndex: this.nonceIndexFn ?? undefined,
    });
  }

  noteOrders(upsert: WireOrder[], remove: string[], replace: boolean): void {
    if (replace) this.wireOrders.clear();
    for (const id of remove) this.wireOrders.delete(id);
    for (const o of upsert) this.wireOrders.set(o.id, o);
  }

  /** SOL held back by open armed orders of a wallet, and its nonce slots in use / known on chain. */
  reserved(address: string): { sol: number; nonceUsed: number; nonceTotal: number } {
    let lamports = 0n;
    const nonces = new Set<string>();
    for (const o of this.wireOrders.values()) {
      if (o.wallet !== address || !o.open) continue;
      lamports += BigInt(o.reservation.lamports);
      for (const a of o.attempts)
        if (a.status === "live" || a.status === "submitted" || a.status === "cancelling") nonces.add(a.nonceAccount);
    }
    const total = this.nonceTotals.get(address);
    return { sol: Number(lamports) / 1e9, nonceUsed: nonces.size, nonceTotal: total ?? Number.NaN };
  }

  walletView(address: string, emit: { snapshot(s: WalletStatus): void; delta(d: DeltaData<`wallet:${string}`>): void }): WireViewPart {
    const model = new WalletModel(address, {
      token: (mint) => this.tokenSummary(mint),
      reserved: (a) => this.reserved(a),
    });
    this.walletModels.set(address, model);
    let seenVersion = this.tokensVersion;
    const timer = setInterval(() => {
      if (!model.loaded || seenVersion === this.tokensVersion) return;
      seenVersion = this.tokensVersion;
      const r = this.reserved(address);
      emit.delta({ positions: model.revalue(), reservedSol: r.sol, nonceSlots: { used: r.nonceUsed, total: r.nonceTotal } });
    }, REVALUE_MS);
    return {
      onMessage: (m: WireMessage) => {
        if (m.type === "snapshot") emit.snapshot(model.applySnapshot(m.data as Parameters<WalletModel["applySnapshot"]>[0]));
        else if (m.type === "delta") emit.delta(model.applyDelta(m.data as Parameters<WalletModel["applyDelta"]>[0]));
      },
      // Not signed in or not this user's wallet: no status (the UI shows "–"); the socket resubscribes after
      // sign-in. An RPC failure on the server ("internal") is retried shortly.
      onError: (e) => {
        if (e.code === "internal" || e.code === "unavailable") setTimeout(() => this.socket.resync(`wallet:${address}`), 5_000);
      },
      current: () => (model.loaded ? model.status() : null),
      stop: () => {
        clearInterval(timer);
        if (this.walletModels.get(address) === model) this.walletModels.delete(address);
      },
    };
  }

  // -------------------------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------------------------

  private createView(topic: Topic): AnyView {
    const v = ((): AnyView => {
      if (topic === "market") return new MarketView(this);
      if (topic === "orders") return new OrdersView(this);
      if (topic === "tracked") return new TrackedView(this);
      if (topic === "social") return new SocialView(this);
      const i = topic.indexOf(":");
      const head = topic.slice(0, i);
      const rest = topic.slice(i + 1);
      switch (head) {
        case "pulse":
          return new PulseView(rest as PulseColumnId, this);
        case "token":
          return new TokenView(rest, this);
        case "trades":
          return new TradesView(rest, this);
        case "wallet":
          return new WalletView(rest, this);
        case "candles": {
          const j = rest.lastIndexOf(":");
          return new CandlesView(rest.slice(0, j), rest.slice(j + 1) as Timeframe, this);
        }
      }
      throw new Error(`unknown topic ${topic}`);
    })();
    return v;
  }

  private applyChain(m: WireMessage): void {
    if (m.type === "snapshot") this.chainState = m.data as ChainState;
    else if (m.type === "delta" && this.chainState) this.chainState = { ...this.chainState, ...(m.data as ChainDelta) };
    else return;
    const halt = this.chainState.halt;
    const b = useBackend.getState();
    if (b.halted !== halt.halted || b.haltReason !== halt.reason) b.set({ halted: halt.halted, haltReason: halt.reason });
    const c = this.chainState;
    for (const l of this.chainListeners) l(c);
  }

  private async pollHealth(): Promise<void> {
    try {
      const h = await api<HealthResponse>("/api/health");
      this.healthState = h;
      const b = useBackend.getState();
      if (b.dryRun !== h.dryRun || b.version !== h.version) b.set({ dryRun: h.dryRun, version: h.version });
      for (const l of this.healthListeners) l(h);
    } catch {
      // The socket state already tells the UI the server is unreachable.
    }
  }
}
