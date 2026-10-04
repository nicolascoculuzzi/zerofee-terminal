/**
 * packages/protocol trade inputs -> @zerofee/core TokenState, so the browser quotes and builds with core
 * exactly as the CLI does after loadTokenState, without an RPC of its own:
 *   - pump.fun curve / PumpSwap pool: the streamed `tradectx:<mint>` (reserves, live creator, flags) plus
 *     the program-wide accounts (programs.ts) and the wallet's own balance from `wallet:<address>`;
 *   - Jupiter fallback (venue "jupiter"): no local venue (the server has no trade context, or the coin is
 *     quoted in something other than SOL, so a SOL trade needs a route); core asks Jupiter `/build`.
 *
 * Fields core only needs for venues the server does not stream (Clock, Token-2022 extension detail) are
 * empty: the curve and pool builders do not read them. Anything that decides where funds go is derived
 * here from the mint and the user (ATAs, PDAs) or checked by the signer firewall, never taken on trust.
 */
import type { Address } from "@solana/kit";
import {
  ammFeeRates,
  BONDING_CURVE_NEW_SIZE,
  curveFeeRates,
  DEFAULT_PUBKEY,
  findAssociatedTokenAddress,
  isCanonicalPumpPool,
  type JupiterState,
  type MintInfo,
  POOL_ACCOUNT_NEW_SIZE,
  type PumpCurveState,
  type PumpSwapState,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  type Token2022Extensions,
  type TokenProgram,
  WSOL_MINT,
} from "@zerofee/core";
import type { CurveTradeContext, PoolTradeContext, TradeContext } from "@zerofee/protocol";
import type { ProgramConfigs } from "./programs";

export class TradeStateError extends Error {}

const NO_EXTENSIONS: Token2022Extensions = {
  types: [],
  transferFeeConfig: null,
  transferHookProgramId: null,
  paused: false,
  nonTransferable: false,
  permanentDelegate: null,
};

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

/** True when the coin trades against SOL (the venues core builds locally for a SOL-sized trade). */
export function isSolQuoted(ctx: TradeContext): boolean {
  return ctx.quoteMint === WSOL_MINT;
}

/** pump.fun curve or PumpSwap pool state from the streamed trade context. */
export async function tokenStateFromContext(
  ctx: TradeContext,
  programs: ProgramConfigs,
  u: UserInputs,
): Promise<PumpCurveState | PumpSwapState> {
  const mint = ctx.mint as Address;
  const tokenProgram = tokenProgramOf(ctx.tokenProgram);
  const quoteTokenProgram = tokenProgramOf(ctx.quoteTokenProgram);
  const mintInfo: MintInfo = { supply: BigInt(ctx.supply), decimals: ctx.decimals, tokenProgram, extensions: NO_EXTENSIONS };
  const held = await baseHolding(u.user, mint, tokenProgram, u.balance);
  const common = {
    mint,
    mintInfo,
    user: u.user,
    userLamports: u.lamports ?? 0n,
    userBaseAta: held.ata,
    userBaseBalance: held.amount,
    userBaseWithheld: 0n,
    quoteMint: ctx.quoteMint as Address,
    quoteTokenProgram,
    quoteDecimals: ctx.quoteDecimals,
    clock: null,
  };
  if (ctx.venue === "pump") return curveState(ctx, programs, common);
  return poolState(ctx, programs, common);
}

type Common = Omit<PumpCurveState, "venue" | "curveAddress" | "curve" | "global" | "feeConfig">;

function curveState(ctx: CurveTradeContext, programs: ProgramConfigs, common: Common): PumpCurveState {
  if (!programs.global) throw new TradeStateError("pump.fun's Global account is not loaded yet. Try again in a moment.");
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

async function poolState(ctx: PoolTradeContext, programs: ProgramConfigs, common: Common): Promise<PumpSwapState> {
  if (!programs.ammGlobalConfig) throw new TradeStateError("PumpSwap's GlobalConfig is not loaded yet. Try again in a moment.");
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
 * Total venue fee in bps for the UI (protocol + creator, + LP on PumpSwap) at the context's reserves;
 * null while the program accounts it depends on are not loaded.
 */
export function venueFeeBps(ctx: TradeContext, programs: ProgramConfigs | null): number | null {
  if (!programs) return null;
  try {
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
    if (!programs.ammGlobalConfig) return null;
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
