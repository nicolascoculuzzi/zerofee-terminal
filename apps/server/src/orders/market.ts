/**
 * What the order engine reads from the market: live quotes (the same inputs the browser's trade context
 * carries, so the server's quote matches the one the order was armed with), coin facts for staleness,
 * fee-recipient lists, the Jito tip floor and the current slot.
 *
 * A market whose fee inputs are not all known yet (per-coin creator fee override, canonical-pool flag)
 * is reported as not quotable: a quote on a wrong fee tier could pick a variant that lands and fails,
 * which burns the nonce.
 */
import type { Address } from "@solana/kit";
import {
  type AmmGlobalConfig,
  type ArmedVenue,
  DEFAULT_PUBKEY,
  decodeAmmGlobalConfig,
  decodeFeeConfig,
  decodePumpGlobal,
  type FeeConfig,
  globalFeeRecipients,
  globalMayhemFeeRecipients,
  type LiveMarketState,
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
  coinFacts(mint: string): Pick<StalenessObservation, "curve" | "pool">;
  recipients(): RecipientLists;
  symbol(mint: string): string | null;
  /** The coin migrated to its canonical pool (a migration snipe's trigger may already hold). */
  migrated(mint: string): boolean;
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

  coinFacts(mint: string): Pick<StalenessObservation, "curve" | "pool"> {
    const rec = this.d.market.tokens.get(mint);
    if (!rec?.creator) return {};
    const flags = { isMayhemMode: rec.isMayhem, ...(rec.isCashback !== null ? { isCashbackCoin: rec.isCashback } : {}) };
    if (rec.migrated && rec.pool) {
      const info = this.d.pools.get(rec.pool);
      return {
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

  jitoTipFloorLamports(): bigint | null {
    const f = this.d.chain?.state.jitoTipFloor;
    return f && Number.isFinite(f.p50) && f.p50 > 0 ? BigInt(Math.round(f.p50)) : null;
  }

  slot(): number | null {
    return this.d.chain?.state.slot ?? null;
  }
}
