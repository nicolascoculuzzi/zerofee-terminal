import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Z } from "../../components/ui/layer";

/** Same timing as the shared Tooltip (DESIGN.md 4.14): 400 ms delay, instant within 500 ms of the last one. */
const DELAY_MS = 400;
const SKIP_MS = 500;

export interface TipRequest {
  el: HTMLElement;
  tip: string;
  mint: string | null;
  column: string | null;
}

/**
 * One tooltip for every Pulse card (DESIGN.md 8: a Tooltip wrapper per chip and counter would
 * double a card's DOM). Elements carry `data-tip="<key>"`; the closest `[data-mint]` names the
 * token. Hover waits 400 ms, keyboard focus shows at once, a press, scroll or wheel hides it.
 * The box matches the shared Tooltip: tooltip surface, hairline-strong border, e1, 6 px radius,
 * 8 × 10 px padding, at most 280 px wide, above the anchor (flipping below), 6 px away, no
 * arrow, pointer-events none. Touch never opens it.
 */
export function TipLayer({ root, render }: { root: RefObject<HTMLElement | null>; render: (req: TipRequest) => ReactNode }) {
  const [open, setOpen] = useState<TipRequest | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = root.current;
    if (!host) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let current: HTMLElement | null = null;
    let shown = false;
    let lastClosed = 0;

    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const hide = (keep?: HTMLElement | null) => {
      clear();
      current = keep ?? null;
      if (shown) lastClosed = Date.now();
      shown = false;
      setOpen(null);
    };
    const tipOf = (node: EventTarget | null): HTMLElement | null =>
      node instanceof Element ? node.closest<HTMLElement>("[data-tip]") : null;
    const request = (el: HTMLElement): TipRequest => {
      const card = el.closest<HTMLElement>("[data-mint]");
      return { el, tip: el.dataset.tip ?? "", mint: card?.dataset.mint ?? null, column: card?.dataset.col ?? null };
    };
    const show = (el: HTMLElement, immediate: boolean) => {
      if (current === el) return;
      const wasShown = shown;
      hide();
      current = el;
      const go = () => {
        shown = true;
        setOpen(request(el));
      };
      if (immediate || wasShown || Date.now() - lastClosed < SKIP_MS) go();
      else timer = setTimeout(go, DELAY_MS);
    };

    const onOver = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const el = tipOf(e.target);
      if (el) show(el, false);
      else if (current) hide();
    };
    const onLeave = () => {
      if (current) hide();
    };
    const onFocusIn = (e: FocusEvent) => {
      const el = tipOf(e.target);
      if (el && (e.target as Element).matches(":focus-visible")) show(el, true);
    };
    const onFocusOut = () => {
      if (current) hide();
    };
    // A press dismisses the tip, and it stays dismissed until the pointer moves to another element.
    const onDown = (e: PointerEvent) => hide(tipOf(e.target));
    const onScroll = () => {
      if (current) hide();
    };

    host.addEventListener("pointerover", onOver);
    host.addEventListener("pointerleave", onLeave);
    host.addEventListener("focusin", onFocusIn);
    host.addEventListener("focusout", onFocusOut);
    host.addEventListener("pointerdown", onDown, true);
    host.addEventListener("scroll", onScroll, true);
    host.addEventListener("wheel", onScroll, { passive: true });
    return () => {
      clear();
      host.removeEventListener("pointerover", onOver);
      host.removeEventListener("pointerleave", onLeave);
      host.removeEventListener("focusin", onFocusIn);
      host.removeEventListener("focusout", onFocusOut);
      host.removeEventListener("pointerdown", onDown, true);
      host.removeEventListener("scroll", onScroll, true);
      host.removeEventListener("wheel", onScroll);
    };
  }, [root]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    if (!open.el.isConnected) {
      setOpen(null);
      return;
    }
    const r = open.el.getBoundingClientRect();
    const tip = tipRef.current?.getBoundingClientRect();
    const w = tip?.width ?? 200;
    const h = tip?.height ?? 40;
    const above = r.top - h - 6 >= 4;
    const x = Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2));
    const y = above ? r.top - h - 6 : Math.min(window.innerHeight - h - 4, r.bottom + 6);
    setPos({ x, y });
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div
      ref={tipRef}
      role="tooltip"
      style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999, maxWidth: 280, zIndex: Z.tooltip }}
      className="pointer-events-none fixed rounded-md border border-hairline-strong bg-tooltip px-2.5 py-2 text-label text-fg-1 shadow-e1"
    >
      {render(open)}
    </div>,
    document.body,
  );
}
