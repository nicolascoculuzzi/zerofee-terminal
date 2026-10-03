/** Pure bigint helpers shared by curve and AMM math. */
import { BPS_DENOMINATOR } from "../constants";

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new RangeError("division by zero");
  if (a < 0n || b < 0n) throw new RangeError("ceilDiv expects non-negative operands");
  return (a + b - 1n) / b;
}

/** `ceil(amount * bps / 10_000)` - how pump and PumpSwap round every fee component (notes §2, §4). */
export function feeCeil(amount: bigint, bps: bigint): bigint {
  return ceilDiv(amount * bps, BPS_DENOMINATOR);
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function assertSlippage(slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new RangeError(`slippageBps must be an integer in [0, 10000], got ${slippageBps}`);
  }
  return BigInt(slippageBps);
}

/** Upper bound for a cost we pay (`max_sol_cost`, `max_quote_amount_in`): floor(x * (1 + s)). */
export function applySlippageUp(amount: bigint, slippageBps: number): bigint {
  const s = assertSlippage(slippageBps);
  return (amount * (BPS_DENOMINATOR + s)) / BPS_DENOMINATOR;
}

/** Lower bound for an amount we receive (`min_sol_output`, `min_tokens_out`): floor(x * (1 - s)). */
export function applySlippageDown(amount: bigint, slippageBps: number): bigint {
  const s = assertSlippage(slippageBps);
  return (amount * (BPS_DENOMINATOR - s)) / BPS_DENOMINATOR;
}

/** Parse a decimal UI amount (e.g. "0.05") into base units without floating point. */
export function parseUiAmount(ui: string, decimals: number): bigint {
  const s = ui.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`invalid amount: ${ui}`);
  const [whole = "0", frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`too many decimals in ${ui} (max ${decimals})`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** Format base units as a decimal string (no float rounding). */
export function formatUnits(amount: bigint, decimals: number): string {
  const neg = amount < 0n;
  const v = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Nearest-rank percentile of numeric samples (p in [0,100]). Returns 0 for no samples. */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx] as number;
}
