import type { LandingPreset } from "../protocol";

/**
 * Landing presets from SPEC.md "Landing presets": route, tip rule and the risk note shown
 * wherever a preset is picked or displayed.
 */
export const LANDING_INFO: Record<LandingPreset, { label: string; risky: boolean; route: string; tip: string; note: string }> = {
  reduced: {
    label: "Reduced",
    risky: false,
    route: "Helius Sender with swqos_only + mev-protect",
    tip: "0.000005 SOL + priority-fee estimate (clamped)",
    note: "Default. MEV-protected route at minimal cost.",
  },
  secure: {
    label: "Secure",
    risky: false,
    route: "Jito bundle-only with a jitodontfront account",
    tip: "max(1,000 lamports, live Jito p50–p75)",
    note: "Strongest sandwich protection; only works when the transaction actually goes through Jito.",
  },
  fast: {
    label: "Fast",
    risky: true,
    route: "Sender Max: all lanes in parallel",
    tip: "0.001 SOL",
    note: "Fastest landing, not protected: expect sandwich risk on large buys.",
  },
};
