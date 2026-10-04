import { useEffect } from "react";
import { create } from "zustand";
import type { TokenSummary } from "../../protocol";
import { useMarket } from "../../state/market";
import { subscribeSequenced } from "../../state/subscribe";

export interface LiveQuote {
  mcUsd: number;
  priceSol: number;
  supply: number;
  lastTradeAt: number;
}

/**
 * Live market data for order tokens that aren't in a Pulse column (older positions, migrated
 * tokens past the column cap). Without it the Distance column and the drawer's "Now" row
 * would read "–" for exactly the orders a trader watches most.
 */
export const useOrderQuotes = create<{ byMint: Record<string, LiveQuote> }>()(() => ({ byMint: {} }));

function put(t: TokenSummary): void {
  const prev = useOrderQuotes.getState().byMint[t.mint];
  if (prev && prev.priceSol === t.priceSol && prev.mcUsd === t.marketCapUsd && prev.lastTradeAt === t.lastTradeAt) return;
  useOrderQuotes.setState((s) => ({
    byMint: { ...s.byMint, [t.mint]: { mcUsd: t.marketCapUsd, priceSol: t.priceSol, supply: t.supply, lastTradeAt: t.lastTradeAt } },
  }));
}

/** Subscribes `token:<mint>` for each mint the Pulse feed doesn't carry, while mounted. */
export function useOrderQuoteFeed(mints: readonly string[]): void {
  // A primitive selection, so the Pulse feed's 6 Hz writes don't re-render the page.
  const key = useMarket((s) => [...new Set(mints.filter((m) => !s.tokens[m]))].sort().join(","));
  useEffect(() => {
    if (!key) return;
    const stops = key.split(",").map((mint) =>
      subscribeSequenced(
        `token:${mint}`,
        (detail) => put(detail.summary),
        (delta) => {
          if (delta.summary) put(delta.summary);
        },
      ),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [key]);
}
