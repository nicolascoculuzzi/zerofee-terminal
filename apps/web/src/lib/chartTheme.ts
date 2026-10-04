import { type ChartOptions, ColorType, CrosshairMode, type DeepPartial, LineStyle, TickMarkType, type Time } from "lightweight-charts";
import { useSettings } from "../state/settings";

/** Chart palette (DESIGN.md 2.1 "Chart tokens"), read live from the CSS variables. */
export interface ChartColors {
  bg: string;
  grid: string;
  /** Axis labels and crosshair (text-3). */
  text: string;
  /** Axis borders (hairline). */
  line: string;
  fg: string;
  fg2: string;
  dim: string;
  buy: string;
  sell: string;
  warn: string;
  info: string;
  /** Crosshair label chips. */
  chip: string;
}

export function chartColors(): ChartColors {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    bg: v("--zf-surface-1", "#0f1113"),
    grid: v("--zf-chart-grid", "#16181b"),
    text: v("--zf-text-3", "#858a90"),
    line: v("--zf-hairline", "#232529"),
    fg: v("--zf-text-1", "#e9ebee"),
    fg2: v("--zf-text-2", "#b2b6bc"),
    dim: v("--zf-text-3", "#858a90"),
    buy: v("--zf-buy", "#3dca8d"),
    sell: v("--zf-sell", "#fa6b6d"),
    warn: v("--zf-warn", "#f3b743"),
    info: v("--zf-info", "#73b0ee"),
    chip: v("--zf-surface-3", "#1e2124"),
  };
}

/** `color` at `alpha` (0..1) as an rgba() string, for volume bars and fills (canvas has no color-mix). */
export function withAlpha(color: string, alpha: number): string {
  const hex = color.trim().replace("#", "");
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    const n = Number.parseInt(hex, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  return color;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Charts show local time, like every table and toast in the app (the library defaults to UTC). */
function localTime(time: Time): string {
  const d = new Date((time as number) * 1000);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function localTick(time: Time, type: TickMarkType): string {
  const d = new Date((time as number) * 1000);
  switch (type) {
    case TickMarkType.Year:
      return String(d.getFullYear());
    case TickMarkType.Month:
      return d.toLocaleDateString("en-US", { month: "short" });
    case TickMarkType.DayOfMonth:
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    case TickMarkType.Time:
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    case TickMarkType.TimeWithSeconds:
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
}

/**
 * Base options for every Lightweight Charts instance (DESIGN.md 4.10): surface-1 canvas, quiet
 * grid, 11px Plex Sans axis text in text-3, dashed crosshair with surface-3 label chips.
 * `attributionLogo` stays on: it is the link to tradingview.com that the Apache-2.0 NOTICE
 * requires (see apps/web/NOTICE).
 */
export function baseChartOptions(c: ChartColors): DeepPartial<ChartOptions> {
  return {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: c.bg },
      textColor: c.text,
      fontSize: 11,
      fontFamily: '"IBM Plex Sans Variable", ui-sans-serif, system-ui, sans-serif',
      attributionLogo: true,
      panes: { separatorColor: c.line, separatorHoverColor: c.line, enableResize: true },
    },
    grid: {
      vertLines: { color: c.grid },
      horzLines: { color: c.grid },
    },
    rightPriceScale: { borderColor: c.line },
    timeScale: { borderColor: c.line, timeVisible: true, secondsVisible: false, tickMarkFormatter: localTick },
    localization: { timeFormatter: localTime },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: c.dim, width: 1, style: LineStyle.Dashed, labelBackgroundColor: c.chip },
      horzLine: { color: c.dim, width: 1, style: LineStyle.Dashed, labelBackgroundColor: c.chip },
    },
  };
}

/** Changes whenever the theme or palette changes; use it as an effect dependency to re-apply colours. */
export function useChartThemeKey(): string {
  const theme = useSettings((s) => s.display.theme);
  const cvd = useSettings((s) => s.display.cvd);
  return `${theme}:${cvd}`;
}
