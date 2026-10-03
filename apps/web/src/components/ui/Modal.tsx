import { X } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { pushOverlay } from "../../lib/overlayStack";
import { LayerContext, Z } from "./layer";

/*
 * Modals, drawers and sheets per DESIGN.md 4.17: opaque floating surface (surface-2 dark,
 * surface-1 light), hairline-strong border, e2, over an unblurred scrim. Focus is trapped and
 * returns to the trigger. Header anatomy after Linear's dialogs:
 * https://mobbin.com/screens/eddaff7c-37b8-4382-b53c-e4e09c1003d0
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function useOverlayBehaviour(open: boolean, onClose: () => void, panel: RefObject<HTMLElement | null>) {
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
    // Trap Tab inside the panel.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !panel.current) return;
      const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      pop();
      document.removeEventListener("keydown", onKey);
      previous?.focus?.({ preventScroll: true });
    };
  }, [open, panel]);
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close"
      title="Close (Esc)"
      className="flex size-7 shrink-0 items-center justify-center rounded-sm text-fg-3 transition-colors hover:bg-surface-3 hover:text-fg-1"
    >
      <X className="icon-md" />
    </button>
  );
}

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** Optional one-line description under the title (12px text-3). */
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Width presets: 400 (confirm), 560 (forms), 720 (filters), 880 (share). */
  width?: number;
  className?: string;
  bodyClassName?: string;
  /** Hide the header row (custom layouts such as the command palette). */
  bare?: boolean;
  label?: string;
  /** "palette" raises it to the palette layer (DESIGN.md 2.7). */
  layer?: "modal" | "palette";
  /** Distance from the top: 10vh for dialogs, 12vh for the palette. */
  top?: "dialog" | "palette";
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 560,
  className,
  bodyClassName,
  bare,
  label,
  layer = "modal",
  top = "dialog",
}: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  useOverlayBehaviour(open, onClose, panel);
  if (!open) return null;
  const z = layer === "palette" ? Z.palette : Z.modal;
  return createPortal(
    <LayerContext.Provider value={z}>
      <div
        className={cn(
          "zf-in-fade fixed inset-0 flex items-start justify-center overflow-y-auto bg-scrim p-3 sm:p-6",
          top === "palette" ? "pt-[12vh] sm:pt-[12vh]" : "pt-[8vh] sm:pt-[10vh]",
        )}
        style={{ zIndex: z }}
      >
        <button type="button" aria-label="Close dialog" className="fixed inset-0 cursor-default" onClick={onClose} tabIndex={-1} />
        <div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-label={label ?? (typeof title === "string" ? title : undefined)}
          tabIndex={-1}
          style={{ maxWidth: width }}
          className={cn(
            "zf-in-modal relative flex max-h-[84vh] w-full flex-col rounded-lg border border-hairline-strong bg-floating shadow-e2 outline-none",
            className,
          )}
        >
          {!bare && (
            <div className={cn("flex shrink-0 items-center gap-3 border-b border-hairline pr-2 pl-4", description ? "h-15" : "h-11")}>
              <div className="min-w-0 flex-1">
                <div className="truncate text-heading font-semibold text-fg-1">{title}</div>
                {description && <div className="truncate text-data text-fg-3">{description}</div>}
              </div>
              <CloseButton onClose={onClose} />
            </div>
          )}
          <div className={cn("min-h-0 flex-1 overflow-y-auto", !bare && "p-4", bodyClassName)}>{children}</div>
          {footer && <div className="grid min-h-13 shrink-0 items-center border-t border-hairline px-4 py-2">{footer}</div>}
        </div>
      </div>
    </LayerContext.Provider>,
    document.body,
  );
}

/* Bottom sheet for narrow screens, after Phantom's token page sheet: https://mobbin.com/screens/76e93b20-0652-4758-8e2d-4925312a1fba */
export function BottomSheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useOverlayBehaviour(open, onClose, panel);
  if (!open) return null;
  return createPortal(
    <LayerContext.Provider value={Z.drawer}>
      <div className="zf-in-fade fixed inset-0 flex items-end bg-scrim" style={{ zIndex: Z.drawer }}>
        <button type="button" aria-label="Close sheet" className="absolute inset-0 cursor-default" onClick={onClose} tabIndex={-1} />
        <div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-label={typeof title === "string" ? title : "Sheet"}
          tabIndex={-1}
          className="zf-in-sheet relative flex max-h-[88vh] w-full flex-col rounded-t-lg border-t border-hairline-strong bg-floating pb-[env(safe-area-inset-bottom)] shadow-e2 outline-none"
        >
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-hairline pr-2 pl-4">
            <div className="text-heading font-semibold">{title}</div>
            <CloseButton onClose={onClose} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </div>
      </div>
    </LayerContext.Provider>,
    document.body,
  );
}

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  /** 400, 560 or 720 px. */
  width?: 400 | 560 | 720;
  headerExtra?: ReactNode;
}

/* Right drawer (DESIGN.md 4.17), after DoorDash's details drawer: https://mobbin.com/screens/147163b2-eef8-40be-b199-dae113a33d9c */
export function Drawer({ open, onClose, title, children, width = 560, headerExtra }: DrawerProps) {
  const panel = useRef<HTMLDivElement>(null);
  useOverlayBehaviour(open, onClose, panel);
  if (!open) return null;
  return createPortal(
    <LayerContext.Provider value={Z.drawer}>
      <div className="zf-in-fade fixed inset-0 flex justify-end bg-scrim" style={{ zIndex: Z.drawer }}>
        <button type="button" aria-label="Close panel" className="absolute inset-0 cursor-default" onClick={onClose} tabIndex={-1} />
        <div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-label={typeof title === "string" ? title : "Panel"}
          tabIndex={-1}
          style={{ maxWidth: width }}
          className="zf-in-drawer relative flex h-full w-full flex-col border-l border-hairline-strong bg-floating shadow-e2 outline-none"
        >
          <div className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline pr-2 pl-4">
            <div className="text-heading font-semibold">{title}</div>
            <div className="ml-auto flex items-center gap-2">
              {headerExtra}
              <CloseButton onClose={onClose} />
            </div>
          </div>
          <div className="min-h-0 flex-1">{children}</div>
        </div>
      </div>
    </LayerContext.Provider>,
    document.body,
  );
}
