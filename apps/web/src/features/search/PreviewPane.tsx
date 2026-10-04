import { useEffect, useState } from "react";
import { MetricLabel, MetricTip } from "../../components/ui/bits";
import { CopyButton } from "../../components/ui/controls";
import { Num } from "../../components/ui/Num";
import { TokenAvatar } from "../../components/ui/TokenAvatar";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import { fmtCount, fmtRiskPct, shortAddr } from "../../lib/format";
import { bandsText, METRICS, RISK_LETTER, type RiskKey, riskTone, TONE_CHIP } from "../../lib/metrics";
import type { Candle, TokenSummary } from "../../protocol";
import { useSettings } from "../../state/settings";
import { subscribeSequenced } from "../../state/subscribe";
import { QuoteValue } from "./rows";

const RISK_KEYS: RiskKey[] = ["top10", "dev", "snipers", "insiders", "bundlers"];
const CHART_W = 216;
const CHART_H = 56;

function riskValue(token: TokenSummary, k: RiskKey): number {
  const r = token.risk;
  return k === "top10"
    ? r.top10Pct
    : k === "dev"
      ? r.devPct
      : k === "snipers"
        ? r.snipersPct
        : k === "insiders"
          ? r.insidersPct
          : r.bundlersPct;
}

/** One-hour line: 1 px text-2, no fill, a 3 px dot on the last point (the Pulse mini chart, 4.4). */
function Sparkline({ candles }: { candles: Candle[] }) {
  if (candles.length < 2) {
    return <div className="flex h-14 items-center text-label text-fg-4">No trades in the last hour</div>;
  }
  const closes = candles.map((c) => c.close);
  const lo = Math.min(...closes);
  const hi = Math.max(...closes);
  const span = hi - lo || hi || 1;
  const pts = closes.map(
    (v, i) => [(i / (closes.length - 1)) * (CHART_W - 4) + 2, CHART_H - 3 - ((v - lo) / span) * (CHART_H - 6)] as const,
  );
  const last = pts[pts.length - 1] ?? [0, 0];
  return (
    <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} width={CHART_W} height={CHART_H} aria-hidden="true" className="block text-fg-2">
      <polyline
        points={pts.map(([x, y]) => `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`).join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
      />
      <circle cx={last[0]} cy={last[1]} r="1.5" fill="currentColor" />
    </svg>
  );
}

/*
 * Palette preview (DESIGN.md 4.15, viewport 1280 px and up): a 240 px column with a 1-hour mini
 * chart, MC / liquidity / volume / holders in a 2 × 2 grid, the risk chips and dev info. Updates
 * on selection, debounced 80 ms. Preview beside results after Dropbox Dash:
 * https://mobbin.com/screens/0567ef26-d68b-4674-a6ee-8d255bbe7990
 */
export function PreviewPane({ token }: { token: TokenSummary | null }) {
  const thresholds = useSettings((s) => s.display.riskThresholds);
  const metricColors = useSettings((s) => s.display.metricColors);
  const [shown, setShown] = useState<TokenSummary | null>(token);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [dev, setDev] = useState<{ launches: number; migrations: number } | null>(null);
  const mint = token?.mint ?? null;

  // Debounce selection changes by 80 ms, then subscribe to the selected token's 1-minute candles
  // and detail (for dev history). One subscription pair at a time. `token` changes on every live
  // tick, so only a new mint restarts the subscriptions.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the mint on purpose
  useEffect(() => {
    if (!mint) {
      setShown(null);
      return;
    }
    let offCandles: (() => void) | null = null;
    let offDetail: (() => void) | null = null;
    const timer = setTimeout(() => {
      setShown(token);
      setCandles([]);
      setDev(null);
      offCandles = subscribeSequenced(
        `candles:${mint}:1m`,
        (snap) => setCandles(snap.candles.slice(-60)),
        (delta) =>
          setCandles((prev) => {
            const byTime = new Map(prev.map((c) => [c.time, c]));
            for (const c of delta.candles) byTime.set(c.time, c);
            return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-60);
          }),
      );
      offDetail = subscribeSequenced(
        `token:${mint}`,
        (detail) => setDev({ launches: detail.devLaunches, migrations: detail.devMigrations }),
        () => {},
      );
    }, 80);
    return () => {
      clearTimeout(timer);
      offCandles?.();
      offDetail?.();
    };
  }, [mint]);

  // Live values for the token already shown.
  const t = shown && token && shown.mint === token.mint ? token : shown;
  if (!t) return <div className="w-60 shrink-0 border-l border-hairline" />;

  const first = candles[0]?.open ?? null;
  const lastClose = candles[candles.length - 1]?.close ?? null;
  const change = first && lastClose ? ((lastClose - first) / first) * 100 : null;

  return (
    <aside aria-label={`Preview of ${t.symbol}`} className="w-60 shrink-0 overflow-y-auto border-l border-hairline p-3">
      <div className="flex items-center gap-2">
        <TokenAvatar mint={t.mint} symbol={t.symbol} imageUri={t.imageUri} launchpad={t.launchpad} size="sm" badge={false} />
        <div className="min-w-0">
          <div className="truncate text-body font-semibold text-fg-1">{t.symbol}</div>
          <div className="truncate text-label text-fg-3">{t.name}</div>
        </div>
      </div>
      <div className="mt-1 flex items-center gap-1 font-mono text-label text-fg-3">
        {shortAddr(t.mint)}
        <CopyButton text={t.mint} label="Copy contract address" />
      </div>

      <div className="mt-3 flex items-baseline justify-between text-label">
        <span className="text-fg-3">Last hour</span>
        <Num value={change} kind="pct" signed className="text-label" />
      </div>
      <div className="mt-1">
        <Sparkline candles={candles} />
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
        {(
          [
            ["marketCap", <QuoteValue key="mc" usd={t.marketCapUsd} sol={t.marketCapSol} strong />],
            ["liquidity", <QuoteValue key="liq" usd={t.liquidityUsd} sol={null} />],
            ["volume", <QuoteValue key="vol" usd={t.volumeUsd} sol={null} />],
            [
              "holders",
              <span key="h" className="zf-num text-data text-fg-2">
                {fmtCount(t.holders)}
              </span>,
            ],
          ] as const
        ).map(([metric, value]) => (
          <div key={metric} className="min-w-0">
            <dt className="text-label text-fg-3">
              <MetricLabel metric={metric} />
            </dt>
            <dd className="truncate">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-3 flex flex-wrap gap-1">
        {RISK_KEYS.map((k) => {
          const v = riskValue(t, k);
          const ds = k === "dev" && t.risk.devSold;
          const tone = ds ? "neutral" : metricColors ? riskTone(k, v, thresholds) : "neutral";
          return (
            <Tooltip key={k} content={<MetricTip metric={k} value={ds ? "DS" : fmtRiskPct(v)} bands={bandsText(k, thresholds)} />}>
              <span
                className={cn("inline-flex h-4 min-w-10 items-center justify-between gap-0.5 rounded-xs border px-[3px]", TONE_CHIP[tone])}
              >
                <span className="sr-only">
                  {METRICS[k].label}{" "}
                  {ds
                    ? "dev sold everything"
                    : `${fmtRiskPct(v)}, ${tone === "good" ? "low" : tone === "warn" ? "mid" : tone === "bad" ? "high" : ""} risk`}
                </span>
                <span aria-hidden="true" className="text-micro font-medium text-fg-3">
                  {RISK_LETTER[k]}
                </span>
                <span aria-hidden="true" className="zf-num text-label font-medium">
                  {ds ? "DS" : fmtRiskPct(v)}
                </span>
              </span>
            </Tooltip>
          );
        })}
      </div>

      <div className="mt-3 text-label">
        <div className="text-fg-3">Dev</div>
        <div className="flex items-center gap-1 font-mono text-fg-2">
          {shortAddr(t.creator)}
          <CopyButton text={t.creator} label="Copy dev address" />
        </div>
        <div className="text-fg-3">
          {dev && `${fmtCount(dev.launches)} earlier launches · ${fmtCount(dev.migrations)} migrated · `}
          {t.risk.devSold ? "sold out" : `holds ${fmtRiskPct(t.risk.devPct)}`}
        </div>
      </div>
    </aside>
  );
}
