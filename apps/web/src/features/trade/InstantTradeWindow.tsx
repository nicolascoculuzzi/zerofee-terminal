import { ChevronDown, GripHorizontal, Keyboard, Lock, X } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { Button } from "../../components/ui/Button";
import { Checkbox, Segmented } from "../../components/ui/controls";
import { BottomSheet } from "../../components/ui/Modal";
import { Popover } from "../../components/ui/Popover";
import { cn } from "../../lib/cn";
import { fmtPnlPct, fmtSignedSol, fmtSol, fmtSolShort, fmtTokens, signClass } from "../../lib/format";
import { compactLabel, type HotkeyAction } from "../../lib/hotkeys";
import { buy, sell, sellInitials } from "../../lib/tradeActions";
import { useMediaQuery } from "../../lib/useMediaQuery";
import type { TokenSummary } from "../../protocol";
import { useMarket } from "../../state/market";
import { useSettings } from "../../state/settings";
import { useToken } from "../../state/token";
import { useUi } from "../../state/ui";
import { useWallet } from "../../state/wallet";
import { selectPulseMint, usePulseUi } from "../pulse/store";
import { fmtMoney, toQuote, useQuote } from "../token/money";
import { PresetSwitch, SettingsLine } from "./PresetSettings";

/*
 * Instant Trade (DESIGN.md 4.12): a 296/320 px floating window on z-dock with a 28 px header
 * (P1–P3, hotkeys toggle, drag grip, wallet picker, close), four buy-tint amounts, four sell-tint
 * % (or SOL) buttons, hotkey hints, the settings line and Sell initials with PnL. No confirmations
 * (SPEC); the repeat guard and the central risk confirm live in tradeActions. Dragged by the
 * header, snaps within 12 px to the viewport and the right-rail edge, keeps 24 px on screen,
 * position saved per breakpoint, double-click collapses. Phones get a bottom sheet with a 2 × 4
 * grid of 44 px buttons. Grid of instant actions after Public's options ticket
 * https://mobbin.com/screens/00b5bb2e-ab18-40db-abe1-26a5248bed62; movable panels with a
 * persisted layout after Kraken Pro https://mobbin.com/screens/25b67ef9-d56e-4f69-865f-16a702da74b7;
 * a compact floating bar with a drag handle after Gemini https://mobbin.com/screens/51336744-d390-48af-8815-0c4fbb57a0d0
 */

const SNAP = 12;
const KEEP = 24;
const STORE_KEY = "zerofee.instantTrade.v1";

type Breakpoint = "md" | "lg" | "xl" | "2xl" | "3xl";

interface Saved {
  pos: Partial<Record<Breakpoint, { x: number; y: number }>>;
  collapsed: boolean;
}

function breakpoint(): Breakpoint {
  const w = window.innerWidth;
  if (w >= 1920) return "3xl";
  if (w >= 1440) return "2xl";
  if (w >= 1280) return "xl";
  if (w >= 1024) return "lg";
  return "md";
}

function load(): Saved {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Saved>;
      return { pos: p.pos ?? {}, collapsed: !!p.collapsed };
    }
  } catch {
    // Private windows and blocked storage: fall back to defaults.
  }
  return { pos: {}, collapsed: false };
}

function save(s: Saved): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    // Not persisted; the window still works.
  }
}

/** The trade rail's left edge on the token page, or null elsewhere. */
function railLeft(): number | null {
  const el = document.querySelector<HTMLElement>('aside[aria-label="Trade"]');
  return el ? el.getBoundingClientRect().left : null;
}

function clampToScreen(x: number, y: number, w: number, h: number): { x: number; y: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    x: Math.min(vw - KEEP, Math.max(KEEP - w, x)),
    y: Math.min(vh - KEEP, Math.max(0, Math.min(y, vh - Math.min(h, KEEP)))),
  };
}

function snap(x: number, y: number, w: number, h: number): { x: number; y: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let nx = x;
  let ny = y;
  if (Math.abs(nx) <= SNAP) nx = 0;
  else if (Math.abs(vw - (nx + w)) <= SNAP) nx = vw - w;
  const rail = railLeft();
  if (rail !== null) {
    if (Math.abs(rail - (nx + w)) <= SNAP) nx = rail - w;
    else if (Math.abs(nx - rail) <= SNAP) nx = rail;
  }
  if (Math.abs(ny) <= SNAP) ny = 0;
  else if (Math.abs(vh - (ny + h)) <= SNAP) ny = vh - h;
  return clampToScreen(nx, ny, w, h);
}

/** DESIGN.md 5.2: the chart's top-right corner on the token page; bottom-right elsewhere. */
function defaultPos(w: number, h: number): { x: number; y: number } {
  const chart = document.querySelector<HTMLElement>("[data-zf-chart]");
  const rail = railLeft();
  if (chart && rail !== null) {
    const r = chart.getBoundingClientRect();
    return clampToScreen(rail - w - SNAP, r.top + SNAP, w, h);
  }
  return clampToScreen(window.innerWidth - w - SNAP, window.innerHeight - h - 24 - SNAP, w, h);
}

/** "Space+1 · 2 · 3 · 4": the shared prefix is written once. */
export function hintFor(bindings: (string | undefined)[]): string {
  const labels = bindings.map((b) => compactLabel(b)).filter(Boolean);
  if (labels.length === 0) return "";
  const prefix = labels.every((l) => l.startsWith("Space+")) ? "Space+" : "";
  return labels.map((l, i) => (i === 0 || !prefix ? l : l.slice(prefix.length))).join(" · ");
}

/**
 * The token Instant Trade acts on: the open token page; on Pulse the trade-hotkey target (the
 * hovered card, else the keyboard-cursor card, see pulseTarget); elsewhere the hovered row. The
 * last target sticks while the pointer travels to the window, then the last token viewed.
 */
function useTarget(): TokenSummary | null {
  const location = useLocation();
  const onPulse = location.pathname.startsWith("/pulse");
  const hoverMint = useUi((s) => s.hoverMint);
  const pulseMint = usePulseUi(selectPulseMint);
  const focusedMint = useUi((s) => s.focusedMint);
  const live = onPulse ? pulseMint : hoverMint;
  const [lastTarget, setLastTarget] = useState<string | null>(null);
  useEffect(() => {
    if (live) setLastTarget(live);
  }, [live]);
  const routeMint = location.pathname.startsWith("/t/") ? decodeURIComponent(location.pathname.slice(3)) : null;
  const mint = routeMint ?? live ?? lastTarget ?? focusedMint;
  const detail = useToken((s) => (s.detail && s.detail.summary.mint === mint ? s.detail.summary : null));
  const market = useMarket((s) => (mint ? s.tokens[mint] : undefined));
  return detail ?? market ?? null;
}

function WalletPicker() {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const all = useWallet((s) => s.service.tradingWallets);
  const wallets = all.filter((w) => !w.archived);
  const activeAddress = useWallet((s) => s.activeAddress);
  const status = useWallet((s) => s.status);
  const selected = useSettings((s) => s.instant.wallets);
  const setInstant = useSettings((s) => s.setInstant);
  const effective = selected.filter((a) => wallets.some((w) => w.address === a));
  const count = effective.length || 1;
  const toggle = (address: string) => {
    const base = effective.length > 0 ? effective : activeAddress ? [activeAddress] : [];
    const next = base.includes(address) ? base.filter((a) => a !== address) : [...base, address];
    setInstant({ wallets: next });
  };
  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Wallets this window trades with"
        className="flex h-5 shrink-0 items-center gap-0.5 rounded-sm px-1 text-label font-medium text-fg-2 transition-colors hover:bg-surface-3 hover:text-fg-1"
      >
        {count} wallet{count === 1 ? "" : "s"}
        <ChevronDown className="icon-xs" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} align="end" width={248} padding="form">
        <div className="space-y-2">
          <div className="zf-label">Trade with</div>
          {wallets.map((w) => {
            const on = effective.length > 0 ? effective.includes(w.address) : w.address === activeAddress;
            return (
              <Checkbox
                key={w.id}
                checked={on}
                onChange={() => toggle(w.address)}
                label={
                  <span className="flex w-44 justify-between gap-2">
                    <span className="truncate">{w.label}</span>
                    <span className="zf-num text-fg-2">{fmtSol(status[w.address]?.solBalance ?? null)} SOL</span>
                  </span>
                }
              />
            );
          })}
          <p className="text-label text-fg-3">With several wallets selected, each one places the full amount.</p>
        </div>
      </Popover>
    </>
  );
}

/** Buy and sell grids; shared by the floating window and the phone sheet. */
function TradeGrid({ token, touch }: { token: TokenSummary; touch: boolean }) {
  const preset = useSettings((s) => s.presets[s.activePreset]);
  const instant = useSettings((s) => s.instant);
  const setInstant = useSettings((s) => s.setInstant);
  const tradeHotkeys = useSettings((s) => s.tradeHotkeys);
  const keys = useSettings((s) => s.hotkeys);
  const locked = useWallet((s) => s.service.locked && s.mode === "instant");
  const activeAddress = useWallet((s) => s.activeAddress);
  const status = useWallet((s) => (activeAddress ? s.status[activeAddress] : undefined));
  const position = status?.positions.find((p) => p.mint === token.mint) ?? null;
  const { quote, solUsd } = useQuote();
  const wallets = instant.wallets;
  const sellMode = instant.sellMode;
  const balance = status ? Math.max(0, status.solBalance - status.reservedSol) : 0;
  const holding = position?.holdingTokens ?? 0;
  const remaining = position ? position.boughtSol - position.soldSol : 0;
  const pnl = position ? position.realizedPnlSol + position.unrealizedPnlSol : 0;
  const sells = sellMode === "pct" ? preset.instantSellPct : preset.instantSellSol;
  const h = touch ? "h-11" : "h-7";

  const buyHint = hintFor([1, 2, 3, 4].map((i) => keys[`buy.${i}` as HotkeyAction]?.[0]));
  const sellHint = hintFor([1, 2, 3, 4].map((i) => keys[`sell.${i}` as HotkeyAction]?.[0]));

  return (
    <>
      <div className="space-y-1 p-2">
        <div className="flex h-4 items-center justify-between text-label">
          <span className="font-medium text-fg-3">Buy</span>
          <span className="text-fg-3">
            Bal <span className="zf-num text-fg-2">{fmtSol(balance)}</span> SOL
          </span>
        </div>
        <div className="grid grid-cols-4 gap-1">
          {preset.instantBuy.map((sol, i) => (
            <Button
              // biome-ignore lint/suspicious/noArrayIndexKey: four fixed slots
              key={i}
              data-grid="0"
              variant="buy-tint"
              size="md"
              className={cn(h, "text-data font-semibold")}
              icon={locked ? <Lock /> : undefined}
              aria-label={`Buy ${fmtSolShort(sol)} SOL of ${token.symbol}`}
              onClick={() => void buy({ mint: token.mint, sol, source: "instant", wallets })}
            >
              <span className="zf-num">{fmtSolShort(sol)}</span>
            </Button>
          ))}
        </div>
        {!touch && tradeHotkeys && buyHint && <div className="text-micro text-fg-3">{buyHint}</div>}
        <SettingsLine side="buy" />
      </div>
      <div className="h-px bg-hairline" />
      <div className="space-y-1 p-2">
        <div className="flex h-4 items-center gap-2 text-label">
          <span className="font-medium text-fg-3">Sell</span>
          <Segmented<"pct" | "sol">
            size="xs"
            value={sellMode}
            onChange={(m) => setInstant({ sellMode: m })}
            options={[
              { value: "pct", label: "%" },
              { value: "sol", label: "SOL" },
            ]}
            label="Sell amount unit"
          />
          <span className="ml-auto truncate text-fg-3">
            {holding > 0 ? (
              <>
                <span className="zf-num text-fg-2">{fmtTokens(holding)}</span> {token.symbol} ·{" "}
                <span className="zf-num text-fg-2">
                  {fmtMoney(quote, toQuote(quote, solUsd, { sol: position?.valueSol ?? 0 }), "exact")}
                </span>
                {quote === "SOL" && " SOL"}
              </>
            ) : (
              "No position"
            )}
          </span>
        </div>
        <div className="grid grid-cols-4 gap-1">
          {sells.map((v, i) => (
            <Button
              // biome-ignore lint/suspicious/noArrayIndexKey: four fixed slots
              key={i}
              data-grid="1"
              variant="sell-tint"
              size="md"
              className={cn(h, "text-data font-semibold")}
              disabled={holding <= 0}
              icon={locked ? <Lock /> : undefined}
              aria-label={sellMode === "pct" ? `Sell ${v}% of ${token.symbol}` : `Sell ${fmtSolShort(v)} SOL of ${token.symbol}`}
              onClick={() =>
                void sell(
                  sellMode === "pct"
                    ? { mint: token.mint, pct: v, source: "instant", wallets }
                    : { mint: token.mint, solValue: v, source: "instant", wallets },
                )
              }
            >
              <span className="zf-num">{sellMode === "pct" ? `${fmtSolShort(v)}%` : fmtSolShort(v)}</span>
            </Button>
          ))}
        </div>
        {!touch && tradeHotkeys && sellHint && <div className="text-micro text-fg-3">{sellHint}</div>}
        <div className="flex items-center gap-2 pt-0.5">
          <Button
            data-grid="2"
            variant="secondary"
            size="xs"
            className={cn("min-w-0 flex-1", touch && "h-11")}
            disabled={holding <= 0 || remaining <= 0}
            title={keys["sell.initials"]?.[0] ? `Sell initials (${compactLabel(keys["sell.initials"][0])})` : "Sell initials"}
            onClick={() => void sellInitials(token.mint, "instant")}
          >
            <span className="truncate">Sell initials · {fmtSol(Math.max(0, remaining))} SOL</span>
          </Button>
          {position && position.boughtSol > 0 && (
            <span className={cn("zf-num shrink-0 text-label", signClass(pnl))}>
              {fmtSignedSol(pnl)} SOL ({fmtPnlPct(pnl, position.boughtSol)})
            </span>
          )}
        </div>
      </div>
    </>
  );
}

function Header({
  token,
  showTicker,
  onClose,
  dragHandlers,
  onToggleCollapse,
}: {
  token: TokenSummary | null;
  showTicker: boolean;
  onClose: () => void;
  dragHandlers?: {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => void;
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => void;
    onPointerUp: (e: PointerEvent<HTMLDivElement>) => void;
  };
  onToggleCollapse?: () => void;
}) {
  const tradeHotkeys = useSettings((s) => s.tradeHotkeys);
  const setTradeHotkeys = useSettings((s) => s.setTradeHotkeys);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the header is the drag handle; every control inside is a button
    <div
      className="flex h-7 items-center gap-1 border-b border-hairline px-1 select-none"
      onPointerDown={dragHandlers?.onPointerDown}
      onPointerMove={dragHandlers?.onPointerMove}
      onPointerUp={dragHandlers?.onPointerUp}
      onPointerCancel={dragHandlers?.onPointerUp}
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).closest("button")) onToggleCollapse?.();
      }}
    >
      <PresetSwitch size="xs" />
      <button
        type="button"
        aria-pressed={tradeHotkeys}
        aria-label={tradeHotkeys ? "Trade hotkeys on" : "Trade hotkeys off"}
        title={tradeHotkeys ? "Trade hotkeys on (hold Space)" : "Trade hotkeys off"}
        onClick={() => setTradeHotkeys(!tradeHotkeys)}
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-xs transition-colors",
          tradeHotkeys ? "bg-surface-3 text-fg-1" : "text-fg-3 hover:text-fg-1",
        )}
      >
        <Keyboard className="icon-sm" />
      </button>
      <div className={cn("flex min-w-0 flex-1 items-center justify-center", dragHandlers && "cursor-grab active:cursor-grabbing")}>
        {showTicker && token ? (
          <span className="max-w-[10ch] truncate text-label font-semibold text-fg-1" title={`Target: ${token.name}`}>
            {token.symbol}
          </span>
        ) : (
          <GripHorizontal className="icon-sm text-fg-3" aria-hidden="true" />
        )}
      </div>
      <WalletPicker />
      <button
        type="button"
        aria-label="Close Instant Trade"
        title="Close Instant Trade"
        onClick={onClose}
        className="flex size-5 shrink-0 items-center justify-center rounded-xs text-fg-3 transition-colors hover:bg-surface-3 hover:text-fg-1"
      >
        <X className="icon-sm" />
      </button>
    </div>
  );
}

export function InstantTradeWindow() {
  const open = useSettings((s) => s.instant.open);
  const setInstant = useSettings((s) => s.setInstant);
  const desktop = useMediaQuery("(min-width: 768px)");
  const token = useTarget();
  const location = useLocation();
  const onTokenPage = token !== null && location.pathname === `/t/${token.mint}`;
  const panelRef = useRef<HTMLDivElement>(null);
  const [saved, setSaved] = useState<Saved>(() => load());
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ dx: number; dy: number; startX: number; startY: number; origin: { x: number; y: number }; moved: boolean } | null>(
    null,
  );

  const size = useCallback(() => {
    const el = panelRef.current;
    return { w: el?.offsetWidth ?? 296, h: el?.offsetHeight ?? 320 };
  }, []);

  // Place on open, on breakpoint changes and when the page under it changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the route is a trigger for the default position
  useLayoutEffect(() => {
    if (!open || !desktop) return;
    const place = () => {
      const { w, h } = size();
      const p = load().pos[breakpoint()];
      setPos(p ? clampToScreen(p.x, p.y, w, h) : defaultPos(w, h));
    };
    place();
    const raf = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", place);
    };
  }, [open, desktop, size, location.pathname]);

  useEffect(() => {
    if (!drag.current) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || !drag.current) return;
      e.preventDefault();
      e.stopPropagation();
      setPos(drag.current.origin);
      drag.current = null;
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const persist = (next: Saved) => {
    setSaved(next);
    save(next);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    const p = pos ?? { x: 0, y: 0 };
    drag.current = { dx: e.clientX - p.x, dy: e.clientY - p.y, startX: e.clientX, startY: e.clientY, origin: p, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 3) return;
    d.moved = true;
    const { w, h } = size();
    setPos(clampToScreen(e.clientX - d.dx, e.clientY - d.dy, w, h));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d?.moved || !pos) return;
    const { w, h } = size();
    const snapped = snap(pos.x, pos.y, w, h);
    setPos(snapped);
    persist({ ...saved, pos: { ...saved.pos, [breakpoint()]: { x: Math.round(snapped.x), y: Math.round(snapped.y) } } });
  };

  /** Arrow keys move between the buttons of the grids (DESIGN.md 6.4); Esc only blurs. */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      (document.activeElement as HTMLElement | null)?.blur();
      e.stopPropagation();
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    const active = document.activeElement as HTMLElement | null;
    if (!active?.dataset.grid) return;
    const buttons = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>("button[data-grid]:not(:disabled)") ?? []);
    const rows = [0, 1, 2].map((r) => buttons.filter((b) => b.dataset.grid === String(r)));
    const row = Number(active.dataset.grid);
    const col = rows[row]?.indexOf(active as HTMLButtonElement) ?? 0;
    let target: HTMLButtonElement | undefined;
    if (e.key === "ArrowLeft") target = rows[row]?.[col - 1];
    else if (e.key === "ArrowRight") target = rows[row]?.[col + 1];
    else {
      const step = e.key === "ArrowUp" ? -1 : 1;
      for (let r = row + step; r >= 0 && r < rows.length && !target; r += step) {
        const list = rows[r] ?? [];
        target = list[Math.min(col, list.length - 1)];
      }
    }
    if (target) {
      e.preventDefault();
      target.focus();
    }
  };

  if (!open) return null;

  if (!desktop) {
    return (
      <BottomSheet open onClose={() => setInstant({ open: false })} title={token ? `Instant Trade · ${token.symbol}` : "Instant Trade"}>
        {token ? (
          <div>
            <div className="flex h-11 items-center gap-2 px-3">
              <PresetSwitch size="sm" />
            </div>
            <TradeGrid token={token} touch />
          </div>
        ) : (
          <p className="p-3 text-data text-fg-3">Open a token to trade it here.</p>
        )}
      </BottomSheet>
    );
  }

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={token ? `Instant Trade, ${token.symbol}` : "Instant Trade"}
      onKeyDown={onKeyDown}
      className="zf-in-pop fixed z-dock w-74 overflow-hidden rounded-md border border-hairline-strong bg-floating shadow-e2 in-data-[density=comfortable]:w-80"
      style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999 }}
    >
      <Header
        token={token}
        showTicker={!onTokenPage}
        onClose={() => setInstant({ open: false })}
        dragHandlers={{ onPointerDown, onPointerMove, onPointerUp }}
        onToggleCollapse={() => persist({ ...saved, collapsed: !saved.collapsed })}
      />
      {!saved.collapsed &&
        (token ? (
          <TradeGrid token={token} touch={false} />
        ) : (
          <p className="p-3 text-data text-fg-3">Open a token or hover a Pulse card to trade it here.</p>
        ))}
    </div>
  );
}
