/**
 * MarketState - the single writer of derived market data. Applies decoded events in order, with no RPC
 * on the hot path (pool/mint/curve bootstraps are requested asynchronously and merged when they land).
 *
 * Ordering: every event gets a key (slot, tx index | arrival sequence, event index). Reserves, price
 * and creator only move forward in key order; a late event still updates volume, holders, the tape
 * and candles (as a correction).
 *
 * Forks: a signature seen again in a different slot is parked until the first slot is reported dead;
 * then the first copy is rolled back and the parked copy applied. Dead slots roll back trades
 * (holders, windows, candles, reserves) and emit corrections.
 *
 * Every mutation records what changed in `changes`; the gateway drains it at its own cadence.
 */
import type { Address } from "@solana/kit";
import {
  type AmmCreatePoolEvent,
  type AmmSwapEvent,
  coinCreatorVaultAuthorityPda,
  creatorVaultPda,
  DEFAULT_PUBKEY,
  type DecodedEvent,
  INCINERATOR,
  type OnchainTokenMetadata,
  PUMP_TOKEN_DECIMALS,
  type PumpCompleteEvent,
  type PumpCreateEvent,
  type PumpMigrationEvent,
  type PumpTradeEvent,
} from "@zerofee/core";
import type { Candle, Timeframe, TokenSocials, TokenSummary, Trade, TradeContext, TradeTag } from "@zerofee/protocol";
import { AccountResolver, type CurveResolved, type MintResolved, type PoolInfo } from "../accounts/resolver";
import type { IngestTx } from "../ingest/types";
import { LruMap } from "../util/lru";
import { RateCounter, SampleRing } from "../util/stats";
import { CandleBook, type CandleTrade, type CandleUpdate, cmpKey, type OrderKey } from "./candles";
import { HolderBook } from "./holders";
import { knownQuoteDecimals, normalizeQuoteMint, quoteSolRate, ui } from "./quote";
import {
  buildTradeContext,
  type CurveReserves,
  knownQuoteTokenProgram,
  newTokenRecord,
  type PoolReserves,
  priceQuote,
  summarize,
  type TokenRecord,
  type TradeEntry,
} from "./token";

export interface MarketConfig {
  sniperSlots: number;
  bundleMinBuyers: number;
  proTraderWallets: readonly string[];
  /** Trades kept per token in memory (tape snapshot + rollback). */
  recentTrades?: number;
}

/** What MarketState needs from the account resolver. */
export interface ResolverLike {
  readonly pools: Map<string, PoolInfo>;
  learnPool(partial: Partial<PoolInfo> & { pool: string; baseMint: string; quoteMint: string }): PoolInfo;
  requestPool(pool: string): void;
  requestMint(mint: string): void;
  requestCurve(mint: string): void;
}

export interface StorageSink {
  trade(t: Trade, evIndex: number): void;
  deleteTrades(ids: string[]): void;
  candle(mint: string, tf: Timeframe, c: Candle): void;
  token(rec: TokenRecord, summary: TokenSummary): void;
}

export interface MarketDeps {
  resolver: ResolverLike;
  solUsd(): number | null;
  requestMetadata?(mint: string, uri: string): void;
  storage?: StorageSink;
  now?(): number;
}

/** A launch / migration / trade for the debug feed. */
export interface FeedItem {
  kind: "launch" | "trade" | "complete" | "migration";
  mint: string;
  symbol: string;
  name: string;
  signature: string;
  slot: number;
  blockTime: number;
  receivedAt: number;
  latencyMs: number;
  side?: "buy" | "sell";
  amountSol?: number;
  venue?: "pump" | "pumpswap";
}

export class ChangeLog {
  readonly tokens = new Set<string>();
  readonly tradeCtx = new Set<string>();
  readonly trades = new Map<string, Trade[]>();
  readonly tradeCorrections = new Map<string, { remove: string[]; upsert: Trade[] }>();
  /** `${mint}|${tf}` -> bucket t -> candle */
  readonly candles = new Map<string, Map<number, Candle>>();
  readonly candleCorrections = new Map<string, Map<number, Candle>>();
  readonly feed: FeedItem[] = [];

  pushTrade(t: Trade): void {
    const list = this.trades.get(t.mint);
    if (list) list.push(t);
    else this.trades.set(t.mint, [t]);
  }

  correction(mint: string): { remove: string[]; upsert: Trade[] } {
    let c = this.tradeCorrections.get(mint);
    if (!c) {
      c = { remove: [], upsert: [] };
      this.tradeCorrections.set(mint, c);
    }
    return c;
  }

  candle(u: CandleUpdate): void {
    const map = u.late ? this.candleCorrections : this.candles;
    const k = `${u.mint}|${u.tf}`;
    let m = map.get(k);
    if (!m) {
      m = new Map();
      map.set(k, m);
    }
    m.set(u.candle.t, u.candle);
  }
}

interface EvCtx {
  tx: IngestTx;
  key: OrderKey;
  evIndex: number;
  txBuyers: Map<string, Set<string>>;
}

interface PendingPoolEvent {
  ev: AmmSwapEvent;
  ctx: EvCtx;
}

const MAX_PENDING_PER_POOL = 500;
const MAX_PENDING_TOTAL = 50_000;

export class MarketState {
  readonly tokens = new Map<string, TokenRecord>();
  readonly candles = new CandleBook();
  readonly changes = new ChangeLog();
  private readonly seen = new LruMap<string, number>(300_000);
  private readonly forkParked = new Map<string, IngestTx>();
  private readonly slotTxs = new Map<number, { signature: string; mints: Set<string>; creates: string[]; migrations: string[] }[]>();
  private readonly arrivalSeq = new Map<number, number>();
  private readonly pendingPools = new Map<string, PendingPoolEvent[]>();
  private pendingTotal = 0;
  private readonly pros: Set<string>;
  private readonly recentCap: number;
  readonly latency = new SampleRing(50_000);
  readonly launchLatency = new SampleRing(5_000);
  readonly sourceLatency = new SampleRing(50_000);
  readonly tradeRate = new RateCounter(60);
  readonly stats = {
    txs: 0,
    events: 0,
    trades: 0,
    curveTrades: 0,
    poolTrades: 0,
    launches: 0,
    completes: 0,
    migrations: 0,
    poolsCreated: 0,
    duplicates: 0,
    forkParked: 0,
    lateTrades: 0,
    pendingDropped: 0,
    deadSlots: 0,
    rolledBackTrades: 0,
    decodeFailures: 0,
    lastEventAt: null as number | null,
  };

  constructor(
    private readonly cfg: MarketConfig,
    private readonly deps: MarketDeps,
  ) {
    this.pros = new Set(cfg.proTraderWallets);
    this.recentCap = cfg.recentTrades ?? 200;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  get pendingPoolEvents(): number {
    return this.pendingTotal;
  }

  // ---------------------------------------------------------------------------------------------
  // ingest
  // ---------------------------------------------------------------------------------------------

  applyTx(tx: IngestTx): void {
    const prevSlot = this.seen.get(tx.signature);
    if (prevSlot !== undefined) {
      if (prevSlot === tx.slot) this.stats.duplicates++;
      else {
        this.forkParked.set(tx.signature, tx);
        this.stats.forkParked++;
        if (this.forkParked.size > 10_000) this.forkParked.delete(this.forkParked.keys().next().value as string);
      }
      return;
    }
    this.seen.set(tx.signature, tx.slot);
    this.stats.txs++;
    this.stats.lastEventAt = tx.receivedAt;
    if (tx.sourceCreatedAt !== null) this.sourceLatency.add(tx.receivedAt - tx.sourceCreatedAt);

    let seq = tx.txIndex;
    if (seq === null) {
      seq = (this.arrivalSeq.get(tx.slot) ?? 0) + 1;
      this.arrivalSeq.set(tx.slot, seq);
      if (this.arrivalSeq.size > 512) this.arrivalSeq.delete(this.arrivalSeq.keys().next().value as number);
    }
    for (const pm of tx.poolMints) this.deps.resolver.learnPool({ ...pm });

    // distinct buyers per mint in this tx (one tx buying for several wallets = bundle)
    const txBuyers = new Map<string, Set<string>>();
    for (const ev of tx.events) {
      if (ev.kind === "pumpTrade" && ev.isBuy) {
        const s = txBuyers.get(ev.mint) ?? new Set<string>();
        s.add(ev.user);
        txBuyers.set(ev.mint, s);
      }
    }
    const record = { signature: tx.signature, mints: new Set<string>(), creates: [] as string[], migrations: [] as string[] };
    tx.events.forEach((ev, i) => {
      this.stats.events++;
      const mint = this.applyEvent(ev, { tx, key: [tx.slot, seq as number, i], evIndex: i, txBuyers });
      if (mint) record.mints.add(mint);
      if (ev.kind === "pumpCreate") record.creates.push(ev.mint);
      if (ev.kind === "pumpMigrate") record.migrations.push(ev.mint);
    });
    if (tx.tokenBalances) {
      for (const b of tx.tokenBalances) {
        const rec = this.tokens.get(b.mint);
        if (rec?.holders && record.mints.has(b.mint)) rec.holders.setAbsolute(b.owner, b.amount);
      }
    }
    const list = this.slotTxs.get(tx.slot) ?? [];
    list.push(record);
    this.slotTxs.set(tx.slot, list);
    if (this.slotTxs.size > 600) this.slotTxs.delete(Math.min(...this.slotTxs.keys()));
  }

  private applyEvent(ev: DecodedEvent, ctx: EvCtx): string | null {
    switch (ev.kind) {
      case "pumpCreate":
        return this.onCreate(ev, ctx);
      case "pumpTrade":
        return this.onCurveTrade(ev, ctx);
      case "pumpComplete":
        return this.onComplete(ev, ctx);
      case "pumpMigrate":
        return this.onMigrate(ev, ctx);
      case "ammCreatePool":
        return this.onCreatePool(ev, ctx);
      case "ammBuy":
      case "ammSell":
        return this.onPoolTrade(ev, ctx);
    }
  }

  private touch(rec: TokenRecord): void {
    rec.updatedAt = this.now();
    this.changes.tokens.add(rec.mint);
  }

  private getOrCreate(mint: string, init: Partial<TokenRecord> = {}): TokenRecord {
    let rec = this.tokens.get(mint);
    if (!rec) {
      rec = newTokenRecord(mint, this.now(), init);
      this.tokens.set(mint, rec);
    }
    return rec;
  }

  private onCreate(ev: PumpCreateEvent, ctx: EvCtx): string {
    const ts = Number(ev.timestamp) * 1000;
    const quoteMint = normalizeQuoteMint(ev.quoteMint);
    const sol = quoteMint === normalizeQuoteMint(DEFAULT_PUBKEY);
    const rec = this.getOrCreate(ev.mint);
    Object.assign(rec, {
      name: ev.name,
      symbol: ev.symbol,
      uri: ev.uri || null,
      launchpad: "pump",
      quoteMint,
      quoteDecimals: knownQuoteDecimals(quoteMint) ?? rec.quoteDecimals,
      quoteTokenProgram: knownQuoteTokenProgram(quoteMint),
      tokenProgram: ev.tokenProgram,
      decimals: PUMP_TOKEN_DECIMALS,
      supply: ev.tokenTotalSupply > 0n ? ev.tokenTotalSupply : rec.supply,
      createdAt: ts,
      createdSlot: ctx.tx.slot,
      createSignature: ctx.tx.signature,
      createUser: ev.user,
      creatorAtCreate: ev.creator,
      bondingCurve: ev.bondingCurve,
      isMayhem: ev.isMayhemMode,
      isCashback: ev.isCashbackEnabled,
      isHolderReward: ev.isHolderReward,
      creatorFeeBps: ev.creatorFeeBps,
      initialRealTokenReserves: ev.realTokenReserves,
    } satisfies Partial<TokenRecord>);
    if (!rec.creator) this.setCreator(rec, ev.creator, "curve");
    // A trade that arrived before its create (out of order) already set newer reserves: keep them.
    if (!rec.curve || !rec.curveKey || cmpKey(ctx.key, rec.curveKey) >= 0) {
      rec.curve = {
        vToken: ev.virtualTokenReserves,
        vQuote: sol ? ev.virtualSolReserves : ev.virtualQuoteReserves,
        rToken: ev.realTokenReserves,
        rQuote: 0n,
      };
      rec.curveKey = ctx.key;
      rec.curveSlot = ctx.tx.slot;
    }
    if (!rec.holders) {
      rec.holders = new HolderBook(ctx.tx.slot, this.cfg);
      rec.holders.exclude(ev.bondingCurve);
      rec.holders.exclude(INCINERATOR);
    }
    rec.holders.addDev(ev.creator);
    if (ctx.tx.accountKeys) rec.proTraders ??= new Set();
    this.stats.launches++;
    const latency = ctx.tx.receivedAt - ts;
    this.launchLatency.add(latency);
    this.changes.feed.push({
      kind: "launch",
      mint: ev.mint,
      symbol: ev.symbol,
      name: ev.name,
      signature: ctx.tx.signature,
      slot: ctx.tx.slot,
      blockTime: ts,
      receivedAt: ctx.tx.receivedAt,
      latencyMs: latency,
      venue: "pump",
    });
    if (rec.uri && rec.metadataState === "none") {
      rec.metadataState = "requested";
      this.deps.requestMetadata?.(rec.mint, rec.uri);
    }
    this.touch(rec);
    this.changes.tradeCtx.add(rec.mint);
    this.persist(rec, true);
    return rec.mint;
  }

  /** Live creator changed: update dev wallets and derive the matching vault PDA off the hot path. */
  private setCreator(rec: TokenRecord, creator: string, venue: "curve" | "pool"): void {
    if (!creator || creator === DEFAULT_PUBKEY) return;
    const changed = rec.creator !== creator;
    rec.creator = creator;
    rec.holders?.addDev(creator);
    if (venue === "curve" && (changed || !rec.creatorVault)) {
      void creatorVaultPda(creator as Address).then((v) => {
        if (rec.creator === creator) {
          rec.creatorVault = v;
          this.changes.tradeCtx.add(rec.mint);
        }
      });
    }
    if (venue === "pool" && (changed || !rec.coinCreatorVaultAuthority)) {
      void coinCreatorVaultAuthorityPda(creator as Address).then((v) => {
        if (rec.creator === creator) {
          rec.coinCreatorVaultAuthority = v;
          this.changes.tradeCtx.add(rec.mint);
        }
      });
    }
  }

  private requestBootstrap(rec: TokenRecord, curve: boolean): void {
    if (rec.bootstrapRequested) return;
    rec.bootstrapRequested = true;
    this.deps.resolver.requestMint(rec.mint);
    if (curve) this.deps.resolver.requestCurve(rec.mint);
  }

  private onCurveTrade(ev: PumpTradeEvent, ctx: EvCtx): string {
    const ts = Number(ev.timestamp) * 1000;
    const useQuote = ev.quote !== null && normalizeQuoteMint(ev.quote.mint) !== normalizeQuoteMint(DEFAULT_PUBKEY);
    const quoteMint = useQuote && ev.quote ? normalizeQuoteMint(ev.quote.mint) : normalizeQuoteMint(DEFAULT_PUBKEY);
    const quoteAmount = useQuote && ev.quote ? ev.quote.amount : ev.quoteAmount;
    const after: CurveReserves = {
      vToken: ev.virtualTokenReserves,
      vQuote: useQuote && ev.quote ? ev.quote.virtualReserves : ev.virtualQuoteReserves,
      rToken: ev.realTokenReserves,
      rQuote: useQuote && ev.quote ? ev.quote.realReserves : ev.realQuoteReserves,
    };
    const rec = this.getOrCreate(ev.mint, {
      launchpad: "pump",
      isMayhem: ev.mayhemMode,
      supply: ev.mayhemMode ? 2_000_000_000_000_000n : 1_000_000_000_000_000n,
    });
    if (rec.quoteMint !== quoteMint) {
      rec.quoteMint = quoteMint;
      rec.quoteDecimals = knownQuoteDecimals(quoteMint) ?? rec.quoteDecimals;
      rec.quoteTokenProgram = knownQuoteTokenProgram(quoteMint);
      if (knownQuoteDecimals(quoteMint) === null) this.deps.resolver.requestMint(quoteMint);
    }
    if (ev.mayhemMode && !rec.isMayhem) {
      rec.isMayhem = true;
      if (rec.createdAt === null) rec.supply = 2_000_000_000_000_000n;
    }
    if (rec.createdAt === null) this.requestBootstrap(rec, true);
    const latest = !rec.curveKey || cmpKey(ctx.key, rec.curveKey) >= 0;
    if (latest) {
      rec.curve = after;
      rec.curveKey = ctx.key;
      rec.curveSlot = ctx.tx.slot;
      this.setCreator(rec, ev.creator, "curve");
      if (after.rToken === 0n && !rec.complete) {
        rec.complete = true;
        rec.completedAt = ts;
      }
      this.changes.tradeCtx.add(rec.mint);
    }
    this.stats.curveTrades++;
    this.recordTrade(rec, ctx, {
      venue: "pump",
      isBuy: ev.isBuy,
      trader: ev.user,
      quoteAmount,
      tokenAmount: ev.tokenAmount,
      tsMs: ts,
      priceQuote: after.vToken > 0n ? ui(after.vQuote, rec.quoteDecimals) / ui(after.vToken, rec.decimals) : 0,
      curveAfter: after,
      poolAfter: null,
      latest,
    });
    return rec.mint;
  }

  private onComplete(ev: PumpCompleteEvent, ctx: EvCtx): string {
    const rec = this.getOrCreate(ev.mint);
    rec.bondingCurve ??= ev.bondingCurve;
    if (!rec.complete) {
      rec.complete = true;
      rec.completedAt = Number(ev.timestamp) * 1000;
      this.stats.completes++;
      this.changes.feed.push(this.feedItem("complete", rec, ctx, rec.completedAt));
    }
    this.touch(rec);
    this.persist(rec, true);
    return rec.mint;
  }

  private onMigrate(ev: PumpMigrationEvent, ctx: EvCtx): string {
    const ts = Number(ev.timestamp) * 1000;
    const rec = this.getOrCreate(ev.mint);
    const quoteMint = normalizeQuoteMint(ev.quoteMint);
    rec.complete = true;
    rec.completedAt ??= ts;
    rec.migrated = true;
    rec.migratedAt = ts;
    rec.pool = ev.pool;
    rec.holders?.exclude(ev.pool);
    if (!rec.poolState || !rec.poolKey || cmpKey(ctx.key, rec.poolKey) >= 0) {
      rec.poolState = { base: ev.mintAmount, quoteVault: ev.solAmount, virtualQuote: 0n };
      rec.poolKey = ctx.key;
      rec.poolSlot = ctx.tx.slot;
    }
    this.deps.resolver.learnPool({ pool: ev.pool, baseMint: ev.mint, quoteMint, isCanonical: true, index: 0, baseDecimals: rec.decimals });
    this.stats.migrations++;
    this.changes.feed.push(this.feedItem("migration", rec, ctx, ts));
    this.touch(rec);
    this.changes.tradeCtx.add(rec.mint);
    this.persist(rec, true);
    if (rec.createdAt === null) this.requestBootstrap(rec, false);
    return rec.mint;
  }

  private onCreatePool(ev: AmmCreatePoolEvent, ctx: EvCtx): string {
    this.stats.poolsCreated++;
    const info = this.deps.resolver.learnPool({
      pool: ev.pool,
      baseMint: ev.baseMint,
      quoteMint: ev.quoteMint,
      index: ev.index,
      creator: ev.creator,
      lpMint: ev.lpMint,
      coinCreator: ev.coinCreator,
      isMayhemMode: ev.isMayhemMode,
      creatorFeeBps: ev.creatorFeeBps.toString(),
      canEditCreatorFee: ev.canEditCreatorFee,
      isHolderReward: ev.isHolderReward,
      baseDecimals: ev.baseMintDecimals,
      quoteDecimals: ev.quoteMintDecimals,
    });
    // Only the migration event links a coin to its canonical pool (it follows this event in the same
    // tx); a pool someone else creates for the coin must not become its price source.
    const rec = this.tokens.get(ev.baseMint);
    if (rec && rec.pool === ev.pool) {
      if (!rec.poolState || !rec.poolKey || cmpKey(ctx.key, rec.poolKey) >= 0) {
        rec.poolState = { base: ev.poolBaseAmount, quoteVault: ev.poolQuoteAmount, virtualQuote: 0n };
        rec.poolKey = ctx.key;
        rec.poolSlot = ctx.tx.slot;
      }
      if (info.coinCreator) this.setCreator(rec, info.coinCreator, "pool");
      rec.holders?.exclude(ev.pool);
      this.touch(rec);
      this.changes.tradeCtx.add(rec.mint);
    }
    return ev.baseMint;
  }

  private onPoolTrade(ev: AmmSwapEvent, ctx: EvCtx): string | null {
    const info = this.deps.resolver.pools.get(ev.pool);
    if (!AccountResolver.ready(info)) {
      this.parkPoolEvent(ev, ctx);
      return null;
    }
    return this.applyPoolTrade(ev, ctx, info);
  }

  private parkPoolEvent(ev: AmmSwapEvent, ctx: EvCtx): void {
    let list = this.pendingPools.get(ev.pool);
    if (!list) {
      list = [];
      this.pendingPools.set(ev.pool, list);
      this.deps.resolver.requestPool(ev.pool);
    }
    if (list.length >= MAX_PENDING_PER_POOL || this.pendingTotal >= MAX_PENDING_TOTAL) {
      this.stats.pendingDropped++;
      return;
    }
    list.push({ ev, ctx });
    this.pendingTotal++;
  }

  /** The resolver finished a pool: apply the events that were waiting for it. */
  onPoolReady(info: PoolInfo): void {
    const list = this.pendingPools.get(info.pool);
    const rec = this.tokens.get(info.baseMint);
    if (rec && info.isCanonical) this.adoptCanonicalPool(rec, info);
    if (rec && rec.pool === info.pool) {
      if (info.coinCreator) this.setCreator(rec, info.coinCreator, "pool");
      this.changes.tradeCtx.add(rec.mint);
    }
    if (!list) return;
    this.pendingPools.delete(info.pool);
    this.pendingTotal -= list.length;
    for (const p of list) {
      const mint = this.applyPoolTrade(p.ev, p.ctx, info);
      // keep the slot index complete so a dead slot can still roll these back
      this.slotTxs
        .get(p.ctx.tx.slot)
        ?.find((r) => r.signature === p.ctx.tx.signature)
        ?.mints.add(mint);
    }
  }

  /**
   * A canonical pump pool (pool.creator == pool_authority PDA of the mint) means the coin graduated from
   * the pump.fun curve, whatever its mint suffix. The migration time stays unknown unless we saw it.
   */
  private adoptCanonicalPool(rec: TokenRecord, info: PoolInfo): void {
    if (rec.launchpad === "pump" && rec.pool === info.pool && rec.migrated) return;
    rec.launchpad = "pump";
    rec.pool = info.pool;
    rec.migrated = true;
    rec.complete = true;
    this.touch(rec);
  }

  private applyPoolTrade(ev: AmmSwapEvent, ctx: EvCtx, info: PoolInfo): string {
    const ts = Number(ev.timestamp) * 1000;
    const isBuy = ev.kind === "ammBuy";
    const quoteMint = normalizeQuoteMint(info.quoteMint);
    const known = this.tokens.get(info.baseMint);
    if (known && info.isCanonical) this.adoptCanonicalPool(known, info);
    const rec =
      known ??
      this.getOrCreate(info.baseMint, {
        // canonical pool = graduated from the pump curve; other pools are PumpSwap-only listings
        launchpad: info.isCanonical ? "pump" : "pumpswap",
        decimals: info.baseDecimals ?? 6,
        tokenProgram: info.baseTokenProgram,
        quoteMint,
        quoteDecimals: info.quoteDecimals ?? 9,
        quoteTokenProgram: info.quoteTokenProgram ?? knownQuoteTokenProgram(quoteMint),
        migrated: info.isCanonical === true,
        complete: info.isCanonical === true,
        pool: info.pool,
        supply: info.baseSupply ? BigInt(info.baseSupply) : 1_000_000_000_000_000n,
      });
    if (!known && rec.createdAt === null) this.requestBootstrap(rec, false);
    rec.pool ??= info.pool;
    if (info.isCanonical && rec.pool !== info.pool) rec.pool = info.pool;
    if (ev.baseSupply > 0n) rec.supply = ev.baseSupply;
    const poolAfter: PoolReserves = isBuy
      ? {
          base: ev.poolBaseReserves - ev.baseAmount,
          quoteVault: ev.poolQuoteReserves + ev.quoteAmountVault,
          virtualQuote: ev.virtualQuoteReserves,
        }
      : {
          base: ev.poolBaseReserves + ev.baseAmount,
          quoteVault: ev.poolQuoteReserves - ev.quoteAmountVault,
          virtualQuote: ev.virtualQuoteReserves,
        };
    const primary = rec.pool === info.pool;
    const latest = primary && (!rec.poolKey || cmpKey(ctx.key, rec.poolKey) >= 0);
    if (latest) {
      rec.poolState = poolAfter;
      rec.poolKey = ctx.key;
      rec.poolSlot = ctx.tx.slot;
      this.setCreator(rec, ev.coinCreator, "pool");
      this.changes.tradeCtx.add(rec.mint);
    }
    const eff = poolAfter.quoteVault + poolAfter.virtualQuote;
    this.stats.poolTrades++;
    this.recordTrade(rec, ctx, {
      venue: "pumpswap",
      isBuy,
      trader: ev.user,
      quoteAmount: ev.quoteAmount,
      tokenAmount: ev.baseAmount,
      tsMs: ts,
      priceQuote:
        poolAfter.base > 0n && eff > 0n
          ? ui(eff, info.quoteDecimals ?? rec.quoteDecimals) / ui(poolAfter.base, info.baseDecimals ?? rec.decimals)
          : 0,
      curveAfter: null,
      poolAfter: primary ? poolAfter : null,
      latest,
    });
    return rec.mint;
  }

  private recordTrade(
    rec: TokenRecord,
    ctx: EvCtx,
    t: {
      venue: "pump" | "pumpswap";
      isBuy: boolean;
      trader: string;
      quoteAmount: bigint;
      tokenAmount: bigint;
      tsMs: number;
      priceQuote: number;
      curveAfter: CurveReserves | null;
      poolAfter: PoolReserves | null;
      latest: boolean;
    },
  ): void {
    const solUsd = this.deps.solUsd();
    const rate = quoteSolRate(rec.quoteMint, solUsd);
    const priceSol = rate !== null ? t.priceQuote * rate : 0;
    const supplyUi = ui(rec.supply, rec.decimals);
    const amountSol = rate !== null ? ui(t.quoteAmount, rec.quoteDecimals) * rate : 0;
    const mcSol = priceSol * supplyUi;

    // holders + audit classification
    let holderDelta = 0n;
    if (rec.holders) {
      holderDelta = t.isBuy ? t.tokenAmount : -t.tokenAmount;
      rec.holders.applyDelta(t.trader, holderDelta);
      if (t.isBuy) rec.holders.classifyBuy(t.trader, ctx.tx.slot, ctx.txBuyers.get(rec.mint) ?? new Set());
    }
    if (ctx.tx.accountKeys) {
      rec.proTraders ??= new Set();
      if (ctx.tx.accountKeys.some((k) => this.pros.has(k))) rec.proTraders.add(t.trader);
    }
    const tags: TradeTag[] = rec.holders ? rec.holders.tagsOf(t.trader) : rec.creator === t.trader ? ["dev"] : [];
    if (rec.proTraders?.has(t.trader)) tags.push("pro");

    const trade: Trade = {
      id: `${ctx.tx.signature}:${ctx.evIndex}`,
      signature: ctx.tx.signature,
      slot: ctx.tx.slot,
      txIndex: ctx.tx.txIndex,
      mint: rec.mint,
      venue: t.venue,
      side: t.isBuy ? "buy" : "sell",
      trader: t.trader,
      quoteAmount: t.quoteAmount.toString(),
      tokenAmount: t.tokenAmount.toString(),
      amountSol,
      amountUsd: solUsd && rate !== null ? amountSol * solUsd : null,
      priceSol,
      mcSol,
      blockTime: t.tsMs,
      receivedAt: ctx.tx.receivedAt,
      tags,
    };
    const entry: TradeEntry = {
      trade,
      key: ctx.key,
      tsMs: t.tsMs,
      volumeSol: amountSol,
      isBuy: t.isBuy,
      holderDelta,
      curveAfter: t.curveAfter,
      poolAfter: t.poolAfter,
      priceSol,
      solUsd,
    };
    // keep the ring ordered by key (late events are inserted in place)
    const ring = rec.trades;
    let i = ring.length;
    while (i > 0 && cmpKey((ring[i - 1] as TradeEntry).key, ctx.key) > 0) i--;
    // Out of order relative to what clients already have: send as a correction, not a tape delta.
    const late = i < ring.length;
    ring.splice(i, 0, entry);
    if (ring.length > this.recentCap) ring.splice(0, ring.length - this.recentCap);

    if (late) {
      this.stats.lateTrades++;
      this.changes.correction(rec.mint).upsert.push(trade);
    } else this.changes.pushTrade(trade);
    rec.windows.add(t.tsMs, amountSol, t.isBuy);
    if (priceSol > 0) {
      for (const u of this.candles.addTrade(rec.mint, { tsMs: t.tsMs, price: priceSol, volume: amountSol, key: ctx.key, solUsd })) {
        this.changes.candle(u);
        this.deps.storage?.candle(u.mint, u.tf, u.candle);
      }
    }
    if (t.latest && mcSol > rec.athMcSol) rec.athMcSol = mcSol;
    if (rec.lastTradeAt === null || t.tsMs >= rec.lastTradeAt) rec.lastTradeAt = t.tsMs;
    if (rec.lastSlot === null || ctx.tx.slot > rec.lastSlot) rec.lastSlot = ctx.tx.slot;

    this.stats.trades++;
    this.tradeRate.add(1, ctx.tx.receivedAt);
    this.latency.add(ctx.tx.receivedAt - t.tsMs);
    this.deps.storage?.trade(trade, ctx.evIndex);
    this.changes.feed.push({ ...this.feedItem("trade", rec, ctx, t.tsMs), side: trade.side, amountSol, venue: t.venue });
    this.touch(rec);
    this.persist(rec, false);
  }

  private feedItem(kind: FeedItem["kind"], rec: TokenRecord, ctx: EvCtx, blockTime: number): FeedItem {
    return {
      kind,
      mint: rec.mint,
      symbol: rec.symbol,
      name: rec.name,
      signature: ctx.tx.signature,
      slot: ctx.tx.slot,
      blockTime,
      receivedAt: ctx.tx.receivedAt,
      latencyMs: ctx.tx.receivedAt - blockTime,
    };
  }

  /** Writes the token row now (structural changes) or at most every `tokenPersistIntervalMs`. */
  persistIntervalMs = 10_000;
  private persist(rec: TokenRecord, force: boolean): void {
    if (!this.deps.storage) return;
    const now = this.now();
    if (!force && now - rec.lastPersistAt < this.persistIntervalMs) return;
    rec.lastPersistAt = now;
    this.deps.storage.token(rec, this.summary(rec.mint) as TokenSummary);
  }

  // ---------------------------------------------------------------------------------------------
  // forks and dead slots
  // ---------------------------------------------------------------------------------------------

  /** Rolls back everything applied from `slot` (reported dead) and applies parked fork copies. */
  dropSlot(slot: number): void {
    const txs = this.slotTxs.get(slot);
    if (!txs) return;
    this.slotTxs.delete(slot);
    this.stats.deadSlots++;
    const sigs = new Set(txs.map((t) => t.signature));
    const mints = new Set<string>();
    for (const t of txs) for (const m of t.mints) mints.add(m);
    for (const mint of mints) this.rollbackToken(mint, slot, sigs);
    for (const t of txs) {
      for (const mint of t.creates) {
        const rec = this.tokens.get(mint);
        if (rec && rec.createdSlot === slot && rec.trades.length === 0) {
          this.tokens.delete(mint);
          this.candles.evict(mint);
          this.changes.tokens.add(mint);
        }
      }
      for (const mint of t.migrations) {
        const rec = this.tokens.get(mint);
        if (rec?.migrated && rec.poolSlot === slot) {
          rec.migrated = false;
          rec.migratedAt = null;
          this.touch(rec);
        }
      }
    }
    for (const sig of sigs) {
      this.seen.delete(sig);
      const parked = this.forkParked.get(sig);
      if (parked) {
        this.forkParked.delete(sig);
        this.applyTx(parked);
      }
    }
  }

  private rollbackToken(mint: string, slot: number, sigs: Set<string>): void {
    const rec = this.tokens.get(mint);
    if (!rec) return;
    const removed = rec.trades.filter((e) => e.trade.slot === slot && sigs.has(e.trade.signature));
    if (!removed.length) return;
    rec.trades = rec.trades.filter((e) => !removed.includes(e));
    const corr = this.changes.correction(mint);
    for (const e of removed) {
      if (rec.holders && e.holderDelta !== 0n) rec.holders.applyDelta(e.trade.trader, -e.holderDelta);
      rec.windows.remove(e.tsMs, e.volumeSol, e.isBuy);
      corr.remove.push(e.trade.id);
      this.stats.rolledBackTrades++;
    }
    this.deps.storage?.deleteTrades(removed.map((e) => e.trade.id));
    const toCandle = (e: TradeEntry): CandleTrade => ({
      tsMs: e.tsMs,
      price: e.priceSol,
      volume: e.volumeSol,
      key: e.key,
      solUsd: e.solUsd,
    });
    const coverFrom = rec.trades.length ? (rec.trades[0] as TradeEntry).tsMs : Number.MAX_SAFE_INTEGER;
    for (const u of this.candles.rebuildAfterRemoval(mint, removed.map(toCandle), rec.trades.map(toCandle), coverFrom)) {
      this.changes.candle(u);
      this.deps.storage?.candle(u.mint, u.tf, u.candle);
    }
    // restore reserves from the newest surviving trade of each venue
    const lastCurve = [...rec.trades].reverse().find((e) => e.curveAfter);
    if (rec.curveKey && rec.curveKey[0] === slot && lastCurve?.curveAfter) {
      rec.curve = lastCurve.curveAfter;
      rec.curveKey = lastCurve.key;
      rec.curveSlot = lastCurve.trade.slot;
    }
    const lastPool = [...rec.trades].reverse().find((e) => e.poolAfter);
    if (rec.poolKey && rec.poolKey[0] === slot && lastPool?.poolAfter) {
      rec.poolState = lastPool.poolAfter;
      rec.poolKey = lastPool.key;
      rec.poolSlot = lastPool.trade.slot;
    }
    this.touch(rec);
    this.changes.tradeCtx.add(mint);
  }

  // ---------------------------------------------------------------------------------------------
  // asynchronous enrichment
  // ---------------------------------------------------------------------------------------------

  setMetadata(
    mint: string,
    meta: { image: string | null; description: string | null; socials: TokenSocials; name?: string | null; symbol?: string | null } | null,
  ): void {
    const rec = this.tokens.get(mint);
    if (!rec) return;
    if (!meta) {
      rec.metadataState = "failed";
      return;
    }
    rec.metadataState = "ok";
    rec.image = meta.image;
    rec.description = meta.description;
    rec.socials = meta.socials;
    if (!rec.name && meta.name) rec.name = meta.name;
    if (!rec.symbol && meta.symbol) rec.symbol = meta.symbol;
    this.touch(rec);
    this.persist(rec, true);
  }

  private applyOnchainMetadata(rec: TokenRecord, md: OnchainTokenMetadata): void {
    if (!rec.name) rec.name = md.name;
    if (!rec.symbol) rec.symbol = md.symbol;
    if (!rec.uri && md.uri) rec.uri = md.uri;
    if (rec.uri && rec.metadataState === "none") {
      rec.metadataState = "requested";
      this.deps.requestMetadata?.(rec.mint, rec.uri);
    }
    this.touch(rec);
  }

  onMintResolved(info: MintResolved): void {
    for (const rec of this.tokens.values()) {
      if (rec.quoteMint === info.mint && rec.quoteMint !== rec.mint) {
        rec.quoteDecimals = info.decimals;
        rec.quoteTokenProgram = info.tokenProgram;
        this.touch(rec);
      }
    }
    const rec = this.tokens.get(info.mint);
    if (!rec) return;
    rec.tokenProgram = info.tokenProgram;
    rec.decimals = info.decimals;
    if (info.supply > 0n) rec.supply = info.supply;
    rec.dangers = info.dangers;
    if (info.metadata) this.applyOnchainMetadata(rec, info.metadata);
    this.touch(rec);
    this.changes.tradeCtx.add(rec.mint);
  }

  onMetaplexResolved(mint: string, md: OnchainTokenMetadata): void {
    const rec = this.tokens.get(mint);
    if (rec) this.applyOnchainMetadata(rec, md);
  }

  onCurveResolved(r: CurveResolved): void {
    const rec = this.tokens.get(r.mint);
    if (!rec) return;
    rec.bondingCurve = r.bondingCurve;
    rec.isCashback = r.curve.isCashbackCoin;
    rec.isHolderReward = r.curve.isHolderReward;
    rec.creatorFeeBps = r.curve.creatorFeeBps;
    rec.canEditCreatorFee = r.curve.canEditCreatorFee;
    rec.isMayhem = r.curve.isMayhemMode;
    if (r.curve.tokenTotalSupply > 0n) rec.supply = r.curve.tokenTotalSupply;
    if (r.curve.complete && !rec.complete) rec.complete = true;
    if (!rec.creator) this.setCreator(rec, r.curve.creator, "curve");
    this.touch(rec);
    this.changes.tradeCtx.add(rec.mint);
  }

  // ---------------------------------------------------------------------------------------------
  // reads
  // ---------------------------------------------------------------------------------------------

  summary(mint: string): TokenSummary | null {
    const rec = this.tokens.get(mint);
    return rec ? summarize(rec, { solUsd: this.deps.solUsd(), now: this.now() }) : null;
  }

  tradeContext(mint: string): TradeContext | null {
    const rec = this.tokens.get(mint);
    if (!rec) return null;
    return buildTradeContext(rec, rec.pool ? this.deps.resolver.pools.get(rec.pool) : undefined);
  }

  recentTrades(mint: string, limit = 100): Trade[] {
    const rec = this.tokens.get(mint);
    if (!rec) return [];
    return rec.trades
      .slice(-limit)
      .reverse()
      .map((e) => e.trade);
  }

  /** Live price for a token (quote units), used by tests and debug. */
  priceQuote(mint: string): number {
    const rec = this.tokens.get(mint);
    return rec ? priceQuote(rec) : 0;
  }

  /** Drops tokens idle for longer than `idleMs` unless `keep(mint)` says otherwise. */
  evictIdle(idleMs: number, keep: (mint: string) => boolean): number {
    const now = this.now();
    let n = 0;
    for (const [mint, rec] of this.tokens) {
      const last = Math.max(rec.lastTradeAt ?? 0, rec.updatedAt, rec.firstSeenAt);
      if (now - last > idleMs && !keep(mint)) {
        this.persist(rec, true);
        this.tokens.delete(mint);
        this.candles.evict(mint);
        n++;
      }
    }
    return n;
  }

  /** Restores a persisted record (startup). */
  restore(rec: TokenRecord): void {
    this.tokens.set(rec.mint, rec);
    if (rec.creator) this.setCreator(rec, rec.creator, rec.migrated ? "pool" : "curve");
  }
}
