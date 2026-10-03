import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { pushOverlay } from "../../lib/overlayStack";

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  children: ReactNode;
  align?: "start" | "end";
  className?: string;
  /** Width in px (layout constraint). */
  width?: number;
}

/**
 * Anchored menu/panel in a portal; closes on outside click or Escape. Flat elevated surface
 * with a strong hairline, like Coinbase Advanced's timeframe menu
 * (https://mobbin.com/screens/efd4eda6-5b2e-46b1-befb-20a18b06dff2).
 */
export function Popover({ open, onClose, anchor, children, align = "start", className, width }: PopoverProps) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const p = panel.current?.getBoundingClientRect();
      if (!a) return;
      const w = p?.width ?? width ?? 240;
      const h = p?.height ?? 200;
      let left = align === "end" ? a.right - w : a.left;
      left = Math.min(window.innerWidth - w - 8, Math.max(8, left));
      let top = a.bottom + 4;
      if (top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - 4);
      setPos({ left, top });
    };
    place();
    const raf = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", place);
    };
  }, [open, anchor, align, width]);

  useEffect(() => {
    if (!open) return;
    const pop = pushOverlay(() => closeRef.current());
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panel.current?.contains(target) || anchor.current?.contains(target)) return;
      closeRef.current();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      pop();
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [open, anchor]);

  if (!open) return null;
  return createPortal(
    <div
      ref={panel}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width }}
      className={cn("fixed z-[150] rounded-lg border border-line-strong bg-elev p-2", className)}
    >
      {children}
    </div>,
    document.body,
  );
}
