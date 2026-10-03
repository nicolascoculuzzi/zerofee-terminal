/**
 * Fee / tip policy (tx_landing_and_mev.md "Default fee and tip policy").
 *
 * - CU price: percentile of recent prioritization fees (or a Helius estimate), eco=p50 / fast=p75 /
 *   turbo=p95, clamped so cu_price*cu_limit/1e6 never exceeds the user's max priority fee.
 * - Tip: Jito tip-floor percentiles (eco=p50 / fast=p75 / turbo=p95), clamped to the user's max tip
 *   and floored at each lane's minimum.
 * - Landing modes:
 *     standard  (default): Helius Sender SWQoS-only (5,000-lamport tip) + Jito sendTransaction, identical bytes,
 *                          one tip per lane inside the tx (runtime dedupes by signature).
 *     turbo     (opt-in):  Helius Sender Max (>= 0.001 SOL tip); Sender adds the Jito/other pathway tips itself,
 *                          so we do NOT also send to Jito directly.
 *     protected:           Jito only, bundleOnly=true, read-only jitodontfront marker, tip >= p75, never raced
 *                          on SWQoS lanes, no durable nonce.
 */
import {
  HELIUS_SENDER_MAX_MIN_TIP_LAMPORTS,
  HELIUS_SENDER_SWQOS_MIN_TIP_LAMPORTS,
  JITO_MIN_TIP_LAMPORTS,
  JITO_TIP_FLOOR_URL,
  LAMPORTS_PER_SOL,
  MICRO_LAMPORTS_PER_LAMPORT,
} from "../constants";
import { postJsonRpc } from "../send/jsonRpc";
import { maxBig, minBig, percentile } from "../util/math";
import { priorityFeeLamports } from "./computeBudget";
import type { TipSpec } from "./tip";

export type SpeedPreset = "eco" | "fast" | "turbo";
export type LandingMode = "standard" | "turbo" | "protected";

export interface FeeCaps {
  /** Max priority fee (cu_price * cu_limit / 1e6) in lamports. */
  maxPriorityFeeLamports: bigint;
  /** Max TOTAL tip across all lanes in lamports. */
  maxTipLamports: bigint;
}

const PRESET_PERCENTILE: Record<SpeedPreset, number> = { eco: 50, fast: 75, turbo: 95 };

/** CU price (micro-lamports) from recent prioritization-fee samples. */
export function cuPriceFromSamples(samples: readonly (number | bigint)[], preset: SpeedPreset): bigint {
  const nums = samples.map((s) => Number(s)).filter((n) => Number.isFinite(n) && n >= 0);
  return BigInt(Math.ceil(percentile(nums, PRESET_PERCENTILE[preset])));
}

/** Clamp a CU price so the total priority fee stays <= maxPriorityFeeLamports. */
export function capCuPrice(cuPriceMicroLamports: bigint, cuLimit: number, maxPriorityFeeLamports: bigint): bigint {
  const ceiling = (maxPriorityFeeLamports * MICRO_LAMPORTS_PER_LAMPORT) / BigInt(cuLimit);
  return minBig(cuPriceMicroLamports, ceiling);
}

export interface TipFloor {
  time?: string;
  p25: bigint;
  p50: bigint;
  p75: bigint;
  p95: bigint;
  p99: bigint;
  emaP50: bigint;
}

const solToLamports = (sol: unknown): bigint => {
  const n = Number(sol);
  if (!Number.isFinite(n) || n < 0) return 0n;
  return BigInt(Math.round(n * Number(LAMPORTS_PER_SOL)));
};

/** Parses the Jito tip_floor REST response (values are in SOL). */
export function parseJitoTipFloor(json: unknown): TipFloor {
  const row = (Array.isArray(json) ? json[0] : json) as Record<string, unknown> | undefined;
  if (!row || typeof row !== "object") throw new Error("unexpected tip_floor response");
  return {
    time: typeof row.time === "string" ? row.time : undefined,
    p25: solToLamports(row.landed_tips_25th_percentile),
    p50: solToLamports(row.landed_tips_50th_percentile),
    p75: solToLamports(row.landed_tips_75th_percentile),
    p95: solToLamports(row.landed_tips_95th_percentile),
    p99: solToLamports(row.landed_tips_99th_percentile),
    emaP50: solToLamports(row.ema_landed_tips_50th_percentile),
  };
}

export async function fetchJitoTipFloor(fetchFn: typeof fetch = fetch, url = JITO_TIP_FLOOR_URL): Promise<TipFloor> {
  const res = await fetchFn(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`tip_floor HTTP ${res.status}`);
  return parseJitoTipFloor(await res.json());
}

export function tipTargetFromFloor(floor: TipFloor, preset: SpeedPreset): bigint {
  return preset === "eco" ? floor.p50 : preset === "fast" ? floor.p75 : floor.p95;
}

const HELIUS_LEVEL: Record<SpeedPreset, string> = { eco: "medium", fast: "high", turbo: "veryHigh" };

/**
 * Helius `getPriorityFeeEstimate` (Helius RPC only) by account keys; returns µL/CU for the preset
 * (eco=Medium p50, fast=High p75, turbo=VeryHigh p95). https://www.helius.dev/docs/priority-fee-api
 */
export async function fetchHeliusPriorityFeeEstimate(
  rpcUrl: string,
  accountKeys: readonly string[],
  preset: SpeedPreset,
  fetchFn?: typeof fetch,
): Promise<bigint> {
  const res = await postJsonRpc<{ priorityFeeLevels?: Record<string, number>; priorityFeeEstimate?: number }>(
    rpcUrl,
    "getPriorityFeeEstimate",
    [{ accountKeys, options: { includeAllPriorityFeeLevels: true } }],
    { fetchFn },
  );
  if (res.error) throw new Error(`getPriorityFeeEstimate: ${res.error.message}`);
  const v = res.result?.priorityFeeLevels?.[HELIUS_LEVEL[preset]] ?? res.result?.priorityFeeEstimate;
  if (v === undefined || !Number.isFinite(v)) throw new Error("getPriorityFeeEstimate: no estimate");
  return BigInt(Math.ceil(v));
}

export interface FeePlanInput {
  mode: LandingMode;
  preset: SpeedPreset;
  cuLimit: number;
  /** Recent prioritization fees (micro-lamports/CU) or a pre-computed estimate as a single sample. */
  prioritySamples: readonly (number | bigint)[];
  /** Live Jito tip floor; when absent the lane minimums are used. */
  tipFloor?: TipFloor | null;
  caps: FeeCaps;
  /** Fixed Helius SWQoS-only tip (no priority buffer below 0.001 SOL, so the minimum is enough). */
  heliusSwqosTipLamports?: bigint;
  /**
   * Floor for the CU price. `getRecentPrioritizationFees` reports the per-slot MINIMUM fee, so its
   * percentiles are often 0 on public RPCs; a floor keeps the tx competitive (still capped by maxPriorityFee).
   */
  minCuPriceMicroLamports?: bigint;
}

export interface FeePlan {
  mode: LandingMode;
  cuLimit: number;
  cuPriceMicroLamports: bigint;
  priorityFeeLamports: bigint;
  tips: TipSpec[];
  totalTipLamports: bigint;
  heliusMode: "swqos" | "max" | null;
  sendToJito: boolean;
  jitoBundleOnly: boolean;
  jitoDontFront: boolean;
  warnings: string[];
}

export class FeeCapError extends Error {}

/** Produces CU price, tips and lane flags for one trade. Throws FeeCapError if caps cannot cover lane minimums. */
export function planFees(input: FeePlanInput): FeePlan {
  const warnings: string[] = [];
  const { caps, cuLimit } = input;
  const sampled = cuPriceFromSamples(input.prioritySamples, input.mode === "protected" ? "eco" : input.preset);
  const rawPrice = maxBig(sampled, input.minCuPriceMicroLamports ?? 0n);
  const cuPriceMicroLamports = capCuPrice(rawPrice, cuLimit, caps.maxPriorityFeeLamports);
  if (cuPriceMicroLamports < rawPrice) warnings.push(`priority fee capped (${rawPrice} -> ${cuPriceMicroLamports} µL/CU)`);
  // Sender requires a non-zero setComputeUnitPrice; 1 µL/CU is the floor.
  const price = cuPriceMicroLamports > 0n ? cuPriceMicroLamports : 1n;

  const target = input.tipFloor ? tipTargetFromFloor(input.tipFloor, input.preset) : 0n;
  const tips: TipSpec[] = [];
  let heliusMode: FeePlan["heliusMode"] = null;
  let sendToJito = false;
  let jitoBundleOnly = false;
  let jitoDontFront = false;

  if (input.mode === "standard") {
    const heliusTip = input.heliusSwqosTipLamports ?? HELIUS_SENDER_SWQOS_MIN_TIP_LAMPORTS;
    if (heliusTip < HELIUS_SENDER_SWQOS_MIN_TIP_LAMPORTS) throw new FeeCapError("Helius SWQoS tip below 5,000 lamports");
    const budget = caps.maxTipLamports - heliusTip;
    if (budget < JITO_MIN_TIP_LAMPORTS) {
      throw new FeeCapError(
        `maxTipLamports ${caps.maxTipLamports} cannot cover Helius SWQoS (${heliusTip}) + Jito minimum (${JITO_MIN_TIP_LAMPORTS})`,
      );
    }
    const jitoTip = minBig(maxBig(target, JITO_MIN_TIP_LAMPORTS), budget);
    if (jitoTip < target) warnings.push(`jito tip capped (${target} -> ${jitoTip})`);
    tips.push({ lane: "helius", lamports: heliusTip }, { lane: "jito", lamports: jitoTip });
    heliusMode = "swqos";
    sendToJito = true;
  } else if (input.mode === "turbo") {
    if (caps.maxTipLamports < HELIUS_SENDER_MAX_MIN_TIP_LAMPORTS) {
      throw new FeeCapError(`turbo (Sender Max) needs maxTipLamports >= ${HELIUS_SENDER_MAX_MIN_TIP_LAMPORTS}`);
    }
    const tip = minBig(maxBig(target, HELIUS_SENDER_MAX_MIN_TIP_LAMPORTS), caps.maxTipLamports);
    tips.push({ lane: "helius", lamports: tip });
    heliusMode = "max";
  } else {
    if (caps.maxTipLamports < JITO_MIN_TIP_LAMPORTS)
      throw new FeeCapError(`protected mode needs maxTipLamports >= ${JITO_MIN_TIP_LAMPORTS}`);
    // Protected: tip at p75 or higher.
    const want = input.tipFloor ? maxBig(target, input.tipFloor.p75) : JITO_MIN_TIP_LAMPORTS;
    const tip = minBig(maxBig(want, JITO_MIN_TIP_LAMPORTS), caps.maxTipLamports);
    if (tip < want) warnings.push(`protected tip capped below p75 (${want} -> ${tip}); landing may be slow`);
    tips.push({ lane: "jito", lamports: tip });
    sendToJito = true;
    jitoBundleOnly = true;
    jitoDontFront = true;
  }
  if (!input.tipFloor) warnings.push("no live Jito tip floor; using lane minimum tips");
  const totalTipLamports = tips.reduce((s, t) => s + t.lamports, 0n);
  return {
    mode: input.mode,
    cuLimit,
    cuPriceMicroLamports: price,
    priorityFeeLamports: priorityFeeLamports(price, cuLimit),
    tips,
    totalTipLamports,
    heliusMode,
    sendToJito,
    jitoBundleOnly,
    jitoDontFront,
    warnings,
  };
}
