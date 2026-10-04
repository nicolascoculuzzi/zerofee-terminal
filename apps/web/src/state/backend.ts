import { create } from "zustand";

/**
 * What the live gateway says about itself (GET /api/health and the `chain` topic). Empty in the
 * simulation. `dryRun` drives the "Dry run" labels: the server simulates every submitted transaction
 * and sends nothing.
 */
export interface BackendState {
  /** null until the first health read. */
  dryRun: boolean | null;
  version: string | null;
  /** Admin kill switch: trading is refused while on. */
  halted: boolean;
  haltReason: string | null;
  set(patch: Partial<Omit<BackendState, "set">>): void;
}

export const useBackend = create<BackendState>()((set) => ({
  dryRun: null,
  version: null,
  halted: false,
  haltReason: null,
  set(patch) {
    set(patch);
  },
}));
