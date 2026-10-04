/**
 * Per-token in-memory record (single writer: MarketState) and the pure builders that turn it into the
 * protocol's TokenSummary and TradeContext.
 *
 * Raydium LaunchLab curves reuse the pump curve fields in pump's shape, so pricing, liquidity, progress,
 * candles and rollbacks work unchanged: vToken = virtual_base - real_base, vQuote = virtual_quote + real_quote
 * (price = vQuote / vToken, the curve's spot price), rToken = total_base_sell - real_base (base left to sell),
 * rQuote = real_quote, and initialRealTokenReserves = total_base_sell. The curve constants live in
 * `launchLab`. A graduated LaunchLab coin's CPMM pool uses `pool` / `poolState` with reserves net of the fees
 * the pool owes (virtualQuote 0).
 */
import {
  BPS_DENOMINATOR,
  DEFAULT_INITIAL_REAL_TOKEN_RESERVES,
  LAUNCHLAB_POOL_STATUS,
  MAINNET_SLOTS_PER_EPOCH,
  ONE_BILLION_SUPPLY,
  TOKEN_PROGRAM_ID,
  type Token2022Danger,
  type TransferFeeConfig,
  USDC_MINT,
  WSOL_MINT,
} from "@zerofee/core";
import {
  imageProxyUrl,
  type Launchpad,
  type TokenHistory,
  type TokenSocials,
  type TokenSummary,
  type Trade,
  type TradeContext,
  type TransferFeeInfo,
} from "@zerofee/protocol";
import type { CpmmPoolInfo, LaunchLabPoolInfo } from "../accounts/raydium";
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

/** Raydium LaunchLab curve constants (the moving curve state is `TokenRecord.curve`, see the module comment). */
export interface LaunchLabRecord {
  /** LaunchLab pool (PoolState) PDA ["pool", mint, quote]. */
  pool: string;
  /** Constant-product virtual reserves; null until a TradeEvent or the pool account. */
  virtualBase: bigint | null;
  virtualQuote: bigint | null;
  totalBaseSell: bigint | null;
  totalQuoteFundRaising: bigint | null;
  /** 1 = graduates to CPMM, 0 = to Raydium AMM v4. */
  migrateType: number | null;
  globalConfig: string | null;
  platformConfig: string | null;
  /** The CPMM pool it graduates into, from the live PlatformConfig.cpswap_config (null until derived). */
  graduationPool: string | null;
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
  /** LaunchLab launchpad label (PlatformConfig name: letsbonk.fun, StonkFun ...); null otherwise. */
  platform: string | null;
  /** LaunchLab curve constants; null for pump coins. */
  launchLab: LaunchLabRecord | null;
  /** The mint's Token-2022 TransferFeeConfig (StonkFun coins); null when none / unknown. */
  transferFeeConfig: TransferFeeConfig | null;
  quoteMint: string;
  /** Meaningful once quoteTokenProgram is set: both come from the quote mint (null = still being looked up). */
  quoteDecimals: number;
  quoteTokenProgram: string | null;
  tokenProgram: string | null;
  decimals: number;
  /**
   * Mint supply (base units): what market caps multiply by. 2e15 for mayhem coins, whose curve says 1e15
   * (core curveMintSupply); the mint account (or a non-mayhem pool event's base_supply) replaces it, burns included.
   */
  supply: bigint;
  /** True once `supply` was read from the mint (account or base_supply) rather than derived from the curve. */
  supplyExact: boolean;
  /**
   * The curve's own token_total_supply (CreateEvent / BondingCurve): 1e15 for mayhem coins too. Curve trade
   * contexts pass it through (migration estimates subtract the initial real reserves from it). null = unseen.
   */
  curveTokenTotalSupply: bigint | null;
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
  /** Trade-history coverage (history/service.ts); null until assessed. Not persisted here (token_history). */
  history: TokenHistory | null;
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
    platform: null,
    launchLab: null,
    transferFeeConfig: null,
    quoteMint: WSOL_MINT,
    quoteDecimals: 9,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
    tokenProgram: null,
    decimals: 6,
    supply: 1_000_000_000_000_000n,
    supplyExact: false,
    curveTokenTotalSupply: null,
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
    history: null,
    dangers: [],
    bootstrapRequested: false,
    lastPersistAt: 0,
    updatedAt: now,
    ...init,
  };
}

/** Price in quote UI units per whole token from the active venue (0 when unknown). */
export function priceQuote(rec: TokenRecord): number {
  if (rec.quoteTokenProgram === null) return 0; // an exotic quote mint not resolved yet: its decimals are unknown
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

/**
 * Most tokens holders can own together: everything outside the curve (tokens sold, plus a mayhem coin's second
 * 1e15 minted to the Mayhem vault) while on the curve, everything outside the price pool after migration. null
 * when the reserves are unknown (the total supply bounds then).
 */
export function circulatingBound(rec: TokenRecord): bigint | null {
  if (rec.poolState && (rec.migrated || !rec.curve)) return rec.supply > rec.poolState.base ? rec.supply - rec.poolState.base : 0n;
  if (rec.curve && rec.initialRealTokenReserves !== null && rec.initialRealTokenReserves > 0n) {
    const sold = rec.initialRealTokenReserves - rec.curve.rToken;
    const outsideCurve =
      rec.curveTokenTotalSupply !== null && rec.supply > rec.curveTokenTotalSupply ? rec.supply - rec.curveTokenTotalSupply : 0n;
    return (sold > 0n ? sold : 0n) + outsideCurve;
  }
  return null;
}

export interface MarketView {
  solUsd: number | null;
  now: number;
}

export function summarize(rec: TokenRecord, view: MarketView): TokenSummary {
  const pq = priceQuote(rec);
  const supplyUi = ui(rec.supply, rec.decimals);
  // null = the quote's SOL value is unknown right now (exotic quote, or USDC without SOL/USD)
  const rate = quoteSolRate(rec.quoteMint, view.solUsd);
  const priceSol = rate !== null && pq > 0 ? pq * rate : null;
  const mcSol = priceSol !== null ? priceSol * supplyUi : null;
  const stable = rec.quoteMint === USDC_MINT;
  const usdOf = (sol: number | null, quote: number | null): number | null =>
    stable ? quote : sol !== null && view.solUsd ? sol * view.solUsd : null;
  const liqQuote =
    rec.poolState && (rec.migrated || !rec.curve)
      ? ui(rec.poolState.quoteVault, rec.quoteDecimals)
      : rec.curve
        ? ui(rec.curve.rQuote, rec.quoteDecimals)
        : 0;
  const liquidity = rate !== null ? liqQuote * rate : null;
  const w = rec.windows.totals(view.now);
  const m = rec.holders?.metrics(rec.supply, circulatingBound(rec)) ?? null;
  return {
    mint: rec.mint,
    name: rec.name,
    symbol: rec.symbol,
    image: rec.image,
    imageProxied: imageProxyUrl(rec.mint, rec.image),
    description: rec.description,
    launchpad: rec.launchpad,
    platform: rec.platform,
    quoteMint: rec.quoteMint,
    tokenProgram: rec.tokenProgram,
    decimals: rec.decimals,
    supply: supplyUi,
    createdAt: rec.createdAt,
    createdSlot: rec.createdSlot,
    creator: rec.creator,
    priceSol,
    priceUsd: pq > 0 ? usdOf(priceSol, pq) : null,
    mcSol,
    mcUsd: pq > 0 ? usdOf(mcSol, pq * supplyUi) : null,
    priceQuote: pq > 0 ? pq : null,
    mcQuote: pq > 0 ? pq * supplyUi : null,
    liquidity,
    liquidityUsd: usdOf(liquidity, liqQuote),
    // Volumes are sums of trades' SOL values: unknown when the quote has no SOL value.
    volume5m: rate !== null ? w.volume5m : null,
    volume1h: rate !== null ? w.volume1h : null,
    volume24h: rate !== null ? w.volume24h : null,
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
    athMcSol: mcSol !== null ? Math.max(rec.athMcSol, mcSol) : rec.athMcSol > 0 ? rec.athMcSol : null,
    isMayhem: rec.isMayhem,
    lastTradeAt: rec.lastTradeAt,
    ...(rec.history ? { history: rec.history, historyState: rec.history.state } : {}),
    updatedAt: rec.updatedAt,
  };
}

/** What a Raydium trade context needs beyond the record (the registry's accounts). */
export interface RaydiumContextInputs {
  launchLabPool?: LaunchLabPoolInfo;
  /** GlobalConfig rates. */
  global?: { curveType: number; tradeFeeRate: bigint };
  /** PlatformConfig rates and graduation config. */
  platform?: { feeRate: bigint; creatorFeeRate: bigint; cpswapConfig: string; platformCpCreator: string };
  cpmmPool?: CpmmPoolInfo;
  ammConfig?: { tradeFeeRate: bigint; protocolFeeRate: bigint; fundFeeRate: bigint; creatorFeeRate: bigint };
  /** Quote mint transfer fee: null = none; undefined = not known yet. */
  quoteTransferFee?: TransferFeeConfig | null;
  /** Base mint transfer fee is known (the mint was read): rec.transferFeeConfig is authoritative. */
  baseMintKnown?: boolean;
}

export function transferFeeInfo(cfg: TransferFeeConfig | null | undefined): TransferFeeInfo | null {
  if (!cfg) return null;
  const f = (x: TransferFeeConfig["olderTransferFee"]) => ({
    epoch: x.epoch.toString(),
    maximumFee: x.maximumFee.toString(),
    basisPoints: Number(x.transferFeeBasisPoints),
  });
  return { older: f(cfg.olderTransferFee), newer: f(cfg.newerTransferFee) };
}

/** LaunchLab pool status implied by the record (0 funding, 1 complete, 2 migrated). */
export function launchLabStatus(rec: TokenRecord): number {
  if (rec.migrated) return LAUNCHLAB_POOL_STATUS.trade;
  return rec.complete ? LAUNCHLAB_POOL_STATUS.migrate : LAUNCHLAB_POOL_STATUS.fund;
}

/** LaunchLab curve state in core's shape (LaunchLabCurveState), from the record; null while incomplete. */
export function launchLabCurve(rec: TokenRecord): {
  status: number;
  virtualBase: bigint;
  virtualQuote: bigint;
  realBase: bigint;
  realQuote: bigint;
  totalBaseSell: bigint;
  totalQuoteFundRaising: bigint;
} | null {
  const ll = rec.launchLab;
  if (!ll || !rec.curve || ll.virtualBase === null || ll.virtualQuote === null || ll.totalBaseSell === null) return null;
  return {
    status: launchLabStatus(rec),
    virtualBase: ll.virtualBase,
    virtualQuote: ll.virtualQuote,
    realBase: ll.virtualBase - rec.curve.vToken,
    realQuote: rec.curve.vQuote - ll.virtualQuote,
    totalBaseSell: ll.totalBaseSell,
    totalQuoteFundRaising: ll.totalQuoteFundRaising ?? 0n,
  };
}

function raydiumTradeContext(rec: TokenRecord, base: ReturnType<typeof contextBase>, r: RaydiumContextInputs): TradeContext | null {
  const quoteTransferFee = r.quoteTransferFee;
  if (quoteTransferFee === undefined || !r.baseMintKnown) return null;
  const slot = Math.max(rec.curveSlot ?? 0, rec.poolSlot ?? 0, rec.lastSlot ?? 0);
  const epoch = (BigInt(slot) / MAINNET_SLOTS_PER_EPOCH).toString();
  const fees = {
    baseTransferFee: transferFeeInfo(rec.transferFeeConfig),
    quoteTransferFee: transferFeeInfo(quoteTransferFee),
    epoch,
  };
  if (rec.migrated) {
    const c = r.cpmmPool;
    const cfg = r.ammConfig;
    if (!c || !cfg || !rec.poolState || rec.pool !== c.pool) return null;
    const st = c.state;
    const baseIs0 = st.token0Mint === rec.mint;
    return {
      ...base,
      venue: "cpmm",
      slot: rec.poolSlot ?? 0,
      pool: c.pool,
      ammConfig: st.ammConfig,
      poolCreator: st.poolCreator,
      token0Mint: st.token0Mint,
      token1Mint: st.token1Mint,
      token0Vault: st.token0Vault,
      token1Vault: st.token1Vault,
      token0Program: st.token0Program,
      token1Program: st.token1Program,
      observation: st.observationKey,
      lpMint: st.lpMint,
      status: st.status,
      openTime: st.openTime.toString(),
      creatorFeeOn: st.creatorFeeOn,
      enableCreatorFee: st.enableCreatorFee,
      token0Reserve: (baseIs0 ? rec.poolState.base : rec.poolState.quoteVault).toString(),
      token1Reserve: (baseIs0 ? rec.poolState.quoteVault : rec.poolState.base).toString(),
      tradeFeeRate: cfg.tradeFeeRate.toString(),
      protocolFeeRate: cfg.protocolFeeRate.toString(),
      fundFeeRate: cfg.fundFeeRate.toString(),
      creatorFeeRate: cfg.creatorFeeRate.toString(),
      ...fees,
      launchLabPool: c.launchLabPool ?? rec.launchLab?.pool ?? null,
      platform: rec.platform,
    };
  }
  const ll = rec.launchLab;
  const info = r.launchLabPool;
  const curve = launchLabCurve(rec);
  if (!ll || !info || !curve || !r.global || !r.platform) return null;
  const tokenProgramFlag = info.state?.tokenProgramFlag;
  const creator = info.creator ?? rec.creator;
  if (!info.globalConfig || !info.platformConfig || !info.baseVault || !info.quoteVault || tokenProgramFlag === undefined || !creator)
    return null;
  return {
    ...base,
    venue: "launchlab",
    slot: rec.curveSlot ?? 0,
    pool: ll.pool,
    globalConfig: info.globalConfig,
    platformConfig: info.platformConfig,
    platform: rec.platform,
    baseVault: info.baseVault,
    quoteVault: info.quoteVault,
    creator,
    tokenProgramFlag,
    status: curve.status,
    migrateType: ll.migrateType ?? info.state?.migrateType ?? 1,
    virtualBase: curve.virtualBase.toString(),
    virtualQuote: curve.virtualQuote.toString(),
    realBase: curve.realBase.toString(),
    realQuote: curve.realQuote.toString(),
    totalBaseSell: curve.totalBaseSell.toString(),
    totalQuoteFundRaising: curve.totalQuoteFundRaising.toString(),
    curveType: r.global.curveType,
    protocolFeeRate: r.global.tradeFeeRate.toString(),
    platformFeeRate: r.platform.feeRate.toString(),
    creatorFeeRate: r.platform.creatorFeeRate.toString(),
    ...fees,
    graduationPool: ll.graduationPool,
    cpswapConfig: r.platform.cpswapConfig,
    platformCpCreator: r.platform.platformCpCreator,
  };
}

function contextBase(rec: TokenRecord, tokenProgram: string, quoteTokenProgram: string) {
  return {
    mint: rec.mint,
    tokenProgram,
    decimals: rec.decimals,
    supply: rec.supply.toString(),
    quoteMint: rec.quoteMint,
    quoteTokenProgram,
    quoteDecimals: rec.quoteDecimals,
    isMayhemMode: rec.isMayhem,
    isCashbackCoin: rec.isCashback ?? false,
    isHolderReward: rec.isHolderReward ?? false,
    creatorFeeBps: (rec.creatorFeeBps ?? 0n).toString(),
    updatedAt: rec.updatedAt,
  };
}

/**
 * Inputs for building a trade in the browser with @zerofee/core. Null until everything the builder
 * needs is known (token program, live creator vault, pool vaults; for Raydium the pool accounts, the fee
 * configs and the Token-2022 transfer fees ...).
 */
export function buildTradeContext(rec: TokenRecord, pool: PoolInfo | undefined, raydium?: RaydiumContextInputs): TradeContext | null {
  if (!rec.tokenProgram || !rec.quoteTokenProgram) return null;
  if (rec.launchpad === "launchlab") {
    return raydium ? raydiumTradeContext(rec, contextBase(rec, rec.tokenProgram, rec.quoteTokenProgram), raydium) : null;
  }
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
      poolDataLength: pool.dataLength ?? null,
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
    tokenTotalSupply: (rec.curveTokenTotalSupply ?? ONE_BILLION_SUPPLY).toString(),
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
