import type { LogicalRange, MouseEventParams, Time } from "lightweight-charts";
import { X } from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { Hotkey } from "../../components/ui/controls";
import { PlatformMark } from "../../components/ui/Logo";
import { type PlatformLogo, VENUE_LOGO } from "../../components/ui/logos";
import { MenuItem, Popover } from "../../components/ui/Popover";
import { chartColors, useChartThemeKey, withAlpha } from "../../lib/chartTheme";
import { cn } from "../../lib/cn";
import { fmtClock, fmtPct, fmtSol, fmtSolShort, fmtUsd } from "../../lib/format";
import { type Candle, TIMEFRAME_SECONDS, type Timeframe, type TokenDetail, type Venue } from "../../protocol";
import { isOpenOrder, useOrders } from "../../state/orders";
import { useSettings } from "../../state/settings";
import { useToken } from "../../state/token";
import { useTrackedMap } from "../../state/trackers";
import { useActivePosition } from "../../state/wallet";
import { armLimitDraft } from "../trade/orderDraft";
import { distancePct, migrationPriceSol, nudgePrice, snapPrice } from "../trade/tradeMath";
import { useCancelDialog } from "./CancelOrderDialog";
import { AxisFormat, type LegendParts } from "./chart/axisFormat";
import { bucketStart, defaultTimeframe, lowerBound } from "./chart/bars";
import { ChartStateOverlay } from "./chart/ChartStateOverlay";
import { ChartToolbar } from "./chart/ChartToolbar";
import { ChartController, type PlotBar } from "./chart/controller";
import { crosshair } from "./chart/crosshair";
import { type BarChange, ChartFeed, type FeedStatus, type HistoryInfo, historyStateOf } from "./chart/dataSource";
import type { LineSpec, MarkerGroup, MarkerSpec, TimeLineSpec } from "./chart/overlay";
import { useQuote } from "./money";
import { KIND_SHORT, sizeText, triggerPriceSol } from "./orderText";
import { useTokenUi } from "./tokenUi";

/*
 * Token chart (DESIGN.md 4.10), Lightweight Charts v5 in its own lazy chunk with the attribution
 * logo on (Apache-2.0 NOTICE). The series plots market cap in the global quote; Price mode only
 * swaps the axis formatter (value / supply), so tiny prices never hit float limits.
 * Labelled order line after Kraken Pro https://mobbin.com/screens/5bdd6cb2-5040-44c4-8781-c70f3aea60a8;
 * an "Entry" label on a dashed line after Phantom https://mobbin.com/screens/c5d3a411-f5d2-4618-bfb4-0eb2abcbf5d4;
 * a compact chart tooltip with tabular values after Railway https://mobbin.com/screens/14f51fd0-7ad0-4c59-a44c-9f35b2056107
 */

const VENUE_LEGEND: Record<Venue, string> = {
  pump_curve: "pump curve",
  pumpswap: "PumpSwap",
  launchlab: "LaunchLab curve",
  raydium_cpmm: "Raydium CPMM",
  meteora_dbc: "Meteora DBC",
  meteora_damm_v2: "Meteora DAMM",
  other: "pool",
};

type Tone = "buy" | "sell" | "fg" | "fg2" | "dim";

interface LineModel {
  id: string;
  priceSol: number;
  tone: Tone;
  dash: number[];
  axis: "filled" | "avg" | "exit" | "alert" | null;
  axisPrefix?: string;
  chip: null | { label: string; draft: boolean; draggable: boolean; removable: boolean; removeLabel: string };
  onMove?: (priceSol: number) => void;
  onRemove?: () => void;
  onArm?: () => void;
}

interface LegendData {
  o: number;
  h: number;
  l: number;
  c: number;
  changePct: number;
  volume: number;
}

const CHIP_BORDER: Record<Tone, string> = {
  buy: "border-buy",
  sell: "border-sell",
  fg: "border-fg-1",
  fg2: "border-fg-2",
  dim: "border-fg-3",
};

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Legend value: plain text, or subscript-zero parts as spans (DESIGN.md 3.3: no Unicode subscripts in the DOM). */
function LegendValue({ v }: { v: LegendParts }) {
  const p = v.parts;
  if (p.kind === "plain") return <span className="zf-num">{`${v.prefix}${p.text}`}</span>;
  return (
    <span className="zf-num">
      {v.prefix}0.0
      <span className="zf-zc" aria-hidden="true">
        {p.zeros}
      </span>
      {p.digits}
    </span>
  );
}

function Legend({
  register,
  symbol,
  pair,
  venue,
  venueLogo,
  tf,
  format,
  quote,
}: {
  register: (set: (d: LegendData | null) => void) => void;
  symbol: string;
  pair: string;
  venue: string;
  venueLogo: PlatformLogo | null;
  tf: string;
  format: AxisFormat;
  quote: "USD" | "SOL";
}) {
  const [d, setD] = useState<LegendData | null>(null);
  useEffect(() => register(setD), [register]);
  const usd = quote === "USD";
  const value = (v: number): ReactNode => <LegendValue v={format.legend(v)} />;
  return (
    <div className="pointer-events-none absolute top-2 left-2 z-chart-ui flex max-w-[calc(100%-96px)] flex-wrap items-center gap-x-2 gap-y-0.5 text-label">
      <span className="inline-flex items-center gap-1 text-fg-3">
        {symbol}/{pair} ·{venueLogo && <PlatformMark logo={venueLogo} size={12} label="" />}
        {venue} · {tf}
      </span>
      {d && (
        <>
          <span className="text-fg-3">
            O <span className="text-fg-1">{value(d.o)}</span> H <span className="text-fg-1">{value(d.h)}</span> L{" "}
            <span className="text-fg-1">{value(d.l)}</span> C <span className="text-fg-1">{value(d.c)}</span>
          </span>
          <span className={cn("zf-num", d.changePct > 0 ? "text-buy" : d.changePct < 0 ? "text-sell" : "text-fg-3")}>
            {fmtPct(d.changePct, { signed: true })}
          </span>
          <span className="text-fg-3">
            V <span className="zf-num text-fg-2">{usd ? fmtUsd(d.volume) : `${fmtSol(d.volume)} SOL`}</span>
          </span>
        </>
      )}
    </div>
  );
}

/** The interval each token was last viewed at this session (a manual pick sticks to its token). */
const tfByMint = new Map<string, Timeframe>();

/** Bars from the left edge at which the next older page is requested. */
const OLDER_PAGE_EDGE = 40;

export default function TokenChart({ detail, variant = "full" }: { detail: TokenDetail; variant?: "full" | "compact" }) {
  const token = detail.summary;
  const mint = token.mint;
  const supply = token.supply;
  const full = variant === "full";
  const ui = useTokenUi(
    useShallow((s) => ({
      tf: s.tf,
      mode: s.mode,
      chartType: s.chartType,
      volume: s.volume,
      movingAverage: s.movingAverage,
      markers: s.markers,
      candle: s.candle,
      side: s.side,
      orderType: s.orderType,
      limitPriceSol: s.limitPriceSol,
      buySol: s.buySol,
      sellPct: s.sellPct,
      ladder: s.ladder,
      alerts: s.alerts,
      maximized: s.maximized,
    })),
  );
  const quickBuy = useSettings((s) => s.quickBuySol);
  const alertKey = useSettings((s) => s.hotkeys["token.alert"]?.[0]);
  const { quote, solUsd } = useQuote();
  const themeKey = useChartThemeKey();
  const position = useActivePosition(mint);
  const trades = useToken((s) => s.trades);
  const tracked = useTrackedMap();
  const ordersById = useOrders((s) => s.byId);

  const containerRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<ChartController | null>(null);
  const feedRef = useRef<ChartFeed | null>(null);
  const legendSet = useRef<((d: LegendData | null) => void) | null>(null);
  const hoveringRef = useRef(false);
  const chipEls = useRef(new Map<string, HTMLDivElement>());
  const modelsRef = useRef<LineModel[]>([]);
  const dragRef = useRef<{ id: string; startPriceSol: number; startY: number; moved: boolean } | null>(null);
  const justDragged = useRef(0);
  const [dragging, setDragging] = useState<string | null>(null);
  const [status, setStatus] = useState<FeedStatus>("loading");
  const [history, setHistory] = useState<HistoryInfo>({ loading: false, hasMore: false, state: "unknown" });
  /** Bumped when bars are replaced or a bucket is added (markers and the migration line follow). */
  const [barsVersion, setBarsVersion] = useState(0);
  const [retry, setRetry] = useState(0);
  const [hover, setHover] = useState<{ x: number; y: number; entries: string[] } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; priceSol: number } | null>(null);
  const menuAnchor = useRef<HTMLDivElement>(null);
  const [colors, setColors] = useState(() => chartColors());

  const fx = quote === "USD" ? solUsd : 1;
  const plot = useCallback((priceSol: number) => priceSol * supply * fx, [supply, fx]);
  const fromPlot = useCallback((v: number) => v / (supply * fx), [supply, fx]);
  const axis = useMemo(() => new AxisFormat(ui.mode, quote, supply), [ui.mode, quote, supply]);
  const format = axis.format;
  const historyState = historyStateOf(detail.summary);

  // Interval by coin age when a token opens (Axiom): seconds for fresh launches, minutes for older
  // coins. A manual pick sticks to its token for the session. Runs before the first subscription.
  useLayoutEffect(() => {
    const s = useTokenUi.getState();
    const next = tfByMint.get(mint) ?? defaultTimeframe(token.createdAt, Date.now(), s.tf);
    tfByMint.set(mint, next);
    if (next !== s.tf) s.setTf(next);
    return useTokenUi.subscribe((st, prev) => {
      if (st.tf !== prev.tf) tfByMint.set(mint, st.tf);
    });
  }, [mint, token.createdAt]);

  const toPlot = useCallback(
    (c: Candle): PlotBar => {
      const f = quote === "USD" ? c.solUsd : 1;
      return {
        time: c.time,
        open: c.open * supply * f,
        high: c.high * supply * f,
        low: c.low * supply * f,
        close: c.close * supply * f,
        volume: c.volumeSol * f,
      };
    },
    [quote, supply],
  );

  // Latest values for imperative callbacks.
  const live = useRef({ tf: ui.tf, toPlot, fromPlot, plot, markers: ui.markers, candle: ui.candle, current: token.priceSol, full });
  live.current = { tf: ui.tf, toPlot, fromPlot, plot, markers: ui.markers, candle: ui.candle, current: token.priceSol, full };

  const registerLegend = useCallback((set: (d: LegendData | null) => void) => {
    legendSet.current = set;
  }, []);

  const pushLegend = useCallback((bar: PlotBar | null) => {
    legendSet.current?.(
      bar
        ? {
            o: bar.open,
            h: bar.high,
            l: bar.low,
            c: bar.close,
            changePct: bar.open > 0 ? (bar.close / bar.open - 1) * 100 : 0,
            volume: bar.volume,
          }
        : null,
    );
  }, []);

  const lastLegend = useCallback(() => {
    const bars = ctrlRef.current?.barList;
    pushLegend(bars && bars.length > 0 ? (bars[bars.length - 1] ?? null) : null);
  }, [pushLegend]);

  /** Glues the HTML handle chips to their lines on every chart repaint. */
  const syncChips = useCallback(() => {
    const ctrl = ctrlRef.current;
    if (!ctrl) return;
    const height = ctrl.paneHeight();
    for (const m of modelsRef.current) {
      const el = chipEls.current.get(m.id);
      if (!el) continue;
      const y = ctrl.priceToY(live.current.plot(m.priceSol));
      if (y === null || y < 10 || y > height - 10) {
        el.style.visibility = "hidden";
      } else {
        el.style.visibility = "visible";
        el.style.transform = `translate3d(0, ${Math.round(y - 10)}px, 0)`;
      }
    }
  }, []);

  // ---- create the chart (once per token) ----
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let raf = 0;
    let pending: MouseEventParams<Time> | null = null;
    const ctrl = new ChartController(
      el,
      useTokenUi.getState().chartType,
      new AxisFormat(useTokenUi.getState().mode, useSettings.getState().display.quote, supply),
      {
        onCrosshair: (param) => {
          pending = param;
          if (raf) return;
          raf = requestAnimationFrame(() => {
            raf = 0;
            const p = pending;
            if (!p) return;
            const c = ctrlRef.current;
            if (!c) return;
            if (p.time === undefined || !p.point) {
              hoveringRef.current = false;
              crosshair.priceSol = null;
              setHover(null);
              lastLegend();
              return;
            }
            hoveringRef.current = true;
            const price = c.yToPrice(p.point.y);
            crosshair.priceSol = price === null ? null : live.current.fromPlot(price);
            const bar = c.barList.find((b) => b.time === (p.time as number)) ?? null;
            pushLegend(bar);
            const group = c.overlay.markerAt(p.point.x, p.point.y);
            setHover(group ? { x: p.point.x, y: p.point.y, entries: group.entries } : null);
          });
        },
        onClick: (param) => {
          if (!live.current.full || Date.now() - justDragged.current < 350) return;
          if (!live.current.markers.candleClick || param.time === undefined || !param.point) return;
          const t = param.time as number;
          const ui0 = useTokenUi.getState();
          if (ui0.candle?.from === t) ui0.setCandle(null);
          else ui0.setCandle({ from: t, to: t + TIMEFRAME_SECONDS[live.current.tf] });
        },
        onSync: () => syncChips(),
        onRange: (range: LogicalRange | null) => {
          // Near the oldest loaded bar: fetch the page before it (a no-op while one is in flight).
          if (range && range.from < OLDER_PAGE_EDGE) feedRef.current?.requestOlder();
        },
      },
    );
    ctrlRef.current = ctrl;
    return () => {
      cancelAnimationFrame(raf);
      crosshair.priceSol = null;
      ctrl.destroy();
      ctrlRef.current = null;
    };
    // The chart is created once per token; later option changes are applied by the effects below.
  }, [supply, lastLegend, pushLegend, syncChips]);

  // ---- candles: snapshot, live deltas (batched per frame), older pages (chart/dataSource.ts) ----
  const historyRef = useRef(historyState);
  historyRef.current = historyState;
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry is a trigger for resubscribing
  useEffect(() => {
    const ctrl = ctrlRef.current;
    if (!ctrl) return;
    // The age-based interval is being applied: wait for the render that carries it.
    if (useTokenUi.getState().tf !== ui.tf) return;
    ctrl.setSecondsVisible(ui.tf === "1s" || ui.tf === "15s");
    ctrl.setBars([], "reset");
    pushLegend(null);
    let lastLength = 0;
    const feed = new ChartFeed(mint, ui.tf, {
      onBars: (bars: readonly Candle[], change: BarChange) => {
        const c = ctrlRef.current;
        if (!c) return;
        const toPlot = live.current.toPlot;
        if (change.kind === "live") {
          // Same indices as before (no insertions): convert only what changed.
          const next = c.barList.slice();
          for (const i of change.touched) {
            const b = bars[i];
            if (b) next[i] = toPlot(b);
          }
          c.applyLive(next, change.touched);
        } else {
          c.setBars(bars.map(toPlot), change.kind);
        }
        if (!hoveringRef.current) lastLegend();
        if (change.kind !== "live" || bars.length !== lastLength) {
          lastLength = bars.length;
          setBarsVersion((v) => v + 1);
        }
      },
      onStatus: setStatus,
      onHistory: setHistory,
    });
    feedRef.current = feed;
    feed.setHistoryState(historyRef.current);
    feed.start();
    return () => {
      feed.stop();
      if (feedRef.current === feed) feedRef.current = null;
    };
  }, [mint, ui.tf, retry, pushLegend, lastLegend]);

  useEffect(() => {
    feedRef.current?.setHistoryState(historyState);
  }, [historyState]);

  // With the whole history loaded, bars[0] is the launch candle (its open can be a 10x outlier).
  useEffect(() => {
    ctrlRef.current?.setGenesis(!history.hasMore && !history.loading && history.state !== "backfilling");
  }, [history]);

  // ---- units: MC/Price only changes the axis text; USD/SOL re-plots the same bars in place ----
  useEffect(() => {
    ctrlRef.current?.setFormat(axis);
  }, [axis]);
  useEffect(() => {
    const ctrl = ctrlRef.current;
    const feed = feedRef.current;
    if (!ctrl || !feed || feed.list.length === 0) return;
    ctrl.setBars(feed.list.map(toPlot), "keep");
    lastLegend();
  }, [toPlot, lastLegend]);

  // Theme or palette changed: re-read the tokens a frame later (App writes data-theme in its own effect).
  // biome-ignore lint/correctness/useExhaustiveDependencies: themeKey is a trigger; colours are re-read from the CSS variables
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const tf = useTokenUi.getState().tf;
      ctrlRef.current?.applyTheme(tf === "1s" || tf === "15s");
      setColors(chartColors());
    });
    return () => cancelAnimationFrame(raf);
  }, [themeKey]);

  // ---- migration: a dotted vertical line on the first pool bar ----
  // biome-ignore lint/correctness/useExhaustiveDependencies: barsVersion signals new bars
  useEffect(() => {
    const ctrl = ctrlRef.current;
    if (!ctrl) return;
    const at = token.migratedAt;
    const bars = ctrl.barList;
    let lines: TimeLineSpec[] = [];
    if (ui.markers.migration && at !== null && bars.length > 1) {
      const i = lowerBound(bars, bucketStart(at, ui.tf));
      const bar = bars[i];
      if (bar && i > 0) lines = [{ id: "migrated", time: bar.time, label: "Migrated", color: colors.dim, textColor: colors.dim }];
    }
    ctrl.setTimeLines(lines);
  }, [token.migratedAt, ui.markers.migration, ui.tf, colors, barsVersion]);

  useEffect(() => ctrlRef.current?.setType(ui.chartType), [ui.chartType]);
  useEffect(() => ctrlRef.current?.setVolume(ui.volume), [ui.volume]);
  useEffect(() => ctrlRef.current?.setMovingAverage(ui.movingAverage), [ui.movingAverage]);
  useEffect(
    () => ctrlRef.current?.setOutline(full && ui.markers.candleClick && ui.candle ? ui.candle.from : null),
    [ui.candle, ui.markers.candleClick, full],
  );

  // ---- markers: you, dev, tracked, snipers; recomputed at most 4 times a second ----
  const markerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markerInputs = useRef({ trades, tracked, markers: ui.markers, tf: ui.tf, colors });
  markerInputs.current = { trades, tracked, markers: ui.markers, tf: ui.tf, colors };
  // biome-ignore lint/correctness/useExhaustiveDependencies: inputs are read from the ref when the throttle fires
  useEffect(() => {
    if (markerTimer.current) return;
    markerTimer.current = setTimeout(() => {
      markerTimer.current = null;
      const ctrl = ctrlRef.current;
      if (!ctrl) return;
      const { trades: list, tracked: trk, markers: on, tf, colors: c } = markerInputs.current;
      const secs = TIMEFRAME_SECONDS[tf];
      const ink = cssVar("--zf-ink", "#090a0c");
      const groups = new Map<string, { time: number; above: boolean; items: MarkerSpec[]; entries: string[] }>();
      for (const t of list) {
        const you = t.tags.includes("you");
        const dev = t.tags.includes("dev");
        const tw = trk.get(t.maker);
        const sniper = t.tags.includes("sniper") || t.tags.includes("bundler");
        let spec: MarkerSpec | null = null;
        let who = "";
        const sideColor = t.side === "buy" ? c.buy : c.sell;
        if (you && on.you) {
          spec = { kind: "you", text: "Y", fill: sideColor, textColor: ink, size: 16 };
          who = "You";
        } else if (dev && on.dev) {
          spec = { kind: "dev", text: "D", fill: sideColor, textColor: ink, size: 16 };
          who = "Dev";
        } else if (tw && on.tracked) {
          const letter = tw.emoji.trim() || Array.from(tw.name.trim())[0]?.toUpperCase() || "T";
          spec = { kind: "tracked", text: letter, fill: c.chip, ring: sideColor, textColor: c.fg, size: 14 };
          who = tw.name;
        } else if (sniper && on.snipers) {
          spec = { kind: "sniper", text: "", fill: c.sell, textColor: c.sell, size: 6 };
          who = t.tags.includes("sniper") ? "Sniper" : "Bundler";
        }
        if (!spec) continue;
        const time = Math.floor(t.ts / 1000 / secs) * secs;
        if (!ctrl.overlay.extents.has(time)) continue;
        const above = t.side === "sell";
        const key = `${time}:${above ? "s" : "b"}`;
        let g = groups.get(key);
        if (!g) {
          g = { time, above, items: [], entries: [] };
          groups.set(key, g);
        }
        g.items.push(spec);
        g.entries.push(`${who} ${t.side === "buy" ? "bought" : "sold"} ${fmtSol(t.solAmount)} SOL · ${fmtClock(t.ts)}`);
        if (groups.size > 400) break;
      }
      const out: MarkerGroup[] = [];
      for (const g of groups.values()) {
        const markers =
          g.items.length > 3
            ? [{ kind: "cluster" as const, text: String(g.items.length), fill: c.chip, textColor: c.fg, size: 16 }]
            : g.items;
        out.push({ time: g.time, above: g.above, markers, entries: g.entries });
      }
      ctrl.setMarkers(out);
    }, 250);
  }, [trades, tracked, ui.markers, ui.tf, colors, status, barsVersion]);
  useEffect(
    () => () => {
      // Reset too: StrictMode runs this cleanup and remounts, and a stale id would block every later pass.
      if (markerTimer.current) clearTimeout(markerTimer.current);
      markerTimer.current = null;
    },
    [],
  );

  // ---- lines: average entry/exit, drafts, armed orders, alerts, migration ----
  const models = useMemo<LineModel[]>(() => {
    const out: LineModel[] = [];
    const st = useTokenUi.getState;
    const current = token.priceSol;
    const fmtV = (priceSol: number) => format(plot(priceSol));
    if (ui.markers.avgLines && position && position.holdingTokens > 0 && position.avgEntryPriceSol > 0) {
      out.push({ id: "avg", priceSol: position.avgEntryPriceSol, tone: "fg", dash: [4, 3], axis: "avg", axisPrefix: "AVG", chip: null });
    }
    if (ui.markers.avgLines && position?.avgExitPriceSol) {
      out.push({ id: "exit", priceSol: position.avgExitPriceSol, tone: "fg2", dash: [1, 3], axis: "exit", axisPrefix: "EXIT", chip: null });
    }
    if (ui.markers.migration && token.migratedAt === null) {
      const p = migrationPriceSol(detail.curve);
      if (p)
        out.push({
          id: "migration",
          priceSol: p,
          tone: "dim",
          dash: [1, 3],
          axis: null,
          chip: { label: `Migration ${fmtV(p)}`, draft: false, draggable: false, removable: false, removeLabel: "" },
        });
    }
    if (ui.markers.orderLines) {
      for (const o of Object.values(ordersById)) {
        if (o.mint !== mint || !isOpenOrder(o)) continue;
        const p = triggerPriceSol(o, supply, solUsd);
        if (p === null) continue;
        const tone: Tone = o.kind === "take_profit" || o.kind === "limit_buy" ? "buy" : "sell";
        out.push({
          id: `order:${o.id}`,
          priceSol: p,
          tone,
          dash: [],
          axis: "filled",
          chip: {
            label: `${KIND_SHORT[o.kind]} ${sizeText(o).replace(/^(Buy|Sell) /, "")} · ${fmtV(p)}`,
            draft: false,
            draggable: false,
            removable: true,
            removeLabel: `Cancel ${KIND_SHORT[o.kind].toLowerCase()} order`,
          },
          onRemove: () => useCancelDialog.getState().ask(o),
        });
      }
    }
    if (full && ui.orderType === "limit" && ui.limitPriceSol !== null) {
      const buying = ui.side === "buy";
      const size = buying ? `${fmtSolShort(ui.buySol ?? quickBuy)} SOL` : `${fmtSolShort(ui.sellPct ?? 100)}%`;
      out.push({
        id: "draft",
        priceSol: ui.limitPriceSol,
        tone: buying ? "buy" : "sell",
        dash: [4, 3],
        axis: "filled",
        chip: {
          label: `Limit ${buying ? "buy" : "sell"} ${size} · ${fmtV(ui.limitPriceSol)}`,
          draft: true,
          draggable: true,
          removable: true,
          removeLabel: "Remove draft",
        },
        onMove: (p) => st().setLimitPriceSol(p),
        onRemove: () => {
          st().setOrderType("market");
          st().setLimitPriceSol(null);
        },
        onArm: () => void armLimitDraft(token),
      });
    }
    // TP/SL legs are drawn from the entry (or the current price): nothing to draw while both are unknown.
    const ladderRef = ui.side === "sell" && position && position.avgEntryPriceSol > 0 ? position.avgEntryPriceSol : current;
    if (full && ui.orderType === "advanced" && ladderRef !== null) {
      const ref = ladderRef;
      let tpIndex = 0;
      for (const leg of ui.ladder) {
        const tp = leg.kind === "take_profit";
        if (tp) tpIndex++;
        const p = ref * (tp ? 1 + leg.triggerPct / 100 : 1 - leg.triggerPct / 100);
        if (!(p > 0)) continue;
        const name = tp ? `TP${tpIndex}` : "SL";
        out.push({
          id: `leg:${leg.id}`,
          priceSol: p,
          tone: tp ? "buy" : "sell",
          dash: [4, 3],
          axis: "filled",
          chip: {
            label: `${name} sell ${fmtSolShort(leg.sellPct)}% · ${fmtV(p)}`,
            draft: true,
            draggable: true,
            removable: true,
            removeLabel: `Remove ${name}`,
          },
          onMove: (np) => {
            const pct = tp ? (np / ref - 1) * 100 : (1 - np / ref) * 100;
            st().updateLeg(leg.id, { triggerPct: Math.max(0.5, Math.round(pct * 10) / 10) });
          },
          onRemove: () => st().setLadder(st().ladder.filter((l) => l.id !== leg.id)),
        });
      }
    }
    if (full) {
      for (const a of ui.alerts) {
        if (a.mint !== mint) continue;
        out.push({
          id: `alert:${a.id}`,
          priceSol: a.priceSol,
          tone: "fg2",
          dash: [2, 2],
          axis: "alert",
          chip: { label: `Alert · ${fmtV(a.priceSol)}`, draft: false, draggable: true, removable: true, removeLabel: "Remove alert" },
          onMove: (p) => st().moveAlert(a.id, p, live.current.current),
          onRemove: () => st().removeAlert(a.id),
        });
      }
    }
    return out;
  }, [ui, position, ordersById, mint, supply, solUsd, quickBuy, token, detail.curve, format, plot, full]);
  modelsRef.current = models;

  // Canvas specs for the primitive.
  useEffect(() => {
    const ctrl = ctrlRef.current;
    if (!ctrl) return;
    const ink = cssVar("--zf-ink", "#090a0c");
    const color: Record<Tone, string> = {
      buy: colors.buy,
      sell: colors.sell,
      fg: withAlpha(colors.fg, 0.8),
      fg2: colors.fg2,
      dim: colors.dim,
    };
    const specs: LineSpec[] = models.map((m) => {
      const price = plot(m.priceSol);
      const text = `${m.axisPrefix ? `${m.axisPrefix} ` : ""}${format(price)}`;
      let axis: LineSpec["axis"];
      if (m.axis === "filled") axis = { text, bg: color[m.tone], fg: ink };
      else if (m.axis === "avg") axis = { text, bg: colors.chip, fg: colors.fg, border: colors.fg };
      else if (m.axis === "exit") axis = { text, bg: colors.chip, fg: colors.fg2, border: colors.fg2 };
      else if (m.axis === "alert") axis = { text, bg: colors.chip, fg: colors.fg2, border: colors.fg2 };
      return { id: m.id, price, color: color[m.tone], dash: m.dash, draggable: !!m.chip?.draggable, axis };
    });
    ctrl.setLines(specs);
  }, [models, plot, format, colors]);

  useLayoutEffect(() => syncChips());

  // ---- dragging (pointer on the line's 8 px hit area or on its chip) ----
  const beginDrag = (id: string, clientY: number) => {
    const m = modelsRef.current.find((x) => x.id === id);
    if (!m?.chip?.draggable) return false;
    dragRef.current = { id, startPriceSol: m.priceSol, startY: clientY, moved: false };
    setDragging(id);
    ctrlRef.current?.setInteractive(false);
    return true;
  };
  const moveDrag = (clientY: number, alt: boolean) => {
    const d = dragRef.current;
    const ctrl = ctrlRef.current;
    const el = containerRef.current;
    if (!d || !ctrl || !el) return;
    if (!d.moved && Math.abs(clientY - d.startY) < 3) return;
    d.moved = true;
    const v = ctrl.yToPrice(clientY - el.getBoundingClientRect().top);
    if (v === null || v <= 0) return;
    const raw = live.current.fromPlot(v);
    const p = alt ? raw : snapPrice(raw, live.current.current);
    modelsRef.current.find((x) => x.id === d.id)?.onMove?.(p);
  };
  const endDrag = (revert: boolean) => {
    const d = dragRef.current;
    if (!d) return;
    if (revert) modelsRef.current.find((x) => x.id === d.id)?.onMove?.(d.startPriceSol);
    if (d.moved) justDragged.current = Date.now();
    dragRef.current = null;
    setDragging(null);
    ctrlRef.current?.setInteractive(true);
  };
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      endDrag(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const onPointerDownCapture = (e: PointerEvent<HTMLDivElement>) => {
    if (!full || e.button !== 0) return;
    const ctrl = ctrlRef.current;
    const el = containerRef.current;
    if (!ctrl || !el) return;
    const line = ctrl.overlay.lineAt(e.clientY - el.getBoundingClientRect().top);
    if (!line || !beginDrag(line.id, e.clientY)) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMoveCapture = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    e.stopPropagation();
    moveDrag(e.clientY, e.altKey);
  };
  const onPointerUpCapture = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    e.stopPropagation();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    endDrag(false);
  };

  const onChipKey = (m: LineModel, e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 5 : 0.5;
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && m.chip?.draggable) {
      e.preventDefault();
      m.onMove?.(nudgePrice(m.priceSol, token.priceSol, e.key === "ArrowUp" ? step : -step));
    } else if (e.key === "Enter" && m.onArm) {
      e.preventDefault();
      m.onArm();
    } else if ((e.key === "Delete" || e.key === "Backspace") && m.onRemove) {
      e.preventDefault();
      m.onRemove();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.blur();
    }
  };

  const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!full) return;
    const ctrl = ctrlRef.current;
    const el = containerRef.current;
    if (!ctrl || !el) return;
    const r = el.getBoundingClientRect();
    const v = ctrl.yToPrice(e.clientY - r.top);
    if (v === null || v <= 0) return;
    e.preventDefault();
    setMenu({ x: e.clientX - r.left, y: e.clientY - r.top, priceSol: snapPrice(fromPlot(v), token.priceSol) });
  };

  const screenshot = async (): Promise<boolean> => {
    const ctrl = ctrlRef.current;
    if (!ctrl) return false;
    const canvas = ctrl.chart.takeScreenshot();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return false;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      return true;
    } catch {
      // Clipboard images need permission; fall back to saving the PNG locally.
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${token.symbol}-${ui.tf}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    }
  };

  const retryFeed = useCallback(() => setRetry((n) => n + 1), []);
  const chips = full ? models.filter((m) => m.chip) : [];
  const menuValue = menu ? format(plot(menu.priceSol)) : "";

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-surface-1">
      {full && (
        <ChartToolbar onScreenshot={screenshot} maximized={ui.maximized} onMaximize={(on) => useTokenUi.getState().setMaximized(on)} />
      )}
      <div className="relative min-h-0 flex-1" data-zf-chart={full ? "" : undefined}>
        <Legend
          register={registerLegend}
          symbol={token.symbol}
          pair={token.quote === "OTHER" ? "quote" : token.quote}
          venue={VENUE_LEGEND[token.venue]}
          venueLogo={VENUE_LOGO[token.venue]}
          tf={ui.tf}
          format={axis}
          quote={quote}
        />
        {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer capture for dragging order lines; their keyboard equivalents live on the handle chips */}
        <div
          ref={containerRef}
          className="absolute inset-0"
          onPointerDownCapture={onPointerDownCapture}
          onPointerMoveCapture={onPointerMoveCapture}
          onPointerUpCapture={onPointerUpCapture}
          onPointerCancelCapture={() => endDrag(true)}
          onContextMenu={onContextMenu}
        />
        <ChartStateOverlay status={status} tf={ui.tf} history={history} onRetry={retryFeed} />
        {chips.length > 0 && (
          <div className="pointer-events-none absolute inset-0 z-chart-ui overflow-hidden">
            {chips.map((m) => {
              const chip = m.chip;
              if (!chip) return null;
              const isDragging = dragging === m.id;
              const dist = distancePct(m.priceSol, token.priceSol);
              const register = (el: HTMLDivElement | null) => {
                if (el) chipEls.current.set(m.id, el);
                else chipEls.current.delete(m.id);
              };
              const base = cn(
                "focus-inset absolute top-0 left-2 flex h-5 max-w-[calc(100%-120px)] items-center gap-1 rounded-sm border bg-surface-2 pr-0.5 pl-1.5 text-label font-medium whitespace-nowrap select-none",
                CHIP_BORDER[m.tone],
              );
              const remove = chip.removable && (
                <button
                  type="button"
                  tabIndex={chip.draggable ? -1 : 0}
                  aria-label={chip.removeLabel}
                  title={chip.removeLabel}
                  onClick={(e) => {
                    e.stopPropagation();
                    m.onRemove?.();
                  }}
                  className="flex size-4 items-center justify-center rounded-xs text-fg-3 transition-colors hover:text-fg-1"
                >
                  <X className="icon-xs" />
                </button>
              );
              if (!chip.draggable) {
                // Armed orders and the migration level: a label (plus Cancel for orders), not draggable.
                return (
                  <div
                    key={m.id}
                    ref={register}
                    style={{ visibility: "hidden" }}
                    className={cn(base, remove ? "pointer-events-auto text-fg-1" : "pr-1.5 text-fg-3")}
                  >
                    <span className="truncate">{chip.label}</span>
                    {remove}
                  </div>
                );
              }
              return (
                <div
                  key={m.id}
                  ref={register}
                  role="slider"
                  tabIndex={0}
                  aria-label={chip.label}
                  aria-valuetext={`${fmtPct(dist, { signed: true })} vs now`}
                  aria-valuenow={dist === null ? undefined : Math.round(dist * 10) / 10}
                  title={`Drag or use Up/Down to move (Shift for 5%)${m.onArm ? ", Enter to arm" : ""}, Delete to remove. Alt while dragging skips snapping.`}
                  onKeyDown={(e) => onChipKey(m, e)}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    if ((e.target as HTMLElement).closest("button")) return;
                    if (!beginDrag(m.id, e.clientY)) return;
                    e.preventDefault();
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  onPointerMove={(e) => {
                    if (dragRef.current?.id === m.id) moveDrag(e.clientY, e.altKey);
                  }}
                  onPointerUp={(e) => {
                    if (dragRef.current?.id !== m.id) return;
                    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
                    endDrag(false);
                  }}
                  style={{ visibility: "hidden" }}
                  className={cn(base, "pointer-events-auto cursor-ns-resize text-fg-1")}
                >
                  {chip.draft && <span className="text-fg-3">Draft</span>}
                  <span className="truncate">{isDragging ? `${fmtPct(dist, { signed: true })} vs now` : chip.label}</span>
                  {remove}
                </div>
              );
            })}
          </div>
        )}
        {hover && hover.entries.length > 0 && (
          <div
            role="tooltip"
            className="pointer-events-none absolute z-tooltip max-w-70 rounded-md border border-hairline-strong bg-tooltip px-2.5 py-2 text-label text-fg-1 shadow-e1"
            style={{ left: Math.min(hover.x + 12, (containerRef.current?.clientWidth ?? 400) - 240), top: Math.max(4, hover.y - 12) }}
          >
            {hover.entries.slice(0, 6).map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a static list for one hover
              <div key={i} className="zf-num whitespace-nowrap">
                {line}
              </div>
            ))}
            {hover.entries.length > 6 && <div className="text-fg-3">+{hover.entries.length - 6} more</div>}
          </div>
        )}
        <div ref={menuAnchor} className="pointer-events-none absolute size-px" style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }} />
        <Popover open={menu !== null} onClose={() => setMenu(null)} anchor={menuAnchor} width={220}>
          {menu && (
            <div role="menu" aria-label="Chart actions">
              <MenuItem
                onSelect={() => {
                  const s = useTokenUi.getState();
                  s.setSide("buy");
                  s.setOrderType("limit");
                  s.setLimitPriceSol(menu.priceSol);
                  setMenu(null);
                }}
              >
                Limit buy at {menuValue}
              </MenuItem>
              <MenuItem
                onSelect={() => {
                  const s = useTokenUi.getState();
                  s.setSide("sell");
                  s.setOrderType("limit");
                  s.setLimitPriceSol(menu.priceSol);
                  setMenu(null);
                }}
              >
                Limit sell at {menuValue}
              </MenuItem>
              <MenuItem
                hint={<Hotkey binding={alertKey} />}
                onSelect={() => {
                  // An unknown current price gives the alert no direction to cross from.
                  if (token.priceSol !== null) useTokenUi.getState().addAlert(mint, menu.priceSol, token.priceSol);
                  setMenu(null);
                }}
              >
                Alert at {menuValue}
              </MenuItem>
            </div>
          )}
        </Popover>
      </div>
    </div>
  );
}
