import { useEffect } from "react";
import { type HotkeyAction, registerHotkey } from "../../lib/hotkeys";
import { buy, sell, sellInitials } from "../../lib/tradeActions";
import type { PulseColumnId } from "../../protocol";
import { useSettings } from "../../state/settings";
import { copyCa, hideToken } from "./actions";
import { columnHandle, pulseTarget, usePulseUi } from "./store";

/** Arrow keys inside these widgets belong to the widget, not to the Pulse cursor. */
const ARROW_OWNERS = '[role="radiogroup"],[role="tablist"],[role="menu"],[role="slider"],[role="listbox"],[role="dialog"]';

function arrowsOwned(): boolean {
  const el = document.activeElement;
  return el instanceof Element && el.closest(ARROW_OWNERS) !== null;
}

function activeColumn(): PulseColumnId | undefined {
  const s = usePulseUi.getState();
  return s.activeColumn && s.order.includes(s.activeColumn) ? s.activeColumn : s.order[0];
}

function focusColumn(column: PulseColumnId | undefined, at?: number): void {
  if (!column) return;
  usePulseUi.getState().setActiveColumn(column);
  columnHandle(column)?.focus(at);
}

/** The target card's column amount and preset (DESIGN.md 4.3: columns may override both). */
function columnTrade(column: PulseColumnId) {
  const s = useSettings.getState();
  const c = s.columns[column];
  const preset = c.preset ?? s.activePreset;
  return { sol: c.quickBuySol ?? s.quickBuySol, preset, amounts: s.presets[preset] };
}

/**
 * Page-level Pulse keys (DESIGN.md 6.4): 1/2/3 and H/L focus a column, J/K and the arrows move
 * the card cursor, C copies, X hides (Undo toast), Shift+X asks to blacklist the dev, F opens
 * filters, P / Shift+P pause, and the Space trade keys act on the hovered card, else the cursor
 * card. With no target nothing is bought. Enter, Mod+Enter, Home and End are registered by the
 * focused column itself. Lock, feed-loss and risk-confirm rules live in tradeActions. Keys with
 * nothing to act on decline (return false), so arrows still reach a focused control.
 */
export function usePulseHotkeys(): void {
  useEffect(() => {
    const ui = usePulseUi.getState;
    const withTarget = (fn: (mint: string, column: PulseColumnId) => void) => () => {
      const t = pulseTarget();
      if (!t) return false;
      fn(t.mint, t.column);
    };
    const step = (dir: 1 | -1) => () => {
      if (arrowsOwned()) return false;
      const order = ui().order;
      const current = activeColumn();
      const at = columnHandle(current)?.cursorIndex() ?? -1;
      const i = current ? order.indexOf(current) : -1;
      focusColumn(order[Math.min(order.length - 1, Math.max(0, i + dir))], at >= 0 ? at : undefined);
    };
    const offs = [
      ...([1, 2, 3] as const).map((n) => registerHotkey(`pulse.col${n}` as HotkeyAction, () => focusColumn(ui().order[n - 1]))),
      registerHotkey("pulse.prevCol", step(-1)),
      registerHotkey("pulse.nextCol", step(1)),
      registerHotkey("pulse.down", () => {
        if (arrowsOwned()) return false;
        columnHandle(activeColumn())?.move(1);
      }),
      registerHotkey("pulse.up", () => {
        if (arrowsOwned()) return false;
        columnHandle(activeColumn())?.move(-1);
      }),
      registerHotkey(
        "pulse.copy",
        withTarget((mint) => copyCa(mint)),
      ),
      registerHotkey(
        "pulse.hide",
        withTarget((mint) => hideToken(mint)),
      ),
      registerHotkey(
        "pulse.blacklistDev",
        withTarget((mint) => ui().askBlacklistDev(mint)),
      ),
      registerHotkey("pulse.filters", () => {
        const c = activeColumn();
        if (c) ui().openFilters(c);
      }),
      registerHotkey("pulse.pause", () => {
        const c = activeColumn();
        if (c) ui().togglePause(c);
      }),
      registerHotkey("pulse.pauseAll", () => ui().togglePauseAll()),
      registerHotkey(
        "buy.quick",
        withTarget((mint, column) => {
          const { sol, preset } = columnTrade(column);
          void buy({ mint, sol, preset, source: "hotkey" });
        }),
      ),
    ];
    for (let i = 0; i < 4; i++) {
      offs.push(
        registerHotkey(
          `buy.${i + 1}` as HotkeyAction,
          withTarget((mint, column) => {
            const { preset, amounts } = columnTrade(column);
            const sol = amounts.instantBuy[i];
            if (sol) void buy({ mint, sol, preset, source: "hotkey" });
          }),
        ),
        registerHotkey(
          `sell.${i + 1}` as HotkeyAction,
          withTarget((mint, column) => {
            const { preset, amounts } = columnTrade(column);
            const pct = amounts.instantSellPct[i];
            if (pct) void sell({ mint, pct, preset, source: "hotkey" });
          }),
        ),
      );
    }
    offs.push(
      registerHotkey(
        "sell.initials",
        withTarget((mint, column) => void sellInitials(mint, "hotkey", columnTrade(column).preset)),
      ),
    );
    return () => {
      for (const off of offs) off();
      usePulseUi.getState().setHover(null);
    };
  }, []);
}
