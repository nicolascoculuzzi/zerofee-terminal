import { ChevronDown, GripHorizontal, Keyboard, Pencil, Wallet, X } from "lucide-react";
import { type PointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { Checkbox, Segmented } from "../../components/ui/controls";
import { Popover } from "../../components/ui/Popover";
import { cn } from "../../lib/cn";
import { fmtSol, fmtSolShort, fmtTokens } from "../../lib/format";
import { compactLabel, type HotkeyAction } from "../../lib/hotkeys";
import { buy, sell, sellInitials } from "../../lib/tradeActions";
import { useMarket } from "../../state/market";
import { useSettings } from "../../state/settings";
import { useToken } from "../../state/token";
import { useUi } from "../../state/ui";
import { useWallet } from "../../state/wallet";
import { PresetSettingsRow, PresetSwitch } from "./PresetSettings";

/** Matches the w-72 class (288px) for viewport clamping. */
const WIDTH = 288;
const MARGIN = 8;

function clampPos(x: number, y: number, h: number): { x: number; y: number } {
  return {
    x: Math.min(window.innerWidth - WIDTH - MARGIN, Math.max(MARGIN, x)),
    y: Math.min(window.innerHeight - h - MARGIN, Math.max(MARGIN, y)),
  };
}

function HotkeyHint({ action }: { action: HotkeyAction }) {
  const binding = useSettings((s) => s.hotkeys[action]?.[0]);
  const on = useSettings((s) => s.tradeHotkeys);
  if (!on || !binding) return null;
  return <span className="font-mono text-2xs opacity-60">{compactLabel(binding)}</span>;
}

function WalletPicker() {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const allWallets = useWallet((s) => s.service.tradingWallets);
  const wallets = allWallets.filter((w) => !w.archived);
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
        className="flex h-6 items-center gap-1 rounded-md border border-line px-2 text-xs text-muted hover:text-fg"
        title="Wallets used by this window"
      >
        <Wallet className="icon-xs" />
        {count}
        <ChevronDown className="icon-xs" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} align="end" width={240}>
        <div className="space-y-2 p-1">
          <div className="zf-label">Trade with</div>
          {wallets.map((w) => {
            const on = effective.length > 0 ? effective.includes(w.address) : w.address === activeAddress;
            return (
              <Checkbox
                key={w.id}
                checked={on}
                onChange={() => toggle(w.address)}
                label={
                  <span className="flex w-40 justify-between gap-2">
                    <span>{w.label}</span>
                    <span className="text-muted">{fmtSol(status[w.address]?.solBalance ?? 0)} SOL</span>
                  </span>
                }
              />
            );
          })}
          <p className="text-2xs text-dim">With several wallets selected, each one places the full amount.</p>
        </div>
      </Popover>
    </>
  );
}

/**
 * Instant Trade: a draggable floating window that remembers its position. P1–P3, wallet
 * picker, four buy buttons, four sell buttons (% or SOL), Sell Init., hotkey hints, no confirm.
 * Layout follows Axiom's Instant Trade popup; window chrome is flat with hairlines.
 */
export function InstantTradeWindow() {
  const instant = useSettings((s) => s.instant);
  const setInstant = useSettings((s) => s.setInstant);
  const preset = useSettings((s) => s.presets[s.activePreset]);
  const tradeHotkeys = useSettings((s) => s.tradeHotkeys);
  const setTradeHotkeys = useSettings((s) => s.setTradeHotkeys);
  const openSettings = useUi((s) => s.openSettings);
  const mint = useUi((s) => s.focusedMint);
  const detail = useToken((s) => (s.detail && s.detail.summary.mint === mint ? s.detail : null));
  const marketToken = useMarket((s) => (mint ? s.tokens[mint] : undefined));
  const token = detail?.summary ?? marketToken ?? null;
  const activeAddress = useWallet((s) => s.activeAddress);
  const status = useWallet((s) => (activeAddress ? s.status[activeAddress] : undefined));
  const position = status?.positions.find((p) => p.mint === mint) ?? null;
  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const wallets = instant.wallets;

  // Initial placement: remembered position, else bottom-right above the status bar.
  useEffect(() => {
    if (!instant.open) return;
    const h = panelRef.current?.offsetHeight ?? 320;
    const start =
      instant.x >= 0 && instant.y >= 0
        ? { x: instant.x, y: instant.y }
        : { x: window.innerWidth - WIDTH - 24, y: window.innerHeight - h - 48 };
    setPos(clampPos(start.x, start.y, h));
    const onResize = () => setPos((p) => (p ? clampPos(p.x, p.y, panelRef.current?.offsetHeight ?? h) : p));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [instant.open, instant.x, instant.y]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const p = pos ?? { x: 0, y: 0 };
    drag.current = { dx: e.clientX - p.x, dy: e.clientY - p.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const h = panelRef.current?.offsetHeight ?? 320;
    setPos(clampPos(e.clientX - drag.current.dx, e.clientY - drag.current.dy, h));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (pos) setInstant({ x: Math.round(pos.x), y: Math.round(pos.y) });
  };

  const run = useCallback(
    (fn: () => void) => {
      if (!mint) return;
      fn();
    },
    [mint],
  );

  if (!instant.open) return null;
  const sellMode = instant.sellMode;
  const balance = status ? Math.max(0, status.solBalance - status.reservedSol) : 0;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Instant Trade"
      className="fixed z-[95] w-72 rounded-lg border border-line-strong bg-panel"
      style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999 }}
    >
      <div
        className="flex h-8 cursor-grab items-center gap-1 border-b border-line px-2 active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <GripHorizontal className="icon-sm text-dim" />
        <button
          type="button"
          aria-pressed={tradeHotkeys}
          onClick={() => setTradeHotkeys(!tradeHotkeys)}
          title={tradeHotkeys ? "Hotkeys on (hold Space + key)" : "Hotkeys off"}
          className={cn("flex size-6 items-center justify-center rounded-md", tradeHotkeys ? "bg-elev text-fg" : "text-dim hover:text-fg")}
        >
          <Keyboard className="icon-sm" />
        </button>
        <PresetSwitch size="xs" />
        <button
          type="button"
          aria-label="Edit presets"
          title="Edit presets"
          onClick={() => openSettings("presets")}
          className="flex size-6 items-center justify-center text-dim hover:text-fg"
        >
          <Pencil className="icon-xs" />
        </button>
        <div className="ml-auto flex items-center gap-1">
          <WalletPicker />
          <button
            type="button"
            aria-label="Close Instant Trade"
            onClick={() => setInstant({ open: false })}
            className="flex size-6 items-center justify-center text-dim hover:text-fg"
          >
            <X className="icon-sm" />
          </button>
        </div>
      </div>

      {!token ? (
        <div className="px-3 py-4 text-sm text-dim">Open a token to trade it from here.</div>
      ) : (
        <div className="space-y-3 p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-sm font-semibold">{token.symbol}</span>
            <span className="text-dim">
              {wallets.length > 1 ? `${wallets.length} wallets` : "Balance"} <span className="text-fg">{fmtSol(balance)} SOL</span>
            </span>
          </div>

          <div className="space-y-1">
            <span className="zf-label">Buy</span>
            <div className="grid grid-cols-4 gap-1">
              {preset.instantBuy.map((sol, i) => (
                <button
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed four slots
                  key={i}
                  type="button"
                  onClick={() => run(() => void buy({ mint: token.mint, sol, source: "instant", wallets }))}
                  className="flex h-9 flex-col items-center justify-center rounded-md border border-buy/30 text-sm font-semibold text-buy hover:bg-buy/10"
                >
                  {fmtSolShort(sol)}
                  <HotkeyHint action={`buy.${i + 1}` as HotkeyAction} />
                </button>
              ))}
            </div>
            <PresetSettingsRow side="buy" />
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="zf-label">Sell</span>
              <span className="text-2xs text-dim">
                {position && position.holdingTokens > 0
                  ? `${fmtTokens(position.holdingTokens)} · ${fmtSol(position.valueSol)} SOL`
                  : "No position"}
              </span>
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
            </div>
            <div className="grid grid-cols-4 gap-1">
              {(sellMode === "pct" ? preset.instantSellPct : preset.instantSellSol).map((v, i) => (
                <button
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed four slots
                  key={i}
                  type="button"
                  onClick={() =>
                    run(
                      () =>
                        void sell(
                          sellMode === "pct"
                            ? { mint: token.mint, pct: v, source: "instant", wallets }
                            : { mint: token.mint, solValue: v, source: "instant", wallets },
                        ),
                    )
                  }
                  className="flex h-9 flex-col items-center justify-center rounded-md border border-sell/30 text-sm font-semibold text-sell hover:bg-sell/10"
                >
                  {sellMode === "pct" ? `${v}%` : fmtSolShort(v)}
                  <HotkeyHint action={`sell.${i + 1}` as HotkeyAction} />
                </button>
              ))}
            </div>
            <PresetSettingsRow side="sell" />
            <button
              type="button"
              onClick={() => run(() => void sellInitials(token.mint, "instant"))}
              className="flex h-7 w-full items-center justify-center gap-2 rounded-md border border-line text-xs font-medium text-fg hover:bg-hover"
              title="Sell the amount whose current value equals the SOL you still have in (bought minus sold)"
            >
              Sell Init.
              <HotkeyHint action="sell.initials" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
