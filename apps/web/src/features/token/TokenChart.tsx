import {
  type CandlestickData,
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  LineStyle,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { Maximize2, X } from "lucide-react";
import { type PointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { IconButton } from "../../components/ui/Button";
import { Segmented } from "../../components/ui/controls";
import { baseChartOptions, chartColors, useChartThemeKey } from "../../lib/chartTheme";
import { cn } from "../../lib/cn";
import { fmtClock, fmtCompact, fmtPct, fmtSmall } from "../../lib/format";
import { type Candle, TIMEFRAME_SECONDS, TIMEFRAMES, type Timeframe } from "../../protocol";
import { useMarket } from "../../state/market";
import { subscribeSequenced } from "../../state/subscribe";
import { useToken } from "../../state/token";
import { useTrackedMap } from "../../state/trackers";
import { useActivePosition } from "../../state/wallet";
import { type ChartCurrency, type ChartMode, useTokenUi } from "./tokenUi";

/*
 * Chart panel. Toolbar and legend anatomy follow Coinbase Advanced's price chart (timeframe,
 * O/H/L/C legend, volume pane, axis tags) https://mobbin.com/screens/ff785484-4dd2-4fc0-a5f4-658e033b3b08
 * and Kraken Pro's on-chart order preview line https://mobbin.com/screens/7cef61a7-167f-4abd-ab8a-effc2538da6f.
 *
 * Units: the series always plots priceSol × supply × (USD ? SOL/USD : 1), i.e. market cap. Price
 * mode only changes the axis formatter (value / supply), so tiny memecoin prices never hit the
 * library's floating-point precision limits.
 */

const DRAG_TOLERANCE_PX = 6;

function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  if (h.length !== 6) return hex;
  const a = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${h}${a}`;
}

function formatter(mode: ChartMode, currency: ChartCurrency, supply: number) {
  const prefix = currency === "usd" ? "$" : "";
  const suffix = currency === "sol" ? " SOL" : "";
  return (v: number) => (mode === "mc" ? `${prefix}${fmtCompact(v)}${suffix}` : `${prefix}${fmtSmall(v / supply, 4)}${suffix}`);
}

/** Short marker label so clustered tracked-wallet trades stay readable ("Sniper Sam" → "SS"). */
function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "T";
  if (words.length === 1) return (words[0] ?? "T").slice(0, 2).toUpperCase();
  return words
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase();
}

interface Legend {
  o: number;
  h: number;
  l: number;
  c: number;
  changePct: number;
  time: number;
}

export function TokenChart({ mint, supply }: { mint: string; supply: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const rawRef = useRef<Candle[]>([]);
  const timesRef = useRef<Set<number>>(new Set());
  const linesRef = useRef<{ entry: IPriceLine | null; exit: IPriceLine | null; limit: IPriceLine | null }>({
    entry: null,
    exit: null,
    limit: null,
  });
  const draggingRef = useRef(false);
  const justDraggedRef = useRef(0);
  const [legend, setLegend] = useState<Legend | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "empty">("loading");
  const [dataVersion, setDataVersion] = useState(0);

  const tf = useTokenUi((s) => s.tf);
  const mode = useTokenUi((s) => s.mode);
  const currency = useTokenUi((s) => s.currency);
  const limit = useTokenUi((s) => s.limit);
  const candle = useTokenUi((s) => s.candle);
  const setTf = useTokenUi((s) => s.setTf);
  const setMode = useTokenUi((s) => s.setMode);
  const setCurrency = useTokenUi((s) => s.setCurrency);
  const setLimit = useTokenUi((s) => s.setLimit);
  const setCandle = useTokenUi((s) => s.setCandle);
  const themeKey = useChartThemeKey();
  const solUsd = useMarket((s) => s.solUsd);
  const position = useActivePosition(mint);
  const trades = useToken((s) => s.trades);
  const tracked = useTrackedMap();

  // Latest values for imperative callbacks.
  const live = useRef({ tf, mode, currency, supply, solUsd, limit });
  live.current = { tf, mode, currency, supply, solUsd, limit };

  const plot = useCallback((priceSol: number, fx: number) => priceSol * supply * (currency === "usd" ? fx : 1), [supply, currency]);

  const toBar = useCallback(
    (c: Candle): CandlestickData<UTCTimestamp> => ({
      time: c.time as UTCTimestamp,
      open: plot(c.open, c.solUsd),
      high: plot(c.high, c.solUsd),
      low: plot(c.low, c.solUsd),
      close: plot(c.close, c.solUsd),
    }),
    [plot],
  );

  const volumeBar = useCallback(
    (c: Candle, buy: string, sell: string) => ({
      time: c.time as UTCTimestamp,
      value: currency === "usd" ? c.volumeSol * c.solUsd : c.volumeSol,
      color: c.close >= c.open ? withAlpha(buy, 0.45) : withAlpha(sell, 0.45),
    }),
    [currency],
  );

  // Streaming callbacks read the latest converters through refs (units can change mid-stream).
  const toBarRef = useRef(toBar);
  toBarRef.current = toBar;
  const volumeBarRef = useRef(volumeBar);
  volumeBarRef.current = volumeBar;

  // Create the chart once per token.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const colors = chartColors();
    const base = baseChartOptions(colors);
    const chart = createChart(el, {
      ...base,
      rightPriceScale: { borderColor: colors.line, scaleMargins: { top: 0.14, bottom: 0.14 } },
      timeScale: { ...base.timeScale, secondsVisible: true, rightOffset: 4, barSpacing: 7 },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: colors.buy,
      downColor: colors.sell,
      wickUpColor: colors.buy,
      wickDownColor: colors.sell,
      borderVisible: false,
      priceLineColor: colors.dim,
      priceFormat: { type: "custom", minMove: 0.0001, formatter: formatter(live.current.mode, live.current.currency, supply) },
    });
    const volume = chart.addSeries(
      HistogramSeries,
      { priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false },
      1,
    );
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.15, bottom: 0 } });
    chart.panes()[0]?.setStretchFactor(1);
    chart.panes()[1]?.setStretchFactor(0.22);
    // Markers don't take part in autoscaling, so the axis never stretches below zero for a label.
    const markers = createSeriesMarkers(candles, [], { autoScale: false });

    let legendRaf = 0;
    const onMove = (param: MouseEventParams<Time>) => {
      if (legendRaf) return;
      legendRaf = requestAnimationFrame(() => {
        legendRaf = 0;
        const d = param.seriesData.get(candles) as CandlestickData<Time> | undefined;
        if (!d || param.time === undefined) {
          setLegend(null);
          return;
        }
        setLegend({
          o: d.open,
          h: d.high,
          l: d.low,
          c: d.close,
          changePct: d.open > 0 ? (d.close / d.open - 1) * 100 : 0,
          time: param.time as number,
        });
      });
    };
    const onClick = (param: MouseEventParams<Time>) => {
      if (Date.now() - justDraggedRef.current < 350) return;
      if (param.time === undefined || !param.point) return;
      const t = param.time as number;
      setCandle({ from: t, to: t + TIMEFRAME_SECONDS[live.current.tf] });
    };
    chart.subscribeCrosshairMove(onMove);
    chart.subscribeClick(onClick);

    chartRef.current = chart;
    candleRef.current = candles;
    volumeRef.current = volume;
    markersRef.current = markers;
    return () => {
      cancelAnimationFrame(legendRaf);
      chart.unsubscribeCrosshairMove(onMove);
      chart.unsubscribeClick(onClick);
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      markersRef.current = null;
      linesRef.current = { entry: null, exit: null, limit: null };
    };
  }, [supply, setCandle]);

  // Stream candles for the current timeframe; deltas are applied once per animation frame.
  useEffect(() => {
    const candles = candleRef.current;
    const volume = volumeRef.current;
    if (!candles || !volume) return;
    setStatus("loading");
    rawRef.current = [];
    timesRef.current = new Set();
    candles.setData([]);
    volume.setData([]);
    chartRef.current?.applyOptions({ timeScale: { secondsVisible: tf === "1s" || tf === "15s" } });
    const pending = new Map<number, Candle>();
    let raf = 0;
    const colors = chartColors();
    const apply = (c: Candle) => {
      const raw = rawRef.current;
      const last = raw[raw.length - 1];
      if (last && c.time < last.time) {
        const idx = raw.findIndex((x) => x.time === c.time);
        if (idx >= 0) raw[idx] = c;
        return;
      }
      if (last && last.time === c.time) raw[raw.length - 1] = c;
      else {
        raw.push(c);
        timesRef.current.add(c.time);
      }
      candles.update(toBarRef.current(c));
      volume.update(volumeBarRef.current(c, colors.buy, colors.sell));
    };
    const flush = () => {
      raf = 0;
      const list = [...pending.values()].sort((a, b) => a.time - b.time);
      pending.clear();
      const hadData = rawRef.current.length > 0;
      for (const c of list) apply(c);
      if (!hadData && rawRef.current.length > 0) setStatus("ready");
      setDataVersion((v) => v + 1);
    };
    const off = subscribeSequenced(
      `candles:${mint}:${tf}`,
      (snap) => {
        // The library requires strictly ascending, unique times.
        const byTime = new Map<number, Candle>();
        for (const c of snap.candles) byTime.set(c.time, c);
        const sorted = [...byTime.values()].sort((a, b) => a.time - b.time);
        rawRef.current = sorted;
        timesRef.current = new Set(sorted.map((c) => c.time));
        candles.setData(sorted.map((c) => toBarRef.current(c)));
        volume.setData(sorted.map((c) => volumeBarRef.current(c, colors.buy, colors.sell)));
        const n = sorted.length;
        if (n > 0) chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(-2, n - 110), to: n + 4 });
        setStatus(n > 0 ? "ready" : "empty");
        setDataVersion((v) => v + 1);
      },
      (delta) => {
        for (const c of delta.candles) pending.set(c.time, c);
        if (!raf) raf = requestAnimationFrame(flush);
      },
    );
    return () => {
      off();
      cancelAnimationFrame(raf);
    };
  }, [mint, tf]);

  // Re-render for unit or theme changes without resubscribing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: themeKey is a trigger; colours are re-read from the CSS variables
  useEffect(() => {
    const chart = chartRef.current;
    const candles = candleRef.current;
    const volume = volumeRef.current;
    if (!chart || !candles || !volume) return;
    const colors = chartColors();
    const base = baseChartOptions(colors);
    chart.applyOptions({
      ...base,
      rightPriceScale: { borderColor: colors.line, scaleMargins: { top: 0.14, bottom: 0.14 } },
      timeScale: { ...base.timeScale, secondsVisible: tf === "1s" || tf === "15s" },
    });
    candles.applyOptions({
      upColor: colors.buy,
      downColor: colors.sell,
      wickUpColor: colors.buy,
      wickDownColor: colors.sell,
      priceLineColor: colors.dim,
      priceFormat: { type: "custom", minMove: 0.0001, formatter: formatter(mode, currency, supply) },
    });
    if (rawRef.current.length > 0) {
      candles.setData(rawRef.current.map(toBar));
      volume.setData(rawRef.current.map((c) => volumeBar(c, colors.buy, colors.sell)));
    }
  }, [mode, currency, themeKey, supply, toBar, volumeBar, tf]);

  // Markers: own buys/sells, dev trades, tracked wallets (one per kind per candle).
  // biome-ignore lint/correctness/useExhaustiveDependencies: dataVersion is a trigger (new candle times may make markers placeable)
  useEffect(() => {
    const api = markersRef.current;
    if (!api) return;
    const colors = chartColors();
    const secs = TIMEFRAME_SECONDS[tf];
    const groups = new Map<string, SeriesMarker<Time>>();
    for (const tr of trades) {
      const you = tr.tags.includes("you");
      const dev = tr.tags.includes("dev");
      const trk = tracked.get(tr.maker);
      if (!you && !dev && !trk) continue;
      const time = Math.floor(tr.ts / 1000 / secs) * secs;
      if (!timesRef.current.has(time)) continue;
      const buy = tr.side === "buy";
      const kind = you ? "you" : dev ? "dev" : "trk";
      const key = `${time}:${kind}:${tr.side}`;
      if (groups.has(key)) continue;
      if (kind === "you") {
        groups.set(key, {
          time: time as UTCTimestamp,
          position: buy ? "belowBar" : "aboveBar",
          shape: buy ? "arrowUp" : "arrowDown",
          color: buy ? colors.buy : colors.sell,
          text: buy ? "B" : "S",
        });
      } else if (kind === "dev") {
        groups.set(key, {
          time: time as UTCTimestamp,
          position: buy ? "belowBar" : "aboveBar",
          shape: "circle",
          color: colors.warn,
          text: "Dev",
        });
      } else {
        groups.set(key, {
          time: time as UTCTimestamp,
          position: buy ? "belowBar" : "aboveBar",
          shape: "square",
          color: colors.fg,
          text: initials(trk?.name ?? "Tracked"),
        });
      }
      if (groups.size >= 160) break;
    }
    api.setMarkers([...groups.values()].sort((a, b) => (a.time as number) - (b.time as number)));
  }, [trades, tf, tracked, dataVersion]);

  // Average entry / exit lines.
  // biome-ignore lint/correctness/useExhaustiveDependencies: dataVersion is a trigger (lines are re-created after a data reset)
  useEffect(() => {
    const series = candleRef.current;
    if (!series) return;
    const colors = chartColors();
    const lines = linesRef.current;
    const entry = position && position.holdingTokens > 0 && position.avgEntryPriceSol > 0 ? plot(position.avgEntryPriceSol, solUsd) : null;
    if (entry === null) {
      if (lines.entry) series.removePriceLine(lines.entry);
      lines.entry = null;
    } else if (lines.entry) lines.entry.applyOptions({ price: entry });
    else
      lines.entry = series.createPriceLine({
        price: entry,
        color: colors.fg,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "Avg entry",
      });
    const exit = position?.avgExitPriceSol ? plot(position.avgExitPriceSol, solUsd) : null;
    if (exit === null) {
      if (lines.exit) series.removePriceLine(lines.exit);
      lines.exit = null;
    } else if (lines.exit) lines.exit.applyOptions({ price: exit });
    else
      lines.exit = series.createPriceLine({
        price: exit,
        color: colors.dim,
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: false,
        title: "Avg exit",
      });
  }, [position, plot, solUsd, dataVersion]);

  // Limit-order target line (draggable).
  useEffect(() => {
    const series = candleRef.current;
    if (!series) return;
    const colors = chartColors();
    const lines = linesRef.current;
    if (!limit.active || limit.priceSol === null) {
      if (lines.limit) series.removePriceLine(lines.limit);
      lines.limit = null;
      return;
    }
    const price = plot(limit.priceSol, solUsd);
    const color = limit.side === "buy" ? colors.buy : colors.sell;
    if (lines.limit) lines.limit.applyOptions({ price, color });
    else
      lines.limit = series.createPriceLine({
        price,
        color,
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "Limit Order Target",
      });
  }, [limit.active, limit.priceSol, limit.side, plot, solUsd]);

  const nearLimitLine = (clientY: number): boolean => {
    const series = candleRef.current;
    const el = containerRef.current;
    const l = live.current.limit;
    if (!series || !el || !l.active || l.priceSol === null) return false;
    const y = series.priceToCoordinate(plot(l.priceSol, live.current.solUsd));
    if (y === null) return false;
    return Math.abs(clientY - el.getBoundingClientRect().top - y) <= DRAG_TOLERANCE_PX;
  };

  const onPointerDownCapture = (e: PointerEvent<HTMLDivElement>) => {
    if (!nearLimitLine(e.clientY)) return;
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = true;
    chartRef.current?.applyOptions({ handleScroll: false, handleScale: false });
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMoveCapture = (e: PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (!draggingRef.current) {
      el.style.cursor = nearLimitLine(e.clientY) ? "ns-resize" : "";
      return;
    }
    e.stopPropagation();
    const series = candleRef.current;
    if (!series) return;
    const v = series.coordinateToPrice(e.clientY - el.getBoundingClientRect().top);
    if (v === null || v <= 0) return;
    const fx = live.current.currency === "usd" ? live.current.solUsd : 1;
    setLimit({ priceSol: v / (live.current.supply * fx) });
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    justDraggedRef.current = Date.now();
    chartRef.current?.applyOptions({ handleScroll: true, handleScale: true });
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const last = rawRef.current[rawRef.current.length - 1];
  const shown: Legend | null =
    legend ??
    (last
      ? {
          o: plot(last.open, last.solUsd),
          h: plot(last.high, last.solUsd),
          l: plot(last.low, last.solUsd),
          c: plot(last.close, last.solUsd),
          changePct: last.open > 0 ? (last.close / last.open - 1) * 100 : 0,
          time: last.time,
        }
      : null);
  const fmt = formatter(mode, currency, supply);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2">
        <div className="flex items-center" role="radiogroup" aria-label="Timeframe">
          {TIMEFRAMES.map((t: Timeframe) => (
            // biome-ignore lint/a11y/useSemanticElements: compact timeframe radio
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={tf === t}
              onClick={() => setTf(t)}
              className={cn("h-6 rounded-sm px-2 text-xs font-medium", tf === t ? "bg-elev text-fg" : "text-muted hover:text-fg")}
            >
              {t}
            </button>
          ))}
        </div>
        <span className="h-4 w-px bg-line" />
        <Segmented<ChartMode>
          size="xs"
          value={mode}
          onChange={setMode}
          options={[
            { value: "mc", label: "MarketCap" },
            { value: "price", label: "Price" },
          ]}
          label="Chart value"
        />
        <Segmented<ChartCurrency>
          size="xs"
          value={currency}
          onChange={setCurrency}
          options={[
            { value: "usd", label: "USD" },
            { value: "sol", label: "SOL" },
          ]}
          label="Chart currency"
        />
        {candle && (
          <button
            type="button"
            onClick={() => setCandle(null)}
            className="flex h-6 items-center gap-1 rounded-sm border border-line-strong px-2 text-xs text-fg"
          >
            Trades in candle {fmtClock(candle.from * 1000)}
            <X className="icon-xs" />
          </button>
        )}
        <div className="ml-auto flex items-center gap-1">
          <IconButton label="Fit chart" onClick={() => chartRef.current?.timeScale().fitContent()}>
            <Maximize2 className="icon-sm" />
          </IconButton>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <div className="pointer-events-none absolute top-2 left-2 z-10 flex flex-wrap items-center gap-x-2 text-xs">
          {shown && (
            <>
              <span className="text-dim">
                O <span className="text-fg">{fmt(shown.o)}</span>
              </span>
              <span className="text-dim">
                H <span className="text-fg">{fmt(shown.h)}</span>
              </span>
              <span className="text-dim">
                L <span className="text-fg">{fmt(shown.l)}</span>
              </span>
              <span className="text-dim">
                C <span className="text-fg">{fmt(shown.c)}</span>
              </span>
              <span className={shown.changePct >= 0 ? "text-buy" : "text-sell"}>{fmtPct(shown.changePct, { signed: true })}</span>
            </>
          )}
          {limit.active && <span className="text-dim">Drag the target line to set the limit</span>}
        </div>
        {status !== "ready" && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center text-sm text-dim">
            {status === "loading" ? "Loading candles…" : "No trades in this timeframe yet"}
          </div>
        )}
        <div
          ref={containerRef}
          className="absolute inset-0"
          onPointerDownCapture={onPointerDownCapture}
          onPointerMoveCapture={onPointerMoveCapture}
          onPointerUpCapture={endDrag}
          onPointerCancelCapture={endDrag}
        />
      </div>
    </div>
  );
}
