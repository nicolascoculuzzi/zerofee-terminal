import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom";
  delay?: number;
  className?: string;
  /** Classes for the trigger wrapper. */
  wrapperClassName?: string;
  maxWidth?: number;
}

/** Hover/focus tooltip rendered in a portal so it never clips inside scroll containers. */
export function Tooltip({ content, children, side = "top", delay = 220, className, wrapperClassName, maxWidth = 280 }: TooltipProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number; side: "top" | "bottom" } | null>(null);

  const show = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), delay);
  }, [delay]);

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
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
    if (s === "top" && r.top - h - 8 < 4) s = "bottom";
    if (s === "bottom" && r.bottom + h + 8 > window.innerHeight - 4) s = "top";
    const x = Math.min(window.innerWidth - w - 6, Math.max(6, r.left + r.width / 2 - w / 2));
    const y = s === "top" ? r.top - h - 6 : r.bottom + 6;
    setPos({ x, y, side: s });
  }, [open, side]);

  if (content === null || content === undefined || content === "") return <>{children}</>;

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: hover/focus wrapper only; the wrapped child stays the interactive element */}
      <span
        ref={ref}
        className={cn("inline-flex min-w-0", wrapperClassName)}
        onPointerEnter={show}
        onPointerLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        {children}
      </span>
      {open &&
        createPortal(
          <div
            ref={tipRef}
            role="tooltip"
            style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999, maxWidth }}
            className={cn(
              "pointer-events-none fixed z-[200] rounded-md border border-line-strong bg-elev px-2 py-1.5 text-[11px] leading-snug text-fg shadow-pop",
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
