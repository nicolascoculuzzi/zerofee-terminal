import {
  type AutoscaleInfo,
  type BarData,
  BarSeries,
  CandlestickSeries,
  createChart,
  type HistogramData,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  LineSeries,
  LineStyle,
  type LogicalRange,
  type MouseEventParams,
  PriceLineSource,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { baseChartOptions, type ChartColors, chartColors, withAlpha } from "../../../lib/chartTheme";
import type { ChartType } from "../tokenUi";
import { lowerBound, padRange, visibleRange } from "./bars";
import { type AxisFormat, minMoveFor } from "./axisFormat";
import { ChartOverlay, type LineSpec, type MarkerGroup, type TimeLineSpec } from "./overlay";

/*
 * Imperative wrapper around one Lightweight Charts instance (DESIGN.md 4.10, 8): the main series
 * (candles, bars or a line), a volume histogram on its own overlay scale in the bottom fifth, an
 * optional moving average and the drawing primitive.
 *
 * View rules (after Axiom and GMGN):
 * - bars keep a fixed default spacing (8 px) with the newest bar `rightOffset` bars from the right edge,
 *   so one or two candles sit small at the right instead of filling the pane;
 * - autoscale never goes thinner than 1% of the price (padRange), so a flat run or a single trade is a
 *   short candle, not a full-height block;
 * - live ticks use series.update() (historical updates with update(bar, true)); setData only for
 *   replacements and older pages, and those keep the visible range anchored to the same bars.
 */

/** One candle in plot units (market cap in the active quote). */
export interface PlotBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Volume in the active quote. */
  volume: number;
}

export interface ControllerEvents {
  onCrosshair(param: MouseEventParams<Time>): void;
  onClick(param: MouseEventParams<Time>): void;
  onSync(): void;
  /** The visible logical range changed (scroll, zoom, resize, new data). */
  onRange(range: LogicalRange | null): void;
}

type MainSeries = ISeriesApi<"Candlestick"> | ISeriesApi<"Bar"> | ISeriesApi<"Line">;

const MA_PERIOD = 20;

/** Default view (px and bars). */
export const VIEW = { barSpacing: 8, minBarSpacing: 1.5, maxBarSpacing: 50, rightOffset: 8 } as const;
/** Price pane margins with and without the volume band. */
const MARGINS_WITH_VOLUME = { top: 0.1, bottom: 0.24 };
const MARGINS_NO_VOLUME = { top: 0.1, bottom: 0.08 };
/** Thinnest autoscale range relative to the price. */
export const MIN_RANGE_REL = 0.01;

interface ViewAnchor {
  from: number;
  to: number;
  count: number;
  following: boolean;
  anchorTime: number;
  anchorIndex: number;
}

export class ChartController {
  readonly chart: IChartApi;
  readonly overlay = new ChartOverlay();
  private main: MainSeries;
  private volume: ISeriesApi<"Histogram">;
  private ma: ISeriesApi<"Line"> | null = null;
  private type: ChartType;
  private bars: PlotBar[] = [];
  private colors: ChartColors;
  private format: AxisFormat;
  private minMove = 0.0001;
  private showVolume = true;
  /** bars[0] is the coin's first candle (history complete), whose open may be a launch outlier. */
  private genesis = false;
  private readonly resize: ResizeObserver;
  private hidden = false;
  private destroyed = false;

  constructor(
    el: HTMLElement,
    type: ChartType,
    format: AxisFormat,
    private readonly events: ControllerEvents,
  ) {
    this.colors = chartColors();
    this.type = type;
    this.format = format;
    const base = baseChartOptions(this.colors);
    this.chart = createChart(el, {
      ...base,
      rightPriceScale: this.priceScaleOptions(),
      timeScale: {
        ...base.timeScale,
        ...VIEW,
        secondsVisible: true,
        shiftVisibleRangeOnNewBar: true,
        lockVisibleTimeRangeOnResize: false,
      },
    });
    this.main = this.createMain(type);
    this.volume = this.chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    this.chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, visible: false });
    this.overlay.onSync = () => this.events.onSync();
    this.overlay.outlineColor = this.colors.fg2;
    this.main.attachPrimitive(this.overlay);
    this.chart.subscribeCrosshairMove(this.events.onCrosshair);
    this.chart.subscribeClick(this.events.onClick);
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(this.onRange);
    // A pane created or kept hidden (0 x 0: a mobile tab, a collapsed split) lays out against nothing;
    // when it shows again, put the newest bars back in view.
    this.resize = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      const hidden = r.width < 1 || r.height < 1;
      if (this.hidden && !hidden && this.bars.length > 0) requestAnimationFrame(() => !this.destroyed && this.resetView());
      this.hidden = hidden;
    });
    this.resize.observe(el);
  }

  private readonly onRange = (range: LogicalRange | null) => this.events.onRange(range);

  private priceScaleOptions() {
    return {
      borderColor: this.colors.line,
      scaleMargins: this.showVolume ? MARGINS_WITH_VOLUME : MARGINS_NO_VOLUME,
      alignLabels: true,
      entireTextOnly: true,
      minimumWidth: 60,
    };
  }

  private priceFormat() {
    return { type: "custom" as const, minMove: this.minMove, formatter: this.format.format, tickmarksFormatter: this.format.tickmarks };
  }

  private readonly autoscale = (base: () => AutoscaleInfo | null): AutoscaleInfo | null => {
    const info = base();
    const range = info?.priceRange;
    if (!info || !range) return info;
    let lo = range.minValue;
    let hi = range.maxValue;
    // The chart opens from the first trade (Axiom): a launch candle that runs 10x in its first second
    // must not flatten everything after it, so its open and wick only count when they are in scale.
    if (this.genesis && this.type !== "line") {
      const r = this.chart.timeScale().getVisibleLogicalRange();
      const trimmed = r ? visibleRange(this.bars, r.from, r.to, true) : null;
      if (trimmed) {
        lo = trimmed.min;
        hi = trimmed.max;
      }
    }
    const { min, max } = padRange(lo, hi, MIN_RANGE_REL);
    return { ...info, priceRange: { minValue: Math.max(0, min), maxValue: max } };
  };

  /** Marks bars[0] as the coin's first candle (complete history). */
  setGenesis(on: boolean): void {
    if (on === this.genesis) return;
    this.genesis = on;
    this.chart.priceScale("right").applyOptions({ autoScale: true });
  }

  private createMain(type: ChartType): MainSeries {
    const c = this.colors;
    const common = {
      priceFormat: this.priceFormat(),
      autoscaleInfoProvider: this.autoscale,
      // Last-value chip and price line in the last bar's colour (DESIGN.md 4.10); one chip only.
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineSource: PriceLineSource.LastBar,
      priceLineWidth: 1 as const,
      priceLineStyle: LineStyle.Dotted,
      priceLineColor: "",
    };
    if (type === "line") {
      return this.chart.addSeries(LineSeries, { ...common, color: c.fg2, lineWidth: 2, crosshairMarkerRadius: 3, priceLineColor: c.fg2 });
    }
    if (type === "bars") {
      return this.chart.addSeries(BarSeries, { ...common, upColor: c.buy, downColor: c.sell, thinBars: false });
    }
    return this.chart.addSeries(CandlestickSeries, {
      ...common,
      upColor: c.buy,
      downColor: c.sell,
      wickUpColor: c.buy,
      wickDownColor: c.sell,
      borderVisible: false,
    });
  }

  get series(): MainSeries {
    return this.main;
  }

  setType(type: ChartType): void {
    if (type === this.type) return;
    this.main.detachPrimitive(this.overlay);
    this.chart.removeSeries(this.main);
    this.type = type;
    this.main = this.createMain(type);
    this.main.attachPrimitive(this.overlay);
    this.writeAll();
  }

  setFormat(format: AxisFormat): void {
    this.format = format;
    this.applyPriceFormat();
  }

  private applyPriceFormat(): void {
    this.main.applyOptions({ priceFormat: this.priceFormat() });
    this.ma?.applyOptions({ priceFormat: this.priceFormat() });
  }

  /** minMove follows the magnitude of the plotted values (float headroom for tick generation). */
  private syncMinMove(): void {
    let max = 0;
    for (const b of this.bars) if (b.high > max) max = b.high;
    const next = minMoveFor(max);
    if (next === this.minMove) return;
    this.minMove = next;
    this.applyPriceFormat();
  }

  applyTheme(timeSeconds: boolean): void {
    this.colors = chartColors();
    const c = this.colors;
    const base = baseChartOptions(c);
    this.chart.applyOptions({
      ...base,
      rightPriceScale: this.priceScaleOptions(),
      timeScale: { ...base.timeScale, secondsVisible: timeSeconds },
    });
    this.overlay.outlineColor = c.fg2;
    if (this.type === "line") this.main.applyOptions({ color: c.fg2, priceLineColor: c.fg2 });
    else this.main.applyOptions({ upColor: c.buy, downColor: c.sell });
    if (this.type === "candles") this.main.applyOptions({ wickUpColor: c.buy, wickDownColor: c.sell });
    this.ma?.applyOptions({ color: c.dim });
    this.writeAll();
  }

  setSecondsVisible(on: boolean): void {
    this.chart.applyOptions({ timeScale: { secondsVisible: on } });
  }

  private toMain(b: PlotBar): BarData<UTCTimestamp> | LineData<UTCTimestamp> {
    const time = b.time as UTCTimestamp;
    if (this.type === "line") return { time, value: b.close };
    return { time, open: b.open, high: b.high, low: b.low, close: b.close };
  }

  private toVolume(b: PlotBar): HistogramData<UTCTimestamp> {
    const c = this.colors;
    const alpha = document.documentElement.dataset.theme === "light" ? 0.32 : 0.3;
    return { time: b.time as UTCTimestamp, value: b.volume, color: withAlpha(b.close >= b.open ? c.buy : c.sell, alpha) };
  }

  private maAt(i: number): LineData<UTCTimestamp> | null {
    if (i < MA_PERIOD - 1) return null;
    let sum = 0;
    for (let j = i - MA_PERIOD + 1; j <= i; j++) sum += this.bars[j]?.close ?? 0;
    const bar = this.bars[i];
    return bar ? { time: bar.time as UTCTimestamp, value: sum / MA_PERIOD } : null;
  }

  private writeMa(): void {
    if (!this.ma) return;
    const points: LineData<UTCTimestamp>[] = [];
    for (let i = 0; i < this.bars.length; i++) {
      const p = this.maAt(i);
      if (p) points.push(p);
    }
    this.ma.setData(points);
  }

  private writeAll(): void {
    // biome-ignore lint/suspicious/noExplicitAny: the main series type varies with the chart type
    (this.main as ISeriesApi<any>).setData(this.bars.map((b) => this.toMain(b)));
    this.volume.setData(this.showVolume ? this.bars.map((b) => this.toVolume(b)) : []);
    this.writeMa();
    this.syncExtents();
  }

  private syncExtents(): void {
    const ext = this.overlay.extents;
    ext.clear();
    for (const b of this.bars) ext.set(b.time, { high: b.high, low: b.low });
  }

  private captureView(): ViewAnchor | null {
    const n = this.bars.length;
    const r = this.chart.timeScale().getVisibleLogicalRange();
    if (!r || n === 0) return null;
    const anchorIndex = Math.min(n - 1, Math.max(0, Math.round(r.from)));
    return {
      from: r.from,
      to: r.to,
      count: n,
      following: r.to >= n - 1 - 0.5,
      anchorTime: (this.bars[anchorIndex] as PlotBar).time,
      anchorIndex,
    };
  }

  private restoreView(v: ViewAnchor): void {
    const n = this.bars.length;
    if (n === 0) return;
    const ts = this.chart.timeScale();
    if (v.following) {
      // Pinned to the newest bar: same width, same gap to the right edge.
      const shift = n - v.count;
      ts.setVisibleLogicalRange({ from: v.from + shift, to: v.to + shift });
      return;
    }
    // Scrolled back: keep the same bar at the left edge (older pages prepend, corrections rewrite).
    const shift = lowerBound(this.bars, v.anchorTime) - v.anchorIndex;
    if (shift !== 0) ts.setVisibleLogicalRange({ from: v.from + shift, to: v.to + shift });
  }

  /** The newest bars at the default spacing, `rightOffset` bars from the right edge. */
  resetView(): void {
    const ts = this.chart.timeScale();
    ts.applyOptions({ barSpacing: VIEW.barSpacing, rightOffset: VIEW.rightOffset });
    ts.scrollToRealTime();
  }

  /**
   * Replaces all bars. `reset`: a new series (snapshot, interval) at the default view; `keep`: the
   * same series re-read (older page, correction, unit change) with the visible bars held in place.
   */
  setBars(bars: PlotBar[], view: "reset" | "keep"): void {
    const anchor = view === "keep" ? this.captureView() : null;
    this.bars = bars;
    this.syncMinMove();
    this.writeAll();
    if (view === "reset") this.resetView();
    else if (anchor) this.restoreView(anchor);
    else if (bars.length > 0) this.resetView();
  }

  /**
   * Live ticks: `bars` is the full new list, `touched` the indices that changed (ascending). The
   * current bucket and new buckets are plain updates; an older bucket (a late trade, the bar after it
   * re-opened at its close) is a historical update.
   */
  applyLive(bars: PlotBar[], touched: readonly number[]): void {
    const prevLast = this.bars[this.bars.length - 1]?.time ?? Number.NEGATIVE_INFINITY;
    const grew = bars.length > this.bars.length;
    this.bars = bars;
    if (grew) this.syncMinMove();
    let last = prevLast;
    let historical = false;
    try {
      for (const i of touched) {
        const bar = bars[i];
        if (!bar) continue;
        const old = bar.time < last;
        historical ||= old;
        // biome-ignore lint/suspicious/noExplicitAny: the main series type varies with the chart type
        (this.main as ISeriesApi<any>).update(this.toMain(bar), old);
        if (this.showVolume) this.volume.update(this.toVolume(bar), old);
        this.overlay.extents.set(bar.time, { high: bar.high, low: bar.low });
        if (bar.time > last) last = bar.time;
      }
    } catch {
      // The series disagreed with our list (should not happen): rewrite it rather than drift.
      const anchor = this.captureView();
      this.writeAll();
      if (anchor) this.restoreView(anchor);
      return;
    }
    if (this.ma) {
      if (historical) this.writeMa();
      else {
        const p = this.maAt(bars.length - 1);
        if (p) this.ma.update(p);
      }
    }
  }

  get barList(): readonly PlotBar[] {
    return this.bars;
  }

  setVolume(on: boolean): void {
    if (on === this.showVolume) return;
    this.showVolume = on;
    this.chart.applyOptions({ rightPriceScale: this.priceScaleOptions() });
    this.volume.setData(on ? this.bars.map((b) => this.toVolume(b)) : []);
  }

  setMovingAverage(on: boolean): void {
    if (on && !this.ma) {
      this.ma = this.chart.addSeries(LineSeries, {
        color: this.colors.dim,
        lineWidth: 1,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
        // The average never widens the price range (the candles decide it).
        autoscaleInfoProvider: () => null,
        priceFormat: this.priceFormat(),
      });
      this.writeMa();
    } else if (!on && this.ma) {
      this.chart.removeSeries(this.ma);
      this.ma = null;
    }
  }

  setLines(lines: LineSpec[]): void {
    this.overlay.lines = lines;
    this.overlay.update();
  }

  setTimeLines(lines: TimeLineSpec[]): void {
    this.overlay.timeLines = lines;
    this.overlay.update();
  }

  setMarkers(groups: MarkerGroup[]): void {
    this.overlay.groups = groups;
    this.overlay.update();
  }

  setOutline(time: number | null): void {
    this.overlay.outline = time;
    this.overlay.update();
  }

  setInteractive(on: boolean): void {
    this.chart.applyOptions({ handleScroll: on, handleScale: on });
  }

  priceToY(price: number): number | null {
    return this.main.priceToCoordinate(price);
  }

  yToPrice(y: number): number | null {
    return this.main.coordinateToPrice(y);
  }

  paneHeight(): number {
    return this.chart.panes()[0]?.getHeight() ?? 0;
  }

  priceScaleWidth(): number {
    return this.chart.priceScale("right").width();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resize.disconnect();
    this.chart.timeScale().unsubscribeVisibleLogicalRangeChange(this.onRange);
    this.chart.unsubscribeCrosshairMove(this.events.onCrosshair);
    this.chart.unsubscribeClick(this.events.onClick);
    this.overlay.onSync = null;
    this.chart.remove();
  }
}
