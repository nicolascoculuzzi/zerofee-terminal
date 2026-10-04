/**
 * Per-token in-memory record (single writer: MarketState) and the pure builders that turn it into the
 * protocol's TokenSummary and TradeContext.
 */
import {
  BPS_DENOMINATOR,
  DEFAULT_INITIAL_REAL_TOKEN_RESERVES,
  TOKEN_PROGRAM_ID,
  type Token2022Danger,
  USDC_MINT,
  WSOL_MINT,
} from "@zerofee/core";
import type { Launchpad, TokenSocials, TokenSummary, Trade, TradeContext } from "@zerofee/protocol";
import type { PoolInfo } from "../accounts/resolver";
import type { OrderKey } from "./candles";
import type { HolderBook } from "./holders";
import { isSolQuote, quoteSolRate, ui } from "./quote";
import { RollingWindows } from "./windows";

export interface CurveReserves {
  vToken: bigint;
  vQuote: bigint;
  rToken: bigint;
  rQuote: bigint;
}

export interface PoolReserves {
  base: bigint;
  quoteVault: bigint;
  /** Signed Pool.virtual_quote_reserves. */
  virtualQuote: bigint;
}

/** A trade plus what is needed to roll it back (dead slot) or rebuild candles. */
export interface TradeEntry {
  trade: Trade;
  key: OrderKey;
  tsMs: number;
  volumeSol: number;
  isBuy: boolean;
  /** Holder balance change applied for the trader (0n when holders are untracked). */
  holderDelta: bigint;
  /** Reserves right after this trade (restored if a later trade is rolled back). */
  curveAfter: CurveReserves | null;
  poolAfter: PoolReserves | null;
  priceSol: number;
  solUsd: number | null;
}

export interface TokenRecord {
  mint: string;
  name: string;
  symbol: string;
  uri: string | null;
  image: string | null;
  description: string | null;
  socials: TokenSocials;
  metadataState: "none" | "requested" | "ok" | "failed";
  launchpad: Launchpad;
  quoteMint: string;
  quoteDecimals: number;
  quoteTokenProgram: string | null;
  tokenProgram: string | null;
  decimals: number;
  supply: bigint;
  createdAt: number | null;
  createdSlot: number | null;
  createSignature: string | null;
  createUser: string | null;
  creatorAtCreate: string | null;
  /** Live creator (curve) / coin creator (canonical pool). */
  creator: string | null;
  creatorVault: string | null;
  coinCreatorVaultAuthority: string | null;
  bondingCurve: string | null;
  isMayhem: boolean;
  isCashback: boolean | null;
  isHolderReward: boolean | null;
  creatorFeeBps: bigint | null;
  canEditCreatorFee: boolean | null;
  initialRealTokenReserves: bigint | null;
  curve: CurveReserves | null;
  curveKey: OrderKey | null;
  curveSlot: number | null;
  complete: boolean;
  completedAt: number | null;
  migrated: boolean;
  migratedAt: number | null;
  /** Price source pool: the canonical pool after migration, else the first pool seen. */
  pool: string | null;
  poolState: PoolReserves | null;
  poolKey: OrderKey | null;
  poolSlot: number | null;
  athMcSol: number;
  lastTradeAt: number | null;
  lastSlot: number | null;
  firstSeenAt: number;
  windows: RollingWindows;
  holders: HolderBook | null;
  /** Distinct pro traders; null when the source cannot see account keys. */
  proTraders: Set<string> | null;
  /** DexScreener approved token profile (null: not checked yet) and its payment time. */
  dexPaid: boolean | null;
  dexPaidAt: number | null;
  /** Earlier launches by the creator in our database, and how many migrated (null: not computed yet). */
  devLaunches: number | null;
  devMigrated: number | null;
  trades: TradeEntry[];
  dangers: Token2022Danger[];
  bootstrapRequested: boolean;
  lastPersistAt: number;
  updatedAt: number;
}

export function newTokenRecord(mint: string, now: number, init: Partial<TokenRecord> = {}): TokenRecord {
  return {
    mint,
    name: "",
    symbol: "",
    uri: null,
    image: null,
    description: null,
    socials: { x: null, telegram: null, website: null },
    metadataState: "none",
    launchpad: "pump",
    quoteMint: WSOL_MINT,
    quoteDecimals: 9,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
    tokenProgram: null,
    decimals: 6,
    supply: 1_000_000_000_000_000n,
    createdAt: null,
    createdSlot: null,
    createSignature: null,
    createUser: null,
    creatorAtCreate: null,
    creator: null,
    creatorVault: null,
    coinCreatorVaultAuthority: null,
    bondingCurve: null,
    isMayhem: false,
    isCashback: null,
    isHolderReward: null,
    creatorFeeBps: null,
    canEditCreatorFee: null,
    initialRealTokenReserves: null,
    curve: null,
    curveKey: null,
    curveSlot: null,
    complete: false,
    completedAt: null,
    migrated: false,
    migratedAt: null,
    pool: null,
    poolState: null,
    poolKey: null,
    poolSlot: null,
    athMcSol: 0,
    lastTradeAt: null,
    lastSlot: null,
    firstSeenAt: now,
    windows: new RollingWindows(),
    holders: null,
    proTraders: null,
    dexPaid: null,
    dexPaidAt: null,
    devLaunches: null,
    devMigrated: null,
    trades: [],
    dangers: [],
    bootstrapRequested: false,
    lastPersistAt: 0,
    updatedAt: now,
    ...init,
  };
}

/** Price in quote UI units per whole token from the active venue (0 when unknown). */
export function priceQuote(rec: TokenRecord): number {
  if (rec.poolState && (rec.migrated || !rec.curve)) {
    const eff = rec.poolState.quoteVault + rec.poolState.virtualQuote;
    if (rec.poolState.base <= 0n || eff <= 0n) return 0;
    return ui(eff, rec.quoteDecimals) / ui(rec.poolState.base, rec.decimals);
  }
  if (rec.curve && rec.curve.vToken > 0n) return ui(rec.curve.vQuote, rec.quoteDecimals) / ui(rec.curve.vToken, rec.decimals);
  return 0;
}

export function bondingProgress(rec: TokenRecord): number {
  if (rec.migrated || rec.complete) return 10_000;
  if (!rec.curve) return 0;
  const initial = rec.initialRealTokenReserves ?? (rec.isMayhem ? null : DEFAULT_INITIAL_REAL_TOKEN_RESERVES);
  if (!initial || initial <= 0n) return 0;
  if (rec.curve.rToken === 0n) return 10_000;
  const sold = initial - rec.curve.rToken;
  if (sold <= 0n) return 0;
  return Math.min(10_000, Number((sold * BPS_DENOMINATOR) / initial));
}

export interface MarketView {
  solUsd: number | null;
  now: number;
}

export function summarize(rec: TokenRecord, view: MarketView): TokenSummary {
  const pq = priceQuote(rec);
  const supplyUi = ui(rec.supply, rec.decimals);
  const rate = quoteSolRate(rec.quoteMint, view.solUsd);
  const priceSol = rate !== null ? pq * rate : 0;
  const mcSol = priceSol * supplyUi;
  const stable = rec.quoteMint === USDC_MINT;
  const usdOf = (sol: number, quote: number) => (stable ? quote : view.solUsd && rate !== null ? sol * view.solUsd : null);
  const liqQuote =
    rec.poolState && (rec.migrated || !rec.curve)
      ? ui(rec.poolState.quoteVault, rec.quoteDecimals)
      : rec.curve
        ? ui(rec.curve.rQuote, rec.quoteDecimals)
        : 0;
  const liquidity = rate !== null ? liqQuote * rate : 0;
  const w = rec.windows.totals(view.now);
  const m = rec.holders?.metrics(rec.supply) ?? null;
  return {
    mint: rec.mint,
    name: rec.name,
    symbol: rec.symbol,
    image: rec.image,
    description: rec.description,
    launchpad: rec.launchpad,
    quoteMint: rec.quoteMint,
    tokenProgram: rec.tokenProgram,
    decimals: rec.decimals,
    supply: supplyUi,
    createdAt: rec.createdAt,
    createdSlot: rec.createdSlot,
    creator: rec.creator,
    priceSol,
    priceUsd: usdOf(priceSol, pq),
    mcSol,
    mcUsd: usdOf(mcSol, pq * supplyUi),
    priceQuote: pq,
    mcQuote: pq * supplyUi,
    liquidity,
    liquidityUsd: usdOf(liquidity, liqQuote),
    volume5m: w.volume5m,
    volume1h: w.volume1h,
    volume24h: w.volume24h,
    txns: w.txns,
    buys: w.buys,
    sells: w.sells,
    holders: m ? m.holders : null,
    top10Pct: m ? m.top10Pct : null,
    holdersSource: rec.holders ? (rec.holders.reconciledSource ?? "trades") : null,
    holdersCheckedAt: rec.holders?.reconciledAt ?? null,
    devPct: m ? m.devPct : null,
    devSoldAll: m ? m.devSoldAll : null,
    devLaunches: rec.devLaunches,
    devMigrated: rec.devMigrated,
    snipersPct: m ? m.snipersPct : null,
    insidersPct: m ? m.insidersPct : null,
    bundlersPct: m ? m.bundlersPct : null,
    proTraders: rec.proTraders ? rec.proTraders.size : null,
    bondingProgressBps: bondingProgress(rec),
    complete: rec.complete,
    migrated: rec.migrated,
    migratedAt: rec.migratedAt,
    pool: rec.pool,
    socials: { ...rec.socials },
    dexPaid: rec.dexPaid,
    dexPaidAt: rec.dexPaidAt,
    athMcSol: Math.max(rec.athMcSol, mcSol),
    isMayhem: rec.isMayhem,
    lastTradeAt: rec.lastTradeAt,
    updatedAt: rec.updatedAt,
  };
}

/**
 * Inputs for building a trade in the browser with @zerofee/core. Null until everything the builder
 * needs is known (token program, live creator vault, pool vaults ...).
 */
export function buildTradeContext(rec: TokenRecord, pool: PoolInfo | undefined): TradeContext | null {
  if (!rec.tokenProgram || !rec.quoteTokenProgram) return null;
  const base = {
    mint: rec.mint,
    tokenProgram: rec.tokenProgram,
    decimals: rec.decimals,
    supply: rec.supply.toString(),
    quoteMint: rec.quoteMint,
    quoteTokenProgram: rec.quoteTokenProgram,
    quoteDecimals: rec.quoteDecimals,
    isMayhemMode: rec.isMayhem,
    isCashbackCoin: rec.isCashback ?? false,
    isHolderReward: rec.isHolderReward ?? false,
    creatorFeeBps: (rec.creatorFeeBps ?? 0n).toString(),
    updatedAt: rec.updatedAt,
  };
  if (rec.migrated || !rec.curve) {
    if (!pool?.fromAccount || !rec.poolState || !rec.coinCreatorVaultAuthority) return null;
    return {
      ...base,
      venue: "pumpswap",
      isMayhemMode: pool.isMayhemMode ?? rec.isMayhem,
      isCashbackCoin: pool.isCashbackCoin ?? false,
      isHolderReward: pool.isHolderReward ?? false,
      creatorFeeBps: pool.creatorFeeBps ?? "0",
      slot: rec.poolSlot ?? 0,
      pool: pool.pool,
      poolIndex: pool.index ?? 0,
      poolCreator: pool.creator ?? "",
      isCanonical: pool.isCanonical ?? false,
      lpMint: pool.lpMint ?? "",
      lpSupply: pool.lpSupply ?? "0",
      poolBaseTokenAccount: pool.poolBaseTokenAccount ?? "",
      poolQuoteTokenAccount: pool.poolQuoteTokenAccount ?? "",
      baseReserve: rec.poolState.base.toString(),
      quoteVaultReserve: rec.poolState.quoteVault.toString(),
      virtualQuoteReserves: rec.poolState.virtualQuote.toString(),
      coinCreator: rec.creator ?? pool.coinCreator ?? "",
      coinCreatorVaultAuthority: rec.coinCreatorVaultAuthority,
      canEditCreatorFee: pool.canEditCreatorFee ?? false,
    };
  }
  if (!rec.bondingCurve || !rec.creator || !rec.creatorVault) return null;
  return {
    ...base,
    venue: "pump",
    slot: rec.curveSlot ?? 0,
    bondingCurve: rec.bondingCurve,
    virtualTokenReserves: rec.curve.vToken.toString(),
    virtualQuoteReserves: rec.curve.vQuote.toString(),
    realTokenReserves: rec.curve.rToken.toString(),
    realQuoteReserves: rec.curve.rQuote.toString(),
    tokenTotalSupply: rec.supply.toString(),
    complete: rec.complete,
    creator: rec.creator,
    creatorVault: rec.creatorVault,
    migrated: rec.migrated,
    pool: rec.pool,
  };
}

/** Quote token program for quotes we know without a lookup. */
export function knownQuoteTokenProgram(quoteMint: string): string | null {
  return isSolQuote(quoteMint) || quoteMint === USDC_MINT ? TOKEN_PROGRAM_ID : null;
}
