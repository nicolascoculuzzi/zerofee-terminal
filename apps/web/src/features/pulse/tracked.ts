import { useMemo } from "react";
import type { TrackedTrade } from "../../protocol";
import { type TrackedWallet, useTrackers } from "../../state/trackers";

/**
 * Tracked wallets holding each token (the card's Eye counter, DESIGN.md 4.4), derived from the
 * tracked-trade feed: a wallet on the tracker list counts when its net token flow in the feed
 * window is positive. TokenSummary has no server-side count yet, so wallets that bought before
 * the window aren't seen; the counter under-reports rather than invents.
 */
export function trackedHolding(live: readonly TrackedTrade[], wallets: readonly TrackedWallet[]): ReadonlyMap<string, number> {
  const tracked = new Set(wallets.map((w) => w.address));
  const net = new Map<string, Map<string, number>>();
  for (const { trade } of live) {
    if (!tracked.has(trade.maker)) continue;
    let byMaker = net.get(trade.mint);
    if (!byMaker) {
      byMaker = new Map();
      net.set(trade.mint, byMaker);
    }
    const delta = trade.side === "buy" ? trade.tokenAmount : -trade.tokenAmount;
    byMaker.set(trade.maker, (byMaker.get(trade.maker) ?? 0) + delta);
  }
  const out = new Map<string, number>();
  for (const [mint, byMaker] of net) {
    let holding = 0;
    for (const v of byMaker.values()) if (v > 0) holding++;
    if (holding > 0) out.set(mint, holding);
  }
  return out;
}

export function useTrackedHolding(): ReadonlyMap<string, number> {
  const live = useTrackers((s) => s.live);
  const wallets = useTrackers((s) => s.wallets);
  return useMemo(() => trackedHolding(live, wallets), [live, wallets]);
}
