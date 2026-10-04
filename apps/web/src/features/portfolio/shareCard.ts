/**
 * PnL share card (DESIGN.md 4.21), drawn with Canvas 2D so the preview and the exported PNG are
 * the same pixels. One flat background colour, no glow or illustration; Plex for every glyph;
 * numbers formatted by the caller through lib/format (section 3). Hierarchy after Binance's
 * poster (ROI big, PnL, cut-off time, brand footer), without its 3D art:
 * https://mobbin.com/screens/fa184fc0-d47a-4ad5-a927-fd920bc4808f
 */

export type ShareMetric = "pct" | "sol" | "usd";
export type ShareTemplate = "dark" | "light" | "mono";
export type ShareFormat = "landscape" | "portrait";

export interface ShareCardData {
  symbol: string;
  name: string;
  mint: string;
  /** Hero texts per metric, already formatted and signed ("+248.6%", "+1.24 SOL", "+$148.20"). */
  pct: string | null;
  sol: string;
  usd: string;
  /** Sign of the PnL: 1, −1 or 0 (colour of the hero). */
  sign: number;
  stats: { label: string; value: string; arrowTo?: string; amount?: boolean }[];
  /** Position path for the mini chart (time, market cap), oldest first. */
  path: { t: number; v: number }[];
  /** Indexes into `path` for the entry and exit dots. */
  entryIndex: number | null;
  exitIndex: number | null;
  stamp: string;
  walletLabel: string | null;
}

export interface ShareCardOptions {
  metric: ShareMetric;
  template: ShareTemplate;
  chart: boolean;
  amounts: boolean;
  walletLabel: boolean;
  format: ShareFormat;
  blueOrange: boolean;
}

interface Palette {
  bg: string;
  t1: string;
  t2: string;
  t3: string;
  buy: string;
  sell: string;
  mono: readonly string[];
}

/** Token values from DESIGN.md 2.1 (dark and light) plus the blue/orange palette; Mono is pure black and white. */
function palette(template: ShareTemplate, blueOrange: boolean): Palette {
  if (template === "light") {
    return {
      bg: "#F5F6F7",
      t1: "#13161B",
      t2: "#494D54",
      t3: "#5F646A",
      buy: blueOrange ? "#125FB3" : "#00774C",
      sell: blueOrange ? "#A14C00" : "#BA2B2E",
      mono: ["#F5D5D4", "#EFDAC6", "#DFE1C6", "#CDE5D4", "#C4E6E7", "#CCE1F4", "#DDDBF4", "#EED6E7"],
    };
  }
  if (template === "mono") {
    return { bg: "#000000", t1: "#FFFFFF", t2: "#C4C4C4", t3: "#8C8C8C", buy: "#FFFFFF", sell: "#FFFFFF", mono: ["#262626"] };
  }
  return {
    bg: "#090A0C",
    t1: "#E9EBEE",
    t2: "#B2B6BC",
    t3: "#858A90",
    buy: blueOrange ? "#60AAF3" : "#3DCA8D",
    sell: blueOrange ? "#F59740" : "#FA6B6D",
    mono: ["#603D3C", "#5B422A", "#494A2A", "#31503C", "#225052", "#304B61", "#474361", "#593D52"],
  };
}

export function cardSize(format: ShareFormat): { w: number; h: number } {
  return format === "portrait" ? { w: 1080, h: 1350 } : { w: 1200, h: 675 };
}

const FAMILY = '"IBM Plex Sans Variable", "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif';
const font = (size: number, weight: 400 | 500 | 600) => `${weight} ${size}px ${FAMILY}`;

/** Loads the Plex weights the card uses before the first draw (canvas never triggers font loads). */
export function loadCardFonts(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return Promise.resolve();
  return Promise.all([document.fonts.load(font(48, 600)), document.fonts.load(font(36, 500)), document.fonts.load(font(20, 400))]).then(
    () => undefined,
    () => undefined,
  );
}

/** djb2, the same hash the in-app monograms use (TokenAvatar), so the card matches the app. */
function monoIndex(seed: string, n: number): number {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
  return Math.abs(h) % n;
}

function fit(ctx: CanvasRenderingContext2D, s: string, max: number): string {
  if (ctx.measureText(s).width <= max) return s;
  let out = s;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > max) out = out.slice(0, -1);
  return `${out}…`;
}

function draw(
  ctx: CanvasRenderingContext2D,
  s: string,
  x: number,
  y: number,
  f: string,
  color: string,
  align: CanvasTextAlign = "left",
  max?: number,
): number {
  ctx.font = f;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  const t = max !== undefined ? fit(ctx, s, max) : s;
  ctx.fillText(t, x, y);
  return ctx.measureText(t).width;
}

/** Numbers never truncate: the hero shrinks (down to `min` px) until it fits its width. */
function drawShrink(
  ctx: CanvasRenderingContext2D,
  s: string,
  x: number,
  y: number,
  size: number,
  min: number,
  weight: 500 | 600,
  color: string,
  max: number,
): void {
  let sz = size;
  ctx.font = font(sz, weight);
  while (sz > min && ctx.measureText(s).width > max) {
    sz -= 4;
    ctx.font = font(sz, weight);
  }
  draw(ctx, s, x, y, font(sz, weight), color, "left", max);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** The zerofee mark (app/Logo.tsx) at `size`: an ink slashed zero on an accent square. */
function mark(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, p: Palette): void {
  const k = size / 20;
  ctx.fillStyle = p.t1;
  roundRect(ctx, x, y, size, size, 4 * k);
  ctx.fill();
  ctx.strokeStyle = p.bg;
  ctx.lineWidth = 2 * k;
  ctx.beginPath();
  ctx.ellipse(x + 10 * k, y + 10 * k, 4.2 * k, 5.8 * k, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 1.8 * k;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x + 6.3 * k, y + 15.4 * k);
  ctx.lineTo(x + 13.7 * k, y + 4.6 * k);
  ctx.stroke();
  ctx.lineCap = "butt";
}

/** Monogram avatar (DESIGN.md 4.22): muted fill by hash(mint), two letters in Plex 600 at 40% of the box. */
function avatar(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, data: ShareCardData, p: Palette): void {
  ctx.fillStyle = p.mono[monoIndex(data.mint, p.mono.length)] ?? p.t3;
  roundRect(ctx, x, y, size, size, 8);
  ctx.fill();
  const letters = data.symbol.slice(0, 2).toUpperCase() || "?";
  ctx.font = font(Math.round(size * 0.4), 600);
  ctx.fillStyle = p.t1;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(letters, x + size / 2, y + size / 2 + 1);
}

/** A right arrow drawn as lines (Plex has no arrow glyph for it, DESIGN.md 2.2). */
function arrow(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.moveTo(x + w - 8, y - 7);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w - 8, y + 7);
  ctx.stroke();
  ctx.lineCap = "butt";
}

/** The position's path: a 3 px text-2 line, entry dot in buy, exit dot in sell, no fill. */
function miniChart(
  ctx: CanvasRenderingContext2D,
  box: { x: number; y: number; w: number; h: number },
  data: ShareCardData,
  p: Palette,
): void {
  const pts = data.path.filter((q) => q.v > 0);
  if (pts.length < 2) return;
  const t0 = Math.min(...pts.map((q) => q.t));
  const t1 = Math.max(...pts.map((q) => q.t));
  // Market caps move by multiples, so the y axis is logarithmic.
  const lv = pts.map((q) => Math.log10(q.v));
  const v0 = Math.min(...lv);
  const v1 = Math.max(...lv);
  const px = (t: number) => box.x + (t1 > t0 ? ((t - t0) / (t1 - t0)) * box.w : box.w / 2);
  const py = (v: number) => box.y + box.h - (v1 > v0 ? ((Math.log10(v) - v0) / (v1 - v0)) * box.h : box.h / 2);
  ctx.strokeStyle = p.t2;
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  pts.forEach((q, i) => {
    if (i === 0) ctx.moveTo(px(q.t), py(q.v));
    else ctx.lineTo(px(q.t), py(q.v));
  });
  ctx.stroke();
  const dot = (q: { t: number; v: number } | undefined, color: string) => {
    if (!q || q.v <= 0) return;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(px(q.t), py(q.v), 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = p.bg;
    ctx.lineWidth = 3;
    ctx.stroke();
  };
  dot(data.entryIndex !== null ? data.path[data.entryIndex] : undefined, p.buy);
  dot(data.exitIndex !== null ? data.path[data.exitIndex] : undefined, p.sell);
  ctx.lineCap = "butt";
}

function heroText(data: ShareCardData, opts: ShareCardOptions): { hero: string; sub: string | null } {
  // "Show amounts" off means % only (DESIGN.md 4.21).
  const metric: ShareMetric = !opts.amounts || (opts.metric === "pct" && data.pct !== null) ? "pct" : opts.metric;
  if (metric === "pct" && data.pct !== null) {
    return { hero: data.pct, sub: opts.amounts ? `${data.sol} · ${data.usd}` : null };
  }
  if (metric === "usd") return { hero: data.usd, sub: opts.amounts ? [data.pct, data.sol].filter(Boolean).join(" · ") : null };
  return { hero: data.sol, sub: opts.amounts ? [data.pct, data.usd].filter(Boolean).join(" · ") : null };
}

function statsRow(
  ctx: CanvasRenderingContext2D,
  stats: ShareCardData["stats"],
  x: number,
  y: number,
  colW: number,
  cols: number,
  rowH: number,
  p: Palette,
): void {
  stats.forEach((s, i) => {
    const cx = x + (i % cols) * colW;
    const cy = y + Math.floor(i / cols) * rowH;
    draw(ctx, s.label, cx, cy, font(18, 400), p.t3, "left", colW - 24);
    const w = draw(ctx, s.value, cx, cy + 40, font(28, 600), p.t1, "left", s.arrowTo ? (colW - 64) / 2 : colW - 24);
    if (s.arrowTo) {
      arrow(ctx, cx + w + 12, cy + 30, 28, p.t3);
      draw(ctx, s.arrowTo, cx + w + 52, cy + 40, font(28, 600), p.t1, "left", colW - w - 76);
    }
  });
}

/** Draws the whole card onto a context sized to cardSize(format). */
export function drawShareCard(ctx: CanvasRenderingContext2D, data: ShareCardData, opts: ShareCardOptions): void {
  const p = palette(opts.template, opts.blueOrange);
  const { w, h } = cardSize(opts.format);
  const m = 48;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, w, h);

  // Header: mark + wordmark top-left, timestamp top-right.
  mark(ctx, m, m, 32, p);
  draw(ctx, "zerofee", m + 44, m + 25, font(24, 600), p.t1);
  draw(ctx, data.stamp, w - m, m + 23, font(20, 400), p.t3, "right");

  const tone = data.sign > 0 ? p.buy : data.sign < 0 ? p.sell : p.t1;
  const { hero, sub } = heroText(data, opts);
  const stats = opts.amounts ? data.stats : data.stats.filter((s) => !s.amount);
  const showChart = opts.chart && data.path.filter((q) => q.v > 0).length >= 2;

  if (opts.format === "landscape") {
    const textW = showChart ? w * 0.62 - m : w - 2 * m;
    avatar(ctx, m, 128, 72, data, p);
    const tickerW = draw(ctx, `$${data.symbol}`, m + 92, 182, font(48, 600), p.t1, "left", textW - 92);
    draw(ctx, data.name, m + 92 + tickerW + 20, 182, font(24, 400), p.t2, "left", Math.max(0, textW - 112 - tickerW));
    drawShrink(ctx, hero, m - 6, 352, 128, 72, 600, tone, textW);
    if (sub) drawShrink(ctx, sub, m, 410, 36, 24, 500, p.t1, textW);
    if (showChart) miniChart(ctx, { x: w * 0.66, y: 150, w: w * 0.34 - m - 8, h: 250 }, data, p);
    statsRow(ctx, stats, m, 500, (w - 2 * m) / 4, 4, 0, p);
  } else {
    avatar(ctx, m, 176, 72, data, p);
    const tickerW = draw(ctx, `$${data.symbol}`, m + 92, 230, font(48, 600), p.t1, "left", w - 2 * m - 92);
    draw(ctx, data.name, m + 92 + tickerW + 20, 230, font(24, 400), p.t2, "left", Math.max(0, w - 2 * m - 112 - tickerW));
    drawShrink(ctx, hero, m - 6, 450, 128, 72, 600, tone, w - 2 * m);
    if (sub) drawShrink(ctx, sub, m, 512, 36, 24, 500, p.t1, w - 2 * m);
    if (showChart) miniChart(ctx, { x: m + 8, y: 600, w: w - 2 * m - 16, h: 300 }, data, p);
    statsRow(ctx, stats, m, showChart ? 990 : 640, (w - 2 * m) / 2, 2, 110, p);
  }

  // Footer: the claim we prove on every fill, plus the wallet label only when asked (privacy).
  draw(ctx, "zerofee · 0% platform fee", m, h - m, font(20, 400), p.t3);
  if (opts.walletLabel && data.walletLabel) draw(ctx, data.walletLabel, w - m, h - m, font(20, 400), p.t3, "right", 320);
}
