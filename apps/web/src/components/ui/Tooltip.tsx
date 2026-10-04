import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { Z } from "./layer";

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom";
  className?: string;
  /** Classes for the trigger wrapper. */
  wrapperClassName?: string;
  /** Max width in px (DESIGN.md 4.14: 280). */
  maxWidth?: number;
}

/** Skip the hover delay when another tooltip closed less than 500 ms ago (DESIGN.md 4.14). */
let lastClosedAt = 0;
const DELAY_MS = 400;
const SKIP_MS = 500;

/**
 * Hover/focus tooltip in a portal (never clipped by scroll containers). 400 ms hover delay,
 * immediate on focus or right after another tooltip; 6px radius, tooltip surface,
 * hairline-strong border, e1, no arrow, pointer-events none.
 */
export function Tooltip({ content, children, side = "top", className, wrapperClassName, maxWidth = 280 }: TooltipProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const show = useCallback((immediate: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    if (immediate || Date.now() - lastClosedAt < SKIP_MS) {
      setOpen(true);
      return;
    }
    timer.current = setTimeout(() => setOpen(true), DELAY_MS);
  }, []);

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setOpen((was) => {
      if (was) lastClosedAt = Date.now();
      return false;
    });
    setPos(null);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const tip = tipRef.current?.getBoundingClientRect();
    const w = tip?.width ?? 200;
    const h = tip?.height ?? 40;
    let s = side;
    if (s === "top" && r.top - h - 6 < 4) s = "bottom";
    if (s === "bottom" && r.bottom + h + 6 > window.innerHeight - 4) s = "top";
    const x = Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2));
    const y = s === "top" ? r.top - h - 6 : r.bottom + 6;
    setPos({ x, y });
  }, [open, side]);

  if (content === null || content === undefined || content === "") return <>{children}</>;

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: hover/focus wrapper only; the wrapped child stays the interactive element */}
      <span
        ref={ref}
        className={cn("inline-flex min-w-0", wrapperClassName)}
        onPointerEnter={(e) => {
          if (e.pointerType !== "touch") show(false);
        }}
        onPointerLeave={hide}
        onFocus={() => show(true)}
        onBlur={hide}
      >
        {children}
      </span>
      {open &&
        createPortal(
          <div
            ref={tipRef}
            role="tooltip"
            style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999, maxWidth, zIndex: Z.tooltip }}
            className={cn(
              "pointer-events-none fixed rounded-md border border-hairline-strong bg-tooltip px-2.5 py-2 text-label text-fg-1 shadow-e1",
              className,
            )}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
