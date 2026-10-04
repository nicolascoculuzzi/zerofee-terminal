import { type KeyboardEvent, type PointerEvent, type RefObject, useRef } from "react";
import { DEFAULT_SPLIT } from "./tokenUi";

/** Minimum heights (DESIGN.md 5.2, 6.5): chart 240 px, tables 160 px. */
export const MIN_CHART = 240;
export const MIN_TABLES = 160;

/** Clamps a chart share so both panels keep their minimum heights. */
export function clampSplit(split: number, height: number): number {
  if (!(height > MIN_CHART + MIN_TABLES)) return split;
  const min = MIN_CHART / height;
  const max = 1 - MIN_TABLES / height;
  return Math.min(max, Math.max(min, split));
}

/**
 * Token-page splitter between chart and tables (DESIGN.md 6.5): a 1 px hairline with an 8 px hit
 * area, pointer capture, moves under 3 px ignored, double-click resets to 56%, Up/Down move 16 px
 * (Shift 64 px), Home/End go to the limits. The share is persisted per user.
 */
export function Splitter({
  container,
  split,
  onChange,
}: {
  container: RefObject<HTMLElement | null>;
  split: number;
  onChange: (split: number) => void;
}) {
  const drag = useRef<{ startY: number; moved: boolean } | null>(null);
  const height = () => container.current?.getBoundingClientRect().height ?? 0;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    drag.current = { startY: e.clientY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const el = container.current;
    if (!d || !el) return;
    if (!d.moved && Math.abs(e.clientY - d.startY) < 3) return;
    d.moved = true;
    const r = el.getBoundingClientRect();
    onChange(clampSplit((e.clientY - r.top) / r.height, r.height));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const h = height();
    if (!h) return;
    const px = e.shiftKey ? 64 : 16;
    let next: number | null = null;
    if (e.key === "ArrowUp") next = split - px / h;
    else if (e.key === "ArrowDown") next = split + px / h;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = 1;
    else if (e.key === "Enter") next = DEFAULT_SPLIT;
    if (next === null) return;
    e.preventDefault();
    onChange(clampSplit(next, h));
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable window splitter, not a static separator
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-label="Resize chart and tables (Up/Down, Enter resets)"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(split * 100)}
      title="Drag to resize · double-click resets"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onChange(clampSplit(DEFAULT_SPLIT, height()))}
      onKeyDown={onKeyDown}
      className="focus-inset group relative z-sticky h-px shrink-0 cursor-row-resize touch-none bg-hairline"
    >
      <span aria-hidden="true" className="absolute inset-x-0 -top-1 -bottom-1" />
      <span aria-hidden="true" className="absolute inset-x-0 top-0 h-px bg-transparent transition-colors group-hover:bg-fg-3" />
    </div>
  );
}
