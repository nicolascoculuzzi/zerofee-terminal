/**
 * packages/protocol trade inputs -> @zerofee/core TokenState, so the browser quotes and builds with core
 * exactly as the CLI does after loadTokenState, without an RPC of its own:
 *   - pump.fun curve / PumpSwap pool: the streamed `tradectx:<mint>` (reserves, live creator, flags) plus
 *     the program-wide accounts (programs.ts) and the wallet's own balance from `wallet:<address>`;
 *   - Raydium LaunchLab curve / CPMM pool: the streamed context alone (pool keys, curve or net reserves, the
 *     GlobalConfig / PlatformConfig / AmmConfig rates and the Token-2022 transfer fees), mapped field by field
 *     as packages/protocol/src/market.ts documents; the Clock core reads comes from the context's epoch and
 *     the `chain` topic's slot;
 *   - Jupiter fallback (venue "jupiter"): no local venue (the server has no trade context, the coin is quoted
 *     in something other than SOL, or its context is still missing an account), so a SOL trade needs a
 *     route; core asks Jupiter `/build`.
 *
 * Fields core only reads for decisions the venues do not take here (Token-2022 extensions other than the
 * transfer fee, LaunchLab vesting and migrate fee, CPMM fees owed, which the server already nets out of the
 * reserves) are empty. Anything that decides where funds go is derived here from the mint and the user
 * (ATAs, PDAs), checked against the context (LaunchLab pool PDA, CPMM vaults and observation), and checked
 * again by the signer firewall, never taken on trust.
 */
import { type Address, isAddress } from "@solana/kit";
import {
  ammFeeRates,
  BONDING_CURVE_NEW_SIZE,
  type CpmmAmmConfig,
  type CpmmPool,
  type CpmmState,
  cpmmFeeRates,
  cpmmObservationPda,
  cpmmVaultPda,
  curveFeeRates,
  DEFAULT_PUBKEY,
  findAssociatedTokenAddress,
  isCanonicalPumpPool,
  type JupiterState,
  LAUNCHLAB_POOL_STATUS,
  type LaunchLabGlobalConfig,
  type LaunchLabPlatformConfig,
  type LaunchLabPool,
  type LaunchLabState,
  type LocalTokenState,
  launchLabBaseTokenProgram,
  launchLabPoolPda,
  launchLabQuoteTokenProgram,
  launchLabTotalFeeRate,
  launchLabTradeParams,
  MAINNET_SLOTS_PER_EPOCH,
  type MintInfo,
  POOL_ACCOUNT_NEW_SIZE,
  type PumpCurveState,
  type PumpSwapState,
  TOKEN_2022_EXTENSIONS,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  type Token2022Extensions,
  type TokenProgram,
  type TransferFeeConfig,
  WSOL_MINT,
} from "@zerofee/core";
import type {
  CpmmTradeContext,
  CurveTradeContext,
  LaunchLabTradeContext,
  PoolTradeContext,
  TradeContext,
  TransferFeeInfo,
} from "@zerofee/protocol";
import type { ProgramConfigs } from "./programs";

export class TradeStateError extends Error {}

/**
 * The context cannot be built locally yet: an account the builder needs is still missing from the server's
 * context, or the coin left the venue the context describes. LiveTradeService takes the Jupiter fallback.
 */
export class NoLocalBuildError extends TradeStateError {}

const NO_EXTENSIONS: Token2022Extensions = {
  types: [],
  transferFeeConfig: null,
  transferHookProgramId: null,
  paused: false,
  nonTransferable: false,
  permanentDelegate: null,
};

/** PoolState sizes (core's decoders record them; nothing reads them for LaunchLab / CPMM trades). */
const LAUNCHLAB_POOL_SIZE = 429;
const CPMM_POOL_SIZE = 637;

/**
 * Withheld Token-2022 fees on the user's base ATA are not streamed. A mint with a transfer fee withholds on
 * every transfer into the ATA, so assume some are there: core then never closes the ATA on a full exit
 * (CloseAccount would fail and take the sale with it).
 */
const UNKNOWN_WITHHELD = 1n;

/** What the wallet feed says the user holds of the mint (null = nothing / not loaded). */
export interface HeldBalance {
  amount: bigint;
  /** Token account holding it. */
  account: string;
}

export interface UserInputs {
  user: Address;
  /** Lamports, when the wallet feed has them (core does not read it for these venues). */
  lamports?: bigint;
  balance: HeldBalance | null;
}

/** The live chain view the Raydium venues need (Token-2022 fee epoch, CPMM open_time). */
export interface ChainInputs {
  /** Highest slot from the `chain` topic; the transfer-fee epoch follows it when it moved past the context's. */
  slot?: number | null;
  /** Wall clock (ms) for CPMM open_time. Default Date.now(). */
  nowMs?: number;
}

function tokenProgramOf(program: string): TokenProgram {
  if (program === TOKEN_PROGRAM_ID) return TOKEN_PROGRAM_ID;
  if (program === TOKEN_2022_PROGRAM_ID) return TOKEN_2022_PROGRAM_ID;
  throw new TradeStateError(`Unsupported token program ${program}`);
}

/**
 * The base balance core may sell: only what sits in the user's ATA (the venues sell from it). A balance in
 * some other token account is not sellable here (0), so a sell of it fails cleanly in buildTrade.
 */
async function baseHolding(user: Address, mint: Address, program: TokenProgram, balance: HeldBalance | null) {
  const ata = await findAssociatedTokenAddress(user, mint, program);
  const inAta = balance !== null && balance.account === ata;
  return { ata, amount: inAta ? balance.amount : 0n, ataExists: inAta };
}

/** The venues the browser builds locally: pump.fun curve, PumpSwap pool, Raydium LaunchLab curve, Raydium CPMM pool. */
export type LocalTradeContext = CurveTradeContext | PoolTradeContext | LaunchLabTradeContext | CpmmTradeContext;

const LOCAL_VENUES: ReadonlySet<string> = new Set<LocalTradeContext["venue"]>(["pump", "pumpswap", "launchlab", "cpmm"]);

/**
 * True when the browser builds this coin's trade itself: a pump.fun, PumpSwap, Raydium LaunchLab or Raydium
 * CPMM coin that trades against SOL (wSOL quote). Everything else (USDC or xStock pairs, unknown venues)
 * goes through the Jupiter fallback.
 */
export function hasLocalBuilder(ctx: TradeContext): ctx is LocalTradeContext {
  return LOCAL_VENUES.has(ctx.venue) && ctx.quoteMint === WSOL_MINT;
}

export interface StateOptions {
  /**
   * Build a LaunchLab curve that completed and waits for migration (status 1). Trades refuse it; a migration
   * order needs its keys.
   */
  allowCompleteCurve?: boolean;
}

/**
 * Core TokenState from the streamed trade context. `programs` (pump.fun / PumpSwap program accounts) is only
 * read for those venues; Raydium contexts carry their own configs.
 */
export async function tokenStateFromContext(
  ctx: LocalTradeContext,
  programs: ProgramConfigs | null,
  u: UserInputs,
  chain: ChainInputs = {},
  opts: StateOptions = {},
): Promise<LocalTokenState> {
  const mint = ctx.mint as Address;
  const tokenProgram = tokenProgramOf(ctx.tokenProgram);
  const quoteTokenProgram = tokenProgramOf(ctx.quoteTokenProgram);
  const baseFee = ctx.venue === "launchlab" || ctx.venue === "cpmm" ? transferFeeConfigOf(ctx.baseTransferFee, "the coin") : null;
  const mintInfo: MintInfo = { supply: BigInt(ctx.supply), decimals: ctx.decimals, tokenProgram, extensions: extensionsOf(baseFee) };
  const held = await baseHolding(u.user, mint, tokenProgram, u.balance);
  const common: Common = {
    mint,
    mintInfo,
    user: u.user,
    userLamports: u.lamports ?? 0n,
    userBaseAta: held.ata,
    userBaseBalance: held.amount,
    userBaseWithheld: baseFee ? UNKNOWN_WITHHELD : 0n,
    quoteMint: ctx.quoteMint as Address,
    quoteTokenProgram,
    quoteDecimals: ctx.quoteDecimals,
    clock: null,
  };
  switch (ctx.venue) {
    case "pump":
      return curveState(ctx, programs, common);
    case "pumpswap":
      return poolState(ctx, programs, common);
    case "launchlab":
      return launchLabState(ctx, common, chain, opts);
    case "cpmm":
      return cpmmState(ctx, common, chain);
  }
}

type Common = Omit<PumpCurveState, "venue" | "curveAddress" | "curve" | "global" | "feeConfig">;

function curveState(ctx: CurveTradeContext, programs: ProgramConfigs | null, common: Common): PumpCurveState {
  if (!programs?.global) throw new TradeStateError("pump.fun's Global account is not loaded yet. Try again in a moment.");
  if (ctx.complete || ctx.migrated) {
    throw new TradeStateError("The bonding curve is complete: trading moves to PumpSwap once the migration lands.");
  }
  return {
    venue: "pump",
    ...common,
    curveAddress: ctx.bondingCurve as Address,
    curve: {
      virtualTokenReserves: BigInt(ctx.virtualTokenReserves),
      virtualQuoteReserves: BigInt(ctx.virtualQuoteReserves),
      realTokenReserves: BigInt(ctx.realTokenReserves),
      realQuoteReserves: BigInt(ctx.realQuoteReserves),
      tokenTotalSupply: BigInt(ctx.tokenTotalSupply),
      complete: ctx.complete,
      creator: ctx.creator as Address,
      isMayhemMode: ctx.isMayhemMode,
      isCashbackCoin: ctx.isCashbackCoin,
      // On chain a SOL curve stores the default key; core reads both as SOL.
      quoteMint: ctx.quoteMint === WSOL_MINT ? DEFAULT_PUBKEY : (ctx.quoteMint as Address),
      creatorFeeBps: BigInt(ctx.creatorFeeBps),
      canEditCreatorFee: false,
      isHolderReward: ctx.isHolderReward,
      dataLength: BONDING_CURVE_NEW_SIZE,
    },
    global: programs.global,
    feeConfig: programs.pumpFeeConfig,
  };
}

async function poolState(ctx: PoolTradeContext, programs: ProgramConfigs | null, common: Common): Promise<PumpSwapState> {
  if (!programs?.ammGlobalConfig) throw new TradeStateError("PumpSwap's GlobalConfig is not loaded yet. Try again in a moment.");
  const pool = {
    poolBump: 0,
    index: ctx.poolIndex,
    creator: ctx.poolCreator as Address,
    baseMint: ctx.mint as Address,
    quoteMint: ctx.quoteMint as Address,
    lpMint: ctx.lpMint as Address,
    poolBaseTokenAccount: ctx.poolBaseTokenAccount as Address,
    poolQuoteTokenAccount: ctx.poolQuoteTokenAccount as Address,
    lpSupply: BigInt(ctx.lpSupply),
    coinCreator: ctx.coinCreator as Address,
    isMayhemMode: ctx.isMayhemMode,
    isCashbackCoin: ctx.isCashbackCoin,
    virtualQuoteReserves: BigInt(ctx.virtualQuoteReserves),
    creatorFeeBps: BigInt(ctx.creatorFeeBps),
    canEditCreatorFee: ctx.canEditCreatorFee,
    isHolderReward: ctx.isHolderReward,
    // A pool read before the size was recorded is assumed current (no extend_account).
    dataLength: ctx.poolDataLength ?? POOL_ACCOUNT_NEW_SIZE,
  };
  return {
    venue: "pumpswap",
    ...common,
    poolAddress: ctx.pool as Address,
    pool,
    // Derived here (pool creator == pool-authority PDA of the mint), not taken from the server's flag.
    isCanonical: await isCanonicalPumpPool(pool),
    reserves: {
      baseReserve: BigInt(ctx.baseReserve),
      quoteVaultReserve: BigInt(ctx.quoteVaultReserve),
      virtualQuoteReserves: BigInt(ctx.virtualQuoteReserves),
    },
    globalConfig: programs.ammGlobalConfig,
    feeConfig: programs.ammFeeConfig,
  };
}

// ---------------------------------------------------------------------------------------------
// Raydium
// ---------------------------------------------------------------------------------------------

/** An account the builder needs; empty / not an address = the server has not read it yet. */
function account(value: string | null | undefined, what: string): Address {
  if (!value || !isAddress(value)) throw new NoLocalBuildError(`The server has not read this coin's ${what} yet`);
  return value;
}

/** A decimal u64 from the context. */
function amount(value: string, what: string): bigint {
  let v: bigint;
  try {
    v = BigInt(value);
  } catch {
    throw new TradeStateError(`The trade context's ${what} is not a number (${value})`);
  }
  if (v < 0n) throw new TradeStateError(`The trade context's ${what} is negative (${value})`);
  return v;
}

/** protocol TransferFeeInfo -> core TransferFeeConfig (authorities and withheld totals do not change a quote). */
export function transferFeeConfigOf(info: TransferFeeInfo | null, what = "the mint"): TransferFeeConfig | null {
  if (!info) return null;
  const fee = (x: TransferFeeInfo["older"]) => {
    if (!Number.isInteger(x.basisPoints) || x.basisPoints < 0 || x.basisPoints > 10_000) {
      throw new TradeStateError(`The transfer fee of ${what} is out of range (${x.basisPoints} bps)`);
    }
    return {
      epoch: amount(x.epoch, `transfer fee epoch of ${what}`),
      maximumFee: amount(x.maximumFee, `maximum transfer fee of ${what}`),
      transferFeeBasisPoints: BigInt(x.basisPoints),
    };
  };
  return {
    transferFeeConfigAuthority: null,
    withdrawWithheldAuthority: null,
    withheldAmount: 0n,
    olderTransferFee: fee(info.older),
    newerTransferFee: fee(info.newer),
  };
}

function extensionsOf(fee: TransferFeeConfig | null): Token2022Extensions {
  return fee ? { ...NO_EXTENSIONS, types: [TOKEN_2022_EXTENSIONS.transferFeeConfig], transferFeeConfig: fee } : NO_EXTENSIONS;
}

/** Quote mint info: wSOL is plain SPL Token; a Token-2022 quote carries its transfer fee. */
function quoteMintInfoOf(ctx: LaunchLabTradeContext | CpmmTradeContext, quoteTokenProgram: TokenProgram): MintInfo {
  const fee = transferFeeConfigOf(ctx.quoteTransferFee, "the quote");
  return { supply: 0n, decimals: ctx.quoteDecimals, tokenProgram: quoteTokenProgram, extensions: extensionsOf(fee) };
}

/**
 * The Clock core reads: the context's epoch (the server's, from its event slot) unless the live chain slot
 * moved into a later one; unix time from the wall clock (only CPMM open_time reads it).
 */
function clockOf(ctx: LaunchLabTradeContext | CpmmTradeContext, chain: ChainInputs) {
  const slot = BigInt(Math.max(ctx.slot, chain.slot ?? 0));
  const ctxEpoch = amount(ctx.epoch, "epoch");
  const liveEpoch = slot / MAINNET_SLOTS_PER_EPOCH;
  return {
    slot,
    epoch: liveEpoch > ctxEpoch ? liveEpoch : ctxEpoch,
    unixTimestamp: BigInt(Math.floor((chain.nowMs ?? Date.now()) / 1000)),
  };
}

/**
 * LaunchLab curve state. Mapping (protocol LaunchLabTradeContext -> core LaunchLabState):
 *   pool keys     { globalConfig, platformConfig, baseMint: mint, quoteMint, baseVault, quoteVault, creator, tokenProgramFlag }
 *   curve state   { status, virtualBase, virtualQuote, realBase, realQuote, totalBaseSell, totalQuoteFundRaising }
 *   trade params  GlobalConfig { curveType, tradeFeeRate: protocolFeeRate }, PlatformConfig { feeRate: platformFeeRate,
 *                 creatorFeeRate }; share_fee_rate is always 0, so max_share_fee_rate 0 admits it
 *   transfer fees mintInfo (base) / quoteMintInfo (quote) transferFeeConfig, at clock.epoch
 */
async function launchLabState(ctx: LaunchLabTradeContext, common: Common, chain: ChainInputs, opts: StateOptions): Promise<LaunchLabState> {
  const poolAddress = account(ctx.pool, "LaunchLab pool");
  const globalConfig = account(ctx.globalConfig, "LaunchLab GlobalConfig");
  const platformConfig = account(ctx.platformConfig, "LaunchLab PlatformConfig");
  const baseVault = account(ctx.baseVault, "LaunchLab base vault");
  const quoteVault = account(ctx.quoteVault, "LaunchLab quote vault");
  const creator = account(ctx.creator, "LaunchLab pool creator");
  if (ctx.status === LAUNCHLAB_POOL_STATUS.migrate && !opts.allowCompleteCurve) {
    throw new TradeStateError("The LaunchLab curve is complete: trading moves to Raydium CPMM once Raydium migrates it.");
  }
  if (ctx.status !== LAUNCHLAB_POOL_STATUS.fund && ctx.status !== LAUNCHLAB_POOL_STATUS.migrate) {
    throw new NoLocalBuildError("This LaunchLab coin graduated; its Raydium pool is not in the server's context yet");
  }
  // The token programs the swap names come from token_program_flag: they must be the mints' owners.
  const flag = { tokenProgramFlag: ctx.tokenProgramFlag };
  if (launchLabBaseTokenProgram(flag) !== common.mintInfo.tokenProgram || launchLabQuoteTokenProgram(flag) !== common.quoteTokenProgram) {
    throw new TradeStateError(`The LaunchLab pool's token_program_flag ${ctx.tokenProgramFlag} does not match the mints' token programs`);
  }
  // The firewall only signs the pool PDA ["pool", base, quote] (one pool per pair).
  const expected = await launchLabPoolPda(common.mint, common.quoteMint);
  if (poolAddress !== expected) throw new TradeStateError(`${poolAddress} is not the LaunchLab pool of this coin (${expected})`);

  const pool: LaunchLabPool = {
    epoch: 0n,
    authBump: 0,
    status: ctx.status,
    baseDecimals: ctx.decimals,
    quoteDecimals: ctx.quoteDecimals,
    migrateType: ctx.migrateType,
    supply: common.mintInfo.supply,
    totalBaseSell: amount(ctx.totalBaseSell, "totalBaseSell"),
    virtualBase: amount(ctx.virtualBase, "virtualBase"),
    virtualQuote: amount(ctx.virtualQuote, "virtualQuote"),
    realBase: amount(ctx.realBase, "realBase"),
    realQuote: amount(ctx.realQuote, "realQuote"),
    totalQuoteFundRaising: amount(ctx.totalQuoteFundRaising, "totalQuoteFundRaising"),
    quoteProtocolFee: 0n,
    platformFee: 0n,
    migrateFee: 0n,
    vestingSchedule: { totalLockedAmount: 0n, cliffPeriod: 0n, unlockPeriod: 0n, startTime: 0n, allocatedShareAmount: 0n },
    globalConfig,
    platformConfig,
    baseMint: common.mint,
    quoteMint: common.quoteMint,
    baseVault,
    quoteVault,
    creator,
    tokenProgramFlag: ctx.tokenProgramFlag,
    ammCreatorFeeOn: 0,
    platformVestingShare: 0n,
    dataLength: LAUNCHLAB_POOL_SIZE,
  };
  if (pool.realBase > pool.virtualBase)
    throw new TradeStateError("The LaunchLab curve in the trade context is inconsistent (real base > virtual base)");
  const global: LaunchLabGlobalConfig = {
    epoch: 0n,
    curveType: ctx.curveType,
    index: 0,
    migrateFee: 0n,
    tradeFeeRate: amount(ctx.protocolFeeRate, "protocolFeeRate"),
    maxShareFeeRate: 0n,
    minBaseSupply: 0n,
    maxLockRate: 0n,
    minBaseSellRate: 0n,
    minBaseMigrateRate: 0n,
    minQuoteFundRaising: 0n,
    quoteMint: common.quoteMint,
    protocolFeeOwner: DEFAULT_PUBKEY,
    migrateFeeOwner: DEFAULT_PUBKEY,
    migrateToAmmWallet: DEFAULT_PUBKEY,
    migrateToCpswapWallet: DEFAULT_PUBKEY,
    requiresPlatformAuth: 0,
  };
  const platform: LaunchLabPlatformConfig = {
    epoch: 0n,
    platformFeeWallet: DEFAULT_PUBKEY,
    platformNftWallet: DEFAULT_PUBKEY,
    platformScale: 0n,
    creatorScale: 0n,
    burnScale: 0n,
    feeRate: amount(ctx.platformFeeRate, "platformFeeRate"),
    name: ctx.platform ?? "",
    web: "",
    img: "",
    cpswapConfig: ctx.cpswapConfig && isAddress(ctx.cpswapConfig) ? ctx.cpswapConfig : DEFAULT_PUBKEY,
    creatorFeeRate: amount(ctx.creatorFeeRate, "creatorFeeRate"),
    transferFeeExtensionAuth: DEFAULT_PUBKEY,
    platformVestingWallet: DEFAULT_PUBKEY,
    platformVestingScale: 0n,
    platformCpCreator: ctx.platformCpCreator && isAddress(ctx.platformCpCreator) ? ctx.platformCpCreator : DEFAULT_PUBKEY,
  };
  return {
    venue: "launchlab",
    ...common,
    clock: clockOf(ctx, chain),
    poolAddress,
    pool,
    globalConfig: global,
    platformConfig: platform,
    quoteMintInfo: quoteMintInfoOf(ctx, common.quoteTokenProgram),
  };
}

/**
 * CPMM pool state. Mapping (protocol CpmmTradeContext -> core CpmmState): the pool keys as named, observationKey
 * = observation; token0Reserve / token1Reserve are already net of the protocol, fund and creator fees the pool
 * owes, so they are vault0Amount / vault1Amount with zero fees owed; AmmConfig { tradeFeeRate, protocolFeeRate,
 * fundFeeRate, creatorFeeRate } (cpmmFeeRates applies creatorFeeRate only when enableCreatorFee).
 */
async function cpmmState(ctx: CpmmTradeContext, common: Common, chain: ChainInputs): Promise<CpmmState> {
  const poolAddress = account(ctx.pool, "CPMM pool");
  const ammConfig = account(ctx.ammConfig, "CPMM AmmConfig");
  const poolCreator = account(ctx.poolCreator, "CPMM pool creator");
  const token0Mint = account(ctx.token0Mint, "CPMM token_0 mint");
  const token1Mint = account(ctx.token1Mint, "CPMM token_1 mint");
  const token0Vault = account(ctx.token0Vault, "CPMM token_0 vault");
  const token1Vault = account(ctx.token1Vault, "CPMM token_1 vault");
  const observationKey = account(ctx.observation, "CPMM observation account");
  const token0Program = tokenProgramOf(account(ctx.token0Program, "CPMM token_0 program"));
  const token1Program = tokenProgramOf(account(ctx.token1Program, "CPMM token_1 program"));
  let baseIs0: boolean;
  if (token0Mint === common.mint) baseIs0 = true;
  else if (token1Mint === common.mint) baseIs0 = false;
  else throw new TradeStateError(`CPMM pool ${poolAddress} does not trade this coin`);
  const [quoteMint, baseProgram, quoteProgram] = baseIs0
    ? [token1Mint, token0Program, token1Program]
    : [token0Mint, token1Program, token0Program];
  if (quoteMint !== common.quoteMint)
    throw new TradeStateError(`CPMM pool ${poolAddress} pairs this coin with ${quoteMint}, not ${common.quoteMint}`);
  if (baseProgram !== common.mintInfo.tokenProgram || quoteProgram !== common.quoteTokenProgram) {
    throw new TradeStateError(`CPMM pool ${poolAddress} names other token programs than the mints'`);
  }
  // The firewall signs only swaps whose vaults and observation are the pool's PDAs; so does core's loader.
  const [v0, v1, obs] = await Promise.all([
    cpmmVaultPda(poolAddress, token0Mint),
    cpmmVaultPda(poolAddress, token1Mint),
    cpmmObservationPda(poolAddress),
  ]);
  if (v0 !== token0Vault || v1 !== token1Vault || obs !== observationKey) {
    throw new TradeStateError(`CPMM pool ${poolAddress}: the vaults or observation in the trade context are not its PDAs`);
  }
  const pool: CpmmPool = {
    ammConfig,
    poolCreator,
    token0Vault,
    token1Vault,
    lpMint: ctx.lpMint && isAddress(ctx.lpMint) ? ctx.lpMint : DEFAULT_PUBKEY,
    token0Mint,
    token1Mint,
    token0Program,
    token1Program,
    observationKey,
    authBump: 0,
    status: ctx.status,
    lpMintDecimals: 0,
    mint0Decimals: baseIs0 ? ctx.decimals : ctx.quoteDecimals,
    mint1Decimals: baseIs0 ? ctx.quoteDecimals : ctx.decimals,
    lpSupply: 0n,
    // Net reserves: nothing owed on top.
    protocolFeesToken0: 0n,
    protocolFeesToken1: 0n,
    fundFeesToken0: 0n,
    fundFeesToken1: 0n,
    openTime: amount(ctx.openTime, "openTime"),
    recentEpoch: 0n,
    creatorFeeOn: ctx.creatorFeeOn,
    enableCreatorFee: ctx.enableCreatorFee,
    creatorFeesToken0: 0n,
    creatorFeesToken1: 0n,
    dataLength: CPMM_POOL_SIZE,
  };
  const config: CpmmAmmConfig = {
    bump: 0,
    disableCreatePool: false,
    index: 0,
    tradeFeeRate: amount(ctx.tradeFeeRate, "tradeFeeRate"),
    protocolFeeRate: amount(ctx.protocolFeeRate, "protocolFeeRate"),
    fundFeeRate: amount(ctx.fundFeeRate, "fundFeeRate"),
    createPoolFee: 0n,
    protocolOwner: DEFAULT_PUBKEY,
    fundOwner: DEFAULT_PUBKEY,
    creatorFeeRate: amount(ctx.creatorFeeRate, "creatorFeeRate"),
    creatorFeeShareRate: 0n,
  };
  return {
    venue: "cpmm",
    ...common,
    clock: clockOf(ctx, chain),
    poolAddress,
    pool,
    ammConfig: config,
    vault0Amount: amount(ctx.token0Reserve, "token0Reserve"),
    vault1Amount: amount(ctx.token1Reserve, "token1Reserve"),
    quoteMintInfo: quoteMintInfoOf(ctx, common.quoteTokenProgram),
    ...(ctx.launchLabPool && isAddress(ctx.launchLabPool) ? { launchLabPool: ctx.launchLabPool } : {}),
  };
}

// ---------------------------------------------------------------------------------------------

/** The Jupiter fallback for a coin the browser has no local venue for (bought with / sold for SOL). */
export async function jupiterStateFor(
  token: { mint: string; tokenProgram: string | null; decimals: number | null },
  u: UserInputs,
  reason: string,
): Promise<JupiterState> {
  if (!token.tokenProgram || token.decimals === null) throw new TradeStateError("This coin's token program is not known yet.");
  const mint = token.mint as Address;
  const tokenProgram = tokenProgramOf(token.tokenProgram);
  const held = await baseHolding(u.user, mint, tokenProgram, u.balance);
  return {
    venue: "jupiter",
    mint,
    mintInfo: { supply: 0n, decimals: token.decimals, tokenProgram, extensions: NO_EXTENSIONS },
    user: u.user,
    userLamports: u.lamports ?? 0n,
    userBaseAta: held.ata,
    userBaseBalance: held.amount,
    userBaseWithheld: 0n,
    quoteMint: WSOL_MINT,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
    quoteDecimals: 9,
    clock: null,
    reason,
    userBaseAtaExists: held.ataExists,
  };
}

/**
 * Total venue fee in bps for the UI at the context's state: protocol + creator (+ LP on PumpSwap) on pump.fun
 * and PumpSwap, null while the program accounts they depend on are not loaded; protocol + platform + creator on
 * a LaunchLab curve; the trade fee (LP, protocol and fund shares) + the creator fee where enabled on a CPMM pool.
 * Raydium rates are parts per million (1 bps = 100 ppm), so they may be fractional bps.
 */
export function venueFeeBps(ctx: TradeContext, programs: ProgramConfigs | null): number | null {
  try {
    if (ctx.venue === "launchlab") {
      const params = launchLabTradeParams({
        globalConfig: { curveType: ctx.curveType, tradeFeeRate: BigInt(ctx.protocolFeeRate), maxShareFeeRate: 0n },
        platformConfig: { feeRate: BigInt(ctx.platformFeeRate), creatorFeeRate: BigInt(ctx.creatorFeeRate) },
      });
      return Number(launchLabTotalFeeRate(params)) / 100;
    }
    if (ctx.venue === "cpmm") {
      const rates = cpmmFeeRates(
        {
          tradeFeeRate: BigInt(ctx.tradeFeeRate),
          protocolFeeRate: BigInt(ctx.protocolFeeRate),
          fundFeeRate: BigInt(ctx.fundFeeRate),
          creatorFeeRate: BigInt(ctx.creatorFeeRate),
        },
        { enableCreatorFee: ctx.enableCreatorFee },
      );
      return Number(rates.tradeFeeRate + rates.creatorFeeRate) / 100;
    }
    if (!programs) return null;
    if (ctx.venue === "pump") {
      if (!programs.global) return null;
      const r = curveFeeRates({
        curve: {
          virtualTokenReserves: BigInt(ctx.virtualTokenReserves),
          virtualQuoteReserves: BigInt(ctx.virtualQuoteReserves),
          realTokenReserves: BigInt(ctx.realTokenReserves),
          realQuoteReserves: BigInt(ctx.realQuoteReserves),
          complete: ctx.complete,
          creator: ctx.creator as Address,
          isMayhemMode: ctx.isMayhemMode,
          quoteMint: ctx.quoteMint === WSOL_MINT ? DEFAULT_PUBKEY : (ctx.quoteMint as Address),
          creatorFeeBps: BigInt(ctx.creatorFeeBps),
        },
        global: programs.global,
        feeConfig: programs.pumpFeeConfig,
        mintSupply: BigInt(ctx.supply),
      });
      return Number(r.protocolFeeBps + r.creatorFeeBps);
    }
    if (ctx.venue !== "pumpswap" || !programs.ammGlobalConfig) return null;
    const r = ammFeeRates({
      pool: {
        quoteMint: ctx.quoteMint as Address,
        isMayhemMode: ctx.isMayhemMode,
        coinCreator: ctx.coinCreator as Address,
        creatorFeeBps: BigInt(ctx.creatorFeeBps),
      },
      isCanonical: ctx.isCanonical,
      reserves: {
        baseReserve: BigInt(ctx.baseReserve),
        quoteVaultReserve: BigInt(ctx.quoteVaultReserve),
        virtualQuoteReserves: BigInt(ctx.virtualQuoteReserves),
      },
      baseMintSupply: BigInt(ctx.supply),
      feeConfig: programs.ammFeeConfig,
      globalConfig: programs.ammGlobalConfig,
    });
    return Number(r.lpFeeBps + r.protocolFeeBps + r.creatorFeeBps);
  } catch {
    return null;
  }
}
