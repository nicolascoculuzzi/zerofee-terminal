/**
 * Live state loading over any @solana/kit RPC (browser or server). One `getMultipleAccounts` round
 * trip resolves the venue, the mint's token program, the global/fee configs, the user's balances and
 * the Clock; later batches load what the venue needs (pool vaults, LaunchLab configs, the CPMM pool a
 * LaunchLab coin graduated into). Venue order for a bare mint:
 *   1. active pump.fun bonding curve
 *   2. canonical PumpSwap pool
 *   3. Raydium LaunchLab pool [mint, wSOL] (or `quoteMint`): funding -> LaunchLab; migrated -> its CPMM
 *      pool, the canonical PDA [pool, PlatformConfig.cpswap_config, token0, token1]
 * An explicit `poolAddress` is resolved by its owner program (PumpSwap, LaunchLab or CPMM).
 * Creator, fee tiers, reserves and fee recipients always come from these live accounts.
 */
import { type Address, getBase64Encoder, type Rpc, type SolanaRpcApi } from "@solana/kit";
import {
  LAUNCHLAB_POOL_STATUS,
  PUMP_AMM_FEE_CONFIG,
  PUMP_AMM_GLOBAL_CONFIG,
  PUMP_AMM_PROGRAM_ID,
  PUMP_FEE_CONFIG,
  PUMP_GLOBAL,
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  SYSVAR_CLOCK_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from "./constants";
import { decodeFeeConfig, type FeeConfig } from "./fees";
import {
  type BondingCurve,
  bondingCurvePda,
  canonicalPoolPda,
  curveQuoteMint,
  decodeBondingCurve,
  decodePumpGlobal,
  type PumpGlobal,
} from "./pump/accounts";
import { type AmmGlobalConfig, decodeAmmGlobalConfig, decodePool, isCanonicalPumpPool, type Pool } from "./pumpswap/accounts";
import type { AmmReserves } from "./pumpswap/math";
import { type CpmmAmmConfig, type CpmmPool, cpmmPoolPda, cpmmVaultPda, decodeCpmmAmmConfig, decodeCpmmPool } from "./raydium/cpmm/accounts";
import {
  decodeLaunchLabGlobalConfig,
  decodeLaunchLabPlatformConfig,
  decodeLaunchLabPool,
  type LaunchLabGlobalConfig,
  type LaunchLabPlatformConfig,
  type LaunchLabPool,
  launchLabPoolPda,
} from "./raydium/launchlab/accounts";
import {
  decodeMint,
  decodeTokenAccount,
  findAssociatedTokenAddress,
  type MintInfo,
  type TokenProgram,
  tokenProgramFromMintOwner,
} from "./token";
import { decodeToken2022AccountWithheld, type Token2022Extensions } from "./token2022";
import { Reader } from "./util/bytes";

export type StateRpc = Rpc<Pick<SolanaRpcApi, "getMultipleAccounts" | "getRecentPrioritizationFees">>;

export interface RawAccount {
  address: Address;
  owner: Address;
  lamports: bigint;
  data: Uint8Array;
}

const b64 = getBase64Encoder();

/** getMultipleAccounts (base64) -> decoded raw accounts (null when missing). Max 100 per call. */
export async function fetchRawAccounts(
  rpc: Rpc<Pick<SolanaRpcApi, "getMultipleAccounts">>,
  addresses: readonly Address[],
): Promise<(RawAccount | null)[]> {
  const out: (RawAccount | null)[] = [];
  for (let i = 0; i < addresses.length; i += 100) {
    const chunk = addresses.slice(i, i + 100);
    const { value } = await rpc.getMultipleAccounts(chunk, { encoding: "base64", commitment: "confirmed" }).send();
    value.forEach((acc, j) => {
      if (!acc) {
        out.push(null);
        return;
      }
      const [data] = acc.data as unknown as [string, string];
      out.push({ address: chunk[j] as Address, owner: acc.owner, lamports: acc.lamports, data: b64.encode(data) as Uint8Array });
    });
  }
  return out;
}

export interface ClockInfo {
  slot: bigint;
  /** Selects the Token-2022 transfer fee in force. */
  epoch: bigint;
  /** CPMM pools refuse swaps before open_time. */
  unixTimestamp: bigint;
}

/** Clock sysvar: slot u64, epoch_start_timestamp i64, epoch u64, leader_schedule_epoch u64, unix_timestamp i64. */
export function decodeClock(data: Uint8Array): ClockInfo {
  if (data.length < 40) throw new Error(`Clock sysvar too short (${data.length})`);
  const r = new Reader(data);
  const slot = r.u64();
  r.u64(); // epoch_start_timestamp
  const epoch = r.u64();
  r.u64(); // leader_schedule_epoch
  const raw = r.u64();
  return { slot, epoch, unixTimestamp: raw >= 1n << 63n ? raw - (1n << 64n) : raw };
}

interface CommonState {
  mint: Address;
  mintInfo: MintInfo;
  user: Address;
  userLamports: bigint;
  userBaseAta: Address;
  userBaseBalance: bigint;
  /** Token-2022 fees withheld on the user's base ATA; CloseAccount fails while non-zero. */
  userBaseWithheld: bigint;
  quoteMint: Address;
  quoteTokenProgram: TokenProgram;
  quoteDecimals: number;
  /**
   * Clock sysvar at load time; null when the RPC did not return it. Only the Raydium venues need it
   * (Token-2022 fee epoch, CPMM open_time) and they refuse to load without it.
   */
  clock: ClockInfo | null;
}

export interface PumpCurveState extends CommonState {
  venue: "pump";
  curveAddress: Address;
  curve: BondingCurve;
  global: PumpGlobal;
  feeConfig: FeeConfig | null;
}

export interface PumpSwapState extends CommonState {
  venue: "pumpswap";
  poolAddress: Address;
  pool: Pool;
  isCanonical: boolean;
  reserves: AmmReserves;
  globalConfig: AmmGlobalConfig;
  feeConfig: FeeConfig | null;
}

export interface LaunchLabState extends CommonState {
  venue: "launchlab";
  clock: ClockInfo;
  poolAddress: Address;
  pool: LaunchLabPool;
  globalConfig: LaunchLabGlobalConfig;
  platformConfig: LaunchLabPlatformConfig;
  /** Quote mint incl. Token-2022 extensions (StonkFun pairs coins with Token-2022 xStocks). */
  quoteMintInfo: MintInfo;
}

export interface CpmmState extends CommonState {
  venue: "cpmm";
  clock: ClockInfo;
  poolAddress: Address;
  pool: CpmmPool;
  ammConfig: CpmmAmmConfig;
  /** Raw vault balances (fees owed are subtracted by the math). */
  vault0Amount: bigint;
  vault1Amount: bigint;
  quoteMintInfo: MintInfo;
  /** The LaunchLab pool this coin graduated from, when resolved through it. */
  launchLabPool?: Address;
}

export type TokenState = PumpCurveState | PumpSwapState | LaunchLabState | CpmmState;
export type TradeVenue = TokenState["venue"];

const NO_EXTENSIONS: Token2022Extensions = {
  types: [],
  transferFeeConfig: null,
  transferHookProgramId: null,
  paused: false,
  nonTransferable: false,
  permanentDelegate: null,
};
/** wSOL needs no fetch: legacy SPL Token, 9 decimals, no extensions (supply is not used by any quote). */
const WSOL_INFO: MintInfo = { supply: 0n, decimals: 9, tokenProgram: TOKEN_PROGRAM_ID, extensions: NO_EXTENSIONS };

async function loadMintInfo(rpc: StateRpc, mint: Address): Promise<MintInfo> {
  if (mint === WSOL_MINT) return WSOL_INFO;
  const [acc] = await fetchRawAccounts(rpc, [mint]);
  if (!acc) throw new Error(`mint ${mint} not found`);
  return decodeMint(acc.data, acc.owner);
}

/**
 * Resolves where `mint` trades and loads everything a quote + build needs.
 * `quoteMint` selects the LaunchLab pair (default wSOL); `poolAddress` forces a specific pool.
 */
export async function loadTokenState(
  rpc: StateRpc,
  args: { mint: Address; user: Address; poolAddress?: Address; quoteMint?: Address },
): Promise<TokenState> {
  const { mint, user } = args;
  const [curveAddr, canonicalPool, ataToken, ataToken2022, launchLabPoolAddr] = await Promise.all([
    bondingCurvePda(mint),
    canonicalPoolPda(mint),
    findAssociatedTokenAddress(user, mint, TOKEN_PROGRAM_ID),
    findAssociatedTokenAddress(user, mint, TOKEN_2022_PROGRAM_ID),
    launchLabPoolPda(mint, args.quoteMint ?? WSOL_MINT),
  ]);
  const poolAddress = args.poolAddress ?? canonicalPool;
  const [mintAcc, curveAcc, globalAcc, feeCfgAcc, poolAcc, ammCfgAcc, ammFeeAcc, ataTAcc, ata22Acc, userAcc, llPoolAcc, clockAcc] =
    await fetchRawAccounts(rpc, [
      mint,
      curveAddr,
      PUMP_GLOBAL,
      PUMP_FEE_CONFIG,
      poolAddress,
      PUMP_AMM_GLOBAL_CONFIG,
      PUMP_AMM_FEE_CONFIG,
      ataToken,
      ataToken2022,
      user,
      launchLabPoolAddr,
      SYSVAR_CLOCK_ID,
    ]);
  if (!mintAcc) throw new Error(`mint ${mint} not found`);
  const mintInfo = decodeMint(mintAcc.data, mintAcc.owner);
  const is2022 = mintInfo.tokenProgram === TOKEN_2022_PROGRAM_ID;
  const userBaseAta = is2022 ? ataToken2022 : ataToken;
  const ataAcc = is2022 ? ata22Acc : ataTAcc;
  const common = {
    mint,
    mintInfo,
    user,
    userLamports: userAcc?.lamports ?? 0n,
    userBaseAta,
    userBaseBalance: ataAcc ? decodeTokenAccount(ataAcc.data).amount : 0n,
    userBaseWithheld: ataAcc && is2022 ? decodeToken2022AccountWithheld(ataAcc.data) : 0n,
    clock: clockAcc ? decodeClock(clockAcc.data) : null,
  };

  // Explicit pool: dispatch on its owner program.
  if (args.poolAddress) {
    if (!poolAcc) throw new Error(`pool ${args.poolAddress} not found`);
    if (poolAcc.owner === RAYDIUM_LAUNCHLAB_PROGRAM_ID) return loadLaunchLab(rpc, common, args.poolAddress, poolAcc.data);
    if (poolAcc.owner === RAYDIUM_CPMM_PROGRAM_ID) return loadCpmm(rpc, common, args.poolAddress, decodeCpmmPool(poolAcc.data));
    if (poolAcc.owner !== PUMP_AMM_PROGRAM_ID) throw new Error(`pool ${args.poolAddress} is owned by ${poolAcc.owner} (unsupported venue)`);
  }

  const curve = curveAcc ? decodeBondingCurve(curveAcc.data) : null;
  if (curve && !curve.complete && curve.virtualTokenReserves > 0n && !args.poolAddress) {
    if (!globalAcc) throw new Error("pump Global account missing");
    const quoteMint = curveQuoteMint(curve);
    let quoteTokenProgram: TokenProgram = TOKEN_PROGRAM_ID;
    let quoteDecimals = 9;
    if (quoteMint !== WSOL_MINT) {
      const qi = await loadMintInfo(rpc, quoteMint);
      quoteTokenProgram = qi.tokenProgram;
      quoteDecimals = qi.decimals;
    }
    return {
      venue: "pump",
      ...common,
      quoteMint,
      quoteTokenProgram,
      quoteDecimals,
      curveAddress: curveAddr,
      curve,
      global: decodePumpGlobal(globalAcc.data),
      feeConfig: feeCfgAcc ? decodeFeeConfig(feeCfgAcc.data) : null,
    };
  }

  if (!poolAcc && !args.poolAddress && llPoolAcc && llPoolAcc.owner === RAYDIUM_LAUNCHLAB_PROGRAM_ID) {
    return loadLaunchLab(rpc, common, launchLabPoolAddr, llPoolAcc.data);
  }

  if (!poolAcc) {
    throw new Error(
      curve
        ? `bonding curve for ${mint} is complete but canonical pool ${poolAddress} was not found (migration pending?)`
        : `${mint} has no pump bonding curve, PumpSwap pool or Raydium LaunchLab ${args.quoteMint ? "" : "SOL "}pair (pass a pool address)`,
    );
  }
  if (!ammCfgAcc) throw new Error("PumpSwap GlobalConfig missing");
  const pool = decodePool(poolAcc.data);
  if (pool.baseMint !== mint) throw new Error(`pool ${poolAddress} base mint ${pool.baseMint} != ${mint}`);
  const [baseVault, quoteVault, quoteMintAcc] = await fetchRawAccounts(rpc, [
    pool.poolBaseTokenAccount,
    pool.poolQuoteTokenAccount,
    pool.quoteMint,
  ]);
  if (!baseVault || !quoteVault || !quoteMintAcc) throw new Error("pool vaults or quote mint missing");
  const qi = decodeMint(quoteMintAcc.data, quoteMintAcc.owner);
  return {
    venue: "pumpswap",
    ...common,
    quoteMint: pool.quoteMint,
    quoteTokenProgram: tokenProgramFromMintOwner(quoteMintAcc.owner),
    quoteDecimals: qi.decimals,
    poolAddress,
    pool,
    isCanonical: await isCanonicalPumpPool(pool),
    reserves: {
      baseReserve: decodeTokenAccount(baseVault.data).amount,
      quoteVaultReserve: decodeTokenAccount(quoteVault.data).amount,
      virtualQuoteReserves: pool.virtualQuoteReserves,
    },
    globalConfig: decodeAmmGlobalConfig(ammCfgAcc.data),
    feeConfig: ammFeeAcc ? decodeFeeConfig(ammFeeAcc.data) : null,
  };
}

type Common = Omit<CommonState, "quoteMint" | "quoteTokenProgram" | "quoteDecimals">;

function requireClock(common: Common): ClockInfo {
  if (!common.clock) throw new Error("Clock sysvar missing (Raydium quotes need the epoch and unix time)");
  return common.clock;
}

/** LaunchLab pool -> LaunchLab state while funding, or the CPMM pool it graduated into. */
async function loadLaunchLab(rpc: StateRpc, common: Common, poolAddress: Address, data: Uint8Array): Promise<LaunchLabState | CpmmState> {
  const clock = requireClock(common);
  const pool = decodeLaunchLabPool(data);
  if (pool.baseMint !== common.mint) throw new Error(`LaunchLab pool ${poolAddress} base mint ${pool.baseMint} != ${common.mint}`);
  const [globalAcc, platformAcc] = await fetchRawAccounts(rpc, [pool.globalConfig, pool.platformConfig]);
  if (!globalAcc || !platformAcc) throw new Error(`LaunchLab configs of ${poolAddress} missing`);
  const platformConfig = decodeLaunchLabPlatformConfig(platformAcc.data);

  if (pool.status === LAUNCHLAB_POOL_STATUS.migrate) {
    throw new Error(`LaunchLab curve of ${common.mint} is complete and waiting for migration to CPMM (Raydium's wallet signs it)`);
  }
  if (pool.status !== LAUNCHLAB_POOL_STATUS.fund) {
    if (pool.migrateType !== 1) throw new Error(`${common.mint} graduated to Raydium AMM v4, which is not supported`);
    const cpmmPool = await cpmmPoolPda(platformConfig.cpswapConfig, pool.baseMint, pool.quoteMint);
    const [cpmmAcc] = await fetchRawAccounts(rpc, [cpmmPool]);
    if (!cpmmAcc || cpmmAcc.owner !== RAYDIUM_CPMM_PROGRAM_ID) {
      throw new Error(`${common.mint} graduated but its CPMM pool ${cpmmPool} was not found (platform cpswap_config changed?)`);
    }
    return loadCpmm(rpc, common, cpmmPool, decodeCpmmPool(cpmmAcc.data), poolAddress);
  }
  const quoteMintInfo = await loadMintInfo(rpc, pool.quoteMint);
  return {
    venue: "launchlab",
    ...common,
    clock,
    quoteMint: pool.quoteMint,
    quoteTokenProgram: quoteMintInfo.tokenProgram,
    quoteDecimals: quoteMintInfo.decimals,
    poolAddress,
    pool,
    globalConfig: decodeLaunchLabGlobalConfig(globalAcc.data),
    platformConfig,
    quoteMintInfo,
  };
}

async function loadCpmm(rpc: StateRpc, common: Common, poolAddress: Address, pool: CpmmPool, launchLabPool?: Address): Promise<CpmmState> {
  const clock = requireClock(common);
  let quoteMint: Address;
  if (pool.token0Mint === common.mint) quoteMint = pool.token1Mint;
  else if (pool.token1Mint === common.mint) quoteMint = pool.token0Mint;
  else throw new Error(`CPMM pool ${poolAddress} does not trade ${common.mint}`);
  const [vault0, vault1] = await Promise.all([cpmmVaultPda(poolAddress, pool.token0Mint), cpmmVaultPda(poolAddress, pool.token1Mint)]);
  if (vault0 !== pool.token0Vault || vault1 !== pool.token1Vault)
    throw new Error(`CPMM pool ${poolAddress} vaults are not the canonical PDAs`);
  const [configAcc, v0Acc, v1Acc, quoteAcc] = await fetchRawAccounts(rpc, [
    pool.ammConfig,
    pool.token0Vault,
    pool.token1Vault,
    ...(quoteMint === WSOL_MINT ? [] : [quoteMint]),
  ]);
  if (!configAcc || !v0Acc || !v1Acc) throw new Error(`CPMM config or vaults of ${poolAddress} missing`);
  const quoteMintInfo = quoteMint === WSOL_MINT ? WSOL_INFO : quoteAcc ? decodeMint(quoteAcc.data, quoteAcc.owner) : null;
  if (!quoteMintInfo) throw new Error(`quote mint ${quoteMint} not found`);
  return {
    venue: "cpmm",
    ...common,
    clock,
    quoteMint,
    quoteTokenProgram: quoteMintInfo.tokenProgram,
    quoteDecimals: quoteMintInfo.decimals,
    poolAddress,
    pool,
    ammConfig: decodeCpmmAmmConfig(configAcc.data),
    vault0Amount: decodeTokenAccount(v0Acc.data).amount,
    vault1Amount: decodeTokenAccount(v1Acc.data).amount,
    quoteMintInfo,
    launchLabPool,
  };
}

/** Recent prioritization fees (micro-lamports/CU) for txs write-locking ALL of `writable` (max 128). */
export async function fetchPriorityFeeSamples(rpc: StateRpc, writable: readonly Address[]): Promise<number[]> {
  const res = await rpc.getRecentPrioritizationFees(writable.slice(0, 128)).send();
  return res.map((r) => Number(r.prioritizationFee));
}
