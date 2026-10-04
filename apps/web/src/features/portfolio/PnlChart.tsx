import {
  BaselineSeries,
  type BaselineSeriesPartialOptions,
  type ChartOptions,
  createChart,
  type DeepPartial,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  LineStyle,
  type LineWidth,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";
import { baseChartOptions, type ChartColors, chartColors, useChartThemeKey, withAlpha } from "../../lib/chartTheme";
import { cn } from "../../lib/cn";
import { fmtDate, fmtSignedSol, fmtSignedUsd, fmtUsd, signClass } from "../../lib/format";
import type { PnlPoint } from "../../protocol";
import type { QuoteCurrency } from "../../state/settings";
import { type PnlRange, RANGE_LABEL } from "./helpers";
import { useQuote } from "./quote";
import { PanelError } from "./table";

/** Signed compact axis label: "+$1.24K", "−$412", "+1.24". */
function axisLabel(v: number, quote: QuoteCurrency): string {
  if (quote === "SOL") return fmtSignedSol(v);
  return `${v > 0 ? "+" : ""}${fmtUsd(v)}`;
}

function signedText(v: number, quote: QuoteCurrency): string {
  return quote === "SOL" ? `${fmtSignedSol(v)} SOL` : fmtSignedUsd(v);
}

function chartOptions(c: ChartColors): DeepPartial<ChartOptions> {
  const base = baseChartOptions(c);
  return {
    ...base,
    // A daily summary: no panning or zooming, so touch scrolling passes through to the page.
    handleScroll: false,
    handleScale: false,
    rightPriceScale: { ...base.rightPriceScale, scaleMargins: { top: 0.18, bottom: 0.1 } },
    timeScale: { ...base.timeScale, timeVisible: false, fixLeftEdge: true, fixRightEdge: true },
    // The floating tooltip carries the date and value, so the axis labels stay quiet.
    crosshair: {
      ...base.crosshair,
      vertLine: { ...base.crosshair?.vertLine, labelVisible: false },
      horzLine: { ...base.crosshair?.horzLine, labelVisible: false },
    },
  };
}

/**
 * Above zero in buy, below in sell: the colours mean profit and loss, nothing else. Flat 10%
 * fills (both stops equal, so the fill is one flat tint) and a 1.5 px line (DESIGN.md 5.3). The line renderer
 * multiplies lineWidth by the pixel ratio without flooring, so 1.5 is honoured although the
 * LineWidth type only lists integers.
 */
function seriesOptions(c: ChartColors, quote: QuoteCurrency): BaselineSeriesPartialOptions {
  const up = withAlpha(c.buy, 0.1);
  const down = withAlpha(c.sell, 0.1);
  return {
    baseValue: { type: "price", price: 0 },
    topLineColor: c.buy,
    topFillColor1: up,
    topFillColor2: up,
    bottomLineColor: c.sell,
    bottomFillColor1: down,
    bottomFillColor2: down,
    lineWidth: 1.5 as LineWidth,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerRadius: 3,
    priceFormat: { type: "custom", formatter: (v: number) => axisLabel(v, quote), minMove: 0.0001 },
  };
}

/** Points are local start-of-day (Unix ms); chartTheme formats axis times in local time. */
function toSeries(points: PnlPoint[], scale: number): { time: UTCTimestamp; value: number }[] {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const out: { time: UTCTimestamp; value: number }[] = [];
  for (const p of sorted) {
    const time = Math.floor(p.t / 1000) as UTCTimestamp;
    const last = out[out.length - 1];
    if (last && last.time >= time) last.value = p.pnlSol * scale;
    else out.push({ time, value: p.pnlSol * scale });
  }
  return out;
}

interface Hover {
  x: number;
  y: number;
  time: number;
  value: number;
}

/**
 * Cumulative PnL as a Lightweight Charts baseline series at 0 (DESIGN.md 5.3), in the global
 * quote. The crosshair tooltip shows date and PnL; a legend top-left shows the change over the
 * range. `attributionLogo` stays on (baseChartOptions, Apache-2.0 NOTICE). Chart coloured above
 * and below a reference line after Gemini: https://mobbin.com/screens/fe564b29-e2e7-43ff-8c21-9d9861d24ea1
 * A PnL line that dips below zero after Binance: https://mobbin.com/screens/f63adfaf-72f6-4247-9982-8fcabd254ee2
 * Compact dark tooltip with tabular values after Railway: https://mobbin.com/screens/14f51fd0-7ad0-4c59-a44c-9f35b2056107
 */
export function PnlChart({
  points,
  loading,
  failures,
  onRetry,
  range,
  className,
}: {
  points: PnlPoint[] | null;
  loading: boolean;
  failures: number;
  onRetry: () => void;
  range: PnlRange;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Baseline"> | null>(null);
  const zeroRef = useRef<IPriceLine | null>(null);
  const themeKey = useChartThemeKey();
  const { quote, solUsd } = useQuote();
  const [hover, setHover] = useState<Hover | null>(null);
  const quoteRef = useRef(quote);
  quoteRef.current = quote;
  // Convert at the live SOL/USD (the history is kept in SOL). Re-scaling on every rate tick
  // would redraw the series each second; a rate rounded to the cent is plenty for a daily chart.
  const scale = quote === "USD" ? Math.round(solUsd * 100) / 100 : 1;
  const data = useMemo(() => (points ? toSeries(points, scale) : []), [points, scale]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const colors = chartColors();
    const chart = createChart(host, chartOptions(colors));
    const series = chart.addSeries(BaselineSeries, seriesOptions(colors, quoteRef.current));
    zeroRef.current = series.createPriceLine({
      price: 0,
      color: colors.line,
      lineWidth: 1,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: false,
      lineVisible: true,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    const onMove = (param: MouseEventParams<Time>) => {
      const point = param.point;
      const time = param.time;
      const datum = param.seriesData.get(series) as { value?: number } | undefined;
      if (!point || time === undefined || datum?.value === undefined) {
        setHover(null);
        return;
      }
      const y = series.priceToCoordinate(datum.value);
      setHover({ x: point.x, y: y ?? point.y, time: Number(time) * 1000, value: datum.value });
    };
    chart.subscribeCrosshairMove(onMove);
    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      zeroRef.current = null;
    };
  }, []);

  // Theme, palette or quote changed: re-read the tokens (App writes data-theme in its own
  // effect, after this one, so wait a frame).
  useEffect(() => {
    // The key only signals the change; the colours are read from the CSS variables.
    void themeKey;
    const raf = requestAnimationFrame(() => {
      const colors = chartColors();
      chartRef.current?.applyOptions(chartOptions(colors));
      seriesRef.current?.applyOptions(seriesOptions(colors, quote));
      zeroRef.current?.applyOptions({ color: colors.line });
    });
    return () => cancelAnimationFrame(raf);
  }, [themeKey, quote]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    series.setData(data);
    if (data.length > 0) chartRef.current?.timeScale().fitContent();
  }, [data]);

  const first = data[0];
  const last = data[data.length - 1];
  const change = first && last && data.length > 1 ? last.value - first.value : null;
  const empty = points !== null && points.length === 0;

  return (
    <div className={cn("relative min-w-0 overflow-hidden bg-surface-1", className)}>
      <div ref={hostRef} className="absolute inset-0" />
      {/* Legend (DESIGN.md 4.10): top-left overlay, 8 px inset, 11 px. */}
      <div className="pointer-events-none absolute top-2 left-2 z-chart-ui flex items-baseline gap-2 text-label">
        <span className="text-fg-3">Cumulative PnL · {RANGE_LABEL[range]}</span>
        {change !== null && <span className={cn("zf-num font-medium", signClass(change))}>{signedText(change, quote)}</span>}
      </div>
      {hover && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-chart-ui rounded-md border border-hairline-strong bg-tooltip px-2.5 py-2 text-label shadow-e1"
          style={{
            left: Math.max(4, Math.min(hover.x + 12, (hostRef.current?.clientWidth ?? 0) - 132)),
            top: Math.max(4, hover.y - 48),
          }}
        >
          <div className="text-fg-3">{fmtDate(hover.time)}</div>
          <div className={cn("zf-num font-semibold", signClass(hover.value))}>{signedText(hover.value, quote)}</div>
        </div>
      )}
      {failures > 0 && points === null ? (
        <div className="absolute inset-x-0 top-7 z-chart-ui">
          <PanelError what="PnL history" failures={failures} onRetry={onRetry} />
        </div>
      ) : points === null || empty ? (
        // Loading state per DESIGN.md 4.10: the canvas plus one line of text-3, no spinner.
        <div className="pointer-events-none absolute top-7 left-2 z-chart-ui text-data text-fg-3">
          {points === null
            ? loading
              ? `Loading ${RANGE_LABEL[range]} PnL…`
              : "No PnL history"
            : "No PnL history yet. It starts with your first trade."}
        </div>
      ) : null}
    </div>
  );
}
