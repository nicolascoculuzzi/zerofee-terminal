/**
 * Venue-agnostic trade builder: quote locally from cached state (no external quote API on the hot
 * path) and produce the trade instructions with slippage-bounded limits.
 *   buy  = spend `amount` quote base units (fees included)      -> buy_exact_quote_in(_v2)
 *   sell = sell `amount` base units for >= quote*(1-slippage)    -> sell(_v2)
 */
import type { Address, Instruction } from "@solana/kit";
import { DEFAULT_CU_LIMITS } from "./constants";
import { curveFeeRates, quoteBuyExactQuoteIn, quoteSell } from "./pump/curve";
import { buildPumpBuyInstructions, buildPumpSellInstructions } from "./pump/instructions";
import { buildAmmBuyInstructions, buildAmmSellInstructions } from "./pumpswap/instructions";
import { ammFeeRates, quoteAmmBuyExactQuoteIn, quoteAmmSell } from "./pumpswap/math";
import type { TokenState } from "./state";
import { applySlippageDown } from "./util/math";

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
  /** buy: expected base out; sell: expected quote out after fees. */
  expectedOut: bigint;
  /** Slippage-bounded minimum out passed on-chain. */
  minOut: bigint;
  feesQuote: { protocol: bigint; creator: bigint; lp: bigint; buyback: bigint; total: bigint };
  feeBps: { protocol: bigint; creator: bigint; lp: bigint };
}

export interface BuiltTrade {
  quote: TradeQuote;
  instructions: Instruction[];
  /** Hot write-locked account for priority-fee sampling (curve or pool). */
  hotAccount: Address;
  defaultCuLimit: number;
}

export async function buildTrade(state: TokenState, req: TradeRequest): Promise<BuiltTrade> {
  if (req.amount <= 0n) throw new RangeError("amount must be > 0");
  if (state.venue === "pump") {
    const rates = curveFeeRates({
      curve: state.curve,
      global: state.global,
      feeConfig: state.feeConfig,
      mintSupply: state.mintInfo.supply,
    });
    const ctx = {
      mint: state.mint,
      baseTokenProgram: state.mintInfo.tokenProgram,
      quoteTokenProgram: state.quoteTokenProgram,
      user: state.user,
      curve: state.curve,
      global: state.global,
    };
    const feeBps = { protocol: rates.protocolFeeBps, creator: rates.creatorFeeBps, lp: 0n };
    if (req.side === "buy") {
      const q = quoteBuyExactQuoteIn(state.curve, req.amount, rates);
      const minOut = applySlippageDown(q.tokenAmount, req.slippageBps);
      const { instructions } = await buildPumpBuyInstructions(ctx, { mode: "exactQuoteIn", amount: req.amount, limit: minOut });
      return {
        quote: {
          venue: "pump",
          side: "buy",
          amountIn: req.amount,
          expectedOut: q.tokenAmount,
          minOut,
          feesQuote: { protocol: q.protocolFee, creator: q.creatorFee, lp: 0n, buyback: q.buybackFee, total: q.totalFee },
          feeBps,
        },
        instructions,
        hotAccount: state.curveAddress,
        defaultCuLimit: DEFAULT_CU_LIMITS.pumpBuy,
      };
    }
    if (req.amount > state.userBaseBalance) throw new RangeError(`sell amount ${req.amount} exceeds balance ${state.userBaseBalance}`);
    const q = quoteSell(state.curve, req.amount, rates);
    const minOut = applySlippageDown(q.quoteNet, req.slippageBps);
    const { instructions } = await buildPumpSellInstructions(ctx, {
      amount: req.amount,
      minQuoteOut: minOut,
      closeBaseAccount: (req.closeOnFullExit ?? true) && req.amount === state.userBaseBalance,
    });
    return {
      quote: {
        venue: "pump",
        side: "sell",
        amountIn: req.amount,
        expectedOut: q.quoteNet,
        minOut,
        feesQuote: { protocol: q.protocolFee, creator: q.creatorFee, lp: 0n, buyback: q.buybackFee, total: q.totalFee },
        feeBps,
      },
      instructions,
      hotAccount: state.curveAddress,
      defaultCuLimit: DEFAULT_CU_LIMITS.pumpSell,
    };
  }

  // PumpSwap
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
  const feeBps = { protocol: rates.protocolFeeBps, creator: rates.creatorFeeBps, lp: rates.lpFeeBps };
  if (req.side === "buy") {
    const q = quoteAmmBuyExactQuoteIn(state.reserves, req.amount, rates);
    const minOut = applySlippageDown(q.baseOut, req.slippageBps);
    const { instructions } = await buildAmmBuyInstructions(ctx, { mode: "exactQuoteIn", amount: req.amount, limit: minOut });
    return {
      quote: {
        venue: "pumpswap",
        side: "buy",
        amountIn: req.amount,
        expectedOut: q.baseOut,
        minOut,
        feesQuote: { protocol: q.protocolFee, creator: q.creatorFee, lp: q.lpFee, buyback: q.buybackFee, total: q.totalFee },
        feeBps,
      },
      instructions,
      hotAccount: state.poolAddress,
      defaultCuLimit: DEFAULT_CU_LIMITS.ammBuy,
    };
  }
  if (req.amount > state.userBaseBalance) throw new RangeError(`sell amount ${req.amount} exceeds balance ${state.userBaseBalance}`);
  const q = quoteAmmSell(state.reserves, req.amount, rates);
  const minOut = applySlippageDown(q.quoteOutNet, req.slippageBps);
  const { instructions } = await buildAmmSellInstructions(ctx, {
    baseAmountIn: req.amount,
    minQuoteOut: minOut,
    closeBaseAccount: (req.closeOnFullExit ?? true) && req.amount === state.userBaseBalance,
  });
  return {
    quote: {
      venue: "pumpswap",
      side: "sell",
      amountIn: req.amount,
      expectedOut: q.quoteOutNet,
      minOut,
      feesQuote: { protocol: q.protocolFee, creator: q.creatorFee, lp: q.lpFee, buyback: q.buybackFee, total: q.totalFee },
      feeBps,
    },
    instructions,
    hotAccount: state.poolAddress,
    defaultCuLimit: DEFAULT_CU_LIMITS.ammSell,
  };
}
