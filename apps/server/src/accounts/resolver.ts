/**
 * Off-hot-path account lookups, batched into `getMultipleAccounts` (<= 100 addresses per call):
 *
 *  - PumpSwap pools: Buy/Sell events name the pool but not the base mint. Logs-only sources must read
 *    the pool account (cached forever, persisted); gRPC sources learn most pools from instruction
 *    accounts, and the fetch still fills vault addresses and flags for the trade context.
 *  - Mints: token program, decimals, supply, and Token-2022 TokenMetadata (name/symbol/uri of
 *    create_v2 coins) for tokens first seen mid-life.
 *  - Bonding curves of tokens first seen mid-life (flags the TradeEvent does not carry).
 *  - Metaplex metadata of legacy (SPL Token) coins.
 *
 * Uses `processed` reads because events arrive at processed commitment and a new pool would otherwise
 * be invisible for a slot or two. Missing accounts are retried a few times, then given up on.
 */
import type { Address } from "@solana/kit";
import {
  type BondingCurve,
  bondingCurvePda,
  decodeBondingCurve,
  decodeMetaplexMetadata,
  decodeMint,
  decodeMintExtensions,
  decodePool,
  isCanonicalPumpPool,
  metaplexMetadataPda,
  type OnchainTokenMetadata,
  TOKEN_PROGRAM_ID,
  type Token2022Danger,
  WSOL_MINT,
} from "@zerofee/core";
import { logger } from "../log";
import type { RpcClient } from "../util/rpc";

const log = logger("resolver");

export interface PoolInfo {
  pool: string;
  baseMint: string;
  quoteMint: string;
  index: number | null;
  /** pool.creator (pool_authority PDA for canonical pump pools). */
  creator: string | null;
  lpMint: string | null;
  lpSupply: string | null;
  poolBaseTokenAccount: string | null;
  poolQuoteTokenAccount: string | null;
  coinCreator: string | null;
  isMayhemMode: boolean | null;
  isCashbackCoin: boolean | null;
  creatorFeeBps: string | null;
  canEditCreatorFee: boolean | null;
  isHolderReward: boolean | null;
  isCanonical: boolean | null;
  baseDecimals: number | null;
  quoteDecimals: number | null;
  baseTokenProgram: string | null;
  quoteTokenProgram: string | null;
  baseSupply: string | null;
  /** Size of the pool account when read: below POOL_ACCOUNT_NEW_SIZE a swap must extend it first. */
  dataLength?: number | null;
  /** True once the pool account itself was read (all fields above known). */
  fromAccount: boolean;
  updatedAt: number;
}

export interface MintResolved {
  mint: string;
  tokenProgram: string;
  decimals: number;
  supply: bigint;
  metadata: OnchainTokenMetadata | null;
  dangers: Token2022Danger[];
}

export interface CurveResolved {
  mint: string;
  bondingCurve: string;
  curve: BondingCurve;
}

export interface ResolverEvents {
  /** A pool with base-mint decimals known: pending events for it can be applied. */
  pool(info: PoolInfo): void;
  mint(info: MintResolved): void;
  curve(r: CurveResolved): void;
  metaplex(mint: string, metadata: OnchainTokenMetadata): void;
  /** Persist hook for pool records. */
  persistPool?(info: PoolInfo): void;
}

type JobKind = "pool" | "mint" | "curve" | "metaplex";

interface Job {
  kind: JobKind;
  address: Address;
  /** Mint the job is for (curve / metaplex). */
  mint: string;
  attempts: number;
  notBefore: number;
}

export interface ResolverOptions {
  batchIntervalMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  /** Cap on queued jobs (oldest low-priority jobs dropped first). */
  maxQueue?: number;
}

const PRIORITY: Record<JobKind, number> = { pool: 0, mint: 1, curve: 2, metaplex: 3 };

export class AccountResolver {
  readonly pools = new Map<string, PoolInfo>();
  readonly mints = new Map<string, MintResolved>();
  private readonly queue = new Map<string, Job>();
  private readonly waitingOnMint = new Map<string, Set<string>>(); // base mint -> pools
  private readonly gaveUp = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  readonly stats = {
    batches: 0,
    accounts: 0,
    missing: 0,
    gaveUp: 0,
    errors: 0,
    poolsResolved: 0,
    mintsResolved: 0,
    curvesResolved: 0,
    dropped: 0,
  };

  constructor(
    private readonly rpc: RpcClient,
    private readonly events: ResolverEvents,
    private readonly opts: ResolverOptions = {},
  ) {}

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), this.opts.batchIntervalMs ?? 200);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get pending(): number {
    return this.queue.size;
  }

  /** Loads persisted pools (startup). */
  loadPools(infos: Iterable<PoolInfo>): void {
    for (const p of infos) this.pools.set(p.pool, p);
  }

  /** Records what events / instructions revealed about a pool; returns the merged record. */
  upsertPool(partial: Partial<PoolInfo> & { pool: string; baseMint: string; quoteMint: string }): PoolInfo {
    const prev = this.pools.get(partial.pool);
    const merged: PoolInfo = {
      index: null,
      creator: null,
      lpMint: null,
      lpSupply: null,
      poolBaseTokenAccount: null,
      poolQuoteTokenAccount: null,
      coinCreator: null,
      isMayhemMode: null,
      isCashbackCoin: null,
      creatorFeeBps: null,
      canEditCreatorFee: null,
      isHolderReward: null,
      isCanonical: null,
      baseDecimals: null,
      quoteDecimals: null,
      baseTokenProgram: null,
      quoteTokenProgram: null,
      baseSupply: null,
      fromAccount: false,
      ...prev,
      ...Object.fromEntries(Object.entries(partial).filter(([, v]) => v !== null && v !== undefined)),
      updatedAt: Date.now(),
    } as PoolInfo;
    this.pools.set(partial.pool, merged);
    this.events.persistPool?.(merged);
    return merged;
  }

  /** True when a pool's base mint and decimals are known (its events can be priced). */
  static ready(p: PoolInfo | undefined): p is PoolInfo {
    return !!p && p.baseDecimals !== null && p.quoteDecimals !== null;
  }

  requestPool(pool: string): void {
    this.enqueue("pool", pool as Address, pool);
  }

  requestMint(mint: string): void {
    if (this.mints.has(mint)) {
      this.events.mint(this.mints.get(mint) as MintResolved);
      return;
    }
    this.enqueue("mint", mint as Address, mint);
  }

  /** Resolves once the job is queued (the PDA derivation is async). */
  requestCurve(mint: string): Promise<void> {
    return bondingCurvePda(mint as Address).then((pda) => this.enqueue("curve", pda, mint));
  }

  /** Resolves once the job is queued (the PDA derivation is async). */
  requestMetaplex(mint: string): Promise<void> {
    return metaplexMetadataPda(mint as Address).then((pda) => this.enqueue("metaplex", pda, mint));
  }

  private enqueue(kind: JobKind, address: Address, mint: string): void {
    const key = `${kind}:${address}`;
    if (this.queue.has(key) || this.gaveUp.has(key)) return;
    if (this.queue.size >= (this.opts.maxQueue ?? 20_000)) {
      // drop the lowest-priority oldest job
      let victim: string | null = null;
      for (const [k, j] of this.queue) if (!victim || PRIORITY[j.kind] > PRIORITY[(this.queue.get(victim) as Job).kind]) victim = k;
      if (victim && PRIORITY[(this.queue.get(victim) as Job).kind] >= PRIORITY[kind]) {
        this.queue.delete(victim);
        this.stats.dropped++;
      } else return;
    }
    this.queue.set(key, { kind, address, mint, attempts: 0, notBefore: 0 });
  }

  /** One batch. Exposed for tests. */
  async tick(now = Date.now()): Promise<void> {
    if (this.busy || this.queue.size === 0 || this.rpc.coolingDown(now)) return;
    this.busy = true;
    try {
      const jobs = [...this.queue.values()]
        .filter((j) => j.notBefore <= now)
        .sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind])
        .slice(0, 100);
      if (!jobs.length) return;
      for (const j of jobs) this.queue.delete(`${j.kind}:${j.address}`);
      let accounts: Awaited<ReturnType<RpcClient["getMultipleAccounts"]>>["accounts"];
      try {
        ({ accounts } = await this.rpc.getMultipleAccounts(
          jobs.map((j) => j.address),
          "processed",
        ));
      } catch (e) {
        this.stats.errors++;
        log.debug(`batch failed: ${e instanceof Error ? e.message : e}`);
        for (const j of jobs) this.retry(j, now, false);
        return;
      }
      this.stats.batches++;
      this.stats.accounts += jobs.length;
      await Promise.all(jobs.map((j, i) => this.handle(j, accounts[i] ?? null, now)));
    } finally {
      this.busy = false;
    }
  }

  private retry(j: Job, now: number, missing: boolean): void {
    j.attempts++;
    if (missing) this.stats.missing++;
    if (j.attempts >= (this.opts.maxAttempts ?? 4)) {
      this.gaveUp.add(`${j.kind}:${j.address}`);
      this.stats.gaveUp++;
      return;
    }
    j.notBefore = now + (this.opts.retryDelayMs ?? 2_000) * j.attempts;
    this.queue.set(`${j.kind}:${j.address}`, j);
  }

  private async handle(j: Job, acc: { owner: Address; data: Uint8Array } | null, now: number): Promise<void> {
    if (!acc) return this.retry(j, now, true);
    try {
      switch (j.kind) {
        case "pool": {
          const p = decodePool(acc.data);
          const info = this.upsertPool({
            pool: j.address,
            baseMint: p.baseMint,
            quoteMint: p.quoteMint,
            index: p.index,
            creator: p.creator,
            lpMint: p.lpMint,
            lpSupply: p.lpSupply.toString(),
            poolBaseTokenAccount: p.poolBaseTokenAccount,
            poolQuoteTokenAccount: p.poolQuoteTokenAccount,
            coinCreator: p.coinCreator,
            isMayhemMode: p.isMayhemMode,
            isCashbackCoin: p.isCashbackCoin,
            creatorFeeBps: p.creatorFeeBps.toString(),
            canEditCreatorFee: p.canEditCreatorFee,
            isHolderReward: p.isHolderReward,
            isCanonical: await isCanonicalPumpPool(p),
            dataLength: p.dataLength,
            fromAccount: true,
          });
          this.stats.poolsResolved++;
          this.completePool(info);
          return;
        }
        case "mint": {
          const m = decodeMint(acc.data, acc.owner);
          const ext = decodeMintExtensions(acc.data);
          const info: MintResolved = {
            mint: j.mint,
            tokenProgram: m.tokenProgram,
            decimals: m.decimals,
            supply: m.supply,
            metadata: ext.metadata,
            dangers: ext.dangers,
          };
          this.mints.set(j.mint, info);
          this.stats.mintsResolved++;
          this.events.mint(info);
          // pools waiting for this mint's decimals
          for (const pool of this.waitingOnMint.get(j.mint) ?? []) {
            const p = this.pools.get(pool);
            if (p) this.completePool(p);
          }
          this.waitingOnMint.delete(j.mint);
          if (!ext.metadata && m.tokenProgram === TOKEN_PROGRAM_ID) this.requestMetaplex(j.mint);
          return;
        }
        case "curve": {
          this.stats.curvesResolved++;
          this.events.curve({ mint: j.mint, bondingCurve: j.address, curve: decodeBondingCurve(acc.data) });
          return;
        }
        case "metaplex": {
          const md = decodeMetaplexMetadata(acc.data);
          if (md) this.events.metaplex(j.mint, md);
          return;
        }
      }
    } catch (e) {
      this.stats.errors++;
      log.debug(`decode ${j.kind} ${j.address} failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Fills decimals / token programs from known mints, or waits for them. */
  private completePool(info: PoolInfo): void {
    const fill = (mint: string): MintResolved | null => {
      if (mint === WSOL_MINT) {
        return { mint, tokenProgram: TOKEN_PROGRAM_ID, decimals: 9, supply: 0n, metadata: null, dangers: [] };
      }
      return this.mints.get(mint) ?? null;
    };
    const base = fill(info.baseMint);
    const quote = fill(info.quoteMint);
    const missing = [!base ? info.baseMint : null, !quote ? info.quoteMint : null].filter(Boolean) as string[];
    if (missing.length) {
      for (const m of missing) {
        const set = this.waitingOnMint.get(m) ?? new Set();
        set.add(info.pool);
        this.waitingOnMint.set(m, set);
        this.enqueue("mint", m as Address, m);
      }
      return;
    }
    const done = this.upsertPool({
      pool: info.pool,
      baseMint: info.baseMint,
      quoteMint: info.quoteMint,
      baseDecimals: base?.decimals ?? null,
      quoteDecimals: quote?.decimals ?? null,
      baseTokenProgram: info.baseTokenProgram ?? base?.tokenProgram ?? null,
      quoteTokenProgram: info.quoteTokenProgram ?? quote?.tokenProgram ?? null,
      baseSupply: info.baseSupply ?? (base ? base.supply.toString() : null),
    });
    this.events.pool(done);
  }

  /** Called when events/instructions revealed a pool: complete it (decimals) and fetch the account once. */
  learnPool(partial: Partial<PoolInfo> & { pool: string; baseMint: string; quoteMint: string }): PoolInfo {
    const info = this.upsertPool(partial);
    if (!info.fromAccount) this.requestPool(info.pool);
    if (!AccountResolver.ready(info)) this.completePool(info);
    return this.pools.get(info.pool) as PoolInfo;
  }
}
