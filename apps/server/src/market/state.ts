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
 *
 * Raydium: LaunchLab curves (PoolCreateEvent, TradeEvent) and the CPMM pools LaunchLab coins graduate into
 * (SwapEvent; graduation = migrate_to_cpswap, which has no event). Their events carry no timestamp (block
 * time when the source has it, else the receive time) and LaunchLab events no mint: the instruction accounts
 * (IngestTx.raydium) or the registry (accounts/raydium.ts, asynchronous) supply it, and events wait for it
 * like PumpSwap swaps wait for their pool. The trading wallet comes from the instruction's payer; without
 * accounts (RPC logs feed, no fetch) a trade is recorded with trader "" and does not move holder balances.
 *
 * History (backfill, history/service.ts): `collectHistory` runs one coin's fetched transactions through the
 * same event handlers in "history mode" (trades are collected with their prices, nothing live happens: no tape,
 * no listeners, no stats), and `mergeHistory` merges them with the stored and in-memory trades (idempotent:
 * a trade already held, by id or by signature + side + amount, is never added twice), stores the new ones and
 * rebuilds what derives from the whole trade list: candles, rolling windows, the trade ring, the ATH and, when
 * the history reaches the creation, the holder book (holders, dev / sniper / bundler shares).
 */
import type { Address } from "@solana/kit";
import {
  type AmmCreatePoolEvent,
  type AmmSwapEvent,
  type CpmmSwapEvent,
  coinCreatorVaultAuthorityPda,
  cpmmVaultAmountsWithoutFees,
  creatorVaultPda,
  curveMintSupply,
  DEFAULT_PUBKEY,
  type DecodedEvent,
  INCINERATOR,
  LAUNCHLAB_POOL_STATUS,
  type LaunchLabPoolCreateEvent,
  type LaunchLabTradeEvent,
  MAINNET_SLOTS_PER_EPOCH,
  MAYHEM_FEE_RECIPIENTS,
  ONE_BILLION_SUPPLY,
  type OnchainTokenMetadata,
  PUMP_TOKEN_DECIMALS,
  type PumpCompleteEvent,
  type PumpCreateEvent,
  type PumpMigrationEvent,
  type PumpTradeEvent,
  RAYDIUM_CPMM_AUTHORITY,
  RAYDIUM_FEE_RATE_DENOMINATOR,
  RAYDIUM_LAUNCHLAB_AUTHORITY,
  TOKEN_2022_PROGRAM_ID,
  type TransferFeeConfig,
  transferFeeFor,
  transferInverseFeeFor,
  USDC_MINT,
} from "@zerofee/core";
import type {
  Candle,
  Timeframe,
  TokenHistory,
  TokenSocials,
  TokenSummary,
  Trade,
  TradeContext,
  TradeTag,
  TradeVenue,
} from "@zerofee/protocol";
import type { CpmmPoolInfo, LaunchLabPoolInfo, RaydiumRegistry } from "../accounts/raydium";
import { AccountResolver, type CurveResolved, type MintResolved, type PoolInfo } from "../accounts/resolver";
import { type CoinAccounts, eventMatchesCoin } from "../history/coin";
import type { LaunchLabMigration, RaydiumEventAccounts } from "../ingest/raydium";
import type { IngestTx } from "../ingest/types";
import { perf } from "../perf";
import { rowToTrade, type TradeRow } from "../storage/reader";
import { BoundedSet, LruMap } from "../util/lru";
import { RateCounter, SampleRing } from "../util/stats";
import { CandleBook, type CandleTrade, type CandleUpdate, cmpKey, type OrderKey } from "./candles";
import { HolderBook, type MetricsConfig, type SnapshotEntry } from "./holders";
import { priceSolFromQuote } from "./jupiterPrice";
import { knownQuoteDecimals, normalizeQuoteMint, quoteSolRate, ui } from "./quote";
import {
  buildTradeContext,
  type CurveReserves,
  circulatingBound,
  knownQuoteTokenProgram,
  type LaunchLabRecord,
  newTokenRecord,
  type PoolReserves,
  priceQuote,
  type RaydiumContextInputs,
  summarize,
  type TokenRecord,
  type TradeEntry,
} from "./token";

export interface MarketConfig extends MetricsConfig {
  /** Known terminal fee wallets (SOL): a swap that credits one marks its trader as a pro trader. */
  proTraderWallets: readonly string[];
  /** Known terminal fee token accounts (fees taken in an SPL token): present in the swap = paid. */
  proTraderTokenAccounts?: readonly string[];
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

/** What a backfill already holds for a coin: content-key counts (MarketState.contentKey) and their signatures. */
export interface HistoryIndex {
  counts: Map<string, number>;
  sigs: Set<string>;
}

export interface MarketDeps {
  resolver: ResolverLike;
  solUsd(): number | null;
  /** Fetch a token's metadata JSON; `restore` (startup refetch) runs at background priority. */
  requestMetadata?(mint: string, uri: string, origin?: "launch" | "restore"): void;
  storage?: StorageSink;
  now?(): number;
  /** Cached funder of a wallet (non-exchange), for the shared-funder bundle rule; null when unknown. */
  funderOf?(wallet: string): string | null;
  /** A launch was applied (dev history bookkeeping). Must not block: called on the ingest path. */
  onLaunch?(rec: TokenRecord): void;
  /** A migration was applied. Must not block. */
  onMigrate?(rec: TokenRecord): void;
  /** Every recorded trade with its transaction (the wallet tracker's firehose matcher). Must not throw. */
  onTrade?(trade: Trade, tx: IngestTx): void;
  /** Raydium LaunchLab / CPMM account registry; without it Raydium events need instruction accounts. */
  raydium?: RaydiumRegistry;
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
  /** null when the trade's quote has no known SOL value. */
  amountSol?: number | null;
  venue?: TradeVenue;
}

export class ChangeLog {
  /** Changed mints -> when they first changed since the last Pulse flush (ms; the gateway's pulseWait). */
  readonly tokens = new Map<string, number>();
  readonly tradeCtx = new Set<string>();
  readonly trades = new Map<string, Trade[]>();
  readonly tradeCorrections = new Map<string, { remove: string[]; upsert: Trade[] }>();
  /** `${mint}|${tf}` -> bucket t -> candle */
  readonly candles = new Map<string, Map<number, Candle>>();
  readonly candleCorrections = new Map<string, Map<number, Candle>>();
  readonly feed: FeedItem[] = [];

  token(mint: string, now: number): void {
    if (!this.tokens.has(mint)) this.tokens.set(mint, now);
  }

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
  /** Known terminal fee wallets this tx paid; null when the source has no account keys. */
  paidFeeWallets: string[] | null;
}

interface PendingPoolEvent {
  ev: AmmSwapEvent;
  ctx: EvCtx;
}

interface PendingRaydiumEvent<E> {
  ev: E;
  ctx: EvCtx;
}

const isDefault = (a: string | undefined | null): boolean => !a || a === DEFAULT_PUBKEY;
const max0 = (v: bigint): bigint => (v < 0n ? 0n : v);

/**
 * Order key of an account read at `slot`: after every transaction of that slot (the account already reflects
 * them), before any later slot's.
 */
const anchorKey = (slot: number): OrderKey => [slot, Number.MAX_SAFE_INTEGER, 0];

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
  /** LaunchLab events waiting for their pool's mint (logs-only records). */
  private readonly pendingLaunchLab = new Map<string, PendingRaydiumEvent<LaunchLabTradeEvent | LaunchLabPoolCreateEvent>[]>();
  /** CPMM swaps waiting for their pool to be classified as a graduation pool. */
  private readonly pendingCpmm = new Map<string, PendingRaydiumEvent<CpmmSwapEvent>[]>();
  private pendingTotal = 0;
  /** Set while collectHistory runs: trades are collected for a backfill instead of applied live. */
  private hist: { coin: CoinAccounts; entries: TradeEntry[]; skipped: number } | null = null;
  /** Non-SOL, non-USDC quote mints whose decimals were requested from the resolver. */
  private readonly quoteRequests = new Set<string>();
  private readonly quoteMintInfo = new Map<
    string,
    { decimals: number; tokenProgram: string; transferFeeConfig: TransferFeeConfig | null }
  >();
  private readonly proWallets: Set<string>;
  private readonly proTokenAccounts: Set<string>;
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
    /** Raydium: LaunchLab launches / trades / completed curves / graduations, CPMM trades on graduation pools. */
    launchLabLaunches: 0,
    launchLabTrades: 0,
    launchLabCompletes: 0,
    launchLabGraduations: 0,
    cpmmTrades: 0,
    /** Graduated LaunchLab coins found through their CPMM pool, graduation time unknown (not counted above). */
    launchLabGraduatesFound: 0,
    /** Raydium trades recorded without a wallet (no instruction accounts). */
    unattributedTrades: 0,
    /** CPMM swaps on pools that are not graduation pools (ignored). */
    cpmmIgnored: 0,
    lastEventAt: null as number | null,
  };

  constructor(
    private readonly cfg: MarketConfig,
    private readonly deps: MarketDeps,
  ) {
    this.proWallets = new Set(cfg.proTraderWallets);
    this.proTokenAccounts = new Set(cfg.proTraderTokenAccounts ?? []);
    this.recentCap = cfg.recentTrades ?? 200;
  }

  /**
   * Known terminal fee accounts this tx paid: a fee wallet whose lamports went up (presence alone when the
   * source has no balances), or a fee token account present in the account keys.
   */
  private paidFeeWallets(tx: IngestTx): string[] {
    const keys = tx.accountKeys as string[];
    const out: string[] = [];
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i] as string;
      if (this.proTokenAccounts.has(k)) {
        out.push(k);
        continue;
      }
      if (!this.proWallets.has(k)) continue;
      const pre = tx.lamports?.pre[i];
      const post = tx.lamports?.post[i];
      if (pre === undefined || post === undefined) out.push(k);
      else {
        try {
          if (BigInt(post) > BigInt(pre)) out.push(k);
        } catch {
          out.push(k);
        }
      }
    }
    return out;
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
    const addBuyer = (mint: string, buyer: string) => {
      const s = txBuyers.get(mint) ?? new Set<string>();
      s.add(buyer);
      txBuyers.set(mint, s);
    };
    tx.events.forEach((ev, i) => {
      if (ev.kind === "pumpTrade" && ev.isBuy) addBuyer(ev.mint, ev.user);
      if (ev.kind === "launchlabTrade" && ev.isBuy) {
        const acc = tx.raydium?.accounts[i];
        if (acc?.kind === "launchlabSwap") addBuyer(acc.baseMint, acc.payer);
      }
    });
    const record = { signature: tx.signature, mints: new Set<string>(), creates: [] as string[], migrations: [] as string[] };
    const paidFeeWallets = tx.accountKeys ? this.paidFeeWallets(tx) : null;
    tx.events.forEach((ev, i) => {
      this.stats.events++;
      const mint = this.applyEvent(ev, { tx, key: [tx.slot, seq as number, i], evIndex: i, txBuyers, paidFeeWallets });
      if (mint) record.mints.add(mint);
      if (ev.kind === "pumpCreate") record.creates.push(ev.mint);
      if (ev.kind === "launchlabPoolCreate" && mint) record.creates.push(mint);
      if (ev.kind === "pumpMigrate") record.migrations.push(ev.mint);
    });
    // LaunchLab graduations carry no event: they come from the migrate_to_cpswap instruction.
    (tx.raydium?.migrations ?? []).forEach((m, k) => {
      const i = tx.events.length + k;
      const mint = this.onLaunchLabMigrate(m, { tx, key: [tx.slot, seq as number, i], evIndex: i, txBuyers, paidFeeWallets });
      record.mints.add(mint);
      record.migrations.push(mint);
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
    // insertion order ~ slot order: evict the oldest inserted slot (~4 min of history kept)
    if (this.slotTxs.size > 600) this.slotTxs.delete(this.slotTxs.keys().next().value as number);
  }

  /**
   * Sets the record's quote (normalized mint, decimals, token program). Decimals / program come from the
   * caller when it knows them, else from the known quotes or an earlier lookup, else they are requested.
   */
  private setQuote(rec: TokenRecord, mint: string, decimals: number | null = null, tokenProgram: string | null = null): void {
    const quoteMint = normalizeQuoteMint(mint);
    const known = this.quoteMintInfo.get(quoteMint);
    const dec = decimals ?? knownQuoteDecimals(quoteMint) ?? known?.decimals ?? null;
    const program = tokenProgram ?? knownQuoteTokenProgram(quoteMint) ?? known?.tokenProgram ?? null;
    if (
      rec.quoteMint === quoteMint &&
      (dec === null || rec.quoteDecimals === dec) &&
      (program === null || rec.quoteTokenProgram === program)
    )
      return;
    rec.quoteMint = quoteMint;
    if (dec !== null) rec.quoteDecimals = dec;
    rec.quoteTokenProgram = program;
    // Token-2022 quotes (xStocks) are read for their transfer fee too.
    if (dec === null || program === null || program === TOKEN_2022_PROGRAM_ID) this.requestQuoteMint(quoteMint);
    this.touch(rec);
    this.changes.tradeCtx.add(rec.mint);
  }

  /**
   * A pool that prices the token (canonical after migration, or a pool-only token's first pool) also sets its
   * quote: a token first seen in a third-party pool (say GMk6/PUMP) must not keep that quote once its
   * canonical wSOL pool takes over, or the wSOL vault is read in PUMP units with no SOL value (tx 4LYf7b9i...).
   */
  private alignQuoteWithPool(rec: TokenRecord, info: PoolInfo): void {
    if (rec.pool !== info.pool || !(rec.migrated || !rec.curve)) return;
    this.setQuote(rec, info.quoteMint, info.quoteDecimals, info.quoteTokenProgram);
  }

  /** Asks the resolver for an unfamiliar quote mint's decimals / token program (once). */
  private requestQuoteMint(quoteMint: string): void {
    if (knownQuoteDecimals(quoteMint) !== null || this.quoteRequests.has(quoteMint)) return;
    this.quoteRequests.add(quoteMint);
    this.deps.resolver.requestMint(quoteMint);
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
      case "launchlabPoolCreate":
        return this.onLaunchLabCreate(ev, ctx);
      case "launchlabTrade":
        return this.onLaunchLabTrade(ev, ctx);
      case "cpmmSwap":
        return this.onCpmmSwap(ev, ctx);
    }
  }

  private touch(rec: TokenRecord): void {
    rec.updatedAt = this.now();
    this.changes.token(rec.mint, Date.now());
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
      // token_total_supply is the curve's 1e15 even for a mayhem coin, whose mint holds 2e15
      supply:
        rec.supplyExact || ev.tokenTotalSupply <= 0n
          ? rec.supply
          : curveMintSupply({ tokenTotalSupply: ev.tokenTotalSupply, isMayhemMode: ev.isMayhemMode }),
      curveTokenTotalSupply: ev.tokenTotalSupply > 0n ? ev.tokenTotalSupply : rec.curveTokenTotalSupply,
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
    this.requestQuoteMint(quoteMint);
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
    if (ctx.tx.accountKeys) rec.proTraders ??= new Set();
    if (!this.hist) {
      if (!rec.holders) {
        rec.holders = this.newHolderBook(ctx.tx.slot);
        rec.holders.exclude(ev.bondingCurve);
      }
      rec.holders.addDev(ev.creator);
      this.stats.launches++;
      this.deps.onLaunch?.(rec);
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
    }
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
    // PDA derivation is async and must never break the hot path.
    const derive = (fn: () => Promise<Address>, set: (v: Address) => void) => {
      try {
        fn()
          .then((v) => {
            if (rec.creator === creator) {
              set(v);
              this.changes.tradeCtx.add(rec.mint);
            }
          })
          .catch(() => {});
      } catch {
        /* invalid address */
      }
    };
    if (venue === "curve" && (changed || !rec.creatorVault)) {
      derive(
        () => creatorVaultPda(creator as Address),
        (v) => {
          rec.creatorVault = v;
        },
      );
    }
    if (venue === "pool" && (changed || !rec.coinCreatorVaultAuthority)) {
      derive(
        () => coinCreatorVaultAuthorityPda(creator as Address),
        (v) => {
          rec.coinCreatorVaultAuthority = v;
        },
      );
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
      supply: curveMintSupply({ tokenTotalSupply: ONE_BILLION_SUPPLY, isMayhemMode: ev.mayhemMode }),
    });
    if (rec.quoteMint !== quoteMint) this.setQuote(rec, quoteMint);
    if (ev.mayhemMode && !rec.isMayhem) {
      rec.isMayhem = true;
      if (!rec.supplyExact)
        rec.supply = curveMintSupply({ tokenTotalSupply: rec.curveTokenTotalSupply ?? ONE_BILLION_SUPPLY, isMayhemMode: true });
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
    if (!this.hist) this.stats.curveTrades++;
    this.recordTrade(rec, ctx, {
      venue: "pump",
      isBuy: ev.isBuy,
      trader: ev.user,
      quoteAmount,
      tokenAmount: ev.tokenAmount,
      tsMs: ts,
      quoteMint: rec.quoteMint,
      quoteDecimals: rec.quoteDecimals,
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
      if (!this.hist) {
        this.stats.completes++;
        this.changes.feed.push(this.feedItem("complete", rec, ctx, rec.completedAt));
      }
    } else if (this.hist && rec.completedAt === null) rec.completedAt = Number(ev.timestamp) * 1000;
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
    // The canonical pool quotes in the curve's quote. SOL curves store the default pubkey, which is also
    // what an event without the field decodes to: then the curve's own trades already set the quote.
    if (ev.quoteMint !== DEFAULT_PUBKEY || !rec.curve) this.setQuote(rec, quoteMint);
    rec.holders?.exclude(ev.pool);
    if (!rec.poolState || !rec.poolKey || cmpKey(ctx.key, rec.poolKey) >= 0) {
      rec.poolState = { base: ev.mintAmount, quoteVault: ev.solAmount, virtualQuote: 0n };
      rec.poolKey = ctx.key;
      rec.poolSlot = ctx.tx.slot;
    }
    this.deps.resolver.learnPool({ pool: ev.pool, baseMint: ev.mint, quoteMint, isCanonical: true, index: 0, baseDecimals: rec.decimals });
    if (!this.hist) {
      this.stats.migrations++;
      this.changes.feed.push(this.feedItem("migration", rec, ctx, ts));
    }
    this.touch(rec);
    this.changes.tradeCtx.add(rec.mint);
    this.persist(rec, true);
    if (rec.createdAt === null) this.requestBootstrap(rec, false);
    if (!this.hist) this.deps.onMigrate?.(rec);
    return rec.mint;
  }

  /** Holder book for a token whose creation we observed: burn addresses excluded, funder lookup wired. */
  newHolderBook(createdSlot: number | null): HolderBook {
    const h = new HolderBook(createdSlot, this.cfg, this.deps.funderOf ? (w) => this.deps.funderOf?.(w) ?? null : null);
    h.exclude(INCINERATOR);
    // Tokens sent to an account owned by the system program address are as good as burned.
    h.exclude(DEFAULT_PUBKEY);
    return h;
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
      if (rec.migrated || !rec.curve) this.setQuote(rec, ev.quoteMint, ev.quoteMintDecimals, info.quoteTokenProgram);
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
      // history: the backfill waits for the pool before it starts; never park old events for live application
      if (this.hist) this.hist.skipped++;
      else this.parkPoolEvent(ev, ctx);
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
      this.alignQuoteWithPool(rec, info);
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
    if (rec.launchpad === "pump" && rec.pool === info.pool && rec.migrated) {
      this.alignQuoteWithPool(rec, info);
      return;
    }
    rec.launchpad = "pump";
    rec.pool = info.pool;
    rec.migrated = true;
    rec.complete = true;
    this.alignQuoteWithPool(rec, info);
    this.touch(rec);
  }

  private applyPoolTrade(ev: AmmSwapEvent, ctx: EvCtx, info: PoolInfo): string {
    const ts = Number(ev.timestamp) * 1000;
    const isBuy = ev.kind === "ammBuy";
    const quoteMint = normalizeQuoteMint(info.quoteMint);
    const known = this.tokens.get(info.baseMint);
    if (known && info.isCanonical) this.adoptCanonicalPool(known, info);
    // Mayhem pools pay the reserved (mayhem) fee recipients; their events' base_supply is a fixed 1e15
    // basis while the mint holds ~2e15 (tx 4L4LjiEv...), so it must not replace the supply.
    const mayhemPool = info.isMayhemMode === true || known?.isMayhem === true || MAYHEM_FEE_RECIPIENTS.includes(ev.protocolFeeRecipient);
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
        isMayhem: mayhemPool,
        // the pool registry's base supply comes from the mint account
        supply: info.baseSupply
          ? BigInt(info.baseSupply)
          : curveMintSupply({ tokenTotalSupply: ONE_BILLION_SUPPLY, isMayhemMode: mayhemPool }),
        supplyExact: !!info.baseSupply,
      });
    if (!known && rec.createdAt === null) this.requestBootstrap(rec, false);
    // A LaunchLab coin's price pool is its CPMM graduation pool, never a PumpSwap listing.
    if (rec.launchpad !== "launchlab") rec.pool ??= info.pool;
    if (info.isCanonical && rec.pool !== info.pool) rec.pool = info.pool;
    this.alignQuoteWithPool(rec, info);
    if (ev.baseSupply > 0n && !mayhemPool) {
      rec.supply = ev.baseSupply;
      rec.supplyExact = true;
    }
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
    const poolQuoteDecimals = info.quoteDecimals ?? rec.quoteDecimals; // known: the pool passed ready()
    if (!this.hist) this.stats.poolTrades++;
    this.recordTrade(rec, ctx, {
      venue: "pumpswap",
      isBuy,
      trader: ev.user,
      quoteAmount: ev.quoteAmount,
      tokenAmount: ev.baseAmount,
      tsMs: ts,
      quoteMint,
      quoteDecimals: poolQuoteDecimals,
      priceQuote: poolAfter.base > 0n && eff > 0n ? ui(eff, poolQuoteDecimals) / ui(poolAfter.base, info.baseDecimals ?? rec.decimals) : 0,
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
      venue: TradeVenue;
      isBuy: boolean;
      trader: string;
      quoteAmount: bigint;
      tokenAmount: bigint;
      tsMs: number;
      /** The venue's (normalized) quote and its decimals: what quoteAmount and priceQuote are in. */
      quoteMint: string;
      quoteDecimals: number;
      priceQuote: number;
      curveAfter: CurveReserves | null;
      poolAfter: PoolReserves | null;
      latest: boolean;
      /** False when tsMs is the receive time (Raydium events have no timestamp): kept out of latency stats. */
      tsKnown?: boolean;
    },
  ): void {
    const solUsd = this.deps.solUsd();
    // The venue's own quote: a third-party pool can quote the coin in something else than its curve does.
    // null = no SOL value for that quote right now (exotic quote; USDC before a SOL/USD rate).
    const rate = quoteSolRate(t.quoteMint, solUsd);
    const priceSol = rate !== null && t.priceQuote > 0 ? t.priceQuote * rate : null;
    const supplyUi = ui(rec.supply, rec.decimals);
    const amountSol = rate !== null ? ui(t.quoteAmount, t.quoteDecimals) * rate : null;
    const mcSol = priceSol !== null ? priceSol * supplyUi : null;

    if (this.hist) {
      this.collectHistoryTrade(rec, ctx, t, { priceSol, amountSol, mcSol, solUsd });
      return;
    }

    // holders + audit classification. A trade without a wallet (Raydium, logs only) leaves the holder book
    // incomplete: it becomes unknown rather than wrong.
    let holderDelta = 0n;
    if (!t.trader) {
      this.stats.unattributedTrades++;
      if (rec.holders) rec.holders = null;
    }
    if (rec.holders) {
      holderDelta = t.isBuy ? t.tokenAmount : -t.tokenAmount;
      rec.holders.applyDelta(t.trader, holderDelta);
      if (t.isBuy) rec.holders.classifyBuy(t.trader, ctx.tx.slot, ctx.txBuyers.get(rec.mint) ?? new Set(), t.quoteAmount);
    }
    if (ctx.paidFeeWallets && t.trader) {
      rec.proTraders ??= new Set();
      // the fee wallet trading for itself (a sweep, a treasury buy) is not a customer
      if (ctx.paidFeeWallets.some((w) => w !== t.trader)) rec.proTraders.add(t.trader);
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
      // a USD stable's amount is its USD value, with or without a SOL/USD rate
      amountUsd: t.quoteMint === USDC_MINT ? ui(t.quoteAmount, t.quoteDecimals) : amountSol !== null && solUsd ? amountSol * solUsd : null,
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
      volumeSol: amountSol ?? 0,
      isBuy: t.isBuy,
      holderDelta,
      curveAfter: t.curveAfter,
      poolAfter: t.poolAfter,
      priceSol: priceSol ?? 0,
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
    rec.windows.add(t.tsMs, entry.volumeSol, t.isBuy);
    if (priceSol !== null) {
      for (const u of this.candles.addTrade(rec.mint, { tsMs: t.tsMs, price: priceSol, volume: entry.volumeSol, key: ctx.key, solUsd })) {
        this.changes.candle(u);
        this.deps.storage?.candle(u.mint, u.tf, u.candle);
      }
    }
    if (t.latest && mcSol !== null && mcSol > rec.athMcSol) rec.athMcSol = mcSol;
    if (rec.lastTradeAt === null || t.tsMs >= rec.lastTradeAt) rec.lastTradeAt = t.tsMs;
    if (rec.lastSlot === null || ctx.tx.slot > rec.lastSlot) rec.lastSlot = ctx.tx.slot;

    this.stats.trades++;
    this.tradeRate.add(1, ctx.tx.receivedAt);
    if (t.tsKnown !== false) this.latency.add(ctx.tx.receivedAt - t.tsMs);
    this.deps.storage?.trade(trade, ctx.evIndex);
    this.changes.feed.push({ ...this.feedItem("trade", rec, ctx, t.tsMs), side: trade.side, amountSol, venue: t.venue });
    if (this.deps.onTrade) {
      try {
        this.deps.onTrade(trade, ctx.tx);
      } catch {
        /* a listener must never break the single writer */
      }
    }
    this.touch(rec);
    this.persist(rec, false);
  }

  // ---------------------------------------------------------------------------------------------
  // history backfill (history/service.ts)
  // ---------------------------------------------------------------------------------------------

  /** History mode: the trade recordTrade would build, collected for mergeHistory; nothing live happens. */
  private collectHistoryTrade(
    rec: TokenRecord,
    ctx: EvCtx,
    t: Parameters<MarketState["recordTrade"]>[2],
    v: { priceSol: number | null; amountSol: number | null; mcSol: number | null; solUsd: number | null },
  ): void {
    const hist = this.hist as NonNullable<MarketState["hist"]>;
    if (ctx.paidFeeWallets && t.trader) {
      rec.proTraders ??= new Set();
      if (ctx.paidFeeWallets.some((w) => w !== t.trader)) rec.proTraders.add(t.trader);
    }
    const trade: Trade = {
      id: `${ctx.tx.signature}:${ctx.evIndex}`,
      signature: ctx.tx.signature,
      slot: ctx.tx.slot,
      txIndex: null,
      mint: rec.mint,
      venue: t.venue,
      side: t.isBuy ? "buy" : "sell",
      trader: t.trader,
      quoteAmount: t.quoteAmount.toString(),
      tokenAmount: t.tokenAmount.toString(),
      amountSol: v.amountSol,
      amountUsd:
        t.quoteMint === USDC_MINT ? ui(t.quoteAmount, t.quoteDecimals) : v.amountSol !== null && v.solUsd ? v.amountSol * v.solUsd : null,
      priceSol: v.priceSol,
      mcSol: v.mcSol,
      blockTime: t.tsMs,
      receivedAt: ctx.tx.receivedAt,
      tags: [],
    };
    hist.entries.push({
      trade,
      key: ctx.key,
      tsMs: t.tsMs,
      volumeSol: v.amountSol ?? 0,
      isBuy: t.isBuy,
      holderDelta: 0n,
      curveAfter: t.curveAfter,
      poolAfter: t.poolAfter,
      priceSol: v.priceSol ?? 0,
      solUsd: v.solUsd,
    });
  }

  /**
   * Runs one coin's fetched transactions (oldest or newest first, any order) through the event handlers in
   * history mode: creation / completion / migration facts land on the record (older keys never overwrite newer
   * reserves), trades are returned as entries for mergeHistory. Only the coin's events are applied (a bundle
   * buying several coins in one transaction leaves the others alone). `seq` orders transactions inside a slot;
   * negative values sort before live arrivals of the same slot, so a backfilled transaction never takes over
   * the live reserves of its slot.
   */
  collectHistory(coin: CoinAccounts, txs: readonly { tx: IngestTx; seq: number }[]): { entries: TradeEntry[]; skipped: number } {
    this.hist = { coin, entries: [], skipped: 0 };
    try {
      for (const { tx, seq } of txs) {
        for (const pm of tx.poolMints) this.deps.resolver.learnPool({ ...pm });
        const txBuyers = new Map<string, Set<string>>();
        tx.events.forEach((ev, i) => {
          let buyer: string | null = null;
          if (ev.kind === "pumpTrade" && ev.isBuy && ev.mint === coin.mint) buyer = ev.user;
          if (ev.kind === "launchlabTrade" && ev.isBuy) {
            const acc = tx.raydium?.accounts[i];
            if (acc?.kind === "launchlabSwap" && acc.baseMint === coin.mint) buyer = acc.payer;
          }
          if (buyer) {
            const set = txBuyers.get(coin.mint) ?? new Set<string>();
            set.add(buyer);
            txBuyers.set(coin.mint, set);
          }
        });
        const paidFeeWallets = tx.accountKeys ? this.paidFeeWallets(tx) : null;
        tx.events.forEach((ev, i) => {
          if (!eventMatchesCoin(ev, tx.raydium?.accounts[i], coin)) return;
          this.applyEvent(ev, { tx, key: [tx.slot, seq, i], evIndex: i, txBuyers, paidFeeWallets });
        });
        (tx.raydium?.migrations ?? []).forEach((m, k) => {
          if (m.baseMint !== coin.mint) return;
          const i = tx.events.length + k;
          this.onLaunchLabMigrate(m, { tx, key: [tx.slot, seq, i], evIndex: i, txBuyers, paidFeeWallets });
        });
      }
      return { entries: this.hist.entries, skipped: this.hist.skipped };
    } finally {
      this.hist = null;
    }
  }

  /** Content identity of a trade: survives event-index differences between a logs record and a full transaction. */
  static contentKey(t: Pick<Trade, "signature" | "side" | "tokenAmount">): string {
    return `${t.signature}|${t.side}|${t.tokenAmount}`;
  }

  /**
   * Merges collected history entries into the coin: a trade already held (its content key is in `known`, which
   * counts the stored and in-memory trades and is updated here, or its transaction was applied live after
   * `known` was built and the ring holds it) is skipped; new ones are stored, marked seen (a late live copy is
   * then a duplicate), inserted into the trade ring and the rolling windows, and checked against the ATH.
   * Returns the new trades (tagged) and the hour buckets they fall in (candles to rebuild).
   */
  mergeHistory(mint: string, entries: readonly TradeEntry[], known: HistoryIndex): { added: Trade[]; hours: number[] } {
    const rec = this.tokens.get(mint);
    if (!rec) return { added: [], hours: [] };
    const ids = new Set(rec.trades.map((e) => e.trade.id));
    const added: TradeEntry[] = [];
    const hours = new Set<number>();
    for (const e of entries) {
      const k = MarketState.contentKey(e.trade);
      const n = known.counts.get(k) ?? 0;
      if (n > 0) {
        known.counts.set(k, n - 1);
        continue;
      }
      // Applied live after `known` was built (not by a backfill): held already, never count it twice.
      const sig = e.trade.signature;
      if (!known.sigs.has(sig) && !this.historySeen.has(sig) && this.seen.get(sig) !== undefined) continue;
      let entry = e;
      if (ids.has(entry.trade.id)) entry = { ...e, trade: { ...e.trade, id: `${e.trade.id}:h` } };
      if (ids.has(entry.trade.id)) continue;
      ids.add(entry.trade.id);
      added.push(entry);
    }
    if (!added.length) return { added: [], hours: [] };
    const now = this.now();
    for (const e of added) {
      e.trade.tags = this.tagsFor(rec, e.trade.trader);
      this.deps.storage?.trade(e.trade, e.key[2]);
      if (this.seen.get(e.trade.signature) === undefined) this.seen.set(e.trade.signature, e.trade.slot);
      this.historySeen.add(e.trade.signature);
      if (now - e.tsMs < 86_400_000) rec.windows.add(e.tsMs, e.volumeSol, e.isBuy);
      if (e.trade.mcSol !== null && e.trade.mcSol > rec.athMcSol) rec.athMcSol = e.trade.mcSol;
      if (rec.lastTradeAt === null || e.tsMs > rec.lastTradeAt) rec.lastTradeAt = e.tsMs;
      if (rec.lastSlot === null || e.trade.slot > rec.lastSlot) rec.lastSlot = e.trade.slot;
      hours.add(Math.floor(e.tsMs / 3_600_000) * 3_600_000);
      // keep the ring ordered by key; it holds the newest `recentCap`
      const r = rec.trades;
      let i = r.length;
      while (i > 0 && cmpKey((r[i - 1] as TradeEntry).key, e.key) > 0) i--;
      if (i > 0 || r.length < this.recentCap) r.splice(i, 0, e);
      if (r.length > this.recentCap) r.splice(0, r.length - this.recentCap);
    }
    this.touch(rec);
    this.changes.tradeCtx.add(mint);
    this.persist(rec, true);
    return { added: added.map((e) => e.trade), hours: [...hours].sort((a, b) => a - b) };
  }

  /** Signatures a backfill stored (see mergeHistory). */
  private readonly historySeen = new BoundedSet<string>(200_000);

  private tagsFor(rec: TokenRecord, trader: string): TradeTag[] {
    const tags: TradeTag[] = rec.holders ? rec.holders.tagsOf(trader) : rec.creator === trader ? ["dev"] : [];
    if (rec.proTraders?.has(trader)) tags.push("pro");
    return tags;
  }

  /**
   * Rebuilds the candles of whole hour windows from every stored trade in them (all timeframes divide an hour,
   * so no bucket straddles two windows), plus in-memory trades not stored yet. Writes the rebuilt buckets and
   * returns them per timeframe, oldest first.
   */
  rebuildCandleWindows(
    mint: string,
    windows: readonly { from: number; to: number; rows: readonly TradeRow[] }[],
  ): Map<Timeframe, Candle[]> {
    const out = new Map<Timeframe, Candle[]>();
    const rec = this.tokens.get(mint);
    for (const w of windows) {
      const byId = new Map<string, CandleTrade>();
      for (const r of w.rows) {
        if (r.price_sol === null || !(r.price_sol > 0)) continue;
        byId.set(r.id, {
          tsMs: r.block_time,
          price: r.price_sol,
          volume: r.amount_sol ?? 0,
          key: [r.slot, r.tx_index ?? 0, r.ev_index],
          solUsd: null,
        });
      }
      for (const e of rec?.trades ?? []) {
        if (e.tsMs < w.from || e.tsMs >= w.to || !(e.priceSol > 0)) continue;
        byId.set(e.trade.id, { tsMs: e.tsMs, price: e.priceSol, volume: e.volumeSol, key: e.key, solUsd: e.solUsd });
      }
      for (const [tf, list] of this.candles.rebuildWindow(mint, w.from, w.to, [...byId.values()])) {
        for (const c of list) this.deps.storage?.candle(mint, tf, c);
        const acc = out.get(tf);
        if (acc) acc.push(...list);
        else out.set(tf, [...list]);
      }
    }
    for (const list of out.values()) list.sort((a, b) => a.t - b.t);
    return out;
  }

  /**
   * Rebuilds the holder book from the coin's complete trade list (from its creation on): balances, dev wallets,
   * snipers and bundlers as if every trade had been seen live. Needs a wallet on every trade (logs-only Raydium
   * trades have none). Returns false when it could not.
   */
  rebuildHolders(mint: string, rows: readonly TradeRow[]): boolean {
    const rec = this.tokens.get(mint);
    if (!rec || rec.createdSlot === null || !rows.length || rows.some((r) => !r.trader)) return false;
    const h = this.newHolderBook(rec.createdSlot);
    h.exclude(rec.bondingCurve);
    h.exclude(rec.pool);
    if (rec.launchpad === "launchlab") {
      h.exclude(RAYDIUM_LAUNCHLAB_AUTHORITY);
      h.exclude(RAYDIUM_CPMM_AUTHORITY);
    }
    h.addDev(rec.creatorAtCreate);
    h.addDev(rec.creator);
    const buyersOf = new Map<string, Set<string>>();
    for (const r of rows) {
      if (r.side !== 0) continue;
      const set = buyersOf.get(r.signature) ?? new Set<string>();
      set.add(r.trader);
      buyersOf.set(r.signature, set);
    }
    const sorted = [...rows].sort((a, b) => a.slot - b.slot || (a.tx_index ?? 0) - (b.tx_index ?? 0) || a.ev_index - b.ev_index);
    for (const r of sorted) {
      const amount = BigInt(r.token_amount);
      h.applyDelta(r.trader, r.side === 0 ? amount : -amount);
      if (r.side === 0) h.classifyBuy(r.trader, r.slot, buyersOf.get(r.signature) ?? new Set(), BigInt(r.quote_amount));
    }
    // keep a chain reconciliation's provenance off: the book is trade-based again
    rec.holders = h;
    for (const e of rec.trades) {
      const amount = BigInt(e.trade.tokenAmount);
      e.holderDelta = e.isBuy ? amount : -amount;
      e.trade = { ...e.trade, tags: this.tagsFor(rec, e.trade.trader) };
    }
    this.touch(rec);
    this.persist(rec, true);
    return true;
  }

  /** The coin's holder book holds more than its circulating supply (it missed sells or transfers out). */
  holdersOvercounted(mint: string): boolean {
    const rec = this.tokens.get(mint);
    return rec?.holders?.metrics(rec.supply, circulatingBound(rec)).overcounted ?? false;
  }

  /** Whether a transaction was applied (live or by a backfill) recently. */
  hasSeen(signature: string): boolean {
    return this.seen.get(signature) !== undefined;
  }

  /** The coin's record, created empty when unknown (a backfill of a coin never seen live fills it). */
  ensureToken(mint: string, init: Partial<TokenRecord> = {}): TokenRecord {
    const known = this.tokens.get(mint);
    if (known) return known;
    const rec = this.getOrCreate(mint, init);
    if (rec.launchpad === "pump") this.requestBootstrap(rec, true);
    this.touch(rec);
    return rec;
  }

  /** Trade-history coverage of a coin (history/service.ts): carried on its summary. */
  setHistory(mint: string, h: TokenHistory): void {
    const rec = this.tokens.get(mint);
    if (!rec) return;
    rec.history = h;
    this.touch(rec);
  }

  /** A stored trade row as a ring entry (no reserves: rollbacks fall back to the previous live entry). */
  static entryFromRow(r: TradeRow): TradeEntry {
    const trade = rowToTrade(r);
    const amount = BigInt(r.token_amount);
    return {
      trade,
      key: [r.slot, r.tx_index ?? 0, r.ev_index],
      tsMs: r.block_time,
      volumeSol: r.amount_sol ?? 0,
      isBuy: r.side === 0,
      holderDelta: r.side === 0 ? amount : -amount,
      curveAfter: null,
      poolAfter: null,
      priceSol: r.price_sol ?? 0,
      solUsd: null,
    };
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
    const t0 = performance.now();
    rec.lastPersistAt = now;
    this.deps.storage.token(rec, this.summary(rec.mint) as TokenSummary);
    perf.span("market.persist", performance.now() - t0);
  }

  // ---------------------------------------------------------------------------------------------
  // Raydium LaunchLab / CPMM
  // ---------------------------------------------------------------------------------------------

  /** Raydium events carry no timestamp: the block time when the source has it, else the receive time. */
  private raydiumTime(ctx: EvCtx): { tsMs: number; known: boolean } {
    return ctx.tx.blockTime !== null ? { tsMs: ctx.tx.blockTime * 1000, known: true } : { tsMs: ctx.tx.receivedAt, known: false };
  }

  private raydiumAccounts(ctx: EvCtx): RaydiumEventAccounts | undefined {
    return ctx.tx.raydium?.accounts[ctx.evIndex];
  }

  private parkRaydium<E>(map: Map<string, PendingRaydiumEvent<E>[]>, pool: string, ev: E, ctx: EvCtx, onFirst: () => void): void {
    if (this.hist) {
      this.hist.skipped++;
      return;
    }
    let list = map.get(pool);
    if (!list) {
      list = [];
      map.set(pool, list);
      onFirst();
    }
    if (list.length >= MAX_PENDING_PER_POOL || this.pendingTotal >= MAX_PENDING_TOTAL) {
      this.stats.pendingDropped++;
      return;
    }
    list.push({ ev, ctx });
    this.pendingTotal++;
  }

  private takeParked<E>(map: Map<string, PendingRaydiumEvent<E>[]>, pool: string): PendingRaydiumEvent<E>[] {
    const list = map.get(pool);
    if (!list) return [];
    map.delete(pool);
    this.pendingTotal -= list.length;
    return list;
  }

  /** Keeps the slot index complete for events applied after their transaction (dead-slot rollback). */
  private noteApplied(ctx: EvCtx, mint: string | null, create = false): void {
    if (!mint) return;
    const r = this.slotTxs.get(ctx.tx.slot)?.find((x) => x.signature === ctx.tx.signature);
    r?.mints.add(mint);
    if (create) r?.creates.push(mint);
  }

  /** Pump-shaped curve of a LaunchLab PoolState (see market/token.ts). */
  private launchLabCurveOf(st: NonNullable<LaunchLabPoolInfo["state"]>): CurveReserves {
    return {
      vToken: st.virtualBase - st.realBase,
      vQuote: st.virtualQuote + st.realQuote,
      rToken: max0(st.totalBaseSell - st.realBase),
      rQuote: st.realQuote,
    };
  }

  /** Merges what an event / account revealed into the coin's LaunchLab constants (label, progress basis). */
  private launchLabOf(rec: TokenRecord, pool: string, patch: Partial<LaunchLabRecord>): LaunchLabRecord {
    const prev = rec.launchLab && rec.launchLab.pool === pool ? rec.launchLab : null;
    const next: LaunchLabRecord = {
      pool,
      virtualBase: null,
      virtualQuote: null,
      totalBaseSell: null,
      totalQuoteFundRaising: null,
      migrateType: null,
      globalConfig: null,
      platformConfig: null,
      graduationPool: null,
      ...prev,
      ...(Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null && v !== undefined)) as Partial<LaunchLabRecord>),
    };
    const platformChanged = next.platformConfig !== (prev?.platformConfig ?? null);
    rec.launchLab = next;
    if (next.totalBaseSell !== null && next.totalBaseSell > 0n) rec.initialRealTokenReserves = next.totalBaseSell;
    if (next.platformConfig && (platformChanged || rec.platform === null)) {
      const label = this.deps.raydium?.platformLabel(next.platformConfig) ?? null;
      if (label && label !== rec.platform) {
        rec.platform = label;
        this.touch(rec);
      }
    }
    if (!rec.migrated && (next.graduationPool === null || platformChanged)) this.deriveGraduation(rec);
    return next;
  }

  /** Derives the coin's graduation pool from the live PlatformConfig (asynchronous; cached by the registry). */
  private deriveGraduation(rec: TokenRecord): void {
    const reg = this.deps.raydium;
    const ll = rec.launchLab;
    if (!reg || !ll) return;
    const cached = reg.graduationPool(ll.pool);
    if (cached !== null) {
      this.setGraduationPool(rec, cached);
      return;
    }
    reg
      .deriveGraduationPool(ll.pool)
      .then((p) => {
        if (p) this.setGraduationPool(rec, p);
      })
      .catch(() => {});
  }

  private setGraduationPool(rec: TokenRecord, pool: string): void {
    if (!rec.launchLab || rec.launchLab.graduationPool === pool || (rec.migrated && rec.pool !== pool)) return;
    rec.launchLab = { ...rec.launchLab, graduationPool: pool };
    this.changes.tradeCtx.add(rec.mint);
  }

  private setLaunchLabCreator(rec: TokenRecord, creator: string | null | undefined): void {
    if (!creator || creator === DEFAULT_PUBKEY) return;
    rec.creator = creator;
    rec.holders?.addDev(creator);
  }

  /** What the trader's balance moved by: Token-2022 transfer fees are withheld on the trader's side. */
  private userTokenAmount(cfg: TransferFeeConfig | null, slot: number, isBuy: boolean, vaultAmount: bigint): bigint {
    if (!cfg) return vaultAmount;
    const epoch = BigInt(slot) / MAINNET_SLOTS_PER_EPOCH;
    try {
      return isBuy ? vaultAmount - transferFeeFor(cfg, epoch, vaultAmount) : vaultAmount + transferInverseFeeFor(cfg, epoch, vaultAmount);
    } catch {
      return vaultAmount;
    }
  }

  private onLaunchLabCreate(ev: LaunchLabPoolCreateEvent, ctx: EvCtx): string | null {
    const acc = this.raydiumAccounts(ctx);
    const reg = this.deps.raydium;
    if (acc?.kind === "launchlabCreate") {
      reg?.learnLaunchLabPool({
        pool: ev.pool,
        baseMint: acc.baseMint,
        quoteMint: acc.quoteMint,
        globalConfig: acc.globalConfig,
        platformConfig: acc.platformConfig,
        baseVault: acc.baseVault,
        quoteVault: acc.quoteVault,
        baseTokenProgram: acc.baseTokenProgram,
        quoteTokenProgram: acc.quoteTokenProgram,
        creator: ev.creator,
      });
      return this.applyLaunchLabCreate(ev, ctx, acc.baseMint, acc.quoteMint, acc);
    }
    const info = reg?.launchLabPools.get(ev.pool);
    if (info) return this.applyLaunchLabCreate(ev, ctx, info.baseMint, info.quoteMint);
    if (reg) this.parkRaydium(this.pendingLaunchLab, ev.pool, ev, ctx, () => reg.requestLaunchLabPool(ev.pool));
    return null;
  }

  private applyLaunchLabCreate(
    ev: LaunchLabPoolCreateEvent,
    ctx: EvCtx,
    baseMint: string,
    quoteMint: string,
    acc?: Extract<RaydiumEventAccounts, { kind: "launchlabCreate" }>,
  ): string {
    const info = this.deps.raydium?.launchLabPools.get(ev.pool);
    const { tsMs, known } = this.raydiumTime(ctx);
    const rec = this.getOrCreate(baseMint);
    Object.assign(rec, {
      name: ev.name,
      symbol: ev.symbol,
      uri: ev.uri || null,
      launchpad: "launchlab",
      decimals: ev.decimals,
      supply: rec.supplyExact || ev.supply <= 0n ? rec.supply : ev.supply,
      tokenProgram: acc?.baseTokenProgram ?? info?.baseTokenProgram ?? rec.tokenProgram,
      createdAt: tsMs,
      createdSlot: ctx.tx.slot,
      createSignature: ctx.tx.signature,
      createUser: acc?.payer ?? ev.creator,
      creatorAtCreate: ev.creator,
    } satisfies Partial<TokenRecord>);
    this.launchLabOf(rec, ev.pool, {
      totalBaseSell: ev.curveType === 0 && ev.totalBaseSell > 0n ? ev.totalBaseSell : null,
      totalQuoteFundRaising: ev.totalQuoteFundRaising,
      migrateType: ev.migrateType,
      globalConfig: acc?.globalConfig ?? info?.globalConfig ?? ev.config,
      platformConfig: acc?.platformConfig ?? info?.platformConfig ?? null,
      ...(info?.state ? { virtualBase: info.state.virtualBase, virtualQuote: info.state.virtualQuote } : {}),
    });
    this.setQuote(rec, quoteMint, info?.state?.quoteDecimals ?? null, acc?.quoteTokenProgram ?? info?.quoteTokenProgram ?? null);
    // A trade that arrived before its create (out of order) already set newer reserves: keep them.
    if (!rec.curveKey && info?.state) rec.curve = this.launchLabCurveOf(info.state);
    if (!rec.creator) this.setLaunchLabCreator(rec, ev.creator);
    if (ctx.tx.accountKeys) rec.proTraders ??= new Set();
    if (!this.hist) {
      if (!rec.holders) {
        rec.holders = this.newHolderBook(ctx.tx.slot);
        // vault owners: the LaunchLab authority on the curve, the CPMM authority after graduation
        rec.holders.exclude(RAYDIUM_LAUNCHLAB_AUTHORITY);
        rec.holders.exclude(RAYDIUM_CPMM_AUTHORITY);
      }
      rec.holders.addDev(ev.creator);
      this.stats.launches++;
      this.stats.launchLabLaunches++;
      this.deps.onLaunch?.(rec);
      const latency = ctx.tx.receivedAt - tsMs;
      if (known) this.launchLatency.add(latency);
      this.changes.feed.push({
        kind: "launch",
        mint: baseMint,
        symbol: ev.symbol,
        name: ev.name,
        signature: ctx.tx.signature,
        slot: ctx.tx.slot,
        blockTime: tsMs,
        receivedAt: ctx.tx.receivedAt,
        latencyMs: latency,
        venue: "launchlab",
      });
    }
    if (rec.uri && rec.metadataState === "none") {
      rec.metadataState = "requested";
      this.deps.requestMetadata?.(rec.mint, rec.uri);
    }
    this.touch(rec);
    this.changes.tradeCtx.add(rec.mint);
    this.persist(rec, true);
    return rec.mint;
  }

  private onLaunchLabTrade(ev: LaunchLabTradeEvent, ctx: EvCtx): string | null {
    const acc = this.raydiumAccounts(ctx);
    const reg = this.deps.raydium;
    if (acc?.kind === "launchlabSwap") {
      reg?.learnLaunchLabPool({
        pool: ev.pool,
        baseMint: acc.baseMint,
        quoteMint: acc.quoteMint,
        globalConfig: acc.globalConfig,
        platformConfig: acc.platformConfig,
        baseVault: acc.baseVault,
        quoteVault: acc.quoteVault,
        baseTokenProgram: acc.baseTokenProgram,
        quoteTokenProgram: acc.quoteTokenProgram,
      });
      return this.applyLaunchLabTrade(ev, ctx, acc.baseMint, acc.quoteMint, acc);
    }
    const info = reg?.launchLabPools.get(ev.pool);
    if (info) return this.applyLaunchLabTrade(ev, ctx, info.baseMint, info.quoteMint);
    if (reg) this.parkRaydium(this.pendingLaunchLab, ev.pool, ev, ctx, () => reg.requestLaunchLabPool(ev.pool));
    return null;
  }

  private applyLaunchLabTrade(
    ev: LaunchLabTradeEvent,
    ctx: EvCtx,
    baseMint: string,
    quoteMint: string,
    acc?: Extract<RaydiumEventAccounts, { kind: "launchlabSwap" }>,
  ): string {
    const info = this.deps.raydium?.launchLabPools.get(ev.pool);
    const { tsMs, known } = this.raydiumTime(ctx);
    const rec = this.getOrCreate(baseMint, {
      launchpad: "launchlab",
      decimals: info?.state?.baseDecimals ?? PUMP_TOKEN_DECIMALS,
      tokenProgram: acc?.baseTokenProgram ?? info?.baseTokenProgram ?? null,
      ...(info?.state ? { supply: info.state.supply } : {}),
    });
    rec.launchpad = "launchlab";
    rec.tokenProgram ??= acc?.baseTokenProgram ?? info?.baseTokenProgram ?? null;
    this.launchLabOf(rec, ev.pool, {
      virtualBase: ev.virtualBase,
      virtualQuote: ev.virtualQuote,
      totalBaseSell: ev.totalBaseSell > 0n ? ev.totalBaseSell : null,
      globalConfig: acc?.globalConfig ?? info?.globalConfig,
      platformConfig: acc?.platformConfig ?? info?.platformConfig,
    });
    if (rec.quoteMint !== normalizeQuoteMint(quoteMint) || rec.quoteTokenProgram === null) {
      this.setQuote(rec, quoteMint, info?.state?.quoteDecimals ?? null, acc?.quoteTokenProgram ?? info?.quoteTokenProgram ?? null);
    }
    if (rec.createdAt === null) this.requestBootstrap(rec, false);
    if (!rec.creator && info?.creator) this.setLaunchLabCreator(rec, info.creator);
    const after: CurveReserves = {
      vToken: ev.virtualBase - ev.realBaseAfter,
      vQuote: ev.virtualQuote + ev.realQuoteAfter,
      rToken: max0(ev.totalBaseSell - ev.realBaseAfter),
      rQuote: ev.realQuoteAfter,
    };
    const latest = !rec.curveKey || cmpKey(ctx.key, rec.curveKey) >= 0;
    let completedNow = false;
    if (latest) {
      rec.curve = after;
      rec.curveKey = ctx.key;
      rec.curveSlot = ctx.tx.slot;
      // pool_status 1: the last base was sold; Raydium's migration wallet graduates it to CPMM.
      if ((ev.poolStatus !== LAUNCHLAB_POOL_STATUS.fund || after.rToken === 0n) && !rec.complete) {
        rec.complete = true;
        rec.completedAt = tsMs;
        completedNow = true;
        if (!this.hist) {
          this.stats.completes++;
          this.stats.launchLabCompletes++;
          this.changes.feed.push(this.feedItem("complete", rec, ctx, tsMs));
        }
        this.deriveGraduation(rec);
      }
      this.changes.tradeCtx.add(rec.mint);
    }
    // Curve movement excluding fees (the TradeEvent's amounts include them), like pump's sol_amount.
    const fees = ev.protocolFee + ev.platformFee + ev.creatorFee + ev.shareFee;
    const quoteAmount = ev.isBuy ? max0(ev.amountIn - fees) : ev.amountOut + fees;
    const tokenAmount = this.userTokenAmount(rec.transferFeeConfig, ctx.tx.slot, ev.isBuy, ev.isBuy ? ev.amountOut : ev.amountIn);
    if (!this.hist) this.stats.launchLabTrades++;
    this.recordTrade(rec, ctx, {
      venue: "launchlab",
      isBuy: ev.isBuy,
      trader: acc?.payer ?? "",
      quoteAmount,
      tokenAmount,
      tsMs,
      quoteMint: rec.quoteMint,
      quoteDecimals: rec.quoteDecimals,
      priceQuote: after.vToken > 0n ? ui(after.vQuote, rec.quoteDecimals) / ui(after.vToken, rec.decimals) : 0,
      curveAfter: after,
      poolAfter: null,
      latest,
      tsKnown: known,
    });
    if (completedNow) this.persist(rec, true);
    return rec.mint;
  }

  /** migrate_to_cpswap (gRPC / fetched transactions): the coin graduated into its CPMM pool. */
  private onLaunchLabMigrate(m: LaunchLabMigration, ctx: EvCtx): string {
    const reg = this.deps.raydium;
    reg?.learnLaunchLabPool(
      { pool: m.pool, baseMint: m.baseMint, quoteMint: m.quoteMint, globalConfig: m.globalConfig, platformConfig: m.platformConfig },
      false,
    );
    reg?.learnCpmmPool(m.cpmmPool, { baseMint: m.baseMint, quoteMint: m.quoteMint, launchLabPool: m.pool });
    const known = this.tokens.get(m.baseMint);
    const rec = known ?? this.getOrCreate(m.baseMint, { launchpad: "launchlab" });
    rec.launchpad = "launchlab";
    if (!known) this.requestBootstrap(rec, false);
    this.launchLabOf(rec, m.pool, { globalConfig: m.globalConfig, platformConfig: m.platformConfig, migrateType: 1 });
    if (rec.quoteMint !== normalizeQuoteMint(m.quoteMint) || rec.quoteTokenProgram === null) this.setQuote(rec, m.quoteMint);
    if (m.baseVaultAmount !== null && m.quoteVaultAmount !== null && (!rec.poolKey || cmpKey(ctx.key, rec.poolKey) >= 0)) {
      // A new pool owes no fees yet: its vault balances are its reserves.
      rec.poolState = { base: m.baseVaultAmount, quoteVault: m.quoteVaultAmount, virtualQuote: 0n };
      rec.poolKey = ctx.key;
    }
    rec.poolSlot = ctx.tx.slot;
    this.markGraduated(rec, m.cpmmPool, ctx, this.raydiumTime(ctx).tsMs);
    return rec.mint;
  }

  /**
   * The coin trades on its CPMM graduation pool now. `at` = graduation time (null = unknown: it graduated
   * before the server watched it); `ctx` = the transaction that showed it (feed item).
   */
  private markGraduated(rec: TokenRecord, cpmmPool: string, ctx: EvCtx | null, at: number | null): void {
    if (rec.migrated && rec.pool === cpmmPool) return;
    rec.complete = true;
    rec.completedAt ??= at;
    rec.migrated = true;
    rec.migratedAt = at;
    rec.pool = cpmmPool;
    if (rec.launchLab) rec.launchLab = { ...rec.launchLab, graduationPool: cpmmPool };
    rec.holders?.exclude(RAYDIUM_CPMM_AUTHORITY);
    if (!this.hist) {
      if (at !== null) {
        this.stats.migrations++;
        this.stats.launchLabGraduations++;
      } else this.stats.launchLabGraduatesFound++;
      if (ctx) this.changes.feed.push(this.feedItem("migration", rec, ctx, at ?? ctx.tx.receivedAt));
    }
    this.touch(rec);
    this.changes.tradeCtx.add(rec.mint);
    this.persist(rec, true);
    if (!this.hist) this.deps.onMigrate?.(rec);
  }

  /**
   * The server watched this coin trade on its curve recently, so a graduation found now (pool read, hint)
   * happened about now; otherwise its time is unknown (null), e.g. it graduated while the server was down.
   */
  private watchedOnCurve(rec: TokenRecord): boolean {
    return rec.launchLab !== null && rec.curve !== null && rec.lastTradeAt !== null && this.now() - rec.lastTradeAt < 30 * 60_000;
  }

  /** A tracked LaunchLab coin whose derived graduation pool `pool` is (logs-only graduations). */
  private graduatedInto(pool: string, a: string, b: string): string | undefined {
    for (const m of [a, b]) {
      if (isDefault(m)) continue;
      if (this.tokens.get(m)?.launchLab?.graduationPool === pool) return m;
    }
    return undefined;
  }

  private onCpmmSwap(ev: CpmmSwapEvent, ctx: EvCtx): string | null {
    const acc = this.raydiumAccounts(ctx);
    const a = acc?.kind === "cpmmSwap" ? acc : undefined;
    const reg = this.deps.raydium;
    const inputMint = a?.inputMint ?? ev.inputMint;
    const outputMint = a?.outputMint ?? ev.outputMint;
    const base = reg?.baseMintOf(ev.pool) ?? this.graduatedInto(ev.pool, inputMint, outputMint);
    if (base) return this.applyCpmmSwap(ev, ctx, base, inputMint, outputMint, a);
    if (this.hist) {
      if (this.hist.coin.cpmmPool === ev.pool) return this.applyCpmmSwap(ev, ctx, this.hist.coin.mint, inputMint, outputMint, a);
      this.hist.skipped++;
      return null;
    }
    if (!reg || isDefault(inputMint) || isDefault(outputMint) || reg.isRejected(ev.pool)) {
      this.stats.cpmmIgnored++;
      return null;
    }
    // Maybe the graduation pool of a LaunchLab coin the server has not seen: classify it once.
    if (reg.classifyCpmmPool(ev.pool, inputMint, outputMint) === "pending") this.parkRaydium(this.pendingCpmm, ev.pool, ev, ctx, () => {});
    else this.stats.cpmmIgnored++;
    return null;
  }

  private applyCpmmSwap(
    ev: CpmmSwapEvent,
    ctx: EvCtx,
    baseMint: string,
    inputMint: string,
    outputMint: string,
    acc?: Extract<RaydiumEventAccounts, { kind: "cpmmSwap" }>,
  ): string | null {
    if (isDefault(inputMint) && isDefault(outputMint)) {
      this.stats.cpmmIgnored++;
      return null;
    }
    const reg = this.deps.raydium;
    const info = reg?.cpmmPools.get(ev.pool);
    const st = info?.state;
    const { tsMs, known } = this.raydiumTime(ctx);
    const isBuy = isDefault(outputMint) ? inputMint !== baseMint : outputMint === baseMint;
    const quoteMint = isBuy ? inputMint : outputMint;
    const sideOf = (mint: string) =>
      st
        ? st.token0Mint === mint
          ? { dec: st.mint0Decimals, prog: st.token0Program }
          : { dec: st.mint1Decimals, prog: st.token1Program }
        : null;
    let rec = this.tokens.get(baseMint);
    if (!rec) {
      const b = sideOf(baseMint);
      rec = this.getOrCreate(baseMint, { launchpad: "launchlab", decimals: b?.dec ?? PUMP_TOKEN_DECIMALS, tokenProgram: b?.prog ?? null });
      this.requestBootstrap(rec, false);
    }
    rec.launchpad = "launchlab";
    if (!rec.launchLab) {
      // First seen on its CPMM pool: link the LaunchLab pool it graduated from (platform label, history).
      const ll = info?.launchLabPool ?? reg?.poolOfMint(baseMint)?.pool;
      const llInfo = ll ? reg?.launchLabPools.get(ll) : undefined;
      if (ll) {
        this.launchLabOf(rec, ll, {
          globalConfig: llInfo?.globalConfig,
          platformConfig: llInfo?.platformConfig,
          migrateType: 1,
          graduationPool: ev.pool,
          ...(llInfo?.state
            ? {
                virtualBase: llInfo.state.virtualBase,
                virtualQuote: llInfo.state.virtualQuote,
                totalBaseSell: llInfo.state.totalBaseSell,
                totalQuoteFundRaising: llInfo.state.totalQuoteFundRaising,
              }
            : {}),
        });
        if (!rec.creator) this.setLaunchLabCreator(rec, llInfo?.creator);
      }
    }
    if (!rec.migrated || rec.pool !== ev.pool) {
      // First swap on its graduation pool. A coin watched on the curve graduated now (the logs feed saw no
      // migrate_to_cpswap); otherwise it graduated before the server watched it (time unknown).
      const at = rec.launchLab && rec.curve && !rec.migrated ? tsMs : null;
      reg?.learnCpmmPool(ev.pool, { baseMint, quoteMint, launchLabPool: rec.launchLab?.pool ?? null });
      this.markGraduated(rec, ev.pool, at !== null ? ctx : null, at);
    }
    if (!isDefault(quoteMint) && (rec.quoteMint !== normalizeQuoteMint(quoteMint) || rec.quoteTokenProgram === null)) {
      const q = sideOf(quoteMint);
      this.setQuote(rec, quoteMint, q?.dec ?? null, q?.prog ?? (acc ? (isBuy ? acc.inputTokenProgram : acc.outputTokenProgram) : null));
    }
    // Reserves after the swap, net of the fees the pool now owes (what the next swap prices with).
    const cfg = st ? reg?.ammConfigs.get(st.ammConfig) : undefined;
    const share = (rate: bigint | undefined) => (rate ? (ev.tradeFee * rate) / RAYDIUM_FEE_RATE_DENOMINATOR : 0n);
    const inAfter =
      ev.inputVaultBefore +
      ev.inputAmount -
      share(cfg?.protocolFeeRate) -
      share(cfg?.fundFeeRate) -
      (ev.creatorFeeOnInput ? ev.creatorFee : 0n);
    const outAfter = ev.outputVaultBefore - ev.outputAmount - (ev.creatorFeeOnInput ? 0n : ev.creatorFee);
    const poolAfter: PoolReserves = isBuy
      ? { base: max0(outAfter), quoteVault: max0(inAfter), virtualQuote: 0n }
      : { base: max0(inAfter), quoteVault: max0(outAfter), virtualQuote: 0n };
    const primary = rec.pool === ev.pool;
    const latest = primary && (!rec.poolKey || cmpKey(ctx.key, rec.poolKey) >= 0);
    if (latest) {
      rec.poolState = poolAfter;
      rec.poolKey = ctx.key;
      rec.poolSlot = ctx.tx.slot;
      this.changes.tradeCtx.add(rec.mint);
    }
    // Quote that entered / left the reserves (the trade fee is on the input side); tokens the trader
    // received / sent (Token-2022 transfer fees on the trader's side).
    const quoteAmount = isBuy
      ? max0(ev.inputAmount - ev.tradeFee - (ev.creatorFeeOnInput ? ev.creatorFee : 0n))
      : ev.outputAmount + (ev.creatorFeeOnInput ? 0n : ev.creatorFee);
    const tokenAmount = isBuy ? max0(ev.outputAmount - ev.outputTransferFee) : ev.inputAmount + ev.inputTransferFee;
    if (!this.hist) this.stats.cpmmTrades++;
    this.recordTrade(rec, ctx, {
      venue: "cpmm",
      isBuy,
      trader: acc?.payer ?? "",
      quoteAmount,
      tokenAmount,
      tsMs,
      quoteMint: rec.quoteMint,
      quoteDecimals: rec.quoteDecimals,
      priceQuote:
        poolAfter.base > 0n && poolAfter.quoteVault > 0n
          ? ui(poolAfter.quoteVault, rec.quoteDecimals) / ui(poolAfter.base, rec.decimals)
          : 0,
      curveAfter: null,
      poolAfter: primary ? poolAfter : null,
      latest,
      tsKnown: known,
    });
    return rec.mint;
  }

  /** The registry read a LaunchLab pool: update the coin, apply waiting events, catch a missed graduation. */
  onLaunchLabPoolReady(info: LaunchLabPoolInfo): void {
    const rec = this.tokens.get(info.baseMint);
    const st = info.state;
    if (rec && st && rec.launchpad === "launchlab") {
      this.launchLabOf(rec, info.pool, {
        virtualBase: st.virtualBase,
        virtualQuote: st.virtualQuote,
        totalBaseSell: st.totalBaseSell > 0n ? st.totalBaseSell : null,
        totalQuoteFundRaising: st.totalQuoteFundRaising,
        migrateType: st.migrateType,
        globalConfig: st.globalConfig,
        platformConfig: st.platformConfig,
      });
      if (!rec.creator) this.setLaunchLabCreator(rec, st.creator);
      rec.tokenProgram ??= info.baseTokenProgram;
      rec.decimals = st.baseDecimals;
      if (!rec.supplyExact && st.supply > 0n) rec.supply = st.supply;
      this.setQuote(rec, st.quoteMint, st.quoteDecimals, info.quoteTokenProgram);
      // No trade applied yet (or restored from storage): the account is the freshest curve.
      if (!rec.curveKey && !rec.migrated) rec.curve = this.launchLabCurveOf(st);
      if (st.status !== LAUNCHLAB_POOL_STATUS.fund && !rec.complete) rec.complete = true;
      if (st.status === LAUNCHLAB_POOL_STATUS.trade && !rec.migrated) {
        // Graduated without the server seeing migrate_to_cpswap (logs feed, transaction not fetched).
        const reg = this.deps.raydium;
        const watched = this.watchedOnCurve(rec);
        reg
          ?.deriveGraduationPool(info.pool)
          .then((pool) => {
            if (!pool || rec.migrated) return;
            reg.learnCpmmPool(pool, { baseMint: rec.mint, quoteMint: info.quoteMint, launchLabPool: info.pool });
            this.markGraduated(rec, pool, null, watched ? this.now() : null);
          })
          .catch(() => {});
      }
      this.touch(rec);
      this.changes.tradeCtx.add(rec.mint);
    }
    for (const p of this.takeParked(this.pendingLaunchLab, info.pool)) {
      const mint =
        p.ev.kind === "launchlabTrade"
          ? this.applyLaunchLabTrade(p.ev, p.ctx, info.baseMint, info.quoteMint)
          : this.applyLaunchLabCreate(p.ev, p.ctx, info.baseMint, info.quoteMint);
      this.noteApplied(p.ctx, mint, p.ev.kind === "launchlabPoolCreate");
    }
  }

  /** The LaunchLab pool account is missing (or is not one): drop what waited for it. */
  onLaunchLabPoolMissing(pool: string): void {
    this.stats.pendingDropped += this.takeParked(this.pendingLaunchLab, pool).length;
  }

  /** The registry read a graduation pool (account + vaults): apply waiting swaps, link the coin. */
  onCpmmPoolReady(info: CpmmPoolInfo): void {
    for (const p of this.takeParked(this.pendingCpmm, info.pool)) {
      const acc = p.ctx.tx.raydium?.accounts[p.ctx.evIndex];
      const a = acc?.kind === "cpmmSwap" ? acc : undefined;
      const mint = this.applyCpmmSwap(p.ev, p.ctx, info.baseMint, a?.inputMint ?? p.ev.inputMint, a?.outputMint ?? p.ev.outputMint, a);
      this.noteApplied(p.ctx, mint);
    }
    const rec = this.tokens.get(info.baseMint);
    if (rec) {
      if (!rec.migrated || rec.pool !== info.pool) this.markGraduated(rec, info.pool, null, this.watchedOnCurve(rec) ? this.now() : null);
      const st = info.state;
      const baseIs0 = st.token0Mint === info.baseMint;
      rec.tokenProgram ??= baseIs0 ? st.token0Program : st.token1Program;
      this.setQuote(rec, info.quoteMint, baseIs0 ? st.mint1Decimals : st.mint0Decimals, baseIs0 ? st.token1Program : st.token0Program);
      if (!rec.poolKey && info.vault0 !== null && info.vault1 !== null) {
        try {
          const net = cpmmVaultAmountsWithoutFees(st, info.vault0, info.vault1);
          rec.poolState = { base: baseIs0 ? net.token0 : net.token1, quoteVault: baseIs0 ? net.token1 : net.token0, virtualQuote: 0n };
        } catch {
          /* vault below fees owed: wait for a swap */
        }
      }
      this.touch(rec);
      this.changes.tradeCtx.add(rec.mint);
    }
  }

  /** Not a graduation pool: drop the swaps that waited for the answer. */
  onCpmmRejected(pool: string): void {
    const n = this.takeParked(this.pendingCpmm, pool).length;
    this.stats.cpmmIgnored += n;
  }

  /** A PlatformConfig was (re)read: labels, and graduation pools (cpswap_config may have changed). */
  onPlatformConfig(address: string): void {
    const label = this.deps.raydium?.platformLabel(address) ?? null;
    for (const rec of this.tokens.values()) {
      if (rec.launchLab?.platformConfig !== address) continue;
      if (label && label !== rec.platform) {
        rec.platform = label;
        this.touch(rec);
      }
      if (!rec.migrated) this.deriveGraduation(rec);
      this.changes.tradeCtx.add(rec.mint);
    }
  }

  /** The logs feed saw a graduation it could not read: re-check the completed LaunchLab curves. */
  onLaunchLabMigrationHint(): void {
    for (const rec of this.tokens.values()) {
      if (rec.launchLab && rec.complete && !rec.migrated) this.deps.raydium?.requestLaunchLabPool(rec.launchLab.pool, true);
    }
  }

  /**
   * RPC logs source: is this Raydium transaction worth a getTransaction (wallet, mints, graduation)? Every
   * LaunchLab event and graduation; CPMM swaps only for coins that graduated on the server's watch (or whose
   * derived pool trades for the first time). Swaps on older graduates found later stay logs-only: they would
   * outrun the public RPC's getTransaction budget (measured 2026-10-04).
   */
  wantsRaydiumTx(events: readonly DecodedEvent[], migration: boolean): boolean {
    if (migration) return true;
    for (const ev of events) {
      if (ev.kind === "launchlabTrade" || ev.kind === "launchlabPoolCreate") return true;
      if (ev.kind !== "cpmmSwap") continue;
      if (this.graduatedInto(ev.pool, ev.inputMint, ev.outputMint)) return true;
      const mint = this.deps.raydium?.baseMintOf(ev.pool);
      const rec = mint ? this.tokens.get(mint) : undefined;
      if (rec?.migrated && rec.pool === ev.pool && rec.migratedAt !== null) return true;
    }
    return false;
  }

  /** Base mint of a LaunchLab or graduation CPMM pool (the armed-order engine's pool -> mint). */
  raydiumBaseMint(pool: string): string | undefined {
    return this.deps.raydium?.baseMintOf(pool);
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
          this.changes.token(mint, Date.now());
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

  /**
   * An image to show while the metadata can't be had (pump.fun's CDN for a pump coin). Only when the token
   * has no image and its metadata isn't in; real metadata replaces it. True when it was applied.
   */
  setFallbackImage(mint: string, image: string): boolean {
    const rec = this.tokens.get(mint);
    if (!rec || rec.image || rec.metadataState === "ok") return false;
    rec.image = image;
    this.touch(rec);
    this.persist(rec, true);
    return true;
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
    if (this.quoteRequests.has(info.mint)) {
      // an exotic quote mint: fix decimals / token program of every token quoted in it
      this.quoteMintInfo.set(info.mint, {
        decimals: info.decimals,
        tokenProgram: info.tokenProgram,
        transferFeeConfig: info.transferFeeConfig ?? null,
      });
      for (const rec of this.tokens.values()) {
        if (rec.quoteMint === info.mint && rec.quoteMint !== rec.mint) {
          rec.quoteDecimals = info.decimals;
          rec.quoteTokenProgram = info.tokenProgram;
          this.touch(rec);
          this.changes.tradeCtx.add(rec.mint);
        }
      }
    }
    const rec = this.tokens.get(info.mint);
    if (!rec) return;
    rec.tokenProgram = info.tokenProgram;
    rec.decimals = info.decimals;
    if (info.supply > 0n) {
      rec.supply = info.supply;
      rec.supplyExact = true;
    }
    rec.transferFeeConfig = info.transferFeeConfig ?? null;
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
    if (r.curve.tokenTotalSupply > 0n) {
      rec.curveTokenTotalSupply = r.curve.tokenTotalSupply;
      // The mint account (often resolved in the same batch, just before) wins over the curve's figure.
      if (!rec.supplyExact) rec.supply = curveMintSupply(r.curve);
    }
    if (r.curve.complete && !rec.complete) rec.complete = true;
    if (!rec.creator) this.setCreator(rec, r.curve.creator, "curve");
    // No trade applied yet (a coin opened by address, or discovered for a backfill): the account is the freshest
    // curve. Anchored at the read's slot so a backfilled (older) trade never takes over the price.
    if (!rec.curveKey && r.curve.virtualTokenReserves > 0n) {
      rec.curve = {
        vToken: r.curve.virtualTokenReserves,
        vQuote: r.curve.virtualQuoteReserves,
        rToken: r.curve.realTokenReserves,
        rQuote: r.curve.realQuoteReserves,
      };
      if (r.slot !== undefined) {
        rec.curveKey = anchorKey(r.slot);
        rec.curveSlot = r.slot;
      }
    }
    this.touch(rec);
    this.changes.tradeCtx.add(rec.mint);
  }

  // ---------------------------------------------------------------------------------------------
  // on-demand resolve (market/resolve.ts): a coin opened by address, seeded from chain accounts
  // ---------------------------------------------------------------------------------------------

  /** A LaunchLab coin's record (created when unknown), linked to its pool; the pool account fills the rest. */
  ensureLaunchLabToken(mint: string, pool: string, quoteMint: string): TokenRecord {
    const rec = this.getOrCreate(mint, { launchpad: "launchlab", bootstrapRequested: true });
    rec.launchpad = "launchlab";
    this.launchLabOf(rec, pool, {});
    this.setQuote(rec, quoteMint);
    this.touch(rec);
    return rec;
  }

  /** A coin with no venue the server decodes but a Jupiter route ("other": no price, no trade context). */
  ensureOtherToken(mint: string): TokenRecord {
    const rec = this.getOrCreate(mint, { launchpad: "other", bootstrapRequested: true });
    this.touch(rec);
    return rec;
  }

  /**
   * A Jupiter quote for a Jupiter-only coin: `inLamports` SOL buys `outAmount` base units (market/jupiterPrice.ts).
   * Sets its price (and so its market cap, from the mint supply); ignored for coins priced from reserves.
   */
  setJupiterQuote(mint: string, inLamports: bigint, outAmount: bigint, at: number): void {
    const rec = this.tokens.get(mint);
    if (rec?.launchpad !== "other") return;
    const priceSol = priceSolFromQuote(inLamports, outAmount, rec.decimals);
    if (priceSol === null) return;
    rec.quotePrice = { priceSol, at };
    const mcSol = priceSol * ui(rec.supply, rec.decimals);
    if (mcSol > rec.athMcSol) rec.athMcSol = mcSol;
    this.touch(rec);
  }

  /**
   * PumpSwap pool reserves read from the pool account and its vaults (PumpSwap vaults hold exactly the
   * reserves; virtual_quote_reserves is signed and added to the quote side). Kept only when no swap set newer ones.
   */
  seedPoolReserves(mint: string, pool: string, base: bigint, quoteVault: bigint, virtualQuote: bigint, slot: number): void {
    const rec = this.tokens.get(mint);
    if (!rec || rec.pool !== pool) return;
    if (rec.poolKey && cmpKey(rec.poolKey, anchorKey(slot)) >= 0) return;
    rec.poolState = { base, quoteVault, virtualQuote };
    rec.poolKey = anchorKey(slot);
    rec.poolSlot = slot;
    rec.holders?.exclude(pool);
    this.touch(rec);
    this.changes.tradeCtx.add(mint);
  }

  /** Reserves taken from accounts without a key (LaunchLab / CPMM reads) are anchored at `slot`. */
  anchorReserves(mint: string, slot: number): void {
    const rec = this.tokens.get(mint);
    if (!rec) return;
    if (rec.curve && !rec.curveKey) {
      rec.curveKey = anchorKey(slot);
      rec.curveSlot ??= slot;
    }
    if (rec.poolState && !rec.poolKey) {
      rec.poolKey = anchorKey(slot);
      rec.poolSlot ??= slot;
    }
  }

  /** A pruned record reloaded from storage: its persisted reserves predate the reload, the chain read replaces them. */
  forgetReserveKeys(mint: string): void {
    const rec = this.tokens.get(mint);
    if (!rec) return;
    rec.curveKey = null;
    rec.poolKey = null;
  }

  /** Republishes a record (summary and trade context) and keeps it fresh for the idle eviction. */
  publishToken(mint: string): void {
    const rec = this.tokens.get(mint);
    if (!rec) return;
    this.touch(rec);
    this.changes.tradeCtx.add(mint);
  }

  /** DexScreener verdict. An approved token profile does not revert, so a paid token stays paid. */
  setDexPaid(mint: string, paid: boolean, paidAt: number | null): void {
    const rec = this.tokens.get(mint);
    if (!rec || (rec.dexPaid === true && !paid)) return;
    const at = paid ? paidAt : null;
    if (rec.dexPaid === paid && rec.dexPaidAt === at) return;
    rec.dexPaid = paid;
    rec.dexPaidAt = at;
    this.touch(rec);
    if (paid) this.persist(rec, true);
  }

  /** Dev history (earlier launches by the creator in our database, and how many migrated). */
  setDevHistory(mint: string, launches: number, migrated: number): void {
    const rec = this.tokens.get(mint);
    if (!rec || (rec.devLaunches === launches && rec.devMigrated === migrated)) return;
    rec.devLaunches = launches;
    rec.devMigrated = migrated;
    this.touch(rec);
  }

  /**
   * Reconciles a token's holder book with a chain snapshot (HolderBook.applySnapshot). Trades we already
   * applied after an entry's slot are re-applied on top of it, from the token's recent-trade ring.
   * Returns false when the token has no holder book (history not observed).
   */
  applyHolderSnapshot(
    mint: string,
    entries: readonly SnapshotEntry[],
    o: { source: "rpc" | "das"; at: number; full: boolean; floor?: bigint; slot: number },
  ): boolean {
    const rec = this.tokens.get(mint);
    if (!rec?.holders) return false;
    let oldest = o.slot;
    for (const e of entries) if (e.slot < oldest) oldest = e.slot;
    const later = new Map<string, { slot: number; delta: bigint }[]>();
    for (const e of rec.trades) {
      if (e.trade.slot <= oldest || e.holderDelta === 0n) continue;
      const list = later.get(e.trade.trader);
      if (list) list.push({ slot: e.trade.slot, delta: e.holderDelta });
      else later.set(e.trade.trader, [{ slot: e.trade.slot, delta: e.holderDelta }]);
    }
    rec.holders.applySnapshot(entries, {
      source: o.source,
      at: o.at,
      full: o.full,
      floor: o.floor,
      tradedAfter: new Set(later.keys()),
      laterDelta: (owner, slot) => {
        let d = 0n;
        for (const x of later.get(owner) ?? []) if (x.slot > slot) d += x.delta;
        return d;
      },
    });
    this.touch(rec);
    return true;
  }

  /** Result of the insider analysis: wallets the creator funded within two hops. */
  setFundedInsiders(mint: string, wallets: Iterable<string>, at: number): void {
    const rec = this.tokens.get(mint);
    if (!rec?.holders) return;
    rec.holders.setFundedInsiders(wallets, at);
    this.touch(rec);
  }

  /** New funder data arrived: re-runs the shared-funder bundle rule for a token. Returns bundlers added. */
  recheckBundles(mint: string): number {
    const rec = this.tokens.get(mint);
    if (!rec?.holders) return 0;
    const added = rec.holders.recheckCrowded();
    if (added) this.touch(rec);
    return added;
  }

  /** Marks a token changed so the gateway republishes it (enrichment outside the record itself). */
  touchToken(mint: string): void {
    const rec = this.tokens.get(mint);
    if (rec) this.touch(rec);
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
    if (rec.launchpad === "launchlab") return buildTradeContext(rec, undefined, this.raydiumInputs(rec, true));
    return buildTradeContext(rec, rec.pool ? this.deps.resolver.pools.get(rec.pool) : undefined);
  }

  /**
   * Tokens in memory whose ticker or name matches `query` (case-insensitive): exact ticker first, then
   * ticker prefix, then a name match; ties go to the most recently traded. Only the winners are summarized.
   */
  search(query: string, limit: number): TokenSummary[] {
    const q = query.trim().replace(/^\$/, "").toLowerCase();
    if (!q) return [];
    const hits: { rec: TokenRecord; score: number }[] = [];
    for (const rec of this.tokens.values()) {
      const symbol = rec.symbol.toLowerCase();
      const score = symbol === q ? 3 : symbol.startsWith(q) ? 2 : rec.name.toLowerCase().includes(q) ? 1 : 0;
      if (score) hits.push({ rec, score });
    }
    hits.sort((a, b) => b.score - a.score || (b.rec.lastTradeAt ?? 0) - (a.rec.lastTradeAt ?? 0));
    const opts = { solUsd: this.deps.solUsd(), now: this.now() };
    return hits.slice(0, limit).map((h) => summarize(h.rec, opts));
  }

  /**
   * The registry accounts a Raydium coin's trade context / live quote needs. With `request`, missing ones are
   * read (the context goes out once they land).
   */
  raydiumInputs(rec: TokenRecord, request = false): RaydiumContextInputs {
    const reg = this.deps.raydium;
    const out: RaydiumContextInputs = {};
    const quote = rec.quoteMint;
    if (rec.quoteTokenProgram !== TOKEN_2022_PROGRAM_ID) out.quoteTransferFee = null;
    else {
      const q = this.quoteMintInfo.get(quote);
      if (q) out.quoteTransferFee = q.transferFeeConfig;
      else if (request) {
        this.quoteRequests.delete(quote);
        this.requestQuoteMint(quote);
      }
    }
    out.baseMintKnown = rec.supplyExact || rec.tokenProgram !== TOKEN_2022_PROGRAM_ID;
    if (!out.baseMintKnown && request) this.deps.resolver.requestMint(rec.mint);
    if (!reg) return out;
    const ll = rec.launchLab;
    if (ll) {
      const info = reg.launchLabPools.get(ll.pool);
      if (info?.state) out.launchLabPool = info;
      else if (request) {
        reg.learnLaunchLabPool({ pool: ll.pool, baseMint: rec.mint, quoteMint: quote }, false);
        reg.requestLaunchLabPool(ll.pool);
      }
      const gc = info?.globalConfig ?? ll.globalConfig;
      const pc = info?.platformConfig ?? ll.platformConfig;
      const g = gc ? reg.globals.get(gc) : undefined;
      const pl = pc ? reg.platforms.get(pc) : undefined;
      if (g) out.global = { curveType: g.curveType, tradeFeeRate: g.tradeFeeRate };
      else if (gc && request) reg.requestGlobal(gc);
      if (pl) out.platform = pl;
      else if (pc && request) reg.requestPlatform(pc);
    }
    if (rec.migrated && rec.pool) {
      const c = reg.cpmmPools.get(rec.pool);
      if (c) {
        out.cpmmPool = c;
        const cfg = reg.ammConfigs.get(c.state.ammConfig);
        if (cfg) out.ammConfig = cfg;
        else if (request) reg.requestAmmConfig(c.state.ammConfig);
      } else if (request) {
        reg.learnCpmmPool(rec.pool, { baseMint: rec.mint, quoteMint: quote, launchLabPool: ll?.pool ?? null }, false);
        reg.requestCpmmPool(rec.pool);
      }
    }
    return out;
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
    // Records saved before supplyExact existed kept a mayhem coin's curve supply (1e15) as its supply.
    if (rec.isMayhem && !rec.supplyExact && rec.supply === ONE_BILLION_SUPPLY) rec.supply = 2n * ONE_BILLION_SUPPLY;
    this.tokens.set(rec.mint, rec);
    if (rec.launchpad === "launchlab") {
      // Persisted reserves predate the restart: any live trade or fresh account read replaces them.
      rec.curveKey = null;
      rec.poolKey = null;
      // Seed pool -> mint (logs-only events) without reading anything; accounts are read when needed.
      const reg = this.deps.raydium;
      if (rec.launchLab) {
        reg?.learnLaunchLabPool(
          {
            pool: rec.launchLab.pool,
            baseMint: rec.mint,
            quoteMint: rec.quoteMint,
            globalConfig: rec.launchLab.globalConfig,
            platformConfig: rec.launchLab.platformConfig,
          },
          false,
        );
      }
      if (rec.migrated && rec.pool)
        reg?.learnCpmmPool(rec.pool, { baseMint: rec.mint, quoteMint: rec.quoteMint, launchLabPool: rec.launchLab?.pool ?? null }, false);
      return;
    }
    if (rec.creator) this.setCreator(rec, rec.creator, rec.migrated ? "pool" : "curve");
    // Metadata that failed (e.g. on a since-retired IPFS gateway) or was in flight at shutdown: fetch it again.
    if (rec.uri && rec.metadataState !== "ok") {
      rec.metadataState = "requested";
      this.deps.requestMetadata?.(rec.mint, rec.uri, "restore");
    }
  }
}
