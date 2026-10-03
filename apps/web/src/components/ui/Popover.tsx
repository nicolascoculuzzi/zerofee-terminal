import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { pushOverlay } from "../../lib/overlayStack";
import { LayerContext, usePopoverZ } from "./layer";

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  children: ReactNode;
  align?: "start" | "end";
  className?: string;
  /** Width in px (layout constraint). */
  width?: number;
  /** "menu" (4px padding) or "form" (12px padding), DESIGN.md 4.17. */
  padding?: "menu" | "form" | "none";
}

/**
 * Anchored menu or panel in a portal (DESIGN.md 4.17): 6px radius, floating surface,
 * hairline-strong border, e1, 4px from its anchor, flips to stay on screen. Closes on outside
 * pointerdown, Esc, or another click on the anchor. Inside a modal or drawer it stacks at the
 * parent's z + 10. After OKX's menus with right-aligned hints:
 * https://mobbin.com/screens/a2bb80c5-27d1-4a5e-a87e-7c852a2d38f3
 */
export function Popover({ open, onClose, anchor, children, align = "start", className, width, padding = "menu" }: PopoverProps) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const z = usePopoverZ();

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
    <LayerContext.Provider value={z}>
      <div
        ref={panel}
        style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width, zIndex: z }}
        className={cn(
          "zf-in-pop fixed rounded-md border border-hairline-strong bg-floating shadow-e1",
          padding === "menu" && "p-1",
          padding === "form" && "p-3",
          className,
        )}
      >
        {children}
      </div>
    </LayerContext.Provider>,
    document.body,
  );
}

/** Menu row (DESIGN.md 4.17): 28px, 14px icon in text-3, 12px label, keycaps or a chevron on the right. */
export function MenuItem({
  icon,
  children,
  hint,
  onSelect,
  danger,
  checked,
  disabled,
  className,
}: {
  icon?: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  checked?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      {...(checked === undefined ? { role: "menuitem" } : { role: "menuitemcheckbox", "aria-checked": checked })}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "focus-inset flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-data transition-colors hover:bg-surface-3 disabled:text-fg-4",
        danger ? "text-sell" : "text-fg-1",
        className,
      )}
    >
      {icon && <span className={cn("flex shrink-0 [&_svg]:size-3.5", danger ? "text-sell" : "text-fg-3")}>{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="flex shrink-0 items-center text-label text-fg-3">{hint}</span>}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-hairline" />;
}

export function MenuGroupLabel({ children }: { children: ReactNode }) {
  return <div className="zf-group-label px-2 pt-2 pb-1">{children}</div>;
}
