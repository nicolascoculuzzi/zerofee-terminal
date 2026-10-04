import type { ReactNode } from "react";
import { MetricTip } from "../../components/ui/bits";
import { Hotkey } from "../../components/ui/controls";
import { Num } from "../../components/ui/Num";
import { cn } from "../../lib/cn";
import { DASH, fmtAge, fmtClock, fmtCount, fmtInt, fmtProgress, fmtRiskPct, fmtSol, fmtSolShort, fmtUsd } from "../../lib/format";
import { LAUNCHPAD_BY_ID, type RiskKey, token2022Danger } from "../../lib/metrics";
import { useNow } from "../../lib/useNow";
import type { PulseColumnId, TokenSummary } from "../../protocol";
import { getServices } from "../../services";
import { useMarket } from "../../state/market";
import { useSettings } from "../../state/settings";
import { useWallet } from "../../state/wallet";
import { socialLabel } from "./CardParts";
import { netBuy } from "./cardView";
import { RiskTip, riskChip } from "./RiskChips";
import { seenToken } from "./store";
import type { TipRequest } from "./TipLayer";
import { useTrackedHolding } from "./tracked";

/** Tooltip content for card elements (DESIGN.md 4.14). Live: it re-renders while open. */
export function renderTip(req: TipRequest): ReactNode {
  return <TipContent key={`${req.mint}:${req.tip}`} tip={req.tip} mint={req.mint} column={req.column as PulseColumnId | null} />;
}

function line(children: ReactNode, className = "text-fg-2") {
  return <span className={`mt-1 block ${className}`}>{children}</span>;
}

function useToken(mint: string | null): TokenSummary | undefined {
  const live = useMarket((s) => (mint ? s.tokens[mint] : undefined));
  return live ?? (mint ? seenToken(mint) : undefined);
}

function TipContent({ tip, mint, column }: { tip: string; mint: string | null; column: PulseColumnId | null }) {
  const t = useToken(mint);
  const now = useNow();
  const quote = useSettings((s) => s.display.quote);
  const solUsd = useMarket((s) => s.solUsd);
  const thresholds = useSettings((s) => s.display.riskThresholds);
  const copyKey = useSettings((s) => s.hotkeys["pulse.copy"]?.[0]);
  const buyKey = useSettings((s) => s.hotkeys["buy.quick"]?.[0]);
  const sol = useSettings((s) => (column ? (s.columns[column].quickBuySol ?? s.quickBuySol) : s.quickBuySol));
  const locked = useWallet((s) => s.service.locked && s.mode === "instant");
  const feedUp = useMarket((s) => s.connection === "live" || s.connection === "degraded");
  const tracked = useTrackedHolding();
  if (!t) return null;
  const updated = `Last trade ${fmtAge(t.lastTradeAt, now)} ago`;
  const inSol = quote === "SOL" && solUsd > 0;
  const money = (usd: number) => (inSol ? `${fmtSol(usd / solUsd)} SOL` : fmtUsd(usd));

  if (tip.startsWith("risk:")) {
    const chip = riskChip(tip.slice(5) as RiskKey, t.risk, thresholds);
    return <RiskTip chip={chip} thresholds={thresholds} updated={updated} />;
  }
  if (tip.startsWith("social:")) {
    const kind = tip.slice(7) as "x" | "web" | "tg";
    const value = kind === "x" ? t.socials.x : kind === "web" ? t.socials.website : t.socials.telegram;
    if (!value) return null;
    return (
      <span className="block">
        <span className="block break-all">{socialLabel(kind, value)}</span>
        {getServices().simulated && line("Simulated data: a click copies the link.", "text-fg-3")}
      </span>
    );
  }

  switch (tip) {
    case "mc":
      return (
        <span className="block">
          <MetricTip metric="marketCap" value={money(t.marketCapUsd)} updated={updated} />
          <span className="mt-1 flex items-baseline justify-between gap-3 text-fg-2">
            Price
            <Num kind="price" usd={!inSol} value={inSol ? t.priceSol : t.priceUsd} className="text-fg-1" />
          </span>
          <span className="flex items-baseline justify-between gap-3 text-fg-2">
            5m change
            <Num kind="pct" signed value={t.change5mPct} />
          </span>
        </span>
      );
    case "v":
      return <MetricTip metric="volume" value={money(t.volumeUsd)} updated={updated} />;
    case "tx":
      return (
        <span className="block">
          <MetricTip metric="txns" value={fmtCount(t.txns)} updated={updated} />
          {line(`${fmtInt(t.buys)} buys · ${fmtInt(t.sells)} sells`)}
        </span>
      );
    case "holders":
      return <MetricTip metric="holders" value={fmtCount(t.holders)} updated={updated} />;
    case "pro":
      return <MetricTip metric="proTraders" value={fmtCount(t.proTraders)} updated={updated} />;
    case "eye":
      return (
        <span className="block">
          <span className="flex items-baseline justify-between gap-3">
            <span className="text-data font-semibold text-fg-1">Tracked wallets</span>
            <span className="text-data font-semibold text-info">{tracked.get(t.mint) ?? 0}</span>
          </span>
          {line("Wallets on your tracker list that bought this token in their recent trades and still hold it.")}
        </span>
      );
    case "ring":
      return (
        <span className="block">
          <MetricTip metric="progress" value={t.migratedAt !== null ? "Migrated" : fmtProgress(t.bondingProgress)} />
          {line(`${LAUNCHPAD_BY_ID[t.launchpad]?.label ?? "Other"} · created ${fmtClock(t.createdAt)}`, "text-fg-3")}
        </span>
      );
    case "dex":
      return <MetricTip metric="dexPaid" value="Paid" />;
    case "t22":
      return <MetricTip metric="token2022" value={<span className="text-sell">{token2022Danger(t.token2022).join(", ")}</span>} />;
    case "lp":
      return <MetricTip metric="lpBurned" value={t.lpBurnedPct === null ? DASH : fmtRiskPct(t.lpBurnedPct)} />;
    case "fees":
      return <MetricTip metric="fees" value={`${fmtSol(t.feesPaidSol)} SOL`} updated={updated} />;
    case "nb": {
      const nb = netBuy(t.netBuyUsd, quote === "SOL" ? solUsd : null);
      return (
        <span className="block">
          <span className="flex items-baseline justify-between gap-3">
            <span className="text-data font-semibold text-fg-1">Net buy</span>
            <span
              className={cn(
                "zf-num text-data font-semibold",
                nb.nbTone === "buy" ? "text-buy" : nb.nbTone === "sell" ? "text-sell" : "text-fg-3",
              )}
            >
              {nb.nb}
            </span>
          </span>
          {line("SOL bought minus SOL sold since the token was created.")}
        </span>
      );
    }
    case "chart":
      return (
        <span className="block">
          <span className="block text-data font-semibold">Price, last 30 minutes</span>
          {line("1-minute closes. Younger tokens start part-way across.")}
        </span>
      );
    case "copy":
      return (
        <span className="block">
          <span className="flex items-center justify-between gap-3">
            Copy contract address
            <Hotkey binding={copyKey} />
          </span>
          <span className="mt-1 block font-mono text-label break-all text-fg-2">{t.mint}</span>
        </span>
      );
    case "more":
      return <>More actions (or right-click the card)</>;
    case "pill":
      if (!feedUp) return <>Feed offline: trading resumes when it reconnects</>;
      if (locked) return <>Unlock to buy {fmtSolShort(sol)} SOL</>;
      return (
        <span className="flex items-center gap-3">
          Buy {fmtSolShort(sol)} SOL
          <Hotkey binding={buyKey} />
        </span>
      );
    default:
      return null;
  }
}
