/**
 * Compute budget and tips for one trade from the user's preset and the live `chain` estimates.
 *
 * The server picks lanes by preset (apps/server/src/gateway/tx.ts) and never adds instructions, so the
 * transaction must already carry what that lane needs:
 *   reduced  Helius Sender SWQoS + mev-protect   one Helius tip, at least 5,000 lamports
 *   secure   Jito bundle-only                    one Jito tip, at least 1,000 lamports, + jitodontfront
 *   fast     Helius Sender Max                   one Helius tip, at least 0.001 SOL
 * The tip is the preset's tip, raised to the lane minimum. The CU price is the live estimate for the
 * preset's urgency (p50 secure, p75 reduced, p95 fast), clamped so the whole priority fee stays within the
 * preset's priority fee, and at least 1 micro-lamport (Sender refuses a zero price). Both stay under the
 * signer firewall's per-transaction caps (createSignerPolicy's DEFAULT_FIREWALL_CAPS).
 */
import {
  HELIUS_SENDER_MAX_MIN_TIP_LAMPORTS,
  HELIUS_SENDER_SWQOS_MIN_TIP_LAMPORTS,
  JITO_MIN_TIP_LAMPORTS,
  type TipSpec,
} from "@zerofee/core";
import type { ChainState, LandingPreset } from "@zerofee/protocol";

/** The signer's default caps (packages/signer DEFAULT_FIREWALL_CAPS): 0.01 SOL of tips, 0.005 SOL priority fee. */
export const FIREWALL_MAX_TIP_LAMPORTS = 10_000_000n;
export const FIREWALL_MAX_PRIORITY_LAMPORTS = 5_000_000n;
export const FIREWALL_MAX_CU_LIMIT = 400_000;
export const BASE_FEE_LAMPORTS = 5_000n;

export interface LandingPlan {
  cuLimit: number;
  cuPriceMicroLamports: bigint;
  priorityFeeLamports: bigint;
  tips: TipSpec[];
  totalTipLamports: bigint;
  jitoDontFront: boolean;
  /** The preset asked for more than a cap allows, or for less than the lane needs. */
  notes: string[];
}

const toLamports = (sol: number): bigint => (Number.isFinite(sol) && sol > 0 ? BigInt(Math.round(sol * 1e9)) : 0n);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

const PERCENTILE: Record<LandingPreset, "p50" | "p75" | "p95"> = { secure: "p50", reduced: "p75", fast: "p95" };
const LANE_MIN: Record<LandingPreset, bigint> = {
  reduced: HELIUS_SENDER_SWQOS_MIN_TIP_LAMPORTS,
  secure: JITO_MIN_TIP_LAMPORTS,
  fast: HELIUS_SENDER_MAX_MIN_TIP_LAMPORTS,
};

export function planLanding(args: {
  landing: LandingPreset;
  cuLimit: number;
  chain: ChainState | null;
  priorityFeeSol: number;
  tipSol: number;
}): LandingPlan {
  const notes: string[] = [];
  const cuLimit = Math.min(Math.max(1, Math.ceil(args.cuLimit)), FIREWALL_MAX_CU_LIMIT);
  const estimate = args.chain?.priorityFees?.[PERCENTILE[args.landing]] ?? 0;
  const wanted = BigInt(Math.max(0, Math.ceil(Number.isFinite(estimate) ? estimate : 0)));
  const priorityBudget = min(toLamports(args.priorityFeeSol), FIREWALL_MAX_PRIORITY_LAMPORTS);
  const ceiling = (priorityBudget * 1_000_000n) / BigInt(cuLimit);
  let price = min(wanted, ceiling);
  if (price < wanted) notes.push("priority fee held to your preset");
  if (price < 1n) price = 1n;
  const priorityFeeLamports = (price * BigInt(cuLimit) + 999_999n) / 1_000_000n;

  const laneMin = LANE_MIN[args.landing];
  const asked = toLamports(args.tipSol);
  let tip = max(asked, laneMin);
  if (tip > asked) notes.push("tip raised to the lane minimum");
  if (tip > FIREWALL_MAX_TIP_LAMPORTS) {
    tip = FIREWALL_MAX_TIP_LAMPORTS;
    notes.push("tip held to the signer's cap");
  }
  const tips: TipSpec[] = [{ lane: args.landing === "secure" ? "jito" : "helius", lamports: tip }];
  return {
    cuLimit,
    cuPriceMicroLamports: price,
    priorityFeeLamports,
    tips,
    totalTipLamports: tip,
    jitoDontFront: args.landing === "secure",
    notes,
  };
}
