import { LANDING_INFO } from "../../lib/landing";
import type { LandingPreset } from "../../protocol";

/** Solana base fee for one signature (5,000 lamports). */
export const BASE_FEE_SOL = 0.000005;

export const LANDING_ORDER: LandingPreset[] = ["reduced", "secure", "fast"];

/** Lowest tip each route's tip rule allows (SPEC "Landing presets"), SOL. */
const MIN_TIP_SOL: Record<LandingPreset, number> = { reduced: 0.000005, secure: 0.000001, fast: 0.001 };

/** Landing copy from the top bar's LANDING_INFO plus what the preset editor needs. */
export function landingInfo(id: LandingPreset) {
  return { ...LANDING_INFO[id], minTipSol: MIN_TIP_SOL[id] };
}
