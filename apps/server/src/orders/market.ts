/**
 * What the order engine reads from the market: live quotes (the same inputs the browser's trade context
 * carries, so the server's quote matches the one the order was armed with), coin facts for staleness,
 * fee-recipient lists, the Jito tip floor and the current slot.
 *
 * Raydium: a LaunchLab coin quotes on its curve until it graduates, then on its CPMM pool, with the fee
 * rates of the pool's configs and the Token-2022 transfer fees of both mints (the same accounts its trade
 * context carries). Coin facts carry the LaunchLab pool's creator / status and the CPMM pool the coin
 * graduates into from the live PlatformConfig (staleness "graduation-pool-changed").
 *
 * A market whose fee inputs are not all known yet (per-coin creator fee override, canonical-pool flag)
 * is reported as not quotable: a quote on a wrong fee tier could pick a variant that lands and fails,
 * which burns the nonce.
 */
import type { Address } from "@solana/kit";
import {
  type AmmGlobalConfig,
  type ArmedVenue,
  cpmmFeeRates,
  DEFAULT_PUBKEY,
  decodeAmmGlobalConfig,
  decodeFeeConfig,
  decodePumpGlobal,
  type FeeConfig,
  globalFeeRecipients,
  globalMayhemFeeRecipients,
  type LiveMarketState,
  launchLabTradeParams,
  MAINNET_SLOTS_PER_EPOCH,
  PUMP_AMM_FEE_CONFIG,
  PUMP_AMM_GLOBAL_CONFIG,
  PUMP_FEE_CONFIG,
  PUMP_GLOBAL,
  type PumpGlobal,
  type StalenessObservation,
} from "@zerofee/core";
import type { ChainState, ProgramAccountsResponse } from "@zerofee/protocol";
import type { PoolInfo } from "../accounts/resolver";
import type { MarketState } from "../market/state";
import { launchLabCurve, launchLabStatus, type TokenRecord } from "../market/token";

/** Coin facts the staleness check reads (pump curve / pool, LaunchLab pool and graduation pool). */
export type CoinFacts = Pick<StalenessObservation, "curve" | "pool" | "launchLabPool" | "launchLabGraduationPool">;

export interface MarketQuote {
  /** Where the mint trades right now. */
  venue: ArmedVenue;
  /** Null when the venue's inputs are incomplete (not quotable yet). */
  market: LiveMarketState | null;
}

/** Fee recipients the venues accept right now (staleness: rotated recipients strand an order). */
export type RecipientLists = Pick<StalenessObservation, "feeRecipients" | "buybackFeeRecipients">;

export interface OrderMarket {
  /** Null when the server does not know the mint. */
  quote(mint: string): MarketQuote | null;
  /** Live coin facts for detectStaleness; fields are omitted when unknown. */
  coinFacts(mint: string): CoinFacts;
  recipients(): RecipientLists;
  symbol(mint: string): string | null;
  /** The coin migrated to its canonical pool (a migration snipe's trigger may already hold). */
  migrated(mint: string): boolean;
  /** The pool a migrated coin trades in (PumpSwap canonical pool / Raydium CPMM graduation pool). */
  migratedPool?(mint: string): string | null;
  /** Live Jito landed-tip p50 (lamports), when known. */
  jitoTipFloorLamports(): bigint | null;
  /** Latest slot the ingest source reported. */
  slot(): number | null;
}

export interface ProgramState {
  global: PumpGlobal | null;
  pumpFeeConfig: FeeConfig | null;
  ammGlobalConfig: AmmGlobalConfig | null;
  ammFeeConfig: FeeConfig | null;
}

const EMPTY_PROGRAMS: ProgramState = { global: null, pumpFeeConfig: null, ammGlobalConfig: null, ammFeeConfig: null };

/** Decodes the program-wide accounts (GET /api/program-accounts) once per refresh. */
export class ProgramStateCache {
  private at = -1;
  private value: ProgramState = EMPTY_PROGRAMS;

  constructor(private readonly source: { get(): ProgramAccountsResponse | null } | null) {}

  get(): ProgramState {
    const raw = this.source?.get() ?? null;
    if (!raw) return EMPTY_PROGRAMS;
    if (raw.fetchedAt === this.at) return this.value;
    const bytes = (a: string) => {
      const acc = raw.accounts[a];
      return acc ? new Uint8Array(Buffer.from(acc.data, "base64")) : null;
    };
    const decode = <T>(a: string, fn: (d: Uint8Array) => T): T | null => {
      const d = bytes(a);
      if (!d) return null;
      try {
        return fn(d);
      } catch {
        return null;
      }
    };
    this.value = {
      global: decode(PUMP_GLOBAL, decodePumpGlobal),
      pumpFeeConfig: decode(PUMP_FEE_CONFIG, decodeFeeConfig),
      ammGlobalConfig: decode(PUMP_AMM_GLOBAL_CONFIG, decodeAmmGlobalConfig),
      ammFeeConfig: decode(PUMP_AMM_FEE_CONFIG, decodeFeeConfig),
    };
    this.at = raw.fetchedAt;
    return this.value;
  }
}

export interface MarketStateViewDeps {
  market: MarketState;
  /** The account resolver's pool records (pool -> base mint, flags, coin creator). */
  pools: ReadonlyMap<string, PoolInfo>;
  programs: { get(): ProgramState };
  chain?: { readonly state: ChainState } | null;
}

/** OrderMarket over the server's MarketState (single writer; read-only here). */
export class MarketStateView implements OrderMarket {
  constructor(private readonly d: MarketStateViewDeps) {}

  quote(mint: string): MarketQuote | null {
    const rec = this.d.market.tokens.get(mint);
    if (!rec) return null;
    if (rec.launchpad === "launchlab") return this.raydiumQuote(rec);
    const p = this.d.programs.get();
    // Same venue rule as the trade context the browser builds from (market/token.ts buildTradeContext).
    if (rec.migrated || !rec.curve) {
      const info = rec.pool ? this.d.pools.get(rec.pool) : undefined;
      const gc = p.ammGlobalConfig;
      if (!rec.poolState || !info || !gc || info.isCanonical === null) return { venue: "pumpswap", market: null };
      const coinCreator = rec.creator ?? info.coinCreator;
      if (!coinCreator) return { venue: "pumpswap", market: null };
      if (info.creatorFeeBps === null && gc.creatorFeeConfigurable) return { venue: "pumpswap", market: null };
      return {
        venue: "pumpswap",
        market: {
          venue: "pumpswap",
          pool: {
            quoteMint: info.quoteMint as Address,
            isMayhemMode: info.isMayhemMode ?? rec.isMayhem,
            coinCreator: coinCreator as Address,
            creatorFeeBps: BigInt(info.creatorFeeBps ?? "0"),
          },
          reserves: {
            baseReserve: rec.poolState.base,
            quoteVaultReserve: rec.poolState.quoteVault,
            virtualQuoteReserves: rec.poolState.virtualQuote,
          },
          isCanonical: info.isCanonical,
          baseMintSupply: rec.supply,
          feeConfig: p.ammFeeConfig,
          globalConfig: gc,
        },
      };
    }
    const g = p.global;
    if (!g || !rec.creator || (rec.creatorFeeBps === null && g.creatorFeeConfigurable)) return { venue: "pump", market: null };
    return {
      venue: "pump",
      market: {
        venue: "pump",
        curve: {
          virtualTokenReserves: rec.curve.vToken,
          virtualQuoteReserves: rec.curve.vQuote,
          realTokenReserves: rec.curve.rToken,
          realQuoteReserves: rec.curve.rQuote,
          complete: rec.complete,
          creator: rec.creator as Address,
          isMayhemMode: rec.isMayhem,
          quoteMint: rec.quoteMint as Address,
          creatorFeeBps: rec.creatorFeeBps ?? 0n,
        },
        global: g,
        feeConfig: p.pumpFeeConfig,
        mintSupply: rec.supply,
      },
    };
  }

  /** Transfer-fee epoch: the chain's current epoch (the token program uses it at execution time). */
  private epoch(rec: TokenRecord): bigint {
    const slot = this.d.chain?.state.slot ?? rec.lastSlot ?? 0;
    return BigInt(slot) / MAINNET_SLOTS_PER_EPOCH;
  }

  /** LaunchLab curve or CPMM graduation pool; not quotable until every fee input is known. */
  private raydiumQuote(rec: TokenRecord): MarketQuote {
    // Missing accounts are read (deduplicated by the registry): an order on a restored coin becomes quotable.
    const r = this.d.market.raydiumInputs(rec, true);
    if (!rec.migrated) {
      const curve = launchLabCurve(rec);
      if (!curve || !r.global || !r.platform || r.quoteTransferFee === undefined || !r.baseMintKnown)
        return { venue: "launchlab", market: null };
      let params: ReturnType<typeof launchLabTradeParams>;
      try {
        params = launchLabTradeParams({
          globalConfig: { curveType: r.global.curveType, tradeFeeRate: r.global.tradeFeeRate, maxShareFeeRate: 0n },
          platformConfig: r.platform,
        });
      } catch {
        return { venue: "launchlab", market: null };
      }
      return {
        venue: "launchlab",
        market: {
          venue: "launchlab",
          pool: curve,
          params,
          transferFees: { base: rec.transferFeeConfig, quote: r.quoteTransferFee, epoch: this.epoch(rec) },
          mintSupply: rec.supply,
        },
      };
    }
    const c = r.cpmmPool;
    const cfg = r.ammConfig;
    if (!c || !cfg || !rec.poolState || c.pool !== rec.pool || r.quoteTransferFee === undefined || !r.baseMintKnown) {
      return { venue: "cpmm", market: null };
    }
    const st = c.state;
    const baseIs0 = st.token0Mint === rec.mint;
    // Reserves are kept net of the fees the pool owes: pass them as vault balances with zero fees owed.
    return {
      venue: "cpmm",
      market: {
        venue: "cpmm",
        pool: {
          token0Mint: st.token0Mint,
          token1Mint: st.token1Mint,
          status: st.status,
          openTime: st.openTime,
          creatorFeeOn: st.creatorFeeOn,
          protocolFeesToken0: 0n,
          protocolFeesToken1: 0n,
          fundFeesToken0: 0n,
          fundFeesToken1: 0n,
          creatorFeesToken0: 0n,
          creatorFeesToken1: 0n,
        },
        vault0Amount: baseIs0 ? rec.poolState.base : rec.poolState.quoteVault,
        vault1Amount: baseIs0 ? rec.poolState.quoteVault : rec.poolState.base,
        rates: cpmmFeeRates(cfg, st),
        baseMint: rec.mint as Address,
        transferFees: { base: rec.transferFeeConfig, quote: r.quoteTransferFee, epoch: this.epoch(rec) },
        unixTimestamp: BigInt(Math.floor(Date.now() / 1000)),
        baseMintSupply: rec.supply,
      },
    };
  }

  coinFacts(mint: string): CoinFacts {
    const rec = this.d.market.tokens.get(mint);
    if (rec?.launchpad === "launchlab") {
      if (!rec.launchLab) return {};
      const creator = this.d.market.raydiumInputs(rec).launchLabPool?.creator ?? rec.creator;
      const graduation = rec.migrated ? rec.pool : rec.launchLab.graduationPool;
      return {
        ...(creator ? { launchLabPool: { creator: creator as Address, status: launchLabStatus(rec) } } : {}),
        ...(graduation ? { launchLabGraduationPool: graduation as Address } : {}),
      };
    }
    if (!rec?.creator) return {};
    const flags = { isMayhemMode: rec.isMayhem, ...(rec.isCashback !== null ? { isCashbackCoin: rec.isCashback } : {}) };
    if (rec.migrated && rec.pool) {
      const info = this.d.pools.get(rec.pool);
      return {
        // The curve completed: an order with only curve variants is stranded ("migrated").
        curve: { creator: rec.creator as Address, complete: true, ...flags },
        pool: {
          coinCreator: rec.creator as Address,
          ...(info?.isMayhemMode !== null && info?.isMayhemMode !== undefined ? { isMayhemMode: info.isMayhemMode } : {}),
          ...(info?.isCashbackCoin !== null && info?.isCashbackCoin !== undefined ? { isCashbackCoin: info.isCashbackCoin } : {}),
        },
      };
    }
    // Not migrated: the curve is the source of truth and the canonical pool does not exist yet.
    return { curve: { creator: rec.creator as Address, complete: rec.complete, ...flags }, pool: null };
  }

  recipients(): RecipientLists {
    const p = this.d.programs.get();
    const out: RecipientLists = { feeRecipients: {}, buybackFeeRecipients: {} };
    const nonDefault = (l: readonly Address[]) => l.filter((a) => a !== DEFAULT_PUBKEY);
    if (p.global) {
      (out.feeRecipients as Record<string, Address[]>).pump = [...globalFeeRecipients(p.global), ...globalMayhemFeeRecipients(p.global)];
      const bb = nonDefault(p.global.buybackFeeRecipients);
      if (bb.length) (out.buybackFeeRecipients as Record<string, Address[]>).pump = bb;
    }
    if (p.ammGlobalConfig) {
      const gc = p.ammGlobalConfig;
      (out.feeRecipients as Record<string, Address[]>).pumpswap = nonDefault([
        ...gc.protocolFeeRecipients,
        gc.reservedFeeRecipient,
        ...gc.reservedFeeRecipients,
      ]);
      const bb = nonDefault(gc.buybackFeeRecipients);
      if (bb.length) (out.buybackFeeRecipients as Record<string, Address[]>).pumpswap = bb;
    }
    return out;
  }

  symbol(mint: string): string | null {
    return this.d.market.tokens.get(mint)?.symbol || null;
  }

  migrated(mint: string): boolean {
    return this.d.market.tokens.get(mint)?.migrated === true;
  }

  migratedPool(mint: string): string | null {
    const rec = this.d.market.tokens.get(mint);
    return rec?.migrated ? rec.pool : null;
  }

  jitoTipFloorLamports(): bigint | null {
    const f = this.d.chain?.state.jitoTipFloor;
    return f && Number.isFinite(f.p50) && f.p50 > 0 ? BigInt(Math.round(f.p50)) : null;
  }

  slot(): number | null {
    return this.d.chain?.state.slot ?? null;
  }
}
