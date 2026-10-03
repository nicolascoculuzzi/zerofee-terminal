import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { pushOverlay } from "../../lib/overlayStack";

/*
 * Modal anatomy follows Linear's dialogs: compact title row with a close button, hairline
 * sections, actions bottom-right; flat surface over a dim scrim (no blur, no shadow).
 * https://mobbin.com/screens/eddaff7c-37b8-4382-b53c-e4e09c1003d0
 */

function useOverlayBehaviour(open: boolean, onClose: () => void, panel: React.RefObject<HTMLElement | null>) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const pop = pushOverlay(() => closeRef.current());
    const t = setTimeout(() => {
      const el = panel.current;
      if (!el) return;
      const target = el.querySelector<HTMLElement>("[data-autofocus]") ?? el;
      target.focus({ preventScroll: true });
    }, 10);
    return () => {
      clearTimeout(t);
      pop();
      previous?.focus?.({ preventScroll: true });
    };
  }, [open, panel]);
}

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Max width in px (layout constraint, not a visual token). */
  width?: number;
  className?: string;
  bodyClassName?: string;
  /** Hide the header row (custom layouts). */
  bare?: boolean;
  label?: string;
}

export function Modal({ open, onClose, title, children, footer, width = 480, className, bodyClassName, bare, label }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  useOverlayBehaviour(open, onClose, panel);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-start justify-center overflow-y-auto bg-scrim p-3 pt-[8vh] sm:p-6 sm:pt-[10vh]">
      <button type="button" aria-label="Close dialog" className="fixed inset-0 cursor-default" onClick={onClose} tabIndex={-1} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label ?? (typeof title === "string" ? title : undefined)}
        tabIndex={-1}
        style={{ maxWidth: width }}
        className={cn("relative flex max-h-[84vh] w-full flex-col rounded-xl border border-line-strong bg-panel outline-none", className)}
      >
        {!bare && (
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-line pr-2 pl-4">
            <div className="text-base font-semibold">{title}</div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex size-6 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg"
            >
              <X className="icon-md" />
            </button>
          </div>
        )}
        <div className={cn("min-h-0 flex-1 overflow-y-auto", !bare && "p-4", bodyClassName)}>{children}</div>
        {footer && <div className="shrink-0 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  width?: number;
  headerExtra?: ReactNode;
}

/* Side drawer, after Uniswap's settings drawer: https://mobbin.com/screens/debc076d-b186-42b2-8c23-b1fae356c2d1 */
export function Drawer({ open, onClose, title, children, width = 560, headerExtra }: DrawerProps) {
  const panel = useRef<HTMLDivElement>(null);
  useOverlayBehaviour(open, onClose, panel);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[110] flex justify-end bg-scrim">
      <button type="button" aria-label="Close panel" className="absolute inset-0 cursor-default" onClick={onClose} tabIndex={-1} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : "Panel"}
        tabIndex={-1}
        style={{ maxWidth: width }}
        className="relative flex h-full w-full flex-col border-l border-line-strong bg-panel outline-none"
      >
        <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line pr-2 pl-4">
          <div className="text-md font-semibold">{title}</div>
          <div className="ml-auto flex items-center gap-2">
            {headerExtra}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex size-6 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg"
            >
              <X className="icon-md" />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
