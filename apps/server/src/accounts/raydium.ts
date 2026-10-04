/**
 * Raydium LaunchLab / CPMM account registry, off the hot path (reads go through the resolver's batched
 * getMultipleAccounts, see AccountResolver.requestAccount):
 *
 *  - LaunchLab pools (PoolState): pool -> mints, configs, vaults, token programs, creator, curve. Gives the
 *    mint of a logs-only TradeEvent / PoolCreateEvent, and the creator / migrate type gRPC records lack.
 *  - PlatformConfigs (launchpad label, platform + creator fee rates, the graduation AmmConfig) and
 *    GlobalConfigs (protocol fee rate, curve type): few accounts, cached and refreshed periodically, since a
 *    platform admin can change cpswap_config before a coin graduates (armed orders then go stale).
 *  - CPMM pools of graduated LaunchLab coins: the pool, its AmmConfig and both vault balances. A CPMM pool
 *    counts as a graduation pool only when it is the canonical PDA ["pool", PlatformConfig.cpswap_config,
 *    token0, token1] of a LaunchLab pair; unknown pools seen in swaps are classified once (two PDA reads)
 *    and the others are remembered as rejected, so arbitrary CPMM pairs cost nothing after their first swap.
 *
 * Every account counts only when its program owns it (LaunchLab and CPMM share the PoolState discriminator).
 * Results are reported through callbacks; MarketState stays the single writer of token state.
 */
import type { Address } from "@solana/kit";
import {
  type CpmmAmmConfig,
  type CpmmPool,
  cpmmPoolPda,
  decodeCpmmAmmConfig,
  decodeCpmmPool,
  decodeLaunchLabGlobalConfig,
  decodeLaunchLabPlatformConfig,
  decodeLaunchLabPool,
  decodeTokenAccount,
  type LaunchLabGlobalConfig,
  type LaunchLabPlatformConfig,
  type LaunchLabPool,
  launchLabBaseTokenProgram,
  launchLabPoolPda,
  launchLabQuoteTokenProgram,
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_LAUNCHLAB_PLATFORMS,
  RAYDIUM_LAUNCHLAB_PROGRAM_ID,
} from "@zerofee/core";
import { logger } from "../log";
import { BoundedSet } from "../util/lru";
import type { RpcAccount } from "../util/rpc";
import type { AccountCallback } from "./resolver";

const log = logger("raydium");

/** What the registry needs from the account resolver. */
export interface AccountFetcher {
  requestAccount(address: string, cb: AccountCallback, o?: { retryMissing?: boolean }): void;
}

export interface LaunchLabPoolInfo {
  pool: string;
  baseMint: string;
  quoteMint: string;
  globalConfig: string | null;
  platformConfig: string | null;
  baseVault: string | null;
  quoteVault: string | null;
  baseTokenProgram: string | null;
  quoteTokenProgram: string | null;
  creator: string | null;
  /** Decoded PoolState; null until the account was read. */
  state: LaunchLabPool | null;
}

export interface CpmmPoolInfo {
  pool: string;
  state: CpmmPool;
  /** The graduated LaunchLab coin and the pair's quote. */
  baseMint: string;
  quoteMint: string;
  launchLabPool: string | null;
  /** Raw vault balances (null when the read failed). */
  vault0: bigint | null;
  vault1: bigint | null;
}

export interface RaydiumRegistryEvents {
  /** A LaunchLab pool account was read (parked events for it can be applied). */
  launchLabPool(info: LaunchLabPoolInfo): void;
  /** The account is missing or is not a LaunchLab pool: drop what waits on it. */
  launchLabPoolMissing?(pool: string): void;
  /** A PlatformConfig was (re)read: graduation pools and fee rates may have changed. */
  platform?(address: string, config: LaunchLabPlatformConfig): void;
  /** A graduation pool with its account and vaults. */
  cpmmPool(info: CpmmPoolInfo): void;
  /** Not the graduation pool of a LaunchLab coin (or unreadable): drop what waits on it. */
  cpmmRejected?(pool: string): void;
}

export type ClassifyResult = "known" | "pending" | "rejected" | "busy";

export interface RaydiumRegistryOptions {
  /** Concurrent classifications of unknown CPMM pools. */
  maxClassifying?: number;
}

const defined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;

export class RaydiumRegistry {
  readonly launchLabPools = new Map<string, LaunchLabPoolInfo>();
  /** base mint -> LaunchLab pool */
  private readonly mintPools = new Map<string, string>();
  readonly platforms = new Map<string, LaunchLabPlatformConfig>();
  readonly globals = new Map<string, LaunchLabGlobalConfig>();
  readonly ammConfigs = new Map<string, CpmmAmmConfig>();
  readonly cpmmPools = new Map<string, CpmmPoolInfo>();
  /** Graduation pools known before their account was read (migrate_to_cpswap, restore). */
  private readonly cpmmHints = new Map<string, { baseMint: string; quoteMint: string; launchLabPool: string | null }>();
  private readonly rejected = new BoundedSet<string>(200_000);
  private readonly pending = new Set<string>();
  private classifying = 0;
  /** LaunchLab pool -> graduation pool derived from a given cpswap_config. */
  private readonly graduation = new Map<string, { config: string; pool: string }>();
  readonly stats = {
    launchLabPools: 0,
    platforms: 0,
    cpmmPools: 0,
    classified: 0,
    rejected: 0,
    busy: 0,
    missing: 0,
    decodeErrors: 0,
  };

  constructor(
    private readonly fetcher: AccountFetcher,
    private readonly events: RaydiumRegistryEvents,
    private readonly opts: RaydiumRegistryOptions = {},
  ) {}

  // -------------------------------------------------------------------------------------------
  // LaunchLab pools and configs
  // -------------------------------------------------------------------------------------------

  /** Records what instruction accounts / persisted records revealed about a pool; reads the account once. */
  learnLaunchLabPool(
    p: Partial<LaunchLabPoolInfo> & { pool: string; baseMint: string; quoteMint: string },
    read = true,
  ): LaunchLabPoolInfo {
    const prev = this.launchLabPools.get(p.pool);
    const merged: LaunchLabPoolInfo = {
      globalConfig: null,
      platformConfig: null,
      baseVault: null,
      quoteVault: null,
      baseTokenProgram: null,
      quoteTokenProgram: null,
      creator: null,
      state: null,
      ...prev,
      ...defined(p),
    } as LaunchLabPoolInfo;
    this.launchLabPools.set(p.pool, merged);
    this.mintPools.set(merged.baseMint, p.pool);
    if (merged.platformConfig) this.requestPlatform(merged.platformConfig);
    if (merged.globalConfig) this.requestGlobal(merged.globalConfig);
    if (read && !merged.state) this.requestLaunchLabPool(p.pool);
    return merged;
  }

  /** LaunchLab pool of a coin, when known. */
  poolOfMint(mint: string): LaunchLabPoolInfo | undefined {
    const pool = this.mintPools.get(mint);
    return pool ? this.launchLabPools.get(pool) : undefined;
  }

  /** Reads (or re-reads, with `refresh`) a LaunchLab pool account. */
  requestLaunchLabPool(pool: string, refresh = false): void {
    const key = `ll:${pool}`;
    if (this.pending.has(key) || (!refresh && this.launchLabPools.get(pool)?.state)) return;
    this.pending.add(key);
    this.fetcher.requestAccount(
      pool,
      (acc) => {
        this.pending.delete(key);
        const info = this.onLaunchLabAccount(pool, acc);
        if (info) this.events.launchLabPool(info);
        else this.events.launchLabPoolMissing?.(pool);
      },
      { retryMissing: true },
    );
  }

  private onLaunchLabAccount(pool: string, acc: RpcAccount | null): LaunchLabPoolInfo | null {
    if (!acc || acc.owner !== RAYDIUM_LAUNCHLAB_PROGRAM_ID) {
      this.stats.missing++;
      return null;
    }
    let st: LaunchLabPool;
    try {
      st = decodeLaunchLabPool(acc.data);
    } catch (e) {
      this.stats.decodeErrors++;
      log.debug(`LaunchLab pool ${pool}: ${e instanceof Error ? e.message : e}`);
      return null;
    }
    this.stats.launchLabPools++;
    return this.learnLaunchLabPool(
      {
        pool,
        baseMint: st.baseMint,
        quoteMint: st.quoteMint,
        globalConfig: st.globalConfig,
        platformConfig: st.platformConfig,
        baseVault: st.baseVault,
        quoteVault: st.quoteVault,
        baseTokenProgram: launchLabBaseTokenProgram(st),
        quoteTokenProgram: launchLabQuoteTokenProgram(st),
        creator: st.creator,
        state: st,
      },
      false,
    );
  }

  requestPlatform(address: string, refresh = false): void {
    const key = `pc:${address}`;
    if (this.pending.has(key) || (!refresh && this.platforms.has(address))) return;
    this.pending.add(key);
    this.fetcher.requestAccount(address, (acc) => {
      this.pending.delete(key);
      if (!acc || acc.owner !== RAYDIUM_LAUNCHLAB_PROGRAM_ID) return;
      try {
        const cfg = decodeLaunchLabPlatformConfig(acc.data);
        this.platforms.set(address, cfg);
        this.stats.platforms++;
        this.events.platform?.(address, cfg);
      } catch (e) {
        this.stats.decodeErrors++;
        log.debug(`PlatformConfig ${address}: ${e instanceof Error ? e.message : e}`);
      }
    });
  }

  requestGlobal(address: string, refresh = false): void {
    const key = `gc:${address}`;
    if (this.pending.has(key) || (!refresh && this.globals.has(address))) return;
    this.pending.add(key);
    this.fetcher.requestAccount(address, (acc) => {
      this.pending.delete(key);
      if (!acc || acc.owner !== RAYDIUM_LAUNCHLAB_PROGRAM_ID) return;
      try {
        this.globals.set(address, decodeLaunchLabGlobalConfig(acc.data));
      } catch (e) {
        this.stats.decodeErrors++;
        log.debug(`GlobalConfig ${address}: ${e instanceof Error ? e.message : e}`);
      }
    });
  }

  requestAmmConfig(address: string, refresh = false): void {
    const key = `ac:${address}`;
    if (this.pending.has(key) || (!refresh && this.ammConfigs.has(address))) return;
    this.pending.add(key);
    this.fetcher.requestAccount(address, (acc) => {
      this.pending.delete(key);
      if (!acc || acc.owner !== RAYDIUM_CPMM_PROGRAM_ID) return;
      try {
        this.ammConfigs.set(address, decodeCpmmAmmConfig(acc.data));
      } catch (e) {
        this.stats.decodeErrors++;
        log.debug(`AmmConfig ${address}: ${e instanceof Error ? e.message : e}`);
      }
    });
  }

  /** Re-reads every cached config (periodic: fee rates and graduation configs can change). */
  refreshConfigs(): void {
    for (const a of this.platforms.keys()) this.requestPlatform(a, true);
    for (const a of this.globals.keys()) this.requestGlobal(a, true);
    for (const a of this.ammConfigs.keys()) this.requestAmmConfig(a, true);
  }

  /** Launchpad label of a PlatformConfig: its on-chain name, else the known-platforms table. */
  platformLabel(address: string | null | undefined): string | null {
    if (!address) return null;
    const name = this.platforms.get(address)?.name.replace(/\0+$/g, "").trim();
    return name || RAYDIUM_LAUNCHLAB_PLATFORMS[address] || null;
  }

  // -------------------------------------------------------------------------------------------
  // graduation
  // -------------------------------------------------------------------------------------------

  /** The CPMM pool a LaunchLab coin graduates into, from the cached (live) PlatformConfig; null until derived. */
  graduationPool(launchLabPool: string): string | null {
    const info = this.launchLabPools.get(launchLabPool);
    const plat = info?.platformConfig ? this.platforms.get(info.platformConfig) : undefined;
    const g = this.graduation.get(launchLabPool);
    return plat && g && g.config === plat.cpswapConfig ? g.pool : null;
  }

  /** Derives (and caches) the graduation pool; null while the PlatformConfig is unknown. */
  async deriveGraduationPool(launchLabPool: string): Promise<string | null> {
    const info = this.launchLabPools.get(launchLabPool);
    const plat = info?.platformConfig ? this.platforms.get(info.platformConfig) : undefined;
    if (!info || !plat) return null;
    const cached = this.graduationPool(launchLabPool);
    if (cached) return cached;
    const pool = await cpmmPoolPda(plat.cpswapConfig, info.baseMint as Address, info.quoteMint as Address);
    this.graduation.set(launchLabPool, { config: plat.cpswapConfig, pool });
    return pool;
  }

  private platformNow(address: string): Promise<LaunchLabPlatformConfig | null> {
    const cached = this.platforms.get(address);
    if (cached) return Promise.resolve(cached);
    return new Promise((resolve) => {
      this.fetcher.requestAccount(address, (acc) => {
        if (!acc || acc.owner !== RAYDIUM_LAUNCHLAB_PROGRAM_ID) return resolve(null);
        try {
          const cfg = decodeLaunchLabPlatformConfig(acc.data);
          this.platforms.set(address, cfg);
          resolve(cfg);
        } catch {
          resolve(null);
        }
      });
    });
  }

  // -------------------------------------------------------------------------------------------
  // CPMM pools
  // -------------------------------------------------------------------------------------------

  /** A graduation pool learned from migrate_to_cpswap or a persisted record: read its account and vaults. */
  learnCpmmPool(pool: string, hint: { baseMint: string; quoteMint: string; launchLabPool: string | null }, read = true): void {
    this.cpmmHints.set(pool, hint);
    if (read) this.requestCpmmPool(pool);
  }

  /** Base mint of a LaunchLab or CPMM pool the registry knows. */
  baseMintOf(pool: string): string | undefined {
    return this.launchLabPools.get(pool)?.baseMint ?? this.cpmmPools.get(pool)?.baseMint ?? this.cpmmHints.get(pool)?.baseMint;
  }

  isGraduationPool(pool: string): boolean {
    return this.cpmmPools.has(pool) || this.cpmmHints.has(pool);
  }

  isRejected(pool: string): boolean {
    return this.rejected.has(pool);
  }

  /** Reads a graduation pool, its AmmConfig and its vault balances; reported through events.cpmmPool. */
  requestCpmmPool(pool: string, refresh = false): void {
    const hint = this.cpmmHints.get(pool) ?? this.cpmmPools.get(pool);
    const key = `cp:${pool}`;
    if (!hint || this.pending.has(key) || (!refresh && this.cpmmPools.has(pool))) return;
    this.pending.add(key);
    this.fetcher.requestAccount(
      pool,
      (acc) => {
        if (!acc || acc.owner !== RAYDIUM_CPMM_PROGRAM_ID) {
          this.pending.delete(key);
          this.stats.missing++;
          this.events.cpmmRejected?.(pool);
          return;
        }
        let state: CpmmPool;
        try {
          state = decodeCpmmPool(acc.data);
        } catch (e) {
          this.pending.delete(key);
          this.stats.decodeErrors++;
          log.debug(`CPMM pool ${pool}: ${e instanceof Error ? e.message : e}`);
          this.events.cpmmRejected?.(pool);
          return;
        }
        this.requestAmmConfig(state.ammConfig);
        let left = 2;
        const vaults: [bigint | null, bigint | null] = [null, null];
        const done = () => {
          if (--left > 0) return;
          this.pending.delete(key);
          const info: CpmmPoolInfo = {
            pool,
            state,
            baseMint: hint.baseMint,
            quoteMint: hint.quoteMint,
            launchLabPool: hint.launchLabPool,
            vault0: vaults[0],
            vault1: vaults[1],
          };
          this.cpmmPools.set(pool, info);
          this.stats.cpmmPools++;
          this.events.cpmmPool(info);
        };
        for (const [i, v] of [state.token0Vault, state.token1Vault].entries()) {
          this.fetcher.requestAccount(v, (va) => {
            try {
              vaults[i] = va ? decodeTokenAccount(va.data).amount : null;
            } catch {
              vaults[i] = null;
            }
            done();
          });
        }
      },
      { retryMissing: true },
    );
  }

  /**
   * An unknown CPMM pool traded: is it the graduation pool of a LaunchLab coin? Checks a LaunchLab coin the
   * registry knows among the two mints, else reads the LaunchLab pool PDAs of both orderings, then compares
   * the pool with the canonical PDA on the platform's cpswap_config. Graduates are read (events.cpmmPool);
   * everything else is remembered as rejected (events.cpmmRejected).
   */
  classifyCpmmPool(pool: string, mintA: string, mintB: string): ClassifyResult {
    if (this.cpmmPools.has(pool) || this.cpmmHints.has(pool)) return "known";
    if (this.rejected.has(pool)) return "rejected";
    const key = `cls:${pool}`;
    if (this.pending.has(key)) return "pending";
    if (this.classifying >= (this.opts.maxClassifying ?? 64)) {
      this.stats.busy++;
      return "busy";
    }
    this.pending.add(key);
    this.classifying++;
    void this.classify(pool, mintA, mintB)
      .catch((e) => {
        log.debug(`classify ${pool}: ${e instanceof Error ? e.message : e}`);
        this.reject(pool);
      })
      .finally(() => {
        this.pending.delete(key);
        this.classifying--;
      });
    return "pending";
  }

  private reject(pool: string): void {
    this.rejected.add(pool);
    this.stats.rejected++;
    this.events.cpmmRejected?.(pool);
  }

  private async classify(pool: string, a: string, b: string): Promise<void> {
    for (const [base, quote] of [
      [a, b],
      [b, a],
    ] as const) {
      const known = this.poolOfMint(base);
      if (known && known.quoteMint === quote) return this.confirm(pool, known);
    }
    const pdas = await Promise.all([launchLabPoolPda(a as Address, b as Address), launchLabPoolPda(b as Address, a as Address)]);
    const accs = await Promise.all(pdas.map((p) => new Promise<RpcAccount | null>((resolve) => this.fetcher.requestAccount(p, resolve))));
    for (const [i, acc] of accs.entries()) {
      if (!acc || acc.owner !== RAYDIUM_LAUNCHLAB_PROGRAM_ID) continue;
      const info = this.onLaunchLabAccount(pdas[i] as string, acc);
      if (info) {
        this.events.launchLabPool(info);
        return this.confirm(pool, info);
      }
    }
    this.reject(pool);
  }

  private async confirm(pool: string, info: LaunchLabPoolInfo): Promise<void> {
    const plat = info.platformConfig ? await this.platformNow(info.platformConfig) : null;
    if (!plat) return this.reject(pool);
    const canonical = await cpmmPoolPda(plat.cpswapConfig, info.baseMint as Address, info.quoteMint as Address);
    this.graduation.set(info.pool, { config: plat.cpswapConfig, pool: canonical });
    // A CPMM pool someone else opened for the coin is not its graduation pool (and not a price source).
    if (canonical !== pool) return this.reject(pool);
    this.stats.classified++;
    this.learnCpmmPool(pool, { baseMint: info.baseMint, quoteMint: info.quoteMint, launchLabPool: info.pool });
  }
}
