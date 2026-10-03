/**
 * SimEngine: an in-browser stand-in for the zerofee backend (ingest + gateway + orders).
 *
 * It simulates launches every few seconds on pump-style bonding curves (30 SOL / 1.073B
 * virtual reserves, 793.1M real tokens), random retail flow with occasional whales, dev
 * dumps and rugs, migration at 100% into a constant-product pool, holder-derived risk
 * metrics, candles, the user's own fills and armed orders, and a fake social feed. It
 * speaks the provisional protocol in `src/protocol.ts` through `subscribe()`.
 */
import type {
  ActivityItem,
  Candle,
  CandlesSnapshot,
  Holder,
  LandingPreset,
  Launchpad,
  Order,
  PnlPoint,
  Position,
  PulseColumnId,
  QuoteToken,
  SearchResults,
  ServerMessage,
  SocialPost,
  Timeframe,
  Token2022Flags,
  TokenDetail,
  TokenRef,
  TokenSocials,
  TokenSummary,
  Topic,
  TopTrader,
  TrackedTrade,
  Trade,
  Venue,
  WalletSearchHit,
  WalletStatus,
  WalletTag,
} from "../../protocol";
import { TIMEFRAME_SECONDS } from "../../protocol";
import { fakeAddress, fakeSignature, isBase58Address } from "./addresses";
import {
  applyCurveBuy,
  applyCurveSell,
  applyPoolBuy,
  applyPoolSell,
  curvePrice,
  curveProgress,
  newCurve,
  PUMP,
  poolFeeBps,
  poolFromCurve,
  poolPrice,
  quoteCurveBuy,
  quoteCurveSell,
  quotePoolBuy,
  quotePoolSell,
  type SimCurve,
  type SimPool,
  type SwapResult,
} from "./curve";
import { generateTokenName, SIM_HANDLES } from "./names";
import { Rng } from "./rng";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const TICK_MS = 100;
const PULSE_EMIT_MS = 250;
const DETAIL_EMIT_MS = 500;
const SLOW_EMIT_MS = 1000;
const PRUNE_MS = 5000;
const FINAL_ENTER = 0.6;
const FINAL_EXIT = 0.55;
const MAX_NEW = 80;
const MAX_FINAL = 36;
const MAX_MIGRATED = 60;
const TRADE_RING = 1000;
const BASE_SOL_USD = 119.5;
const SLOT_MS = 400;
const NONCE_SLOTS = 10;
const BASE_FEE_SOL = 0.000005;
const SEED_WINDOW_MS = 32 * 60_000;

const TAG_DEV = 1;
const TAG_SNIPER = 2;
const TAG_INSIDER = 4;
const TAG_BUNDLER = 8;
const TAG_PRO = 16;
const TAG_WHALE = 32;
const TAG_KOL = 64;

type WalletKind = "retail" | "pro" | "whale" | "sniper" | "kol";
type Fate = "dud" | "climber" | "runner" | "rug";

interface PoolWallet {
  address: string;
  kind: WalletKind;
  weight: number;
}

interface Holding {
  bal: number;
  boughtSol: number;
  soldSol: number;
  buys: number;
  sells: number;
  firstBuyAt: number | null;
  firstSlot: number | null;
  tags: number;
  fundedBy: string | null;
}

interface Dynamics {
  fate: Fate;
  rate: number;
  bias: number;
  baseBias: number;
  halfLifeSec: number;
  sizeMu: number;
  rugAt: number | null;
  rugged: boolean;
  devSellAt: number | null;
  spikeUntil: number;
  nextEventAt: number;
}

interface ScheduledTrade {
  at: number;
  wallet: string;
  side: "buy" | "sell";
  sol: number;
  /** For sells: fraction of the balance. */
  frac: number;
  tags: number;
}

interface SimToken {
  mint: string;
  name: string;
  symbol: string;
  launchpad: Launchpad;
  quote: QuoteToken;
  venue: Venue;
  createdAt: number;
  createSlot: number;
  creator: string;
  funder: string | null;
  socials: TokenSocials;
  supply: number;
  curve: SimCurve;
  pool: SimPool | null;
  completeAt: number | null;
  migrateAt: number | null;
  migratedAt: number | null;
  volumeSol: number;
  txns: number;
  buys: number;
  sells: number;
  feesSol: number;
  holders: Map<string, Holding>;
  holderAddrs: string[];
  holderIdx: Map<string, number>;
  insiders: Set<string>;
  scheduled: ScheduledTrade[];
  trades: Trade[];
  minuteCandles: Candle[];
  dyn: Dynamics;
  dexPaid: boolean;
  dexPaidAt: number | null;
  token2022: Token2022Flags | null;
  lpBurnedPct: number | null;
  lastTradeAt: number;
  column: PulseColumnId;
  dirty: boolean;
  detailDirty: boolean;
  summary: TokenSummary | null;
  devLaunches: number;
  devMigrations: number;
}

interface UserPosition {
  mint: string;
  symbol: string;
  name: string;
  imageUri: string | null;
  launchpad: Launchpad;
  boughtSol: number;
  soldSol: number;
  boughtTok: number;
  soldTok: number;
  holding: number;
  costBasis: number;
  realized: number;
  fees: number;
  openedAt: number;
  lastTradeAt: number;
  lastPriceSol: number;
}

interface UserWallet {
  address: string;
  sol: number;
  positions: Map<string, UserPosition>;
  history: Position[];
  activity: ActivityItem[];
  dirty: boolean;
  pendingActivity: ActivityItem[];
  changedPositions: Set<string>;
}

interface ArmedOrder {
  order: Order;
  wallet: string;
  slippagePct: number;
  priorityFeeSol: number;
  tipSol: number;
}

export interface UserSwapParams {
  wallet: string;
  mint: string;
  side: "buy" | "sell";
  solAmount?: number;
  pct?: number;
  tokenAmount?: number;
  expectedPriceSol: number;
  slippagePct: number;
  priorityFeeSol: number;
  tipSol: number;
  signature: string;
}

export type UserSwapResult =
  | {
      ok: true;
      fill: {
        side: "buy" | "sell";
        solAmount: number;
        tokenAmount: number;
        priceSol: number;
        venueFeeSol: number;
      };
      slot: number;
    }
  | { ok: false; error: string };

export interface NewOrderParams {
  wallet: string;
  mint: string | null;
  symbol: string;
  kind: Order["kind"];
  side: "buy" | "sell";
  trigger: Order["trigger"];
  size: Order["size"];
  landing: LandingPreset;
  slippagePct: number;
  priorityFeeSol: number;
  tipSol: number;
  ocoGroupId?: string | null;
  nonceSlots?: number;
}

export interface DefaultTrackedWallet {
  address: string;
  name: string;
  emoji: string;
}

type AnyHandler = (message: ServerMessage<Topic>) => void;

const LAUNCHPAD_WEIGHTS: readonly (readonly [Launchpad, number])[] = [
  ["pump", 52],
  ["mayhem", 6],
  ["bonk", 12],
  ["bags", 6],
  ["stonkfun", 5],
  ["launchlab", 4],
  ["meteora_dbc", 5],
  ["moonit", 3],
  ["boop", 3],
  ["heaven", 2],
  ["other", 2],
];

const MINT_SUFFIX: Partial<Record<Launchpad, string>> = {
  pump: "pump",
  mayhem: "pump",
  bonk: "bonk",
  bags: "BAGS",
  moonit: "moon",
  boop: "boop",
};

const CURVE_VENUE: Record<Launchpad, Venue> = {
  pump: "pump_curve",
  mayhem: "pump_curve",
  bonk: "launchlab",
  bags: "meteora_dbc",
  stonkfun: "launchlab",
  launchlab: "launchlab",
  meteora_dbc: "meteora_dbc",
  moonit: "meteora_dbc",
  boop: "meteora_dbc",
  heaven: "other",
  other: "other",
};

const POOL_VENUE: Record<Launchpad, Venue> = {
  pump: "pumpswap",
  mayhem: "pumpswap",
  bonk: "raydium_cpmm",
  bags: "meteora_damm_v2",
  stonkfun: "raydium_cpmm",
  launchlab: "raydium_cpmm",
  meteora_dbc: "meteora_damm_v2",
  moonit: "meteora_damm_v2",
  boop: "meteora_damm_v2",
  heaven: "other",
  other: "other",
};

const TRACKED_PRESETS: readonly (readonly [string, string])[] = [
  ["🐋", "Whale A"],
  ["🧠", "Smart money 1"],
  ["🎯", "Sniper Sam"],
  ["🦊", "Fox trader"],
  ["💎", "Diamond hands"],
  ["🔥", "Hot wallet"],
  ["🐸", "Frog fund"],
  ["👑", "KOL king"],
  ["🚀", "Early ape"],
  ["🌙", "Night shift"],
];

const STALE_REASONS = [
  "pump.fun program upgrade changed the instruction accounts (IDL-diff alarm). Re-arm to re-sign.",
  "Creator vault moved after fee-sharing was enabled; the frozen account list no longer matches.",
  "Address lookup table referenced by the pre-signed transaction was closed.",
] as const;

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class SimEngine {
  readonly rng: Rng;
  solUsd = BASE_SOL_USD;
  private now: number;
  private readonly slotEpoch: number;
  private readonly baseSlot = 371_204_000;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPulseEmit = 0;
  private lastDetailEmit = 0;
  private lastSlowEmit = 0;
  private lastPrune = 0;
  private lastStaleCheck = 0;
  private nextLaunchAt: number;
  private nextPostAt: number;
  private eventsWindow: number[] = [];

  private readonly tokens = new Map<string, SimToken>();
  private readonly wallets: PoolWallet[] = [];
  private readonly walletKind = new Map<string, WalletKind>();
  private poolCum = new Float64Array(0);
  private poolTotal = 0;
  private readonly serialDevs: string[] = [];
  private readonly devStats = new Map<string, { launches: number; migrations: number }>();
  private readonly fundingHubs: string[] = [];
  private readonly users = new Map<string, UserWallet>();
  private tracked = new Set<string>();
  private trackedHandles: string[] = [];
  private readonly trackedRing: TrackedTrade[] = [];
  private readonly posts: SocialPost[] = [];
  private readonly orders = new Map<string, ArmedOrder>();
  private orderSeq = 0;
  readonly defaultTracked: DefaultTrackedWallet[] = [];

  private readonly subs = new Map<string, Set<AnyHandler>>();
  private readonly seqs = new Map<string, number>();
  private readonly candleState = new Map<string, Candle>();
  private readonly pendingTrades = new Map<string, Trade[]>();
  private pendingTracked: TrackedTrade[] = [];
  private readonly pulseRemovals: Record<PulseColumnId, string[]> = {
    new: [],
    final: [],
    migrated: [],
  };
  private seeding = false;

  constructor(seed: number) {
    this.rng = new Rng(seed);
    this.now = Date.now() - SEED_WINDOW_MS;
    this.slotEpoch = this.now - 2_000_000;
    this.nextLaunchAt = this.now;
    this.nextPostAt = Date.now() + 2000;
    this.createWalletPool();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Builds a believable starting world by fast-forwarding the last ~30 minutes. */
  seedWorld(userWallets: { address: string; sol: number; demo: boolean }[]): void {
    this.seeding = true;
    for (const u of userWallets) this.ensureUserWallet(u.address, u.sol);
    const start = this.now;
    const end = Date.now();
    this.seedVeterans(start);
    const demo = userWallets.find((u) => u.demo);
    let demoBuys = 0;
    for (let t = start; t <= end; t += 1000) {
      this.advance(t);
      if (demo && t > start + SEED_WINDOW_MS * 0.55 && demoBuys < 4 && this.rng.chance(0.004)) {
        if (this.seedDemoBuy(demo.address)) demoBuys++;
      }
      if ((t - start) % 15_000 === 0) this.prune(t, true);
    }
    while (demo && demoBuys < 3) {
      if (!this.seedDemoBuy(demo.address)) break;
      demoBuys++;
    }
    if (demo) this.seedDemoHistory(demo.address);
    for (let i = 0; i < 14; i++) this.generatePost(end - (14 - i) * 45_000);
    this.prune(end, true);
    for (const t of this.tokens.values()) {
      t.summary = this.buildSummary(t);
      t.column = this.columnFor(t);
      t.dirty = false;
    }
    if (demo) this.seedDemoOrders(demo.address);
    this.seeding = false;
  }

  start(): void {
    if (this.timer) return;
    this.now = Math.max(this.now, Date.now() - TICK_MS);
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const now = Date.now();
    if (this.nextLaunchAt < now - 10_000) this.nextLaunchAt = now;
    this.advance(now);
    this.flushFast();
    if (now - this.lastPulseEmit >= PULSE_EMIT_MS) {
      this.lastPulseEmit = now;
      this.flushPulse();
    }
    if (now - this.lastDetailEmit >= DETAIL_EMIT_MS) {
      this.lastDetailEmit = now;
      this.flushDetails();
    }
    if (now - this.lastSlowEmit >= SLOW_EMIT_MS) {
      this.lastSlowEmit = now;
      this.flushSlow();
    }
    if (now - this.lastPrune >= PRUNE_MS) {
      this.lastPrune = now;
      this.prune(now, false);
    }
    if (now - this.lastStaleCheck >= 30_000) {
      this.lastStaleCheck = now;
      this.randomStaleOrders(now);
    }
    if (now >= this.nextPostAt) {
      this.nextPostAt = now + this.rng.range(5000, 14_000);
      const post = this.generatePost(now);
      this.emit("social", { posts: [post] });
    }
  }

  // -------------------------------------------------------------------------
  // Pub/sub (the WebSocket stand-in)
  // -------------------------------------------------------------------------

  subscribe(topic: Topic, handler: AnyHandler): () => void {
    let set = this.subs.get(topic);
    if (!set) {
      set = new Set();
      this.subs.set(topic, set);
    }
    set.add(handler);
    const delay = 40 + this.rng.next() * 90;
    const timer = setTimeout(() => {
      if (!set?.has(handler)) return;
      const data = this.snapshot(topic);
      if (data === null) return;
      handler({
        type: "snapshot",
        topic,
        seq: this.seqs.get(topic) ?? 0,
        ts: Date.now(),
        data,
      } as ServerMessage<Topic>);
    }, delay);
    return () => {
      clearTimeout(timer);
      set?.delete(handler);
      if (set && set.size === 0) {
        this.subs.delete(topic);
        if (topic.startsWith("candles:")) this.candleState.delete(topic);
      }
    };
  }

  private hasSubs(topic: string): boolean {
    return (this.subs.get(topic)?.size ?? 0) > 0;
  }

  private emit(topic: Topic, data: unknown): void {
    const set = this.subs.get(topic);
    if (!set || set.size === 0) return;
    const seq = (this.seqs.get(topic) ?? 0) + 1;
    this.seqs.set(topic, seq);
    const message = { type: "delta", topic, seq, ts: Date.now(), data } as ServerMessage<Topic>;
    for (const handler of set) handler(message);
  }

  // biome-ignore lint/suspicious/noExplicitAny: snapshot payload type depends on the topic string
  private snapshot(topic: Topic): any {
    if (topic === "pulse:new" || topic === "pulse:final" || topic === "pulse:migrated") {
      const column = topic.slice(6) as PulseColumnId;
      const tokens: TokenSummary[] = [];
      for (const t of this.tokens.values()) {
        if (t.column !== column) continue;
        if (!t.summary || t.dirty) t.summary = this.buildSummary(t);
        tokens.push(t.summary);
      }
      return { tokens };
    }
    if (topic === "orders") {
      return { orders: [...this.orders.values()].map((o) => ({ ...o.order })) };
    }
    if (topic === "market") return this.marketStatus();
    if (topic === "tracked") return { items: [...this.trackedRing] };
    if (topic === "social") return { posts: [...this.posts] };
    if (topic.startsWith("token:")) {
      const t = this.tokens.get(topic.slice(6));
      return t ? this.buildDetail(t) : null;
    }
    if (topic.startsWith("trades:")) {
      const t = this.tokens.get(topic.slice(7));
      if (!t) return { trades: [] };
      return { trades: t.trades.slice(-300).reverse() };
    }
    if (topic.startsWith("candles:")) {
      const [, mint, tf] = topic.split(":") as [string, string, Timeframe];
      const t = this.tokens.get(mint);
      const snap: CandlesSnapshot = { tf, candles: t ? this.buildCandles(t, tf) : [] };
      const last = snap.candles[snap.candles.length - 1];
      if (last) this.candleState.set(topic, { ...last });
      return snap;
    }
    if (topic.startsWith("wallet:")) return this.getWalletStatus(topic.slice(7));
    return null;
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  private slotAt(ts: number): number {
    return this.baseSlot + Math.floor((ts - this.slotEpoch) / SLOT_MS);
  }

  get currentSlot(): number {
    return this.slotAt(this.now);
  }

  private advance(now: number): void {
    const dt = Math.min(1.5, Math.max(0, (now - this.now) / 1000));
    this.now = now;
    while (now >= this.nextLaunchAt) {
      this.launchToken(this.nextLaunchAt);
      this.nextLaunchAt += this.rng.range(2200, 6200);
    }
    if (dt > 0) {
      this.solUsd *= 1 + this.rng.normal() * 0.00025 * Math.sqrt(dt);
      this.solUsd += (BASE_SOL_USD - this.solUsd) * 0.004 * dt;
      for (const t of this.tokens.values()) this.stepToken(t, dt, now);
    }
  }

  private stepToken(t: SimToken, dt: number, now: number): void {
    const d = t.dyn;
    if (t.scheduled.length > 0) {
      const due = t.scheduled.filter((s) => s.at <= now);
      if (due.length > 0) {
        t.scheduled = t.scheduled.filter((s) => s.at > now);
        due.sort((a, b) => a.at - b.at);
        for (const s of due) {
          if (s.side === "buy") this.execBuy(t, s.wallet, s.sol, s.at, s.tags);
          else {
            const h = t.holders.get(s.wallet);
            if (h && h.bal > 0) this.execSell(t, s.wallet, h.bal * s.frac, s.at);
          }
        }
      }
    }
    if (t.completeAt !== null && t.migratedAt === null) {
      if (t.migrateAt !== null && now >= t.migrateAt) this.migrate(t, now);
      return;
    }
    d.rate *= 0.5 ** (dt / d.halfLifeSec);
    d.bias += (d.baseBias - d.bias) * 0.05 * dt + this.rng.normal() * 0.012 * Math.sqrt(dt);
    d.bias = Math.min(0.78, Math.max(0.22, d.bias));
    if (d.rugAt !== null && !d.rugged && now >= d.rugAt) this.rug(t, now);
    if (d.devSellAt !== null && now >= d.devSellAt) {
      d.devSellAt = null;
      const dev = t.holders.get(t.creator);
      if (dev && dev.bal > 0) {
        const frac = this.rng.chance(0.55) ? 1 : this.rng.range(0.3, 0.7);
        this.execSell(t, t.creator, dev.bal * frac, now);
      }
    }
    if (now >= d.nextEventAt) {
      d.nextEventAt = now + this.rng.range(15_000, 90_000);
      const p = d.fate === "runner" ? 0.5 : d.fate === "climber" ? 0.3 : 0.12;
      if (this.rng.chance(p) && d.rate > 0.02) {
        d.spikeUntil = now + this.rng.range(6000, 25_000);
        d.bias = Math.min(0.78, d.bias + 0.08);
      }
    }
    if (t.dexPaidAt !== null && !t.dexPaid && now >= t.dexPaidAt) {
      t.dexPaid = true;
      t.dirty = true;
    }
    const spike = now < d.spikeUntil ? 2.6 : 1;
    const n = this.rng.poisson(d.rate * spike * dt);
    if (n === 0) return;
    const span = dt * 1000;
    for (let i = 0; i < n; i++) {
      if (t.curve.complete && t.migratedAt === null) break;
      const ts = Math.round(now - span + ((i + 1) * span) / (n + 1));
      this.randomTrade(t, ts);
    }
  }

  private randomTrade(t: SimToken, ts: number): void {
    const d = t.dyn;
    const holdersAvailable = t.holderAddrs.length > 0;
    const buy = !holdersAvailable || this.rng.chance(d.bias);
    if (buy) {
      const wallet = this.pickBuyer(t);
      const kind = this.walletKind.get(wallet) ?? "retail";
      const mult = kind === "whale" ? 6 : kind === "kol" ? 3 : kind === "pro" ? 2 : 1;
      let sol = this.rng.logNormal(d.sizeMu, 0.85) * mult;
      if (this.rng.chance(0.012)) sol = this.rng.range(4, 22);
      sol = Math.min(45, Math.max(0.005, sol));
      this.execBuy(t, wallet, sol, ts, 0);
      return;
    }
    const seller = this.pickSeller(t);
    if (!seller) return;
    const h = t.holders.get(seller);
    if (!h || h.bal <= 0) return;
    const frac = this.rng.chance(0.42) ? 1 : this.rng.range(0.15, 0.85);
    this.execSell(t, seller, h.bal * frac, ts);
  }

  private pickBuyer(t: SimToken): string {
    if (t.holderAddrs.length > 3 && this.rng.chance(0.28)) {
      for (let i = 0; i < 4; i++) {
        const a = this.rng.pick(t.holderAddrs);
        if (a !== t.creator && !this.users.has(a)) return a;
      }
    }
    if (this.poolTotal <= 0) return fakeAddress(this.rng);
    const r = this.rng.next() * this.poolTotal;
    let lo = 0;
    let hi = this.poolCum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.poolCum[mid] ?? 0) < r) lo = mid + 1;
      else hi = mid;
    }
    return this.wallets[lo]?.address ?? fakeAddress(this.rng);
  }

  private pickSeller(t: SimToken): string | null {
    for (let i = 0; i < 6; i++) {
      const a = this.rng.pick(t.holderAddrs);
      if (this.users.has(a)) continue;
      if (a === t.creator && !t.dyn.rugged) continue;
      return a;
    }
    return null;
  }

  private priceOf(t: SimToken): number {
    return t.pool ? poolPrice(t.pool) : curvePrice(t.curve);
  }

  private holding(t: SimToken, wallet: string): Holding {
    let h = t.holders.get(wallet);
    if (!h) {
      h = {
        bal: 0,
        boughtSol: 0,
        soldSol: 0,
        buys: 0,
        sells: 0,
        firstBuyAt: null,
        firstSlot: null,
        tags: 0,
        fundedBy: t.insiders.has(wallet) ? t.creator : null,
      };
      t.holders.set(wallet, h);
    }
    return h;
  }

  private trackHolder(t: SimToken, wallet: string, h: Holding): void {
    const has = t.holderIdx.has(wallet);
    if (h.bal > 1e-6 && !has) {
      t.holderIdx.set(wallet, t.holderAddrs.length);
      t.holderAddrs.push(wallet);
    } else if (h.bal <= 1e-6 && has) {
      const idx = t.holderIdx.get(wallet) ?? 0;
      const last = t.holderAddrs.pop();
      if (last !== undefined && last !== wallet) {
        t.holderAddrs[idx] = last;
        t.holderIdx.set(last, idx);
      }
      t.holderIdx.delete(wallet);
      h.bal = 0;
    }
  }

  private execBuy(t: SimToken, wallet: string, sol: number, ts: number, extraTags: number): SwapResult | null {
    if (t.migratedAt === null && t.curve.complete) return null;
    let q: SwapResult;
    if (t.pool) {
      q = quotePoolBuy(t.pool, sol);
      applyPoolBuy(t.pool, q);
    } else {
      q = quoteCurveBuy(t.curve, sol);
      if (q.tokens <= 0) return null;
      applyCurveBuy(t.curve, q);
    }
    const slot = this.slotAt(ts);
    const h = this.holding(t, wallet);
    if (h.firstBuyAt === null) {
      h.firstBuyAt = ts;
      h.firstSlot = slot;
      h.tags |= extraTags | this.tagsFor(t, wallet, slot);
    }
    h.bal += q.tokens;
    h.boughtSol += q.sol;
    h.buys++;
    this.trackHolder(t, wallet, h);
    this.recordTrade(t, "buy", wallet, q, ts, slot, h.tags);
    if (t.curve.complete && t.completeAt === null && t.migratedAt === null) {
      t.completeAt = ts;
      t.migrateAt = ts + this.rng.range(1500, 4500);
    }
    return q;
  }

  private execSell(t: SimToken, wallet: string, tokens: number, ts: number): SwapResult | null {
    const h = t.holders.get(wallet);
    if (!h || h.bal <= 0 || tokens <= 0) return null;
    if (t.migratedAt === null && t.curve.complete) return null;
    const amount = Math.min(tokens, h.bal);
    let q: SwapResult;
    if (t.pool) {
      q = quotePoolSell(t.pool, amount);
      applyPoolSell(t.pool, q);
    } else {
      q = quoteCurveSell(t.curve, amount);
      applyCurveSell(t.curve, q);
    }
    const slot = this.slotAt(ts);
    h.bal -= amount;
    h.soldSol += q.sol;
    h.sells++;
    this.trackHolder(t, wallet, h);
    this.recordTrade(t, "sell", wallet, q, ts, slot, h.tags);
    return q;
  }

  private tagsFor(t: SimToken, wallet: string, slot: number): number {
    let tags = 0;
    if (wallet === t.creator) return TAG_DEV;
    if (slot - t.createSlot <= 3) tags |= TAG_SNIPER;
    if (slot === t.createSlot) tags |= TAG_BUNDLER;
    if (t.insiders.has(wallet)) tags |= TAG_INSIDER;
    const kind = this.walletKind.get(wallet);
    if (kind === "pro") tags |= TAG_PRO;
    if (kind === "whale") tags |= TAG_WHALE;
    if (kind === "kol") tags |= TAG_KOL;
    return tags;
  }

  private tagList(bits: number, wallet: string): WalletTag[] {
    const out: WalletTag[] = [];
    if (this.users.has(wallet)) out.push("you");
    if (bits & TAG_DEV) out.push("dev");
    if (bits & TAG_SNIPER) out.push("sniper");
    if (bits & TAG_INSIDER) out.push("insider");
    if (bits & TAG_BUNDLER) out.push("bundler");
    if (bits & TAG_PRO) out.push("pro");
    if (bits & TAG_WHALE) out.push("whale");
    if (bits & TAG_KOL) out.push("kol");
    if (this.tracked.has(wallet)) out.push("tracked");
    return out;
  }

  private recordTrade(
    t: SimToken,
    side: "buy" | "sell",
    maker: string,
    q: SwapResult,
    ts: number,
    slot: number,
    tagBits: number,
    signature?: string,
  ): Trade {
    // Scheduled fills can land a tick late; keep each token's tape strictly time-ordered.
    const at = Math.max(ts, t.trades[t.trades.length - 1]?.ts ?? 0);
    const price = this.priceOf(t);
    if (t.pool) t.pool.feeBps = poolFeeBps(price * t.supply);
    const sig = signature ?? fakeSignature(this.rng);
    const trade: Trade = {
      id: `${sig}:0`,
      signature: sig,
      mint: t.mint,
      ts: at,
      slot,
      side,
      solAmount: q.sol,
      tokenAmount: q.tokens,
      priceSol: price,
      priceUsd: price * this.solUsd,
      marketCapUsd: price * t.supply * this.solUsd,
      maker,
      tags: this.tagList(tagBits, maker),
    };
    t.trades.push(trade);
    if (t.trades.length > TRADE_RING + 200) t.trades.splice(0, t.trades.length - TRADE_RING);
    this.updateMinuteCandle(t, trade);
    t.volumeSol += q.sol;
    t.txns++;
    if (side === "buy") t.buys++;
    else t.sells++;
    const priority = this.rng.chance(0.7) ? this.rng.range(0.00001, 0.0015) : this.rng.range(0.002, 0.012);
    t.feesSol += q.feeSol + priority + BASE_FEE_SOL;
    t.lastTradeAt = at;
    t.dirty = true;
    t.detailDirty = true;
    if (!this.seeding) {
      this.eventsWindow.push(at);
      if (this.hasSubs(`trades:${t.mint}`) || this.hasCandleSubs(t.mint)) {
        let list = this.pendingTrades.get(t.mint);
        if (!list) {
          list = [];
          this.pendingTrades.set(t.mint, list);
        }
        list.push(trade);
      }
      this.checkOrders(t);
    }
    if (this.tracked.has(maker)) {
      const item: TrackedTrade = { trade, token: this.tokenRef(t) };
      this.trackedRing.unshift(item);
      if (this.trackedRing.length > 120) this.trackedRing.length = 120;
      if (!this.seeding) this.pendingTracked.push(item);
    }
    for (const u of this.users.values()) {
      if (u.positions.has(t.mint)) {
        const p = u.positions.get(t.mint);
        if (p && p.holding > 0) {
          p.lastPriceSol = price;
          u.dirty = true;
          u.changedPositions.add(t.mint);
        }
      }
    }
    return trade;
  }

  private hasCandleSubs(mint: string): boolean {
    for (const key of this.subs.keys()) if (key.startsWith(`candles:${mint}:`)) return true;
    return false;
  }

  private updateMinuteCandle(t: SimToken, trade: Trade): void {
    const bucket = Math.floor(trade.ts / 60_000) * 60;
    const last = t.minuteCandles[t.minuteCandles.length - 1];
    if (last && last.time === bucket) {
      last.high = Math.max(last.high, trade.priceSol);
      last.low = Math.min(last.low, trade.priceSol);
      last.close = trade.priceSol;
      last.volumeSol += trade.solAmount;
      if (trade.side === "buy") last.buys++;
      else last.sells++;
      last.solUsd = this.solUsd;
      return;
    }
    const open = last ? last.close : trade.priceSol;
    t.minuteCandles.push({
      time: bucket,
      open,
      high: Math.max(open, trade.priceSol),
      low: Math.min(open, trade.priceSol),
      close: trade.priceSol,
      volumeSol: trade.solAmount,
      buys: trade.side === "buy" ? 1 : 0,
      sells: trade.side === "sell" ? 1 : 0,
      solUsd: this.solUsd,
    });
    if (t.minuteCandles.length > 720) t.minuteCandles.splice(0, t.minuteCandles.length - 720);
  }

  private launchToken(at: number, fateOverride?: Fate): SimToken {
    const rng = this.rng;
    const launchpad = rng.weighted(LAUNCHPAD_WEIGHTS);
    const { name, symbol } = generateTokenName(rng);
    const quote: QuoteToken =
      launchpad === "stonkfun"
        ? rng.weighted([
            ["USDC", 4],
            ["USD1", 3],
            ["SOL", 2],
            ["OTHER", 1],
          ])
        : rng.weighted([
            ["SOL", 92],
            ["USDC", 4],
            ["USD1", 3],
            ["OTHER", 1],
          ]);
    const serial = rng.chance(0.3) && this.serialDevs.length > 0;
    const creator = serial ? rng.pick(this.serialDevs) : fakeAddress(rng);
    const stats = this.devStats.get(creator) ?? { launches: 0, migrations: 0 };
    stats.launches++;
    this.devStats.set(creator, stats);
    const funder = rng.chance(0.45) ? rng.pick(this.fundingHubs) : rng.chance(0.7) ? fakeAddress(rng) : null;
    const handle = `${symbol.toLowerCase()}${rng.chance(0.4) ? rng.int(1, 999) : ""}`;
    const socials: TokenSocials = {};
    if (rng.chance(0.62)) socials.x = rng.chance(0.25) ? `${handle}/status/${rng.int(1e9, 2e9)}` : handle;
    if (rng.chance(0.38)) socials.telegram = `${handle}_portal`;
    if (rng.chance(0.33)) socials.website = `${handle}.fun`;
    const scale = launchpad === "mayhem" ? 2 : 1;
    const fate: Fate =
      fateOverride ??
      rng.weighted([
        ["dud", 70],
        ["climber", 17],
        ["runner", 6],
        ["rug", 7],
      ]);
    const createSlot = this.slotAt(at);
    const t: SimToken = {
      mint: fakeAddress(rng, MINT_SUFFIX[launchpad] ?? ""),
      name,
      symbol,
      launchpad,
      quote,
      venue: CURVE_VENUE[launchpad],
      createdAt: at,
      createSlot,
      creator,
      funder,
      socials,
      supply: PUMP.totalSupply * scale,
      curve: newCurve(scale),
      pool: null,
      completeAt: null,
      migrateAt: null,
      migratedAt: null,
      volumeSol: 0,
      txns: 0,
      buys: 0,
      sells: 0,
      feesSol: 0,
      holders: new Map(),
      holderAddrs: [],
      holderIdx: new Map(),
      insiders: new Set(),
      scheduled: [],
      trades: [],
      minuteCandles: [],
      dyn: this.dynamicsFor(fate, at),
      dexPaid: false,
      dexPaidAt: null,
      token2022: this.token2022For(launchpad),
      lpBurnedPct: null,
      lastTradeAt: at,
      column: "new",
      dirty: true,
      detailDirty: true,
      summary: null,
      devLaunches: stats.launches - 1,
      devMigrations: stats.migrations,
    };
    if (fate === "runner" && rng.chance(0.7)) t.dexPaidAt = at + rng.range(120_000, 900_000);
    this.tokens.set(t.mint, t);
    // Creation slot: dev buy, then bundled co-buyers in the same slot.
    this.execBuy(t, creator, rng.range(0.2, 2.8), at, TAG_DEV);
    const bundles = fate === "rug" ? rng.int(2, 6) : rng.chance(0.35) ? rng.int(1, 4) : 0;
    for (let i = 0; i < bundles; i++) {
      t.scheduled.push({ at, wallet: fakeAddress(rng), side: "buy", sol: rng.range(0.3, 2.5), frac: 0, tags: TAG_BUNDLER });
    }
    const snipers = rng.int(0, fate === "runner" ? 7 : 4);
    for (let i = 0; i < snipers; i++) {
      const w = this.sniperWallet();
      t.scheduled.push({ at: at + rng.range(350, 1150), wallet: w, side: "buy", sol: rng.range(0.2, 3), frac: 0, tags: 0 });
    }
    const insiders = fate === "rug" ? rng.int(2, 5) : rng.chance(0.3) ? rng.int(1, 3) : 0;
    for (let i = 0; i < insiders; i++) {
      const w = fakeAddress(rng);
      t.insiders.add(w);
      t.scheduled.push({ at: at + rng.range(1500, 40_000), wallet: w, side: "buy", sol: rng.range(0.2, 1.5), frac: 0, tags: TAG_INSIDER });
    }
    if (fate !== "rug" && rng.chance(0.4)) t.dyn.devSellAt = at + rng.range(30_000, 900_000);
    return t;
  }

  private dynamicsFor(fate: Fate, at: number): Dynamics {
    const rng = this.rng;
    const base = (rate: [number, number], hl: [number, number], bias: [number, number], size: number): Dynamics => {
      const b = rng.range(bias[0], bias[1]);
      return {
        fate,
        rate: rng.range(rate[0], rate[1]),
        bias: b,
        baseBias: b,
        halfLifeSec: rng.range(hl[0], hl[1]),
        sizeMu: Math.log(size),
        rugAt: null,
        rugged: false,
        devSellAt: null,
        spikeUntil: 0,
        nextEventAt: at + rng.range(10_000, 60_000),
      };
    };
    switch (fate) {
      case "dud":
        return base([0.15, 0.7], [25, 100], [0.44, 0.53], 0.08);
      case "climber":
        return base([0.5, 1.2], [240, 650], [0.56, 0.62], 0.28);
      case "runner":
        return base([1.0, 2.4], [600, 1500], [0.6, 0.67], 0.5);
      case "rug": {
        const d = base([0.7, 1.6], [200, 500], [0.59, 0.65], 0.3);
        d.rugAt = at + rng.range(60_000, 420_000);
        return d;
      }
    }
  }

  private token2022For(launchpad: Launchpad): Token2022Flags | null {
    const clean: Token2022Flags = {
      permanentDelegate: false,
      transferHook: false,
      pausable: false,
      nonTransferable: false,
      defaultFrozen: false,
    };
    if (launchpad === "pump" || launchpad === "mayhem") return clean;
    if ((launchpad === "other" || launchpad === "heaven") && this.rng.chance(0.25)) {
      return { ...clean, transferHook: this.rng.chance(0.6), permanentDelegate: this.rng.chance(0.5) };
    }
    return this.rng.chance(0.2) ? clean : null;
  }

  private sniperWallet(): string {
    for (let i = 0; i < 8; i++) {
      const w = this.rng.pick(this.wallets);
      if (w.kind === "sniper") return w.address;
    }
    return fakeAddress(this.rng);
  }

  private rug(t: SimToken, now: number): void {
    const d = t.dyn;
    d.rugged = true;
    d.baseBias = 0.32;
    d.bias = 0.25;
    d.halfLifeSec = 40;
    const dumpers = [t.creator, ...t.insiders];
    for (const [addr, h] of t.holders) if (h.tags & TAG_BUNDLER) dumpers.push(addr);
    let offset = 0;
    for (const w of dumpers) {
      t.scheduled.push({ at: now + offset, wallet: w, side: "sell", sol: 0, frac: 1, tags: 0 });
      offset += this.rng.range(200, 1500);
    }
  }

  private migrate(t: SimToken, now: number): void {
    t.pool = poolFromCurve(t.curve, fakeAddress(this.rng));
    t.migratedAt = now;
    t.venue = POOL_VENUE[t.launchpad];
    t.lpBurnedPct =
      t.launchpad === "pump" || t.launchpad === "mayhem" ? 100 : this.rng.chance(0.7) ? 100 : Math.round(this.rng.range(0, 90));
    const stats = this.devStats.get(t.creator);
    if (stats) stats.migrations++;
    const d = t.dyn;
    d.rate = Math.max(d.rate, this.rng.range(0.5, 1.7));
    d.halfLifeSec = this.rng.range(600, 2400);
    d.baseBias = d.fate === "runner" ? this.rng.range(0.5, 0.58) : this.rng.range(0.44, 0.54);
    d.bias = d.baseBias;
    d.sizeMu += 0.4;
    if (t.dexPaidAt === null && this.rng.chance(0.35)) t.dexPaidAt = now + this.rng.range(30_000, 600_000);
    t.dirty = true;
    t.detailDirty = true;
    if (!this.seeding) this.onMigrated(t);
  }

  // -------------------------------------------------------------------------
  // Seeding helpers
  // -------------------------------------------------------------------------

  private createWalletPool(): void {
    const rng = this.rng;
    for (let i = 0; i < 2600; i++) {
      const kind: WalletKind = rng.weighted([
        ["retail", 80],
        ["pro", 8],
        ["whale", 3],
        ["sniper", 7],
        ["kol", 2],
      ]);
      const weight = kind === "sniper" ? 0.2 : kind === "pro" ? 1.6 : kind === "whale" ? 0.9 : kind === "kol" ? 1.2 : 1;
      const address = fakeAddress(rng);
      this.wallets.push({ address, kind, weight });
      this.walletKind.set(address, kind);
    }
    for (let i = 0; i < 30; i++) this.serialDevs.push(fakeAddress(rng));
    for (let i = 0; i < 14; i++) this.fundingHubs.push(fakeAddress(rng));
    const picks = this.wallets.filter((w) => w.kind === "pro" || w.kind === "kol" || w.kind === "whale").slice(0, 10);
    picks.forEach((w, i) => {
      const preset = TRACKED_PRESETS[i % TRACKED_PRESETS.length] ?? ["⭐", "Wallet"];
      this.defaultTracked.push({ address: w.address, emoji: preset[0], name: preset[1] });
    });
    this.setTrackedWallets(this.defaultTracked.map((w) => w.address));
  }

  private rebuildPoolWeights(): void {
    this.poolCum = new Float64Array(this.wallets.length);
    let total = 0;
    this.wallets.forEach((w, i) => {
      total += w.weight * (this.tracked.has(w.address) ? 3 : 1);
      this.poolCum[i] = total;
    });
    this.poolTotal = total;
  }

  private seedVeterans(start: number): void {
    const count = 6;
    for (let i = 0; i < count; i++) {
      const createdAt = start - this.rng.range(40, 300) * 60_000;
      const t = this.launchToken(createdAt, "runner");
      t.dyn.halfLifeSec = this.rng.range(1800, 5000);
      let now = createdAt;
      while (now < start) {
        const step = now - createdAt < 10 * 60_000 ? 1000 : 6000;
        now = Math.min(start, now + step);
        this.now = now;
        this.stepToken(t, step / 1000, now);
      }
    }
    this.now = start;
  }

  private seedDemoBuy(address: string): boolean {
    const candidates = [...this.tokens.values()].filter(
      (t) => !(t.curve.complete && t.migratedAt === null) && t.dyn.rate > 0.4 && !this.users.get(address)?.positions.has(t.mint),
    );
    if (candidates.length === 0) return false;
    const t = this.rng.pick(candidates);
    const res = this.executeUserSwap({
      wallet: address,
      mint: t.mint,
      side: "buy",
      solAmount: this.rng.pick([0.25, 0.5, 0.5, 1]),
      expectedPriceSol: this.priceOf(t),
      slippagePct: 100,
      priorityFeeSol: 0.0001,
      tipSol: 0.00001,
      signature: fakeSignature(this.rng),
    });
    return res.ok;
  }

  private seedDemoHistory(address: string): void {
    const u = this.users.get(address);
    if (!u) return;
    const rng = this.rng;
    const outcomes = [6.2, 3.1, 2.4, 1.4, 0.9, 0.6, 0.35, 0.2, -0.1, -0.25, -0.4, -0.45, -0.6, -0.72, -0.85, 0.15, 0.05];
    const now = Date.now();
    outcomes.forEach((r, i) => {
      const { name, symbol } = generateTokenName(rng);
      const bought = rng.pick([0.25, 0.5, 0.5, 1, 1, 2]);
      const sold = Math.max(0, bought * (1 + r));
      const openedAt = now - rng.range(1, 29) * 86_400_000 - i * 3_600_000;
      const tokens = bought / rng.range(2e-8, 3e-7);
      const mint = fakeAddress(rng, "pump");
      const fees = 0.00012 * 2;
      u.history.push({
        mint,
        symbol,
        name,
        imageUri: null,
        launchpad: "pump",
        boughtSol: bought,
        soldSol: sold,
        boughtTokens: tokens,
        soldTokens: tokens,
        holdingTokens: 0,
        avgEntryPriceSol: bought / tokens,
        avgExitPriceSol: sold / tokens,
        costBasisSol: 0,
        realizedPnlSol: sold - bought - fees,
        unrealizedPnlSol: 0,
        valueSol: 0,
        feesSol: fees,
        openedAt,
        lastTradeAt: openedAt + rng.range(60_000, 8 * 3_600_000),
        closed: true,
      });
      u.activity.push(
        {
          id: `h-${i}-s`,
          kind: "sell",
          mint,
          symbol,
          solAmount: sold,
          tokenAmount: tokens,
          marketCapUsd: (sold / tokens) * 1e9 * this.solUsd,
          ts: openedAt + 3_600_000,
          signature: fakeSignature(rng),
        },
        {
          id: `h-${i}-b`,
          kind: "buy",
          mint,
          symbol,
          solAmount: bought,
          tokenAmount: tokens,
          marketCapUsd: (bought / tokens) * 1e9 * this.solUsd,
          ts: openedAt,
          signature: fakeSignature(rng),
        },
      );
    });
    u.activity.push({
      id: "h-deposit",
      kind: "deposit",
      mint: null,
      symbol: null,
      solAmount: 12.3104,
      tokenAmount: null,
      marketCapUsd: null,
      ts: now - 31 * 86_400_000,
      signature: fakeSignature(rng),
    });
    u.activity.sort((a, b) => b.ts - a.ts);
  }

  private seedDemoOrders(address: string): void {
    const u = this.users.get(address);
    if (!u) return;
    const held = [...u.positions.values()].filter((p) => p.holding > 0);
    const first = held[0];
    if (first) {
      const t = this.tokens.get(first.mint);
      const entry = first.costBasis / Math.max(first.holding, 1e-9);
      const group = `oco-${++this.orderSeq}`;
      this.addOrder({
        wallet: address,
        mint: first.mint,
        symbol: first.symbol,
        kind: "take_profit",
        side: "sell",
        trigger: { metric: "price", direction: "above", value: entry * 2 },
        size: { kind: "pct", pct: 50 },
        landing: "secure",
        slippagePct: 25,
        priorityFeeSol: 0.0005,
        tipSol: 0.0001,
        ocoGroupId: group,
        nonceSlots: 1,
      });
      this.addOrder({
        wallet: address,
        mint: first.mint,
        symbol: first.symbol,
        kind: "stop_loss",
        side: "sell",
        trigger: { metric: "price", direction: "below", value: entry * 0.6 },
        size: { kind: "pct", pct: 100 },
        landing: "secure",
        slippagePct: 30,
        priorityFeeSol: 0.0005,
        tipSol: 0.0001,
        ocoGroupId: group,
        nonceSlots: 0,
      });
      if (t && t.migratedAt === null) {
        this.addOrder({
          wallet: address,
          mint: first.mint,
          symbol: first.symbol,
          kind: "migration_sell",
          side: "sell",
          trigger: { metric: "migration", direction: null, value: null },
          size: { kind: "pct", pct: 25 },
          landing: "secure",
          slippagePct: 30,
          priorityFeeSol: 0.001,
          tipSol: 0.0002,
        });
      }
    }
    const finals = [...this.tokens.values()].filter((t) => t.column === "final");
    const target = finals[0] ?? [...this.tokens.values()].find((t) => t.column === "new");
    if (target) {
      const mc = this.priceOf(target) * target.supply * this.solUsd;
      this.addOrder({
        wallet: address,
        mint: target.mint,
        symbol: target.symbol,
        kind: "limit_buy",
        side: "buy",
        trigger: { metric: "mc", direction: "below", value: Math.round(mc * 0.7) },
        size: { kind: "sol", sol: 0.5 },
        landing: "secure",
        slippagePct: 20,
        priorityFeeSol: 0.0003,
        tipSol: 0.0001,
      });
    }
    const second = held[1];
    if (second) {
      const o = this.addOrder({
        wallet: address,
        mint: second.mint,
        symbol: second.symbol,
        kind: "limit_sell",
        side: "sell",
        trigger: { metric: "mc", direction: "above", value: 250_000 },
        size: { kind: "pct", pct: 100 },
        landing: "reduced",
        slippagePct: 20,
        priorityFeeSol: 0.0003,
        tipSol: 0.00001,
      });
      if (o) this.markStale(o.order.id, STALE_REASONS[0]);
    }
    const leader = this.defaultTracked[0];
    this.addOrder({
      wallet: address,
      mint: null,
      symbol: leader ? `Copy ${leader.name}` : "Copy buys",
      kind: "copy_buy",
      side: "buy",
      trigger: { metric: "leader_buy", direction: null, value: null },
      size: { kind: "sol", sol: 0.25 },
      landing: "reduced",
      slippagePct: 20,
      priorityFeeSol: 0.0003,
      tipSol: 0.00001,
      nonceSlots: 0,
    });
  }

  // -------------------------------------------------------------------------
  // Emission
  // -------------------------------------------------------------------------

  private flushFast(): void {
    for (const [mint, trades] of this.pendingTrades) {
      if (trades.length === 0) continue;
      const newestFirst = [...trades].reverse();
      this.emit(`trades:${mint}` as Topic, { trades: newestFirst });
      for (const key of this.subs.keys()) {
        if (!key.startsWith(`candles:${mint}:`)) continue;
        const tf = key.split(":")[2] as Timeframe;
        const changed = this.advanceCandle(key, tf, trades);
        if (changed.length > 0) this.emit(key as Topic, { candles: changed });
      }
    }
    this.pendingTrades.clear();
    if (this.pendingTracked.length > 0) {
      this.emit("tracked", { items: [...this.pendingTracked].reverse() });
      this.pendingTracked = [];
    }
    for (const u of this.users.values()) {
      if (u.pendingActivity.length === 0) continue;
      this.emitWallet(u, true);
    }
  }

  private advanceCandle(key: string, tf: Timeframe, trades: Trade[]): Candle[] {
    const secs = TIMEFRAME_SECONDS[tf];
    const changed: Candle[] = [];
    let current = this.candleState.get(key);
    for (const tr of trades) {
      const bucket = Math.floor(tr.ts / 1000 / secs) * secs;
      if (current && bucket < current.time) continue;
      if (current && current.time === bucket) {
        current.high = Math.max(current.high, tr.priceSol);
        current.low = Math.min(current.low, tr.priceSol);
        current.close = tr.priceSol;
        current.volumeSol += tr.solAmount;
        if (tr.side === "buy") current.buys++;
        else current.sells++;
        current.solUsd = this.solUsd;
      } else {
        if (current) changed.push({ ...current });
        const open = current ? current.close : tr.priceSol;
        current = {
          time: bucket,
          open,
          high: Math.max(open, tr.priceSol),
          low: Math.min(open, tr.priceSol),
          close: tr.priceSol,
          volumeSol: tr.solAmount,
          buys: tr.side === "buy" ? 1 : 0,
          sells: tr.side === "sell" ? 1 : 0,
          solUsd: this.solUsd,
        };
      }
    }
    if (current) {
      this.candleState.set(key, current);
      changed.push({ ...current });
    }
    const dedup = new Map<number, Candle>();
    for (const c of changed) dedup.set(c.time, c);
    return [...dedup.values()].sort((a, b) => a.time - b.time);
  }

  private flushPulse(): void {
    const upserts: Record<PulseColumnId, TokenSummary[]> = { new: [], final: [], migrated: [] };
    for (const t of this.tokens.values()) {
      if (!t.dirty) continue;
      t.dirty = false;
      t.summary = this.buildSummary(t);
      const column = this.columnFor(t);
      if (column !== t.column) {
        this.pulseRemovals[t.column].push(t.mint);
        t.column = column;
        t.summary = { ...t.summary, column };
      }
      upserts[column].push(t.summary);
    }
    for (const column of ["new", "final", "migrated"] as const) {
      const remove = this.pulseRemovals[column];
      if (upserts[column].length === 0 && remove.length === 0) continue;
      this.emit(`pulse:${column}`, { upsert: upserts[column], remove: [...remove] });
      this.pulseRemovals[column] = [];
    }
  }

  private flushDetails(): void {
    for (const key of this.subs.keys()) {
      if (!key.startsWith("token:")) continue;
      const t = this.tokens.get(key.slice(6));
      if (!t?.detailDirty) continue;
      t.detailDirty = false;
      if (!t.summary || t.dirty) t.summary = this.buildSummary(t);
      const detail = this.buildDetail(t);
      this.emit(key as Topic, {
        summary: detail.summary,
        curve: detail.curve,
        pool: detail.pool,
        holders: detail.holders,
        topTraders: detail.topTraders,
      });
    }
  }

  private flushSlow(): void {
    this.emit("market", this.marketStatus());
    for (const u of this.users.values()) {
      if (u.dirty) this.emitWallet(u, false);
    }
  }

  private emitWallet(u: UserWallet, includeActivity: boolean): void {
    const topic = `wallet:${u.address}` as Topic;
    const positions: Position[] = [];
    for (const mint of u.changedPositions) {
      const p = u.positions.get(mint);
      if (p) positions.push(this.toPosition(p));
    }
    const activity = includeActivity ? [...u.pendingActivity].reverse() : [];
    if (includeActivity) u.pendingActivity = [];
    u.changedPositions.clear();
    u.dirty = false;
    this.emit(topic, {
      solBalance: u.sol,
      reservedSol: this.reservedFor(u.address),
      nonceSlots: { used: this.nonceUsed(u.address), total: NONCE_SLOTS },
      positions,
      activity,
    });
  }

  private marketStatus() {
    const cutoff = Date.now() - 5000;
    this.eventsWindow = this.eventsWindow.filter((ts) => ts >= cutoff);
    return {
      solUsd: this.solUsd,
      slot: this.slotAt(Date.now()),
      feed: {
        state: "connected" as const,
        lagMs: Math.round(180 + this.rng.next() * 260),
        eventsPerSec: Math.round((this.eventsWindow.length / 5) * 10) / 10,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Builders
  // -------------------------------------------------------------------------

  private columnFor(t: SimToken): PulseColumnId {
    if (t.migratedAt !== null) return "migrated";
    const p = curveProgress(t.curve);
    if (t.column === "final") return p >= FINAL_EXIT ? "final" : "new";
    return p >= FINAL_ENTER ? "final" : "new";
  }

  private tokenRef(t: SimToken): TokenRef {
    const price = this.priceOf(t);
    return {
      mint: t.mint,
      symbol: t.symbol,
      name: t.name,
      imageUri: null,
      launchpad: t.launchpad,
      createdAt: t.createdAt,
      marketCapUsd: price * t.supply * this.solUsd,
    };
  }

  private buildSummary(t: SimToken): TokenSummary {
    const price = this.priceOf(t);
    const supply = t.supply;
    const top: number[] = [];
    let dev = 0;
    let snipers = 0;
    let insiders = 0;
    let bundlers = 0;
    let holders = 0;
    let pros = 0;
    for (const h of t.holders.values()) {
      if (h.bal <= 1e-6) continue;
      holders++;
      if (h.tags & TAG_DEV) dev += h.bal;
      if (h.tags & TAG_SNIPER) snipers += h.bal;
      if (h.tags & TAG_INSIDER) insiders += h.bal;
      if (h.tags & TAG_BUNDLER) bundlers += h.bal;
      if (h.tags & TAG_PRO) pros++;
      if (top.length < 10) {
        top.push(h.bal);
        top.sort((a, b) => b - a);
      } else if (h.bal > (top[9] ?? 0)) {
        top[9] = h.bal;
        top.sort((a, b) => b - a);
      }
    }
    const top10 = top.reduce((s, v) => s + v, 0);
    const devHolding = t.holders.get(t.creator);
    const devSold = !!devHolding && devHolding.buys > 0 && devHolding.bal <= 1e-6;
    const quoteReserve = t.pool ? t.pool.sol : t.curve.realSol;
    const change5m = this.change5m(t, price);
    return {
      mint: t.mint,
      name: t.name,
      symbol: t.symbol,
      imageUri: null,
      launchpad: t.launchpad,
      quote: t.quote,
      venue: t.venue,
      column: t.column,
      createdAt: t.createdAt,
      creator: t.creator,
      fundingWallet: t.funder,
      socials: t.socials,
      supply,
      decimals: 6,
      priceSol: price,
      priceUsd: price * this.solUsd,
      marketCapSol: price * supply,
      marketCapUsd: price * supply * this.solUsd,
      liquidityUsd: quoteReserve * 2 * this.solUsd,
      volumeUsd: t.volumeSol * this.solUsd,
      txns: t.txns,
      buys: t.buys,
      sells: t.sells,
      holders,
      proTraders: pros,
      bondingProgress: t.migratedAt !== null ? 1 : curveProgress(t.curve),
      migratedAt: t.migratedAt,
      risk: {
        top10Pct: (top10 / supply) * 100,
        devPct: (dev / supply) * 100,
        devSold,
        snipersPct: (snipers / supply) * 100,
        insidersPct: (insiders / supply) * 100,
        bundlersPct: (bundlers / supply) * 100,
      },
      dexPaid: t.dexPaid,
      lpBurnedPct: t.lpBurnedPct,
      token2022: t.token2022,
      feesPaidSol: t.feesSol,
      lastTradeAt: t.lastTradeAt,
      change5mPct: change5m,
    };
  }

  private change5m(t: SimToken, price: number): number {
    const cutoff = this.now - 5 * 60_000;
    let ref: number;
    if (t.createdAt >= cutoff) {
      ref = (PUMP.initialVirtualSol / PUMP.initialVirtualTokens) * (PUMP.totalSupply / t.supply);
    } else {
      const trades = t.trades;
      let lo = 0;
      let hi = trades.length - 1;
      let idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const tr = trades[mid];
        if (tr && tr.ts >= cutoff) {
          idx = mid;
          hi = mid - 1;
        } else lo = mid + 1;
      }
      const prev = idx > 0 ? trades[idx - 1] : idx === 0 ? trades[0] : trades[trades.length - 1];
      ref = prev?.priceSol ?? price;
    }
    return ref > 0 ? (price / ref - 1) * 100 : 0;
  }

  private buildDetail(t: SimToken): TokenDetail {
    const summary = t.summary && !t.dirty ? t.summary : this.buildSummary(t);
    const price = this.priceOf(t);
    const entries = [...t.holders.entries()].filter(([, h]) => h.bal > 1e-6);
    entries.sort((a, b) => b[1].bal - a[1].bal);
    const holders: Holder[] = entries.slice(0, 60).map(([address, h]) => ({
      address,
      balance: h.bal,
      pct: (h.bal / t.supply) * 100,
      boughtSol: h.boughtSol,
      soldSol: h.soldSol,
      buys: h.buys,
      sells: h.sells,
      firstBuyAt: h.firstBuyAt,
      fundedBy: h.fundedBy,
      tags: this.tagList(h.tags, address),
    }));
    if (t.pool) {
      holders.unshift({
        address: t.pool.address,
        balance: t.pool.tok,
        pct: (t.pool.tok / t.supply) * 100,
        boughtSol: 0,
        soldSol: 0,
        buys: 0,
        sells: 0,
        firstBuyAt: null,
        fundedBy: null,
        tags: ["pool"],
      });
    } else {
      const curveBal = t.curve.realTok + t.curve.reservedTok;
      holders.unshift({
        address: `${t.mint.slice(0, 20)}curvePDA`,
        balance: curveBal,
        pct: (curveBal / t.supply) * 100,
        boughtSol: 0,
        soldSol: 0,
        buys: 0,
        sells: 0,
        firstBuyAt: null,
        fundedBy: null,
        tags: ["curve"],
      });
    }
    const traders: TopTrader[] = [...t.holders.entries()]
      .map(([address, h]) => ({
        address,
        boughtSol: h.boughtSol,
        soldSol: h.soldSol,
        buys: h.buys,
        sells: h.sells,
        holdingPct: (h.bal / t.supply) * 100,
        pnlSol: h.soldSol + h.bal * price - h.boughtSol,
        tags: this.tagList(h.tags, address),
      }))
      .sort((a, b) => b.pnlSol - a.pnlSol)
      .slice(0, 40);
    const stats = this.devStats.get(t.creator);
    return {
      summary,
      curve: t.pool
        ? null
        : {
            virtualQuoteReserves: t.curve.vSol,
            virtualTokenReserves: t.curve.vTok,
            realQuoteReserves: t.curve.realSol,
            realTokenReserves: t.curve.realTok,
            initialRealTokenReserves: t.curve.initialRealTok,
            complete: t.curve.complete,
            feeBps: t.curve.feeBps,
          },
      pool: t.pool
        ? {
            quoteReserves: t.pool.sol,
            baseReserves: t.pool.tok,
            feeBps: t.pool.feeBps,
            poolAddress: t.pool.address,
          }
        : null,
      holders,
      topTraders: traders,
      devLaunches: Math.max(0, (stats?.launches ?? 1) - 1),
      devMigrations: stats?.migrations ?? 0,
    };
  }

  private buildCandles(t: SimToken, tf: Timeframe): Candle[] {
    const secs = TIMEFRAME_SECONDS[tf];
    const out: Candle[] = [];
    if (secs < 60) {
      let current: Candle | null = null;
      for (const tr of t.trades) {
        const bucket = Math.floor(tr.ts / 1000 / secs) * secs;
        if (current && current.time === bucket) {
          current.high = Math.max(current.high, tr.priceSol);
          current.low = Math.min(current.low, tr.priceSol);
          current.close = tr.priceSol;
          current.volumeSol += tr.solAmount;
          if (tr.side === "buy") current.buys++;
          else current.sells++;
        } else {
          const open: number = current ? current.close : tr.priceSol;
          current = {
            time: bucket,
            open,
            high: Math.max(open, tr.priceSol),
            low: Math.min(open, tr.priceSol),
            close: tr.priceSol,
            volumeSol: tr.solAmount,
            buys: tr.side === "buy" ? 1 : 0,
            sells: tr.side === "sell" ? 1 : 0,
            solUsd: this.solUsd,
          };
          out.push(current);
        }
      }
      return out.map((c) => ({ ...c }));
    }
    let current: Candle | null = null;
    for (const m of t.minuteCandles) {
      const bucket = Math.floor(m.time / secs) * secs;
      if (current && current.time === bucket) {
        current.high = Math.max(current.high, m.high);
        current.low = Math.min(current.low, m.low);
        current.close = m.close;
        current.volumeSol += m.volumeSol;
        current.buys += m.buys;
        current.sells += m.sells;
        current.solUsd = m.solUsd;
      } else {
        current = { ...m, time: bucket };
        out.push(current);
      }
    }
    return out.map((c) => ({ ...c }));
  }

  // -------------------------------------------------------------------------
  // Pruning
  // -------------------------------------------------------------------------

  private pinned(): Set<string> {
    const pins = new Set<string>();
    for (const key of this.subs.keys()) {
      if (key.startsWith("token:")) pins.add(key.slice(6));
      else if (key.startsWith("trades:")) pins.add(key.slice(7));
      else if (key.startsWith("candles:")) pins.add(key.split(":")[1] ?? "");
    }
    for (const u of this.users.values()) for (const [mint, p] of u.positions) if (p.holding > 0) pins.add(mint);
    for (const o of this.orders.values()) {
      if (o.order.mint && (o.order.status === "armed" || o.order.status === "stale" || o.order.status === "submitted")) {
        pins.add(o.order.mint);
      }
    }
    return pins;
  }

  private prune(now: number, silent: boolean): void {
    const pins = this.pinned();
    const byColumn: Record<PulseColumnId, SimToken[]> = { new: [], final: [], migrated: [] };
    for (const t of this.tokens.values()) byColumn[this.columnFor(t)].push(t);
    const drop = (t: SimToken) => {
      if (pins.has(t.mint)) return;
      this.tokens.delete(t.mint);
      if (!silent) this.pulseRemovals[t.column].push(t.mint);
    };
    byColumn.new.sort((a, b) => b.createdAt - a.createdAt);
    byColumn.new.forEach((t, i) => {
      const stale = now - t.lastTradeAt > 6 * 60_000 && now - t.createdAt > 15 * 60_000;
      if (i >= MAX_NEW || stale) drop(t);
    });
    byColumn.final.sort((a, b) => curveProgress(b.curve) - curveProgress(a.curve));
    byColumn.final.forEach((t, i) => {
      if (i >= MAX_FINAL) drop(t);
    });
    byColumn.migrated.sort((a, b) => (b.migratedAt ?? 0) - (a.migratedAt ?? 0));
    byColumn.migrated.forEach((t, i) => {
      if (i >= MAX_MIGRATED) drop(t);
    });
  }

  // -------------------------------------------------------------------------
  // Users, wallets, positions
  // -------------------------------------------------------------------------

  ensureUserWallet(address: string, sol: number): void {
    if (this.users.has(address)) return;
    this.users.set(address, {
      address,
      sol,
      positions: new Map(),
      history: [],
      activity: [],
      dirty: true,
      pendingActivity: [],
      changedPositions: new Set(),
    });
  }

  isUserWallet(address: string): boolean {
    return this.users.has(address);
  }

  userSol(address: string): number {
    return this.users.get(address)?.sol ?? 0;
  }

  /** Deposit (positive) or withdrawal (negative) on a trading wallet. */
  transferUser(address: string, sol: number, signature: string): boolean {
    const u = this.users.get(address);
    if (!u) return false;
    if (sol < 0 && u.sol + sol < 0) return false;
    u.sol += sol;
    const item: ActivityItem = {
      id: `act-${signature.slice(0, 10)}`,
      kind: sol >= 0 ? "deposit" : "withdraw",
      mint: null,
      symbol: null,
      solAmount: Math.abs(sol),
      tokenAmount: null,
      marketCapUsd: null,
      ts: Date.now(),
      signature,
    };
    u.activity.unshift(item);
    u.pendingActivity.push(item);
    u.dirty = true;
    return true;
  }

  private toPosition(p: UserPosition): Position {
    const t = this.tokens.get(p.mint);
    const price = t ? this.priceOf(t) : p.lastPriceSol;
    const value = p.holding * price;
    return {
      mint: p.mint,
      symbol: p.symbol,
      name: p.name,
      imageUri: p.imageUri,
      launchpad: p.launchpad,
      boughtSol: p.boughtSol,
      soldSol: p.soldSol,
      boughtTokens: p.boughtTok,
      soldTokens: p.soldTok,
      holdingTokens: p.holding,
      avgEntryPriceSol: p.boughtTok > 0 ? p.boughtSol / p.boughtTok : 0,
      avgExitPriceSol: p.soldTok > 0 ? p.soldSol / p.soldTok : null,
      costBasisSol: p.costBasis,
      realizedPnlSol: p.realized,
      unrealizedPnlSol: value - p.costBasis,
      valueSol: value,
      feesSol: p.fees,
      openedAt: p.openedAt,
      lastTradeAt: p.lastTradeAt,
      closed: p.holding <= 1e-6,
    };
  }

  getWalletStatus(address: string): WalletStatus {
    const u = this.users.get(address);
    if (!u) {
      return this.externalWallet(address);
    }
    const positions = [...u.positions.values()].map((p) => this.toPosition(p));
    return {
      address,
      solBalance: u.sol,
      reservedSol: this.reservedFor(address),
      nonceSlots: { used: this.nonceUsed(address), total: NONCE_SLOTS },
      positions: [...positions, ...u.history].sort((a, b) => b.lastTradeAt - a.lastTradeAt),
      activity: u.activity.slice(0, 200),
    };
  }

  private externalWallet(address: string): WalletStatus {
    const positions: Position[] = [];
    const activity: ActivityItem[] = [];
    for (const t of this.tokens.values()) {
      const h = t.holders.get(address);
      if (!h) continue;
      const price = this.priceOf(t);
      const boughtTok = h.boughtSol > 0 ? h.bal + (h.soldSol > 0 ? h.soldSol / price : 0) : h.bal;
      positions.push({
        mint: t.mint,
        symbol: t.symbol,
        name: t.name,
        imageUri: null,
        launchpad: t.launchpad,
        boughtSol: h.boughtSol,
        soldSol: h.soldSol,
        boughtTokens: boughtTok,
        soldTokens: Math.max(0, boughtTok - h.bal),
        holdingTokens: h.bal,
        avgEntryPriceSol: boughtTok > 0 ? h.boughtSol / boughtTok : 0,
        avgExitPriceSol: null,
        costBasisSol: h.boughtSol * (boughtTok > 0 ? h.bal / boughtTok : 0),
        realizedPnlSol: h.soldSol - h.boughtSol * (boughtTok > 0 ? 1 - h.bal / boughtTok : 0),
        unrealizedPnlSol: h.bal * price - h.boughtSol * (boughtTok > 0 ? h.bal / boughtTok : 0),
        valueSol: h.bal * price,
        feesSol: 0,
        openedAt: h.firstBuyAt ?? t.createdAt,
        lastTradeAt: t.lastTradeAt,
        closed: h.bal <= 1e-6,
      });
      for (const tr of t.trades) {
        if (tr.maker !== address) continue;
        activity.push({
          id: tr.id,
          kind: tr.side,
          mint: t.mint,
          symbol: t.symbol,
          solAmount: tr.solAmount,
          tokenAmount: tr.tokenAmount,
          marketCapUsd: tr.marketCapUsd,
          ts: tr.ts,
          signature: tr.signature,
        });
      }
    }
    activity.sort((a, b) => b.ts - a.ts);
    const h = hashString(address);
    return {
      address,
      solBalance: 0.5 + (h % 4000) / 100,
      reservedSol: 0,
      nonceSlots: { used: 0, total: 0 },
      positions,
      activity: activity.slice(0, 100),
    };
  }

  quotePrice(mint: string): number | null {
    const t = this.tokens.get(mint);
    return t ? this.priceOf(t) : null;
  }

  tokenSymbol(mint: string): string | null {
    return this.tokens.get(mint)?.symbol ?? null;
  }

  executeUserSwap(p: UserSwapParams): UserSwapResult {
    const t = this.tokens.get(p.mint);
    const u = this.users.get(p.wallet);
    if (!t) return { ok: false, error: "Token is no longer in the live set" };
    if (!u) return { ok: false, error: "Unknown trading wallet" };
    if (t.migratedAt === null && t.curve.complete) {
      return { ok: false, error: "Curve complete: migration in progress. Retry in a few seconds." };
    }
    const now = Date.now();
    const extra = p.priorityFeeSol + p.tipSol + BASE_FEE_SOL;
    const slot = this.slotAt(now);
    let pos = u.positions.get(p.mint);
    if (p.side === "buy") {
      const sol = p.solAmount ?? 0;
      if (sol <= 0) return { ok: false, error: "Amount must be greater than zero" };
      if (u.sol < sol + extra) {
        return { ok: false, error: `Insufficient SOL: need ${(sol + extra).toFixed(4)}, have ${u.sol.toFixed(4)}` };
      }
      const q = t.pool ? quotePoolBuy(t.pool, sol) : quoteCurveBuy(t.curve, sol);
      if (q.tokens <= 0) return { ok: false, error: "Nothing left to buy on the curve" };
      const exec = q.sol / q.tokens;
      const moved = (exec / p.expectedPriceSol - 1) * 100;
      if (p.expectedPriceSol > 0 && moved > p.slippagePct) {
        return { ok: false, error: `Slippage exceeded: price moved ${moved.toFixed(1)}% (max ${p.slippagePct}%)` };
      }
      if (t.pool) applyPoolBuy(t.pool, q);
      else applyCurveBuy(t.curve, q);
      const h = this.holding(t, p.wallet);
      if (h.firstBuyAt === null) {
        h.firstBuyAt = now;
        h.firstSlot = slot;
        h.tags |= this.tagsFor(t, p.wallet, slot) & ~(TAG_SNIPER | TAG_BUNDLER);
      }
      h.bal += q.tokens;
      h.boughtSol += q.sol;
      h.buys++;
      this.trackHolder(t, p.wallet, h);
      u.sol -= q.sol + extra;
      if (!pos) {
        pos = {
          mint: t.mint,
          symbol: t.symbol,
          name: t.name,
          imageUri: null,
          launchpad: t.launchpad,
          boughtSol: 0,
          soldSol: 0,
          boughtTok: 0,
          soldTok: 0,
          holding: 0,
          costBasis: 0,
          realized: 0,
          fees: 0,
          openedAt: now,
          lastTradeAt: now,
          lastPriceSol: this.priceOf(t),
        };
        u.positions.set(t.mint, pos);
      }
      pos.boughtSol += q.sol + extra;
      pos.boughtTok += q.tokens;
      pos.holding += q.tokens;
      pos.costBasis += q.sol + extra;
      pos.fees += extra;
      pos.lastTradeAt = now;
      const trade = this.recordTrade(t, "buy", p.wallet, q, now, slot, h.tags, p.signature);
      pos.lastPriceSol = trade.priceSol;
      this.pushUserActivity(u, t, "buy", q.sol, q.tokens, trade.marketCapUsd, p.signature, now);
      if (t.curve.complete && t.completeAt === null && t.migratedAt === null) {
        t.completeAt = now;
        t.migrateAt = now + this.rng.range(1500, 4500);
      }
      return {
        ok: true,
        slot,
        fill: { side: "buy", solAmount: q.sol, tokenAmount: q.tokens, priceSol: exec, venueFeeSol: q.feeSol },
      };
    }
    const holding = pos?.holding ?? 0;
    if (!pos || holding <= 1e-6) return { ok: false, error: "No balance to sell" };
    const amount = Math.min(holding, p.tokenAmount ?? (holding * (p.pct ?? 100)) / 100);
    if (amount <= 0) return { ok: false, error: "Amount must be greater than zero" };
    const q = t.pool ? quotePoolSell(t.pool, amount) : quoteCurveSell(t.curve, amount);
    const exec = q.sol / q.tokens;
    const moved = (1 - exec / p.expectedPriceSol) * 100;
    if (p.expectedPriceSol > 0 && moved > p.slippagePct) {
      return { ok: false, error: `Slippage exceeded: price moved ${moved.toFixed(1)}% (max ${p.slippagePct}%)` };
    }
    if (u.sol < extra) return { ok: false, error: "Insufficient SOL for network fees" };
    if (t.pool) applyPoolSell(t.pool, q);
    else applyCurveSell(t.curve, q);
    const h = this.holding(t, p.wallet);
    h.bal = Math.max(0, h.bal - amount);
    h.soldSol += q.sol;
    h.sells++;
    this.trackHolder(t, p.wallet, h);
    const avgCost = pos.costBasis / holding;
    const costRemoved = avgCost * amount;
    const proceeds = q.sol - extra;
    pos.realized += proceeds - costRemoved;
    pos.costBasis = Math.max(0, pos.costBasis - costRemoved);
    pos.holding = Math.max(0, holding - amount);
    if (pos.holding < 1e-6) {
      pos.holding = 0;
      pos.costBasis = 0;
    }
    pos.soldSol += proceeds;
    pos.soldTok += amount;
    pos.fees += extra;
    pos.lastTradeAt = now;
    u.sol += proceeds;
    const trade = this.recordTrade(t, "sell", p.wallet, q, now, slot, h.tags, p.signature);
    pos.lastPriceSol = trade.priceSol;
    this.pushUserActivity(u, t, "sell", q.sol, amount, trade.marketCapUsd, p.signature, now);
    return {
      ok: true,
      slot,
      fill: { side: "sell", solAmount: q.sol, tokenAmount: amount, priceSol: exec, venueFeeSol: q.feeSol },
    };
  }

  private pushUserActivity(
    u: UserWallet,
    t: SimToken,
    kind: "buy" | "sell",
    sol: number,
    tokens: number,
    mc: number,
    signature: string,
    ts: number,
  ): void {
    const item: ActivityItem = {
      id: `act-${signature.slice(0, 12)}`,
      kind,
      mint: t.mint,
      symbol: t.symbol,
      solAmount: sol,
      tokenAmount: tokens,
      marketCapUsd: mc,
      ts,
      signature,
    };
    u.activity.unshift(item);
    if (u.activity.length > 400) u.activity.length = 400;
    u.pendingActivity.push(item);
    u.changedPositions.add(t.mint);
    u.dirty = true;
  }

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  private nonceUsed(wallet: string): number {
    let used = 0;
    for (const o of this.orders.values()) {
      if (o.wallet !== wallet) continue;
      if (o.order.status === "armed" || o.order.status === "stale" || o.order.status === "submitted") {
        used += o.order.nonceSlots;
      }
    }
    return used;
  }

  private reservedFor(wallet: string): number {
    let sum = 0;
    for (const o of this.orders.values()) {
      if (o.wallet !== wallet) continue;
      if (o.order.status === "armed" || o.order.status === "stale" || o.order.status === "submitted") {
        sum += o.order.reservedSol;
      }
    }
    return sum;
  }

  freeNonceSlots(wallet: string): number {
    return NONCE_SLOTS - this.nonceUsed(wallet);
  }

  addOrder(p: NewOrderParams): ArmedOrder | null {
    const slots = p.nonceSlots ?? 1;
    if (slots > 0 && this.freeNonceSlots(p.wallet) < slots) return null;
    const now = Date.now();
    const tabClosed = p.kind !== "copy_buy" && p.kind !== "dev_snipe";
    const reserved =
      p.side === "buy" && p.size.kind === "sol" ? p.size.sol + p.priorityFeeSol + p.tipSol + 0.002 : p.priorityFeeSol + p.tipSol + 0.001;
    const order: Order = {
      id: `ord-${++this.orderSeq}`,
      mint: p.mint,
      symbol: p.symbol,
      kind: p.kind,
      side: p.side,
      trigger: p.trigger,
      size: p.size,
      status: "armed",
      statusReason: null,
      runsWithTabClosed: tabClosed,
      needsBrowserReason: tabClosed
        ? null
        : "The mint isn't known in advance, so this browser must build and sign the buy when the leader trades.",
      reservedSol: reserved,
      nonceSlots: slots,
      ocoGroupId: p.ocoGroupId ?? null,
      landing: p.landing,
      variants: tabClosed ? 6 : 0,
      armedPriceSol: p.mint ? this.quotePrice(p.mint) : null,
      createdAt: now,
      updatedAt: now,
      filledAt: null,
      signature: null,
      fill: null,
    };
    const armed: ArmedOrder = {
      order,
      wallet: p.wallet,
      slippagePct: p.slippagePct,
      priorityFeeSol: p.priorityFeeSol,
      tipSol: p.tipSol,
    };
    this.orders.set(order.id, armed);
    this.emitOrder(armed);
    const u = this.users.get(p.wallet);
    if (u) u.dirty = true;
    return armed;
  }

  getOrder(id: string): Order | null {
    const o = this.orders.get(id);
    return o ? { ...o.order } : null;
  }

  private emitOrder(o: ArmedOrder): void {
    this.emit("orders", { upsert: [{ ...o.order }], remove: [] });
  }

  private setStatus(o: ArmedOrder, status: Order["status"], reason: string | null): void {
    o.order = { ...o.order, status, statusReason: reason, updatedAt: Date.now() };
    this.emitOrder(o);
    const u = this.users.get(o.wallet);
    if (u) u.dirty = true;
  }

  markStale(id: string, reason: string): void {
    const o = this.orders.get(id);
    if (o && o.order.status === "armed") this.setStatus(o, "stale", reason);
  }

  cancelOrder(id: string): boolean {
    const o = this.orders.get(id);
    if (!o) return false;
    if (o.order.status !== "armed" && o.order.status !== "stale" && o.order.status !== "submitted") return false;
    this.setStatus(o, "cancelled", "Cancelled: the stored nonce-advance transaction was fired.");
    // OCO legs share one durable nonce: advancing it kills the sibling too.
    if (o.order.ocoGroupId) {
      for (const sib of this.orders.values()) {
        if (sib === o || sib.order.ocoGroupId !== o.order.ocoGroupId) continue;
        if (sib.order.status === "armed" || sib.order.status === "stale" || sib.order.status === "submitted") {
          this.setStatus(sib, "cancelled", "Cancelled with its OCO sibling: the shared durable nonce was advanced.");
        }
      }
    }
    return true;
  }

  rearmOrder(id: string): Order | null {
    const o = this.orders.get(id);
    if (!o) return null;
    if (o.order.status !== "stale" && o.order.status !== "failed") return { ...o.order };
    o.order = {
      ...o.order,
      status: "armed",
      statusReason: null,
      updatedAt: Date.now(),
      armedPriceSol: o.order.mint ? this.quotePrice(o.order.mint) : null,
    };
    this.emitOrder(o);
    return { ...o.order };
  }

  cancelAll(): number {
    let n = 0;
    for (const o of this.orders.values()) {
      if (o.order.status === "armed" || o.order.status === "stale" || o.order.status === "submitted") {
        this.setStatus(o, "cancelled", "Panic: all pre-signed cancels fired.");
        n++;
      }
    }
    return n;
  }

  private checkOrders(t: SimToken): void {
    if (this.orders.size === 0) return;
    const price = this.priceOf(t);
    const mc = price * t.supply * this.solUsd;
    for (const o of this.orders.values()) {
      const order = o.order;
      if (order.mint !== t.mint || order.status !== "armed") continue;
      const trig = order.trigger;
      if (trig.value === null || trig.direction === null) continue;
      const v = trig.metric === "mc" ? mc : trig.metric === "price" ? price : null;
      if (v === null) continue;
      const hit = trig.direction === "above" ? v >= trig.value : v <= trig.value;
      if (hit) this.fireOrder(o);
    }
  }

  private fireOrder(o: ArmedOrder): void {
    this.setStatus(o, "submitted", "Trigger hit; submitting the variant just below the live quote via Jito bundle-only.");
    setTimeout(
      () => {
        if (o.order.status !== "submitted") return;
        const mint = o.order.mint;
        if (!mint) return;
        const expected = this.quotePrice(mint) ?? 0;
        if (this.rng.chance(0.05)) {
          this.setStatus(o, "failed", "Price moved past the min-out grid; the pre-signed cancel was fired.");
          return;
        }
        const sig = fakeSignature(this.rng);
        const res = this.executeUserSwap({
          wallet: o.wallet,
          mint,
          side: o.order.side,
          solAmount: o.order.size.kind === "sol" ? o.order.size.sol : undefined,
          pct: o.order.size.kind === "pct" ? o.order.size.pct : undefined,
          expectedPriceSol: expected,
          slippagePct: Math.max(o.slippagePct, 50),
          priorityFeeSol: o.priorityFeeSol,
          tipSol: o.tipSol,
          signature: sig,
        });
        if (!res.ok) {
          this.setStatus(o, "failed", res.error);
          return;
        }
        o.order = {
          ...o.order,
          status: "filled",
          statusReason: null,
          updatedAt: Date.now(),
          filledAt: Date.now(),
          signature: sig,
          fill: { solAmount: res.fill.solAmount, tokenAmount: res.fill.tokenAmount, priceSol: res.fill.priceSol },
        };
        this.emitOrder(o);
        if (o.order.ocoGroupId) {
          for (const sib of this.orders.values()) {
            if (sib === o || sib.order.ocoGroupId !== o.order.ocoGroupId) continue;
            if (sib.order.status === "armed" || sib.order.status === "stale") {
              this.setStatus(sib, "cancelled", "Sibling filled; the shared durable nonce advanced, so this leg can no longer land.");
            }
          }
        }
      },
      300 + this.rng.next() * 500,
    );
  }

  private onMigrated(t: SimToken): void {
    for (const o of this.orders.values()) {
      if (o.order.mint !== t.mint || o.order.status !== "armed") continue;
      if (o.order.kind === "migration_buy" || o.order.kind === "migration_sell") this.fireOrder(o);
      else if (
        o.order.kind === "limit_buy" ||
        o.order.kind === "limit_sell" ||
        o.order.kind === "take_profit" ||
        o.order.kind === "stop_loss"
      ) {
        this.setStatus(o, "stale", "Migrated to the pool: pre-signed curve transactions can't land. Re-arm to sign pool transactions.");
      }
    }
  }

  private randomStaleOrders(now: number): void {
    for (const o of this.orders.values()) {
      if (o.order.status !== "armed" || !o.order.runsWithTabClosed) continue;
      if (now - o.order.updatedAt < 120_000) continue;
      if (this.rng.chance(0.02)) this.setStatus(o, "stale", this.rng.pick(STALE_REASONS));
    }
  }

  // -------------------------------------------------------------------------
  // Trackers, social, search, PnL
  // -------------------------------------------------------------------------

  setTrackedWallets(addresses: string[]): void {
    this.tracked = new Set(addresses);
    for (const a of addresses) {
      if (!this.walletKind.has(a) && isBase58Address(a)) {
        this.wallets.push({ address: a, kind: "pro", weight: 1 });
        this.walletKind.set(a, "pro");
      }
    }
    this.rebuildPoolWeights();
  }

  setTrackedHandles(handles: string[]): void {
    this.trackedHandles = handles;
  }

  private generatePost(ts: number): SocialPost {
    const rng = this.rng;
    const useTracked = this.trackedHandles.length > 0 && rng.chance(0.7);
    let handle: string;
    let displayName: string;
    let verified: boolean;
    if (useTracked) {
      handle = rng.pick(this.trackedHandles);
      displayName = handle.replace(/_/g, " ");
      verified = rng.chance(0.4);
    } else {
      const h = rng.pick(SIM_HANDLES);
      [handle, displayName, verified] = h;
    }
    const other = rng.pick(SIM_HANDLES)[0];
    const live = [...this.tokens.values()].filter((t) => t.dyn.rate > 0.2);
    live.sort((a, b) => b.dyn.rate - a.dyn.rate);
    const t = live.length > 0 ? live[Math.floor(rng.next() * Math.min(12, live.length))] : undefined;
    const kind = rng.weighted<SocialPost["kind"]>([
      ["tweet", 58],
      ["reply", 10],
      ["quote", 8],
      ["retweet", 8],
      ["profile_update", 8],
      ["follow", 8],
    ]);
    const sym = t ? `$${t.symbol}` : "$SOL";
    let text: string;
    switch (kind) {
      case "tweet":
        text = t
          ? rng.pick([
              `${sym} looking strong here. ${t.mint}`,
              `aped ${sym}, dev seems to be cooking`,
              `${sym} holders growing fast, chart is clean`,
              `${sym} about to graduate`,
              `careful with ${sym}, lots of bundles in the first slot`,
              `${sym} ${t.mint.slice(0, 6)}…${t.mint.slice(-4)} on watch`,
            ])
          : rng.pick(["gm. lots of migrations today", "volume is back", "quiet day on the curves"]);
        break;
      case "reply":
        text = `@${other} agreed, ${sym} has legs`;
        break;
      case "quote":
        text = `this. ${sym}`;
        break;
      case "retweet":
        text = `RT @${other}: ${sym} is moving`;
        break;
      case "profile_update":
        text = t ? `changed display name to "${displayName} | ${sym}"` : `updated bio: "on-chain since day one"`;
        break;
      case "follow":
        text = `followed @${other}`;
        break;
    }
    const post: SocialPost = {
      id: `post-${ts}-${rng.int(0, 1e6)}`,
      handle,
      displayName,
      verified,
      kind,
      text,
      ts,
      mentions: t && kind !== "follow" ? [this.tokenRef(t)] : [],
    };
    this.posts.unshift(post);
    if (this.posts.length > 80) this.posts.length = 80;
    return post;
  }

  search(query: string, limit: number): SearchResults {
    const q = query.trim().toLowerCase();
    if (!q) return { tokens: [], wallets: [] };
    const tokens: { t: SimToken; score: number }[] = [];
    for (const t of this.tokens.values()) {
      let score = 0;
      const sym = t.symbol.toLowerCase();
      const name = t.name.toLowerCase();
      const mint = t.mint.toLowerCase();
      if (mint === q) score = 100;
      else if (sym === q || sym === q.replace(/^\$/, "")) score = 80;
      else if (sym.startsWith(q)) score = 60;
      else if (name.startsWith(q)) score = 50;
      else if (q.length >= 4 && mint.startsWith(q)) score = 45;
      else if (name.includes(q) || sym.includes(q)) score = 30;
      if (score > 0) tokens.push({ t, score: score + Math.min(10, t.volumeSol / 50) });
    }
    tokens.sort((a, b) => b.score - a.score);
    const wallets: WalletSearchHit[] = [];
    if (q.length >= 3) {
      const seen = new Set<string>();
      const consider = (address: string, label: string | null, tags: WalletTag[]) => {
        if (seen.has(address) || wallets.length >= 6) return;
        if (!address.toLowerCase().startsWith(q) && !label?.toLowerCase().includes(q)) return;
        seen.add(address);
        let holdings = 0;
        for (const t of this.tokens.values()) if ((t.holders.get(address)?.bal ?? 0) > 0) holdings++;
        wallets.push({ address, label, tags, holdings });
      };
      for (const w of this.defaultTracked) consider(w.address, `${w.emoji} ${w.name}`, ["tracked"]);
      for (const u of this.users.keys()) consider(u, "Your trading wallet", ["you"]);
      for (const w of this.wallets) {
        if (wallets.length >= 6) break;
        consider(w.address, null, w.kind === "pro" ? ["pro"] : w.kind === "whale" ? ["whale"] : w.kind === "kol" ? ["kol"] : []);
      }
      if (wallets.length === 0 && isBase58Address(query.trim())) {
        wallets.push({ address: query.trim(), label: null, tags: [], holdings: 0 });
      }
    }
    return {
      tokens: tokens.slice(0, limit).map(({ t }) => (t.summary && !t.dirty ? t.summary : this.buildSummary(t))),
      wallets,
    };
  }

  pnlHistory(address: string, range: "7d" | "30d" | "max"): PnlPoint[] {
    const status = this.getWalletStatus(address);
    let total = 0;
    for (const p of status.positions) total += p.realizedPnlSol + (p.closed ? 0 : p.unrealizedPnlSol);
    const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
    const rng = new Rng(hashString(address));
    const raw: number[] = [];
    let v = 0;
    for (let i = 0; i < 90; i++) {
      v += rng.normal() * 0.35 + 0.02;
      raw.push(v);
    }
    const last = raw[raw.length - 1] ?? 0;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const points: PnlPoint[] = raw.map((val, i) => ({
      t: startOfDay.getTime() - (89 - i) * 86_400_000,
      pnlSol: val - last + total,
    }));
    return points.slice(-days - 1);
  }
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
