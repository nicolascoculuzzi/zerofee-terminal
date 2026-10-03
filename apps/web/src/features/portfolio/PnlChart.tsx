import {
  BaselineSeries,
  type BaselineSeriesPartialOptions,
  type ChartOptions,
  createChart,
  type DeepPartial,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import { baseChartOptions, type ChartColors, chartColors, useChartThemeKey } from "../../lib/chartTheme";
import { fmtSignedSol } from "../../lib/format";
import type { PnlPoint } from "../../protocol";

/** `rgba()` of a theme colour, resolved by the browser so any CSS colour token works. */
function withAlpha(color: string, alpha: number): string {
  const probe = document.createElement("span");
  probe.style.display = "none";
  probe.style.color = color;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  const m = resolved.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  return m ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})` : color;
}

function chartOptions(c: ChartColors): DeepPartial<ChartOptions> {
  const base = baseChartOptions(c);
  return {
    ...base,
    // A daily summary: no panning or zooming, so touch scrolling passes through to the page.
    handleScroll: false,
    handleScale: false,
    rightPriceScale: { ...base.rightPriceScale, scaleMargins: { top: 0.16, bottom: 0.08 } },
    timeScale: { ...base.timeScale, timeVisible: false, fixLeftEdge: true, fixRightEdge: true },
  };
}

/** Above zero in buy green, below in sell red: the colours mean profit and loss, nothing else. */
function seriesOptions(c: ChartColors): BaselineSeriesPartialOptions {
  return {
    baseValue: { type: "price", price: 0 },
    topLineColor: c.buy,
    topFillColor1: withAlpha(c.buy, 0.24),
    topFillColor2: withAlpha(c.buy, 0.02),
    bottomLineColor: c.sell,
    bottomFillColor1: withAlpha(c.sell, 0.02),
    bottomFillColor2: withAlpha(c.sell, 0.24),
    lineWidth: 2,
    priceLineVisible: false,
    crosshairMarkerRadius: 3,
    priceFormat: { type: "custom", formatter: (v: number) => fmtSignedSol(v), minMove: 0.001 },
  };
}

/**
 * Points are local start-of-day in Unix ms. The chart renders UTC, so shift each one by the
 * zone offset; otherwise a midnight east of Greenwich is labelled with the previous date.
 */
function toSeries(points: PnlPoint[]): { time: UTCTimestamp; value: number }[] {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const out: { time: UTCTimestamp; value: number }[] = [];
  for (const p of sorted) {
    const time = Math.floor((p.t - new Date(p.t).getTimezoneOffset() * 60_000) / 1000) as UTCTimestamp;
    const last = out[out.length - 1];
    if (last && last.time >= time) last.value = p.pnlSol;
    else out.push({ time, value: p.pnlSol });
  }
  return out;
}

/** Cumulative PnL area. Fills its positioned parent; `attributionLogo` stays on (baseChartOptions). */
export function PnlChart({ points }: { points: PnlPoint[] | null }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Baseline"> | null>(null);
  const themeKey = useChartThemeKey();
  const appliedTheme = useRef(themeKey);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const colors = chartColors();
    const chart = createChart(host, chartOptions(colors));
    seriesRef.current = chart.addSeries(BaselineSeries, seriesOptions(colors));
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (appliedTheme.current === themeKey) return;
    appliedTheme.current = themeKey;
    // App writes data-theme in its own effect, which runs after this one: read the palette next frame.
    const raf = requestAnimationFrame(() => {
      const colors = chartColors();
      chartRef.current?.applyOptions(chartOptions(colors));
      seriesRef.current?.applyOptions(seriesOptions(colors));
    });
    return () => cancelAnimationFrame(raf);
  }, [themeKey]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const data = points ? toSeries(points) : [];
    series.setData(data);
    if (data.length > 0) chartRef.current?.timeScale().fitContent();
  }, [points]);

  return <div ref={hostRef} className="absolute inset-0" />;
}
