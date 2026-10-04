import { ChevronDown, Columns3, GripVertical } from "lucide-react";
import { useRef, useState } from "react";
import { Switch } from "../../components/ui/controls";
import { Popover } from "../../components/ui/Popover";
import { COLUMN_TITLE } from "../../config";
import { clamp, cn } from "../../lib/cn";
import type { PulseColumnId } from "../../protocol";
import { useSettings } from "../../state/settings";
import { ToolbarButton } from "./ToolbarButton";

const ROW_H = 28;
/** Pointer moves under 3 px stay clicks (DESIGN.md 6.5). */
const DRAG_SLOP = 3;

/**
 * Columns menu (DESIGN.md 5.1, 6.5): show, hide and reorder the Pulse columns. Reordering
 * happens here, by drag handle or by arrow keys on the handle, never by dragging a live column.
 * Drag handles plus visibility toggles after Shopify's columns popover:
 * https://mobbin.com/screens/909c6cdb-f0a1-4183-ab1c-b64f3f2c9aa2
 */
export function ColumnsMenu() {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const order = useSettings((s) => s.pulseLayout.order);
  const hidden = useSettings((s) => s.pulseLayout.hidden);
  const setPulseLayout = useSettings((s) => s.setPulseLayout);
  const drag = useRef<{ column: PulseColumnId; startY: number; index: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState<PulseColumnId | null>(null);
  const visible = order.filter((c) => !hidden.includes(c));

  const moveTo = (column: PulseColumnId, to: number) => {
    const current = useSettings.getState().pulseLayout.order;
    const next = current.filter((c) => c !== column);
    next.splice(clamp(to, 0, next.length), 0, column);
    if (next.some((c, i) => c !== current[i])) setPulseLayout({ order: next });
  };

  return (
    <>
      <ToolbarButton ref={anchor} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Columns3 />
        Columns
        <ChevronDown className="text-fg-3" />
      </ToolbarButton>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} width={240}>
        <div className="zf-group-label px-2 pt-2 pb-1">Columns</div>
        <ul aria-label="Pulse columns">
          {order.map((c, i) => {
            const shown = !hidden.includes(c);
            const title = COLUMN_TITLE[c];
            return (
              <li key={c} className={cn("flex h-7 items-center gap-1 rounded-sm pr-2 pl-0.5", dragging === c && "bg-surface-3")}>
                <button
                  type="button"
                  aria-label={`Move ${title}. Use the up and down arrow keys.`}
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId);
                    drag.current = { column: c, startY: e.clientY, index: i, moved: false };
                  }}
                  onPointerMove={(e) => {
                    const d = drag.current;
                    if (!d) return;
                    const dy = e.clientY - d.startY;
                    if (!d.moved && Math.abs(dy) < DRAG_SLOP) return;
                    d.moved = true;
                    setDragging(d.column);
                    moveTo(d.column, d.index + Math.round(dy / ROW_H));
                  }}
                  onPointerUp={() => {
                    drag.current = null;
                    setDragging(null);
                  }}
                  onPointerCancel={() => {
                    drag.current = null;
                    setDragging(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                      e.preventDefault();
                      moveTo(c, i + (e.key === "ArrowUp" ? -1 : 1));
                    }
                  }}
                  className="focus-inset flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-xs text-fg-3 transition-colors hover:text-fg-1 active:cursor-grabbing"
                >
                  <GripVertical className="icon-sm" />
                </button>
                <span className={cn("min-w-0 flex-1 truncate text-data", shown ? "text-fg-1" : "text-fg-3")}>{title}</span>
                <Switch
                  checked={shown}
                  disabled={shown && visible.length === 1}
                  onChange={(on) => setPulseLayout({ hidden: on ? hidden.filter((x) => x !== c) : [...hidden, c] })}
                  label={`Show ${title}`}
                />
              </li>
            );
          })}
        </ul>
        <div className="px-2 pt-1 pb-1.5 text-label text-fg-3">Drag a handle or use the arrow keys to reorder.</div>
      </Popover>
    </>
  );
}
