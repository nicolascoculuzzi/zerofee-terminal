import { createContext, useContext } from "react";

/**
 * Stacking layers (DESIGN.md 2.7), mirrored from the --zf-z-* tokens in index.css for the
 * few places that need a number (popovers opened inside an overlay take the parent's z + 10,
 * so they never render behind it).
 */
export const Z = {
  sticky: 10,
  chartUi: 20,
  dock: 300,
  popover: 400,
  drawer: 500,
  modal: 600,
  palette: 700,
  toast: 800,
  tooltip: 900,
} as const;

/** z-index of the nearest overlay (modal, drawer, palette, dock), or null at page level. */
export const LayerContext = createContext<number | null>(null);

/** z-index for a popover or menu opened from here. */
export function usePopoverZ(): number {
  const parent = useContext(LayerContext);
  return parent === null ? Z.popover : Math.max(Z.popover, parent + 10);
}
