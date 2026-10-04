import type { PulseColumnId } from "./protocol";

/**
 * Product configuration shared by the UI and the simulated server. The real server owns these
 * values; the UI renders whatever it is configured with (never a hard-coded number in copy).
 */

/** Final Stretch: tokens whose bonding progress is at or above this (server default 60%). */
export const FINAL_STRETCH_PROGRESS = 0.6;

/** A token leaves Final Stretch only below this, so tokens near the line don't flap. */
export const FINAL_STRETCH_EXIT = 0.55;

export const COLUMN_TITLE: Record<PulseColumnId, string> = {
  new: "New Pairs",
  final: "Final Stretch",
  migrated: "Migrated",
};

/** Column definitions for the Pulse header tooltips (DESIGN.md 4.3), from the config above. */
export function columnDefinition(column: PulseColumnId): string {
  switch (column) {
    case "new":
      return "Tokens on a bonding curve, newest first.";
    case "final":
      return `Bonding progress ${Math.round(FINAL_STRETCH_PROGRESS * 100)}% or more, highest progress first.`;
    case "migrated":
      return "Graduated to an AMM pool, newest first.";
  }
}
