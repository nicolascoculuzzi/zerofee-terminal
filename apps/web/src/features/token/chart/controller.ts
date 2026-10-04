import {
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
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { baseChartOptions, type ChartColors, chartColors, withAlpha } from "../../../lib/chartTheme";
import type { ChartType } from "../tokenUi";
import { ChartOverlay, type LineSpec, type MarkerGroup } from "./overlay";

/*
 * Imperative wrapper around one Lightweight Charts instance (DESIGN.md 4.10, 8): the main series
 * (candles, bars or a 1.5 px line), an overlay volume histogram, an optional moving average and
 * the drawing primitive. Ticks use series.update(), never setData() per tick.
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
}

type MainSeries = ISeriesApi<"Candlestick"> | ISeriesApi<"Bar"> | ISeriesApi<"Line">;

const MA_PERIOD = 20;

export class ChartController {
  readonly chart: IChartApi;
  readonly overlay = new ChartOverlay();
  private main: MainSeries;
  private volume: ISeriesApi<"Histogram">;
  private ma: ISeriesApi<"Line"> | null = null;
  private type: ChartType;
  private bars: PlotBar[] = [];
  private colors: ChartColors;
  private formatter: (v: number) => string;
  private showVolume = true;

  constructor(
    el: HTMLElement,
    type: ChartType,
    formatter: (v: number) => string,
    private readonly events: ControllerEvents,
  ) {
    this.colors = chartColors();
    this.type = type;
    this.formatter = formatter;
    const base = baseChartOptions(this.colors);
    this.chart = createChart(el, {
      ...base,
      rightPriceScale: { borderColor: this.colors.line, scaleMargins: { top: 0.12, bottom: 0.24 } },
      timeScale: { ...base.timeScale, rightOffset: 6, barSpacing: 7, secondsVisible: true },
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
  }

  private createMain(type: ChartType): MainSeries {
    const c = this.colors;
    const priceFormat = { type: "custom" as const, minMove: 0.0001, formatter: this.formatter };
    const common = { priceFormat, priceLineColor: c.dim, priceLineStyle: LineStyle.Dotted };
    if (type === "line") {
      return this.chart.addSeries(LineSeries, { ...common, color: c.fg2, lineWidth: 2, crosshairMarkerRadius: 3 });
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

  setFormatter(formatter: (v: number) => string): void {
    this.formatter = formatter;
    this.main.applyOptions({ priceFormat: { type: "custom", minMove: 0.0001, formatter } });
  }

  applyTheme(timeSeconds: boolean): void {
    this.colors = chartColors();
    const c = this.colors;
    const base = baseChartOptions(c);
    this.chart.applyOptions({
      ...base,
      rightPriceScale: { borderColor: c.line, scaleMargins: { top: 0.12, bottom: 0.24 } },
      timeScale: { ...base.timeScale, secondsVisible: timeSeconds },
    });
    this.overlay.outlineColor = c.fg2;
    if (this.type === "line") this.main.applyOptions({ color: c.fg2, priceLineColor: c.dim });
    else this.main.applyOptions({ upColor: c.buy, downColor: c.sell, priceLineColor: c.dim });
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
    const alpha = document.documentElement.dataset.theme === "light" ? 0.3 : 0.35;
    return { time: b.time as UTCTimestamp, value: b.volume, color: withAlpha(b.close >= b.open ? c.buy : c.sell, alpha) };
  }

  private maAt(i: number): LineData<UTCTimestamp> | null {
    if (i < MA_PERIOD - 1) return null;
    let sum = 0;
    for (let j = i - MA_PERIOD + 1; j <= i; j++) sum += this.bars[j]?.close ?? 0;
    const bar = this.bars[i];
    return bar ? { time: bar.time as UTCTimestamp, value: sum / MA_PERIOD } : null;
  }

  private writeAll(): void {
    // biome-ignore lint/suspicious/noExplicitAny: the main series type varies with the chart type
    (this.main as ISeriesApi<any>).setData(this.bars.map((b) => this.toMain(b)));
    this.volume.setData(this.showVolume ? this.bars.map((b) => this.toVolume(b)) : []);
    if (this.ma) {
      const points: LineData<UTCTimestamp>[] = [];
      for (let i = 0; i < this.bars.length; i++) {
        const p = this.maAt(i);
        if (p) points.push(p);
      }
      this.ma.setData(points);
    }
    this.syncExtents();
  }

  private syncExtents(): void {
    const ext = this.overlay.extents;
    ext.clear();
    for (const b of this.bars) ext.set(b.time, { high: b.high, low: b.low });
  }

  /** Replaces all bars (snapshot, timeframe or unit change). */
  setBars(bars: PlotBar[]): void {
    this.bars = bars;
    this.writeAll();
  }

  /** Applies one live bar: updates the last bucket or appends a new one. */
  upsert(bar: PlotBar): void {
    const last = this.bars[this.bars.length - 1];
    if (last && bar.time < last.time) {
      const i = this.bars.findIndex((b) => b.time === bar.time);
      if (i >= 0) {
        this.bars[i] = bar;
        this.overlay.extents.set(bar.time, { high: bar.high, low: bar.low });
      }
      return;
    }
    if (last && last.time === bar.time) this.bars[this.bars.length - 1] = bar;
    else this.bars.push(bar);
    this.overlay.extents.set(bar.time, { high: bar.high, low: bar.low });
    // biome-ignore lint/suspicious/noExplicitAny: the main series type varies with the chart type
    (this.main as ISeriesApi<any>).update(this.toMain(bar));
    if (this.showVolume) this.volume.update(this.toVolume(bar));
    if (this.ma) {
      const p = this.maAt(this.bars.length - 1);
      if (p) this.ma.update(p);
    }
  }

  get barList(): readonly PlotBar[] {
    return this.bars;
  }

  setVolume(on: boolean): void {
    if (on === this.showVolume) return;
    this.showVolume = on;
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
        priceFormat: { type: "custom", minMove: 0.0001, formatter: this.formatter },
      });
      this.writeAll();
    } else if (!on && this.ma) {
      this.chart.removeSeries(this.ma);
      this.ma = null;
    }
  }

  setLines(lines: LineSpec[]): void {
    this.overlay.lines = lines;
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

  showRecent(count = 110): void {
    const n = this.bars.length;
    if (n > 0) this.chart.timeScale().setVisibleLogicalRange({ from: Math.max(-2, n - count), to: n + 6 });
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
    this.chart.unsubscribeCrosshairMove(this.events.onCrosshair);
    this.chart.unsubscribeClick(this.events.onClick);
    this.overlay.onSync = null;
    this.chart.remove();
  }
}
