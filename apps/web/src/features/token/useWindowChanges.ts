import { useEffect, useRef, useState } from "react";
import type { Candle } from "../../protocol";
import { subscribeSequenced } from "../../state/subscribe";

/**
 * 1 h and 24 h price change for the header strip, from the token's 1-minute candles (since
 * launch for younger tokens, like the 5m change). Candles land in a ref, so live deltas don't
 * re-render the header; the header's own price ticks do.
 */
export function useWindowChanges(mint: string, priceSol: number): { h1: number | null; h24: number | null } {
  const candles = useRef<Candle[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    candles.current = [];
    setLoaded(false);
    return subscribeSequenced(
      `candles:${mint}:1m`,
      (snap) => {
        candles.current = [...snap.candles].sort((a, b) => a.time - b.time);
        setLoaded(true);
      },
      (delta) => {
        const list = candles.current;
        for (const c of delta.candles) {
          const last = list[list.length - 1];
          if (last && last.time === c.time) list[list.length - 1] = c;
          else if (!last || c.time > last.time) list.push(c);
        }
      },
    );
  }, [mint]);

  if (!loaded || candles.current.length === 0 || !(priceSol > 0)) return { h1: null, h24: null };
  const now = Date.now() / 1000;
  const change = (windowSec: number): number | null => {
    const from = now - windowSec;
    const list = candles.current;
    const ref = list.find((c) => c.time >= from) ?? list[0];
    if (!ref || !(ref.open > 0)) return null;
    return (priceSol / ref.open - 1) * 100;
  };
  return { h1: change(3600), h24: change(86_400) };
}
