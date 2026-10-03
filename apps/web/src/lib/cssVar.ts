import { useSyncExternalStore } from "react";

/** Reads a px token from the CSS layer (index.css), so JS sizing (virtual rows) follows the design tokens. */
export function cssPx(name: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const v = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Notifies when <html data-density|data-theme> changes (density switches row heights at runtime). */
function subscribeRoot(onChange: () => void): () => void {
  const obs = new MutationObserver(onChange);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-density", "data-theme"] });
  const mql = window.matchMedia("(max-width: 767px)");
  mql.addEventListener("change", onChange);
  return () => {
    obs.disconnect();
    mql.removeEventListener("change", onChange);
  };
}

/**
 * A px token that stays current when density changes (DESIGN.md 2.10): use it for virtualizer
 * item sizes ("--zf-row", "--zf-row-dense", "--zf-card", "--zf-header-row").
 */
export function useCssPx(name: string, fallback: number): number {
  return useSyncExternalStore(
    subscribeRoot,
    () => cssPx(name, fallback),
    () => fallback,
  );
}
