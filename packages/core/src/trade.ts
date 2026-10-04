/**
 * Venue-agnostic trade builder: quote locally from cached state (no external quote API on the hot
 * path) and produce the trade instructions with slippage-bounded limits.
 *   buy  = spend `amount` quote base units (fees included)   -> buy_exact_quote_in(_v2) / buy_exact_in / swap_base_input
 *   sell = sell `amount` base units for >= quote*(1-slippage) -> sell(_v2) / sell_exact_in / swap_base_input
 * Limits are applied to what the user actually RECEIVES (after any Token-2022 transfer fee).
 *
 * The exception is the long-tail fallback (venue "jupiter"): no local venue exists, so the quote and the
 * route come from Jupiter `/build` at build time (one HTTP round trip), with the user's slippage and no
 * Jupiter fee. Its compute budget and tips are ours (assembleTransaction), and it needs the route's
 * address lookup tables (BuiltTrade.lookupTables).
 */
import type { Address, AddressesByLookupTableAddress, Blockhash, Instruction } from "@solana/kit";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  DEFAULT_CU_LIMITS,
  HELIUS_SENDER_TIP_ACCOUNTS,
  JITO_TIP_ACCOUNTS_FALLBACK,
  JUPITER_MAX_ACCOUNTS,
  JUPITER_REVIEWED_HOPS,
  MAX_COMPUTE_UNIT_LIMIT,
  RAYDIUM_FEE_RATE_DENOMINATOR,
} from "./constants";
import {
  fetchJupiterBuild,
  JupiterApiError,
  type JupiterBuildRequest,
  type JupiterBuildResponse,
  type JupiterClientOptions,
} from "./jupiter/client";
import {
  type JupiterRoute,
  JupiterRouteError,
  type JupiterRouteInstruction,
  jupiterRouteFromBuild,
  jupiterRouteProblem,
} from "./jupiter/route";
import { curveFeeRates, quoteBuyExactQuoteIn, quoteSell } from "./pump/curve";
import { buildPumpBuyInstructions, buildPumpSellInstructions } from "./pump/instructions";
import { buildAmmBuyInstructions, buildAmmSellInstructions } from "./pumpswap/instructions";
import { ammFeeRates, quoteAmmBuyExactQuoteIn, quoteAmmSell } from "./pumpswap/math";
import { buildCpmmSwapInstructions } from "./raydium/cpmm/instructions";
import { cpmmFeeRates, quoteCpmmSwapBaseInput } from "./raydium/cpmm/math";
import { buildLaunchLabBuyInstructions, buildLaunchLabSellInstructions } from "./raydium/launchlab/instructions";
import { launchLabTradeParams, quoteLaunchLabBuyExactIn, quoteLaunchLabSellExactIn } from "./raydium/launchlab/math";
import type { CpmmState, JupiterState, LaunchLabState, TokenState } from "./state";
import { assertSwappableMint, closeAccountInstruction } from "./token";
import { assembleTransaction } from "./tx/assemble";
import { minOutForTrade } from "./util/math";

export interface TradeRequest {
  side: "buy" | "sell";
  /** buy: quote base units to spend (lamports for SOL pairs). sell: base units to sell. */
  amount: bigint;
  slippageBps: number;
  /** Close the base token account when selling the whole balance (reclaims rent). Default true. */
  closeOnFullExit?: boolean;
}

export interface TradeQuote {
  venue: TokenState["venue"];
  side: TradeRequest["side"];
  /** buy: quote spent (incl. fees); sell: base sold. */
  amountIn: bigint;
  /** buy: base the user receives; sell: quote the user receives (both after fees and transfer fees). */
  expectedOut: bigint;
  /** Slippage-bounded minimum out passed on-chain. */
  minOut: bigint;
  /** Fees in quote base units (0 where a venue has no such component). */
  feesQuote: { protocol: bigint; creator: bigint; lp: bigint; buyback: bigint; platform: bigint; fund: bigint; total: bigint };
  /** Fees in base units: CPMM trade/creator fees when base is the input, Token-2022 transfer fees. */
  feesBase: { trade: bigint; creator: bigint; transfer: bigint };
  /** Fee rates in parts per million of the trade amount (CPMM protocol/fund are their share of the trade fee). */
  feePpm: { protocol: bigint; platform: bigint; creator: bigint; lp: bigint; fund: bigint };
  /**
   * Raydium venues: what the venue's own event must report (LaunchLab TradeEvent amount_in /
   * amount_out, CPMM SwapEvent input_amount / output_amount), for exact fill reconciliation.
   */
  expectedEvent?: { amountIn: bigint; amountOut: bigint };
  /**
   * Jupiter fallback: Jupiter's quote and route. Venue fees along the route are inside `expectedOut`
   * (Jupiter does not itemize them), so feesQuote / feesBase / feePpm are all 0 here.
   */
  jupiter?: {
    instruction: JupiterRouteInstruction;
    labels: string[];
    ammKeys: Address[];
    priceImpactPct: string | null;
    /** The /build route-account budget the quote came from (undefined: Jupiter's default, 64). */
    maxAccounts?: number;
    /** Jupiter's creation of the (existing) token account was left out to fit one packet. */
    droppedAtaCreate: boolean;
    /** The open route was one the signer would refuse, so the quote is over the reviewed venues only. */
    reviewedVenuesOnly: boolean;
  };
}

export interface BuiltTrade {
  quote: TradeQuote;
  instructions: Instruction[];
  /** Hot write-locked account for priority-fee sampling (curve or pool). */
  hotAccount: Address;
  defaultCuLimit: number;
  /** Address lookup tables the instructions need (Jupiter routes); pass them to assembleTransaction. */
  lookupTables?: AddressesByLookupTableAddress;
}

/** How the Jupiter fallback calls `/build` (API key, base URL, fetch) and shapes the route. */
export interface JupiterTradeOptions
  extends JupiterClientOptions,
    Pick<JupiterBuildRequest, "maxAccounts" | "excludeDexes" | "forJitoBundle" | "mode"> {}

export interface BuildTradeOptions {
  jupiter?: JupiterTradeOptions;
}

const NO_BASE_FEES = { trade: 0n, creator: 0n, transfer: 0n };

function assertSellable(state: TokenState, amount: bigint): void {
  if (amount > state.userBaseBalance) throw new RangeError(`sell amount ${amount} exceeds balance ${state.userBaseBalance}`);
}

/** Full exit closes the base ATA, except Token-2022 accounts still holding withheld transfer fees. */
function closeOnExit(state: TokenState, req: TradeRequest): boolean {
  return (req.closeOnFullExit ?? true) && req.amount === state.userBaseBalance && state.userBaseWithheld === 0n;
}

export async function buildTrade(state: TokenState, req: TradeRequest, opts: BuildTradeOptions = {}): Promise<BuiltTrade> {
  if (req.amount <= 0n) throw new RangeError("amount must be > 0");
  switch (state.venue) {
    case "launchlab":
      return buildLaunchLabTrade(state, req);
    case "cpmm":
      return buildCpmmTrade(state, req);
    case "pump":
      return buildPumpTrade(state, req);
    case "jupiter":
      return buildJupiterTrade(state, req, opts.jupiter);
    default:
      return buildPumpSwapTrade(state, req);
  }
}

const NO_QUOTE_FEES = { protocol: 0n, creator: 0n, lp: 0n, buyback: 0n, platform: 0n, fund: 0n, total: 0n };
const NO_FEE_PPM = { protocol: 0n, platform: 0n, creator: 0n, lp: 0n, fund: 0n };

/** The /build `dexes` labels of the venues whose route_v2 hops the signer can verify. */
export const JUPITER_REVIEWED_DEX_LABELS: readonly string[] = [...new Set(Object.values(JUPITER_REVIEWED_HOPS).map((h) => h.label))];
/** At most this many /build calls per trade (keyless access is 0.5 requests/s). */
export const JUPITER_MAX_QUOTES = 6;

/** /build route-account budgets to try: the caller's (or Jupiter's default 64), then smaller ones. */
export function jupiterMaxAccountsSteps(start?: number): (number | undefined)[] {
  const first = start ?? JUPITER_MAX_ACCOUNTS;
  return [start, ...[48, 32, 24].filter((n) => n < first)];
}

/**
 * The largest compute budget and tip layout any landing mode adds (CU limit and price, a Helius and a
 * Jito tip, the jitodontfront marker), to check that a route fits one packet before choosing the mode.
 */
const SIZE_PROBE = {
  blockhash: { blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 0n },
  fees: {
    cuLimit: MAX_COMPUTE_UNIT_LIMIT,
    cuPriceMicroLamports: 1n,
    tips: [
      { lane: "helius" as const, lamports: 1n, tipAccount: HELIUS_SENDER_TIP_ACCOUNTS[0]! },
      { lane: "jito" as const, lamports: 1n, tipAccount: JITO_TIP_ACCOUNTS_FALLBACK[0]! },
    ],
    jitoDontFront: true,
  },
};

/** Whether a Jupiter trade fits one packet in every landing mode (largest budget and tip layout). */
export function jupiterRouteFits(user: Address, instructions: Instruction[], lookupTables: AddressesByLookupTableAddress): boolean {
  try {
    assembleTransaction({ feePayer: user, instructions, lookupTables, ...SIZE_PROBE });
    return true;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("transaction too large")) return false;
    throw e;
  }
}

const createsAta = (ix: Instruction, ata: Address) =>
  ix.programAddress === ASSOCIATED_TOKEN_PROGRAM_ID && ix.accounts?.[1]?.address === ata;

/**
 * Long-tail fallback: Jupiter `/build` for quote -> token (buy) or token -> quote (sell), exact in, the
 * user's slippage. A full exit also closes the token account, like the local venues.
 */
async function buildJupiterTrade(state: JupiterState, req: TradeRequest, opts: JupiterTradeOptions = {}): Promise<BuiltTrade> {
  const isBuy = req.side === "buy";
  if (!isBuy) assertSellable(state, req.amount);
  const inputMint = isBuy ? state.quoteMint : state.mint;
  const outputMint = isBuy ? state.mint : state.quoteMint;
  const { maxAccounts, excludeDexes, forJitoBundle, mode, ...client } = opts;
  const closeBase = !isBuy && closeOnExit(state, req);
  const withClose = (ixs: Instruction[]) =>
    closeBase
      ? [
          ...ixs,
          closeAccountInstruction({
            account: state.userBaseAta,
            destination: state.user,
            owner: state.user,
            tokenProgram: state.mintInfo.tokenProgram,
          }),
        ]
      : ixs;

  // A route must be one the signer firewall can verify (jupiterRouteProblem: no hop may act on the
  // user's accounts unchecked) and fit one packet with our compute budget and tips, the firewall's static
  // keys kept static. Otherwise: re-quote over the venues whose hops are reviewed; drop the no-op
  // creation of a token account that already exists; ask for fewer accounts (Jupiter's documented
  // remedy). Each re-quote is a new /build call, at most JUPITER_MAX_QUOTES.
  let route: JupiterRoute | undefined;
  let instructions: Instruction[] = [];
  let budget: number | undefined;
  let droppedAtaCreate = false;
  let restricted = false;
  let quotes = 0;
  let lastProblem = "";
  search: for (const accounts of jupiterMaxAccountsSteps(maxAccounts)) {
    const options: readonly boolean[] = restricted ? [true] : [false, true];
    for (const restrict of options) {
      if (quotes++ >= JUPITER_MAX_QUOTES) break search;
      budget = accounts;
      restricted = restrict;
      let build: JupiterBuildResponse;
      try {
        build = await fetchJupiterBuild(
          {
            inputMint,
            outputMint,
            amount: req.amount,
            slippageBps: req.slippageBps,
            taker: state.user,
            maxAccounts: accounts,
            ...(restrict ? { dexes: JUPITER_REVIEWED_DEX_LABELS } : { excludeDexes }),
            forJitoBundle,
            mode,
          },
          client,
        );
      } catch (e) {
        // No route over the reviewed venues alone: report why the open routes were refused.
        if (restrict && e instanceof JupiterApiError && e.status === 400) {
          throw new JupiterRouteError(
            `Jupiter /build: no route the signer can verify (${lastProblem}; none over ${JUPITER_REVIEWED_DEX_LABELS.join(", ")})`,
          );
        }
        throw e;
      }
      route = await jupiterRouteFromBuild(build, {
        user: state.user,
        inputMint,
        outputMint,
        amount: req.amount,
        slippageBps: req.slippageBps,
      });
      const problem = jupiterRouteProblem(route, state.user);
      if (problem) {
        lastProblem = problem;
        route = undefined;
        continue;
      }
      instructions = withClose(route.instructions);
      if (jupiterRouteFits(state.user, instructions, route.lookupTables)) break search;
      if (isBuy && state.userBaseAtaExists) {
        const trimmed = withClose(route.instructions.filter((ix) => !createsAta(ix, state.userBaseAta)));
        if (jupiterRouteFits(state.user, trimmed, route.lookupTables)) {
          instructions = trimmed;
          droppedAtaCreate = true;
          break search;
        }
      }
      lastProblem = "too large for one transaction";
      route = undefined;
      break; // too large: try a smaller account budget
    }
  }
  if (!route) throw new JupiterRouteError(`Jupiter /build: no usable route (${lastProblem}), even with fewer accounts`);
  return {
    quote: {
      venue: "jupiter",
      side: req.side,
      amountIn: req.amount,
      expectedOut: route.outAmount,
      minOut: route.minOut,
      feesQuote: NO_QUOTE_FEES,
      feesBase: NO_BASE_FEES,
      feePpm: NO_FEE_PPM,
      jupiter: {
        instruction: route.instruction,
        labels: route.labels,
        ammKeys: route.ammKeys,
        priceImpactPct: route.priceImpactPct,
        ...(budget !== undefined ? { maxAccounts: budget } : {}),
        droppedAtaCreate,
        reviewedVenuesOnly: restricted,
      },
    },
    instructions,
    hotAccount: route.ammKeys[0] ?? state.mint,
    defaultCuLimit: DEFAULT_CU_LIMITS.jupiter,
    lookupTables: route.lookupTables,
  };
}

async function buildPumpTrade(state: Extract<TokenState, { venue: "pump" }>, req: TradeRequest): Promise<BuiltTrade> {
  const rates = curveFeeRates({ curve: state.curve, global: state.global, feeConfig: state.feeConfig, mintSupply: state.mintInfo.supply });
  const ctx = {
    mint: state.mint,
    baseTokenProgram: state.mintInfo.tokenProgram,
    quoteTokenProgram: state.quoteTokenProgram,
    user: state.user,
    curve: state.curve,
    global: state.global,
  };
  const feePpm = { protocol: rates.protocolFeeBps * 100n, platform: 0n, creator: rates.creatorFeeBps * 100n, lp: 0n, fund: 0n };
  if (req.side === "buy") {
    const q = quoteBuyExactQuoteIn(state.curve, req.amount, rates);
    const minOut = minOutForTrade(q.tokenAmount, req.slippageBps);
    const { instructions } = await buildPumpBuyInstructions(ctx, { mode: "exactQuoteIn", amount: req.amount, limit: minOut });
    return {
      quote: {
        venue: "pump",
        side: "buy",
        amountIn: req.amount,
        expectedOut: q.tokenAmount,
        minOut,
        feesQuote: {
          protocol: q.protocolFee,
          creator: q.creatorFee,
          lp: 0n,
          buyback: q.buybackFee,
          platform: 0n,
          fund: 0n,
          total: q.totalFee,
        },
        feesBase: NO_BASE_FEES,
        feePpm,
      },
      instructions,
      hotAccount: state.curveAddress,
      defaultCuLimit: DEFAULT_CU_LIMITS.pumpBuy,
    };
  }
  assertSellable(state, req.amount);
  const q = quoteSell(state.curve, req.amount, rates);
  const minOut = minOutForTrade(q.quoteNet, req.slippageBps);
  const { instructions } = await buildPumpSellInstructions(ctx, {
    amount: req.amount,
    minQuoteOut: minOut,
    closeBaseAccount: closeOnExit(state, req),
  });
  return {
    quote: {
      venue: "pump",
      side: "sell",
      amountIn: req.amount,
      expectedOut: q.quoteNet,
      minOut,
      feesQuote: {
        protocol: q.protocolFee,
        creator: q.creatorFee,
        lp: 0n,
        buyback: q.buybackFee,
        platform: 0n,
        fund: 0n,
        total: q.totalFee,
      },
      feesBase: NO_BASE_FEES,
      feePpm,
    },
    instructions,
    hotAccount: state.curveAddress,
    defaultCuLimit: DEFAULT_CU_LIMITS.pumpSell,
  };
}

async function buildPumpSwapTrade(state: Extract<TokenState, { venue: "pumpswap" }>, req: TradeRequest): Promise<BuiltTrade> {
  const rates = ammFeeRates({
    pool: state.pool,
    isCanonical: state.isCanonical,
    reserves: state.reserves,
    baseMintSupply: state.mintInfo.supply,
    feeConfig: state.feeConfig,
    globalConfig: state.globalConfig,
  });
  const ctx = {
    poolAddress: state.poolAddress,
    pool: state.pool,
    user: state.user,
    baseTokenProgram: state.mintInfo.tokenProgram,
    quoteTokenProgram: state.quoteTokenProgram,
    globalConfig: state.globalConfig,
  };
  const feePpm = {
    protocol: rates.protocolFeeBps * 100n,
    platform: 0n,
    creator: rates.creatorFeeBps * 100n,
    lp: rates.lpFeeBps * 100n,
    fund: 0n,
  };
  if (req.side === "buy") {
    const q = quoteAmmBuyExactQuoteIn(state.reserves, req.amount, rates);
    const minOut = minOutForTrade(q.baseOut, req.slippageBps);
    const { instructions } = await buildAmmBuyInstructions(ctx, { mode: "exactQuoteIn", amount: req.amount, limit: minOut });
    return {
      quote: {
        venue: "pumpswap",
        side: "buy",
        amountIn: req.amount,
        expectedOut: q.baseOut,
        minOut,
        feesQuote: {
          protocol: q.protocolFee,
          creator: q.creatorFee,
          lp: q.lpFee,
          buyback: q.buybackFee,
          platform: 0n,
          fund: 0n,
          total: q.totalFee,
        },
        feesBase: NO_BASE_FEES,
        feePpm,
      },
      instructions,
      hotAccount: state.poolAddress,
      defaultCuLimit: DEFAULT_CU_LIMITS.ammBuy,
    };
  }
  assertSellable(state, req.amount);
  const q = quoteAmmSell(state.reserves, req.amount, rates);
  const minOut = minOutForTrade(q.quoteOutNet, req.slippageBps);
  const { instructions } = await buildAmmSellInstructions(ctx, {
    baseAmountIn: req.amount,
    minQuoteOut: minOut,
    closeBaseAccount: closeOnExit(state, req),
  });
  return {
    quote: {
      venue: "pumpswap",
      side: "sell",
      amountIn: req.amount,
      expectedOut: q.quoteOutNet,
      minOut,
      feesQuote: {
        protocol: q.protocolFee,
        creator: q.creatorFee,
        lp: q.lpFee,
        buyback: q.buybackFee,
        platform: 0n,
        fund: 0n,
        total: q.totalFee,
      },
      feesBase: NO_BASE_FEES,
      feePpm,
    },
    instructions,
    hotAccount: state.poolAddress,
    defaultCuLimit: DEFAULT_CU_LIMITS.ammSell,
  };
}

async function buildLaunchLabTrade(state: LaunchLabState, req: TradeRequest): Promise<BuiltTrade> {
  assertSwappableMint(state.mint, state.mintInfo);
  assertSwappableMint(state.quoteMint, state.quoteMintInfo);
  // share_fee_rate is always 0: no referral fee on a zero-fee terminal.
  const params = launchLabTradeParams({ globalConfig: state.globalConfig, platformConfig: state.platformConfig });
  const transferFees = {
    base: state.mintInfo.extensions.transferFeeConfig,
    quote: state.quoteMintInfo.extensions.transferFeeConfig,
    epoch: state.clock.epoch,
  };
  const ctx = { poolAddress: state.poolAddress, pool: state.pool, user: state.user };
  const feePpm = {
    protocol: params.protocolFeeRate,
    platform: params.platformFeeRate,
    creator: params.creatorFeeRate,
    lp: 0n,
    fund: 0n,
  };
  if (req.side === "buy") {
    const q = quoteLaunchLabBuyExactIn(state.pool, req.amount, params, transferFees);
    const minOut = minOutForTrade(q.baseReceived, req.slippageBps);
    const { instructions } = await buildLaunchLabBuyInstructions(ctx, { mode: "exactIn", amount: q.quoteIn, limit: minOut });
    return {
      quote: {
        venue: "launchlab",
        side: "buy",
        amountIn: q.quoteIn,
        expectedOut: q.baseReceived,
        minOut,
        feesQuote: {
          protocol: q.protocolFee,
          creator: q.creatorFee,
          lp: 0n,
          buyback: 0n,
          platform: q.platformFee,
          fund: 0n,
          total: q.totalFee,
        },
        feesBase: { trade: 0n, creator: 0n, transfer: q.baseTransferFee },
        feePpm,
        expectedEvent: { amountIn: q.quoteToVault, amountOut: q.baseOut },
      },
      instructions,
      hotAccount: state.poolAddress,
      defaultCuLimit: DEFAULT_CU_LIMITS.launchLabBuy,
    };
  }
  assertSellable(state, req.amount);
  const q = quoteLaunchLabSellExactIn(state.pool, req.amount, params, transferFees);
  const minOut = minOutForTrade(q.quoteReceived, req.slippageBps);
  const { instructions } = await buildLaunchLabSellInstructions(ctx, {
    mode: "exactIn",
    amount: req.amount,
    limit: minOut,
    closeBaseAccount: closeOnExit(state, req),
  });
  return {
    quote: {
      venue: "launchlab",
      side: "sell",
      amountIn: req.amount,
      expectedOut: q.quoteReceived,
      minOut,
      feesQuote: {
        protocol: q.protocolFee,
        creator: q.creatorFee,
        lp: 0n,
        buyback: 0n,
        platform: q.platformFee,
        fund: 0n,
        total: q.totalFee,
      },
      feesBase: { trade: 0n, creator: 0n, transfer: q.baseTransferFee },
      feePpm,
      expectedEvent: { amountIn: q.baseToVault, amountOut: q.quoteFromVault },
    },
    instructions,
    hotAccount: state.poolAddress,
    defaultCuLimit: DEFAULT_CU_LIMITS.launchLabSell,
  };
}

async function buildCpmmTrade(state: CpmmState, req: TradeRequest): Promise<BuiltTrade> {
  assertSwappableMint(state.mint, state.mintInfo);
  assertSwappableMint(state.quoteMint, state.quoteMintInfo);
  const rates = cpmmFeeRates(state.ammConfig, state.pool);
  const isBuy = req.side === "buy";
  if (!isBuy) assertSellable(state, req.amount);
  const baseFee = state.mintInfo.extensions.transferFeeConfig;
  const quoteFee = state.quoteMintInfo.extensions.transferFeeConfig;
  const q = quoteCpmmSwapBaseInput({
    pool: state.pool,
    vault0Amount: state.vault0Amount,
    vault1Amount: state.vault1Amount,
    inputMint: isBuy ? state.quoteMint : state.mint,
    rates,
    transferFees: { input: isBuy ? quoteFee : baseFee, output: isBuy ? baseFee : quoteFee, epoch: state.clock.epoch },
    unixTimestamp: state.clock.unixTimestamp,
    amountIn: req.amount,
  });
  const minOut = minOutForTrade(q.amountReceived, req.slippageBps);
  const { instructions } = await buildCpmmSwapInstructions(
    { poolAddress: state.poolAddress, pool: state.pool, user: state.user, inputMint: isBuy ? state.quoteMint : state.mint },
    { mode: "baseInput", amount: req.amount, limit: minOut, closeInputAccount: !isBuy && closeOnExit(state, req) },
  );
  // Fees land in the input token, except the creator fee when it is charged on the output.
  const creatorInQuote = isBuy === q.isCreatorFeeOnInput;
  const lpPpm =
    (rates.tradeFeeRate * (RAYDIUM_FEE_RATE_DENOMINATOR - rates.protocolFeeRate - rates.fundFeeRate)) / RAYDIUM_FEE_RATE_DENOMINATOR;
  return {
    quote: {
      venue: "cpmm",
      side: req.side,
      amountIn: req.amount,
      expectedOut: q.amountReceived,
      minOut,
      feesQuote: {
        protocol: isBuy ? q.protocolFee : 0n,
        creator: creatorInQuote ? q.creatorFee : 0n,
        lp: isBuy ? q.lpFee : 0n,
        buyback: 0n,
        platform: 0n,
        fund: isBuy ? q.fundFee : 0n,
        total: (isBuy ? q.tradeFee : 0n) + (creatorInQuote ? q.creatorFee : 0n),
      },
      feesBase: {
        trade: isBuy ? 0n : q.tradeFee,
        creator: creatorInQuote ? 0n : q.creatorFee,
        transfer: isBuy ? q.outputTransferFee : q.inputTransferFee,
      },
      feePpm: {
        protocol: (rates.tradeFeeRate * rates.protocolFeeRate) / RAYDIUM_FEE_RATE_DENOMINATOR,
        platform: 0n,
        creator: rates.creatorFeeRate,
        lp: lpPpm,
        fund: (rates.tradeFeeRate * rates.fundFeeRate) / RAYDIUM_FEE_RATE_DENOMINATOR,
      },
      expectedEvent: { amountIn: q.amountIn - q.inputTransferFee, amountOut: q.outputAmount },
    },
    instructions,
    hotAccount: state.poolAddress,
    defaultCuLimit: isBuy ? DEFAULT_CU_LIMITS.cpmmBuy : DEFAULT_CU_LIMITS.cpmmSell,
  };
}
