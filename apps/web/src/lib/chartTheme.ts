import { type ChartOptions, ColorType, CrosshairMode, type DeepPartial, LineStyle, TickMarkType, type Time } from "lightweight-charts";
import { useSettings } from "../state/settings";

export interface ChartColors {
  bg: string;
  grid: string;
  text: string;
  line: string;
  fg: string;
  dim: string;
  buy: string;
  sell: string;
  accent: string;
  warn: string;
  info: string;
}

/** Reads the live palette from the CSS variables, so charts follow the theme. */
export function chartColors(): ChartColors {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    bg: v("--zf-chart-bg", "#0a0b0d"),
    grid: v("--zf-chart-grid", "#15171b"),
    text: v("--zf-muted", "#959ba6"),
    line: v("--zf-line-strong", "#2b2f36"),
    fg: v("--zf-fg", "#e3e5e8"),
    dim: v("--zf-dim", "#5e6570"),
    buy: v("--zf-buy", "#24b47e"),
    sell: v("--zf-sell", "#ec5b6b"),
    accent: v("--zf-accent", "#f08537"),
    warn: v("--zf-warn", "#dfac3c"),
    info: v("--zf-info", "#5a93ec"),
  };
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
 * Base options for every Lightweight Charts instance. `attributionLogo` stays on: it is the
 * link to tradingview.com that the Apache-2.0 NOTICE requires (see apps/web/NOTICE).
 */
export function baseChartOptions(c: ChartColors): DeepPartial<ChartOptions> {
  return {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: c.bg },
      textColor: c.text,
      fontSize: 11,
      fontFamily: getComputedStyle(document.body).fontFamily,
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
      vertLine: { color: c.dim, style: LineStyle.Dashed, labelBackgroundColor: c.line },
      horzLine: { color: c.dim, style: LineStyle.Dashed, labelBackgroundColor: c.line },
    },
  };
}

/** Changes whenever the theme changes; use it as an effect dependency to re-apply colours. */
export function useChartThemeKey(): string {
  return useSettings((s) => s.display.theme);
}
