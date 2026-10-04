/**
 * Which on-chain accounts carry a coin's trades, and which decoded events of a transaction belong to it.
 * Every pump trade writes its bonding curve, every PumpSwap swap its pool, every LaunchLab trade its pool
 * state and every CPMM swap its pool, so walking those accounts' signatures finds every trade of the coin
 * on its venues (third-party PumpSwap pools of a pump coin are not walked).
 */
import type { DecodedEvent } from "@zerofee/core";
import type { TradeVenue } from "@zerofee/protocol";
import type { RaydiumEventAccounts } from "../ingest/raydium";
import type { IngestTx } from "../ingest/types";

export interface CoinAccounts {
  mint: string;
  /** pump.fun bonding curve PDA. */
  curve: string | null;
  /** PumpSwap pool the coin trades in (canonical after migration). */
  pumpPool: string | null;
  /** Raydium LaunchLab pool state. */
  launchLabPool: string | null;
  /** Raydium CPMM graduation pool. */
  cpmmPool: string | null;
}

/**
 * Accounts to walk, newest venue first (a graduate's pool before its curve). Each account is walked newest first
 * too, so a backfill fills the chart's recent candles and the trade tape before older history, and a capped walk
 * (HISTORY_MAX_TX_PER_COIN) keeps the recent trades rather than the launch.
 */
export function walkAccounts(c: CoinAccounts): { address: string; venue: TradeVenue }[] {
  const out: { address: string; venue: TradeVenue }[] = [];
  if (c.cpmmPool) out.push({ address: c.cpmmPool, venue: "cpmm" });
  if (c.pumpPool) out.push({ address: c.pumpPool, venue: "pumpswap" });
  if (c.launchLabPool) out.push({ address: c.launchLabPool, venue: "launchlab" });
  if (c.curve) out.push({ address: c.curve, venue: "pump" });
  return out;
}

/** True when the event at `index` of `tx` concerns the coin (trade, creation, completion, migration). */
export function eventMatchesCoin(ev: DecodedEvent, acc: RaydiumEventAccounts | undefined, c: CoinAccounts): boolean {
  switch (ev.kind) {
    case "pumpCreate":
    case "pumpTrade":
    case "pumpComplete":
    case "pumpMigrate":
      return ev.mint === c.mint;
    case "ammCreatePool":
      return ev.baseMint === c.mint;
    case "ammBuy":
    case "ammSell":
      return ev.pool === c.pumpPool;
    case "launchlabPoolCreate":
    case "launchlabTrade":
      if (acc && (acc.kind === "launchlabSwap" || acc.kind === "launchlabCreate")) return acc.baseMint === c.mint;
      return ev.pool === c.launchLabPool;
    case "cpmmSwap":
      // a graduation pool pairs the coin with its quote: every swap on it trades the coin
      return ev.pool === c.cpmmPool;
  }
}

export interface TruthTrade {
  signature: string;
  slot: number;
  evIndex: number;
  venue: TradeVenue;
  side: "buy" | "sell";
}

/** The coin's trade events in a fully decoded transaction (the audit's and the tests' ground truth). */
export function coinTrades(tx: IngestTx, c: CoinAccounts): TruthTrade[] {
  const out: TruthTrade[] = [];
  tx.events.forEach((ev, i) => {
    const acc = tx.raydium?.accounts[i];
    if (!eventMatchesCoin(ev, acc, c)) return;
    const base = { signature: tx.signature, slot: tx.slot, evIndex: i };
    if (ev.kind === "pumpTrade") out.push({ ...base, venue: "pump", side: ev.isBuy ? "buy" : "sell" });
    else if (ev.kind === "ammBuy" || ev.kind === "ammSell")
      out.push({ ...base, venue: "pumpswap", side: ev.kind === "ammBuy" ? "buy" : "sell" });
    else if (ev.kind === "launchlabTrade") out.push({ ...base, venue: "launchlab", side: ev.isBuy ? "buy" : "sell" });
    else if (ev.kind === "cpmmSwap") {
      const io = acc?.kind === "cpmmSwap" ? acc : ev;
      out.push({ ...base, venue: "cpmm", side: io.outputMint === c.mint ? "buy" : "sell" });
    }
  });
  return out;
}
