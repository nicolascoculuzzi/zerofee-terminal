import { DASH, fmtAge, fmtPct, fmtSignedSol, fmtSignedUsd, fmtSol, fmtUsd } from "../../lib/format";
import type { ActivityItem, Position } from "../../protocol";
import { fillMarketCaps, fmtUtcStamp, positionPnl } from "./helpers";
import type { ShareCardData } from "./shareCard";

export interface ShareInput {
  position: Position;
  activity: readonly ActivityItem[];
  /** Live supply and market cap when the token is in the live set. */
  supply: number | null;
  liveMcUsd: number | null;
  solUsd: number;
  now: number;
  walletLabel: string | null;
}

/** Card numbers from the position's own fills (DESIGN.md 4.21: every value comes from real fills). */
export function buildShareData({ position: p, activity, supply, liveMcUsd, solUsd, now, walletLabel }: ShareInput): ShareCardData {
  const pnl = positionPnl(p);
  const pct = p.boughtSol > 0 ? (pnl / p.boughtSol) * 100 : null;
  const fills = fillMarketCaps(activity).get(p.mint);
  const mcAt = (price: number | null, fallback: number | null | undefined) =>
    price !== null && price > 0 && supply !== null && supply > 0 ? price * supply * solUsd : (fallback ?? null);
  const entryMc = mcAt(p.avgEntryPriceSol, fills?.entryUsd);
  const exitMc = p.closed ? mcAt(p.avgExitPriceSol, fills?.exitUsd) : liveMcUsd;

  const path: { t: number; v: number; kind: "buy" | "sell" | "now" }[] = [];
  for (const a of activity) {
    if (a.mint !== p.mint || a.marketCapUsd === null || (a.kind !== "buy" && a.kind !== "sell")) continue;
    path.push({ t: a.ts, v: a.marketCapUsd, kind: a.kind });
  }
  path.sort((a, b) => a.t - b.t);
  if (!p.closed && liveMcUsd !== null && liveMcUsd > 0) path.push({ t: now, v: liveMcUsd, kind: "now" });
  const entryIndex = path.findIndex((q) => q.kind === "buy");
  let exitIndex = -1;
  if (p.closed)
    for (let i = path.length - 1; i >= 0; i--)
      if (path[i]?.kind === "sell") {
        exitIndex = i;
        break;
      }

  return {
    symbol: p.symbol,
    name: p.name,
    mint: p.mint,
    pct: pct === null ? null : fmtPct(pct, { signed: true }),
    sol: `${fmtSignedSol(pnl)} SOL`,
    usd: fmtSignedUsd(pnl * solUsd),
    sign: Math.abs(pnl) < 1e-9 ? 0 : Math.sign(pnl),
    stats: [
      { label: "Invested", value: `${fmtSol(p.boughtSol)} SOL`, amount: true },
      p.closed
        ? { label: "Returned", value: `${fmtSol(p.soldSol)} SOL`, amount: true }
        : { label: "Worth now", value: `${fmtSol(p.soldSol + p.valueSol)} SOL`, amount: true },
      { label: "Held", value: fmtAge(p.openedAt, p.closed ? p.lastTradeAt : now) },
      {
        label: p.closed ? "Entry to exit MC" : "Entry to now MC",
        value: entryMc === null ? DASH : fmtUsd(entryMc),
        arrowTo: exitMc === null ? DASH : fmtUsd(exitMc),
      },
    ],
    path: path.map(({ t, v }) => ({ t, v })),
    entryIndex: entryIndex >= 0 ? entryIndex : null,
    exitIndex: exitIndex >= 0 ? exitIndex : null,
    stamp: fmtUtcStamp(now),
    walletLabel,
  };
}
