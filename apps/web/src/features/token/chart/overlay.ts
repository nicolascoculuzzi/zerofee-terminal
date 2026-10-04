import type {
  IChartApiBase,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  PrimitiveHoveredItem,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";

/*
 * One series primitive for everything we draw on the chart (DESIGN.md 4.10): letter and emoji
 * marker bubbles (custom, because built-in markers put text beside the shape), order, alert,
 * average and migration lines with exact dash patterns, their axis chips (with a border, which
 * built-in price-line labels can't draw), and the outline of a clicked candle. `onSync` fires on
 * every repaint so HTML handle chips stay glued to their lines while panning and zooming.
 */

type RenderTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

export interface BarExtent {
  high: number;
  low: number;
}

export interface LineSpec {
  id: string;
  /** In plot units (the series' value: market cap in the quote). */
  price: number;
  color: string;
  /** [] solid; [4, 3] dashed (average entry); [1, 3] dotted (exit, migration); [2, 2] alerts. */
  dash: number[];
  draggable: boolean;
  axis?: { text: string; bg: string; fg: string; border?: string };
}

/** A vertical marker at a bar (the curve-to-pool migration). */
export interface TimeLineSpec {
  id: string;
  /** Bar time, Unix seconds (an existing bar, so the line sits on it). */
  time: number;
  label: string;
  color: string;
  textColor: string;
}

export type MarkerKind = "you" | "dev" | "tracked" | "sniper" | "cluster";

export interface MarkerSpec {
  kind: MarkerKind;
  text: string;
  fill: string;
  textColor: string;
  ring?: string;
  /** Diameter, px: 16 (you, dev, clusters), 14 (tracked), 6 (sniper dots). */
  size: number;
}

export interface MarkerGroup {
  /** Bucket time, Unix seconds. */
  time: number;
  /** Sells sit above the bar, buys below. */
  above: boolean;
  markers: MarkerSpec[];
  /** Hover list for the group. */
  entries: string[];
}

interface Hit {
  x: number;
  y: number;
  r: number;
  group: MarkerGroup;
}

const FONT = '"IBM Plex Sans Variable", ui-sans-serif, system-ui, sans-serif';

export class ChartOverlay implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  lines: LineSpec[] = [];
  timeLines: TimeLineSpec[] = [];
  groups: MarkerGroup[] = [];
  outline: number | null = null;
  extents = new Map<number, BarExtent>();
  hits: Hit[] = [];
  onSync: (() => void) | null = null;
  outlineColor = "#b2b6bc";
  private readonly pane: IPrimitivePaneView;
  private readonly axis: IPrimitivePaneView;
  private readonly paneViewList: readonly IPrimitivePaneView[];
  private readonly axisViewList: readonly IPrimitivePaneView[];

  constructor() {
    this.pane = { zOrder: () => "top", renderer: () => ({ draw: (t) => this.drawPane(t) }) };
    this.axis = { zOrder: () => "top", renderer: () => ({ draw: (t) => this.drawAxis(t) }) };
    this.paneViewList = [this.pane];
    this.axisViewList = [this.axis];
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  updateAllViews(): void {
    this.onSync?.();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.paneViewList;
  }

  priceAxisPaneViews(): readonly IPrimitivePaneView[] {
    return this.axisViewList;
  }

  update(): void {
    this.requestUpdate?.();
  }

  priceToY(price: number): number | null {
    return this.series?.priceToCoordinate(price) ?? null;
  }

  /** Nearest draggable line within 4 px (an 8 px hit area), for the ns-resize cursor and drags. */
  lineAt(y: number): LineSpec | null {
    let best: LineSpec | null = null;
    let bestD = 5;
    for (const l of this.lines) {
      if (!l.draggable) continue;
      const ly = this.priceToY(l.price);
      if (ly === null) continue;
      const d = Math.abs(ly - y);
      if (d < bestD) {
        best = l;
        bestD = d;
      }
    }
    return best;
  }

  markerAt(x: number, y: number): MarkerGroup | null {
    for (const h of this.hits) {
      if ((h.x - x) ** 2 + (h.y - y) ** 2 <= (h.r + 2) ** 2) return h.group;
    }
    return null;
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    const line = this.lineAt(y);
    if (line) return { externalId: line.id, zOrder: "top", cursorStyle: "ns-resize", hitTestPriority: 1 };
    const group = this.markerAt(x, y);
    if (group) return { externalId: `marker:${group.time}`, zOrder: "top", itemType: "marker", hitTestPriority: 2 };
    return null;
  }

  private drawPane(target: RenderTarget): void {
    const series = this.series;
    const chart = this.chart;
    if (!series || !chart) return;
    // biome-ignore lint/correctness/useHookAtTopLevel: fancy-canvas rendering scope, not a React hook
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
      for (const l of this.lines) {
        const y = series.priceToCoordinate(l.price);
        if (y === null) continue;
        const width = Math.max(1, Math.floor(vpr));
        const yb = Math.round(y * vpr) + (width % 2 ? 0.5 : 0);
        ctx.save();
        ctx.strokeStyle = l.color;
        ctx.lineWidth = width;
        ctx.setLineDash(l.dash.map((d) => d * hpr));
        ctx.beginPath();
        ctx.moveTo(0, yb);
        ctx.lineTo(bitmapSize.width, yb);
        ctx.stroke();
        ctx.restore();
      }
    });
    // biome-ignore lint/correctness/useHookAtTopLevel: fancy-canvas rendering scope, not a React hook
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
      const ts = chart.timeScale();
      for (const l of this.timeLines) {
        const x = ts.timeToCoordinate(l.time as Time);
        if (x === null) continue;
        const width = Math.max(1, Math.floor(hpr));
        const xb = Math.round(x * hpr) + (width % 2 ? 0.5 : 0);
        ctx.save();
        ctx.strokeStyle = l.color;
        ctx.lineWidth = width;
        ctx.setLineDash([1 * vpr, 3 * vpr]);
        ctx.beginPath();
        ctx.moveTo(xb, 0);
        ctx.lineTo(xb, bitmapSize.height);
        ctx.stroke();
        ctx.restore();
      }
    });
    // biome-ignore lint/correctness/useHookAtTopLevel: fancy-canvas rendering scope, not a React hook
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const ts = chart.timeScale();
      for (const l of this.timeLines) {
        const x = ts.timeToCoordinate(l.time as Time);
        if (x === null) continue;
        ctx.save();
        ctx.font = `500 10px ${FONT}`;
        ctx.textBaseline = "top";
        const w = ctx.measureText(l.label).width;
        const left = Math.min(Math.round(x) + 4, mediaSize.width - w - 4);
        ctx.fillStyle = l.textColor;
        // Under the legend rows.
        ctx.fillText(l.label, left, 44);
        ctx.restore();
      }
      if (this.outline !== null) {
        const x = ts.timeToCoordinate(this.outline as Time);
        const bar = this.extents.get(this.outline);
        if (x !== null && bar) {
          const top = series.priceToCoordinate(bar.high);
          const bottom = series.priceToCoordinate(bar.low);
          if (top !== null && bottom !== null) {
            const half = Math.max(3, ts.options().barSpacing * 0.45);
            ctx.save();
            ctx.strokeStyle = this.outlineColor;
            ctx.lineWidth = 1;
            ctx.strokeRect(Math.round(x - half) + 0.5, Math.round(top - 3) + 0.5, Math.round(half * 2), Math.round(bottom - top + 6));
            ctx.restore();
          }
        }
      }
      const hits: Hit[] = [];
      for (const g of this.groups) {
        const x = ts.timeToCoordinate(g.time as Time);
        const bar = this.extents.get(g.time);
        if (x === null || !bar) continue;
        const edge = series.priceToCoordinate(g.above ? bar.high : bar.low);
        if (edge === null) continue;
        let offset = 2;
        for (const m of g.markers) {
          const r = m.size / 2;
          const y = g.above ? edge - offset - r : edge + offset + r;
          offset += m.size + 2;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle = m.fill;
          ctx.fill();
          if (m.ring) {
            ctx.lineWidth = 2;
            ctx.strokeStyle = m.ring;
            ctx.stroke();
          }
          if (m.text) {
            ctx.fillStyle = m.textColor;
            ctx.font = `600 10px ${FONT}`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(m.text, x, y + 0.5);
          }
          hits.push({ x, y, r, group: g });
        }
      }
      this.hits = hits;
    });
  }

  private drawAxis(target: RenderTarget): void {
    const series = this.series;
    if (!series) return;
    // biome-ignore lint/correctness/useHookAtTopLevel: fancy-canvas rendering scope, not a React hook
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      for (const l of this.lines) {
        if (!l.axis) continue;
        const y = series.priceToCoordinate(l.price);
        if (y === null || y < 0 || y > mediaSize.height) continue;
        const h = 18;
        const top = Math.round(y - h / 2);
        ctx.save();
        ctx.fillStyle = l.axis.bg;
        ctx.beginPath();
        ctx.roundRect(1, top, mediaSize.width - 2, h, 2);
        ctx.fill();
        if (l.axis.border) {
          ctx.strokeStyle = l.axis.border;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(1.5, top + 0.5, mediaSize.width - 3, h - 1, 2);
          ctx.stroke();
        }
        ctx.fillStyle = l.axis.fg;
        ctx.font = `600 11px ${FONT}`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(l.axis.text, 6, top + h / 2 + 0.5, mediaSize.width - 10);
        ctx.restore();
      }
    });
  }
}
