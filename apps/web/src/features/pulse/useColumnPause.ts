import { type FocusEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import type { PulseColumnId } from "../../protocol";
import { usePulseUi } from "./store";

/** After a finger lifts, a touch list stays still this long (so a tap never lands on a card that just moved). */
const TOUCH_HOLD_MS = 1500;

/**
 * Why a column is paused (DESIGN.md 6.7): the pointer is over it, keyboard focus is inside it
 * (focus left behind by a mouse click doesn't count), a finger is on it, or the trader pressed
 * P (this column) or Shift+P (all columns).
 */
export function useColumnPause(column: PulseColumnId) {
  const manual = usePulseUi((s) => s.paused[column]);
  const all = usePulseUi((s) => s.pausedAll);
  const [hovered, setHovered] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const [touching, setTouching] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const touchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (touchTimer.current) clearTimeout(touchTimer.current);
    },
    [],
  );

  const recheckFocus = () =>
    queueMicrotask(() => {
      const el = ref.current;
      const active = document.activeElement;
      setKeyboard(!!el && !!active && el.contains(active) && active.matches(":focus-visible"));
    });

  const handlers = {
    onPointerEnter: (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      setHovered(true);
      usePulseUi.getState().setActiveColumn(column);
    },
    onPointerLeave: (e: PointerEvent) => {
      if (e.pointerType !== "touch") setHovered(false);
    },
    onPointerDown: (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      if (touchTimer.current) clearTimeout(touchTimer.current);
      setTouching(true);
    },
    onPointerUp: (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      if (touchTimer.current) clearTimeout(touchTimer.current);
      touchTimer.current = setTimeout(() => setTouching(false), TOUCH_HOLD_MS);
    },
    onFocus: (_e: FocusEvent) => {
      usePulseUi.getState().setActiveColumn(column);
      recheckFocus();
    },
    onBlur: (_e: FocusEvent) => recheckFocus(),
  };

  return {
    ref,
    paused: hovered || keyboard || touching || manual || all,
    /** Paused by P or Shift+P (the header chip stays until it is lifted). */
    held: manual || all,
    keyboard,
    handlers: { ...handlers, onPointerCancel: handlers.onPointerUp },
  };
}
