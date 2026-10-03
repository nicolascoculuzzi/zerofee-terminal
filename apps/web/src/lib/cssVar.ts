/** Reads a px token from the CSS layer (index.css), so JS sizing (virtual rows) follows the design tokens. */
export function cssPx(name: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const v = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
