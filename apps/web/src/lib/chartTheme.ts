import { type ChartOptions, ColorType, CrosshairMode, type DeepPartial, LineStyle } from "lightweight-charts";
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
  violet: string;
}

/** Reads the live palette from the CSS variables, so charts follow the theme. */
export function chartColors(): ChartColors {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    bg: v("--zf-chart-bg", "#0b0d10"),
    grid: v("--zf-chart-grid", "#14181e"),
    text: v("--zf-muted", "#9aa2af"),
    line: v("--zf-line-strong", "#2a3039"),
    fg: v("--zf-fg", "#e8eaee"),
    dim: v("--zf-dim", "#626a77"),
    buy: v("--zf-buy", "#1fc98c"),
    sell: v("--zf-sell", "#f2526f"),
    accent: v("--zf-accent", "#ff8a3d"),
    warn: v("--zf-warn", "#f3c04f"),
    info: v("--zf-info", "#5aa6ff"),
    violet: v("--zf-violet", "#b18cff"),
  };
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
    timeScale: { borderColor: c.line, timeVisible: true, secondsVisible: false },
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
