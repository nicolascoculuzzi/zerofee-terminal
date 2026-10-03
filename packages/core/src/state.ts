/**
 * Live state loading over any @solana/kit RPC (browser or server). One `getMultipleAccounts` round
 * trip resolves the venue (bonding curve vs canonical PumpSwap pool), the mint's token program, the
 * global/fee configs and the user's balances; a second batch loads pool vaults when needed.
 * Creator, fee tiers, reserves and fee recipients always come from these live accounts.
 */
import { type Address, getBase64Encoder, type Rpc, type SolanaRpcApi } from "@solana/kit";
import {
  PUMP_AMM_FEE_CONFIG,
  PUMP_AMM_GLOBAL_CONFIG,
  PUMP_FEE_CONFIG,
  PUMP_GLOBAL,
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
import {
  decodeMint,
  decodeTokenAccount,
  findAssociatedTokenAddress,
  type MintInfo,
  type TokenProgram,
  tokenProgramFromMintOwner,
} from "./token";

export type StateRpc = Rpc<Pick<SolanaRpcApi, "getMultipleAccounts" | "getRecentPrioritizationFees">>;

export interface RawAccount {
  address: Address;
  owner: Address;
  lamports: bigint;
  data: Uint8Array;
}

const b64 = getBase64Encoder();

/** getMultipleAccounts (base64) -> decoded raw accounts (null when missing). Max 100 per call. */
export async function fetchRawAccounts(rpc: StateRpc, addresses: readonly Address[]): Promise<(RawAccount | null)[]> {
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

interface CommonState {
  mint: Address;
  mintInfo: MintInfo;
  user: Address;
  userLamports: bigint;
  userBaseAta: Address;
  userBaseBalance: bigint;
  quoteMint: Address;
  quoteTokenProgram: TokenProgram;
  quoteDecimals: number;
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

export type TokenState = PumpCurveState | PumpSwapState;

/**
 * Resolves where `mint` trades and loads everything a quote + build needs.
 * Order of preference: active bonding curve -> canonical PumpSwap pool (or an explicit `poolAddress`).
 */
export async function loadTokenState(rpc: StateRpc, args: { mint: Address; user: Address; poolAddress?: Address }): Promise<TokenState> {
  const { mint, user } = args;
  const [curveAddr, canonicalPool, ataToken, ataToken2022] = await Promise.all([
    bondingCurvePda(mint),
    canonicalPoolPda(mint),
    findAssociatedTokenAddress(user, mint, TOKEN_PROGRAM_ID),
    findAssociatedTokenAddress(user, mint, TOKEN_2022_PROGRAM_ID),
  ]);
  const poolAddress = args.poolAddress ?? canonicalPool;
  const [mintAcc, curveAcc, globalAcc, feeCfgAcc, poolAcc, ammCfgAcc, ammFeeAcc, ataTAcc, ata22Acc, userAcc] = await fetchRawAccounts(rpc, [
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
  ]);
  if (!mintAcc) throw new Error(`mint ${mint} not found`);
  const mintInfo = decodeMint(mintAcc.data, mintAcc.owner);
  const is2022 = mintInfo.tokenProgram === TOKEN_2022_PROGRAM_ID;
  const userBaseAta = is2022 ? ataToken2022 : ataToken;
  const ataAcc = is2022 ? ata22Acc : ataTAcc;
  const userBaseBalance = ataAcc ? decodeTokenAccount(ataAcc.data).amount : 0n;
  const userLamports = userAcc?.lamports ?? 0n;

  const curve = curveAcc ? decodeBondingCurve(curveAcc.data) : null;
  if (curve && !curve.complete && curve.virtualTokenReserves > 0n && !args.poolAddress) {
    if (!globalAcc) throw new Error("pump Global account missing");
    const quoteMint = curveQuoteMint(curve);
    let quoteTokenProgram: TokenProgram = TOKEN_PROGRAM_ID;
    let quoteDecimals = 9;
    if (quoteMint !== WSOL_MINT) {
      const [qm] = await fetchRawAccounts(rpc, [quoteMint]);
      if (!qm) throw new Error(`quote mint ${quoteMint} not found`);
      const qi = decodeMint(qm.data, qm.owner);
      quoteTokenProgram = qi.tokenProgram;
      quoteDecimals = qi.decimals;
    }
    return {
      venue: "pump",
      mint,
      mintInfo,
      user,
      userLamports,
      userBaseAta,
      userBaseBalance,
      quoteMint,
      quoteTokenProgram,
      quoteDecimals,
      curveAddress: curveAddr,
      curve,
      global: decodePumpGlobal(globalAcc.data),
      feeConfig: feeCfgAcc ? decodeFeeConfig(feeCfgAcc.data) : null,
    };
  }

  if (!poolAcc) {
    throw new Error(
      curve
        ? `bonding curve for ${mint} is complete but canonical pool ${poolAddress} was not found (migration pending?)`
        : `${mint} has no pump bonding curve and no canonical PumpSwap pool (pass a pool address)`,
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
    mint,
    mintInfo,
    user,
    userLamports,
    userBaseAta,
    userBaseBalance,
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

/** Recent prioritization fees (micro-lamports/CU) for txs write-locking ALL of `writable` (max 128). */
export async function fetchPriorityFeeSamples(rpc: StateRpc, writable: readonly Address[]): Promise<number[]> {
  const res = await rpc.getRecentPrioritizationFees(writable.slice(0, 128)).send();
  return res.map((r) => Number(r.prioritizationFee));
}
