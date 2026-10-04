import { useEffect, useRef, useState } from "react";

/** At most two flashes per second per element (DESIGN.md 6.6). */
const MIN_GAP_MS = 500;

export interface TickFlash {
  /** "zf-tick-up" / "zf-tick-down" for the 600 ms after a change, else "". */
  className: string;
  /** Changes on every flash; use it as the React key so the CSS animation restarts. */
  key: number;
  /** Direction of the latest tick (shown as ↑/↓ when motion is reduced). */
  last: "up" | "down" | null;
}

/**
 * Value-change flash for the token header MC and price, and the trade-panel PnL: the text colour
 * jumps to buy or sell and transitions back (index.css .zf-tick-*), throttled to 2 per second.
 * Nothing else in the app flashes values.
 */
export function useTickFlash(value: number | null | undefined): TickFlash {
  const prev = useRef<number | null | undefined>(value);
  const flashedAt = useRef(0);
  const [state, setState] = useState<TickFlash>({ className: "", key: 0, last: null });

  useEffect(() => {
    const before = prev.current;
    prev.current = value;
    if (typeof before !== "number" || typeof value !== "number" || !Number.isFinite(value) || value === before) return;
    const dir = value > before ? "up" : "down";
    const now = Date.now();
    if (now - flashedAt.current < MIN_GAP_MS) {
      setState((s) => (s.last === dir ? s : { ...s, last: dir }));
      return;
    }
    flashedAt.current = now;
    setState((s) => ({ className: dir === "up" ? "zf-tick-up" : "zf-tick-down", key: s.key + 1, last: dir }));
  }, [value]);

  return state;
}
