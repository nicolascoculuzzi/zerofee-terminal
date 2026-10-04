import { type KeyboardEvent, type PointerEvent, useRef } from "react";
import { cn } from "../../lib/cn";

/**
 * Slider (DESIGN.md 4.23): a 2 px surface-3 track, accent fill from the origin to the thumb, a
 * 12 px accent thumb with a 2 px bg ring, 1 × 4 px hairline-strong ticks. Left/Right step,
 * Shift × 10, Home/End. Slider stops after Binance's order form:
 * https://mobbin.com/screens/14a47c59-4122-498b-ab2e-4ff6d611c85c
 */
export function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
  origin = min,
  ticks = [],
  label,
  valueText,
  className,
}: {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  /** Where the fill starts (0 for a −100…+100 slider). */
  origin?: number;
  ticks?: number[];
  label: string;
  valueText?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const pct = (v: number) => ((clamp(v) - min) / (max - min)) * 100;
  const fromX = (clientX: number) => {
    const el = ref.current;
    if (!el) return value;
    const r = el.getBoundingClientRect();
    const raw = min + ((clientX - r.left) / r.width) * (max - min);
    return clamp(Math.round(raw / step) * step);
  };
  const lo = Math.min(pct(origin), pct(value));
  const hi = Math.max(pct(origin), pct(value));

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const big = e.shiftKey ? 10 : 1;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = value + step * big;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = value - step * big;
    else if (e.key === "Home") next = min;
    else if (e.key === "End") next = max;
    if (next === null) return;
    e.preventDefault();
    onChange(clamp(Math.round(next / step) * step));
  };

  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      aria-valuetext={valueText}
      onKeyDown={onKeyDown}
      onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        onChange(fromX(e.clientX));
      }}
      onPointerMove={(e) => {
        if (dragging.current) onChange(fromX(e.clientX));
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      className={cn("relative h-4 cursor-pointer touch-none select-none", className)}
    >
      <span aria-hidden="true" className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 bg-surface-3" />
      {ticks.map((t) => (
        <span
          key={t}
          aria-hidden="true"
          className="absolute top-1/2 h-1 w-px -translate-x-1/2 -translate-y-1/2 bg-hairline-strong"
          style={{ left: `${pct(t)}%` }}
        />
      ))}
      <span
        aria-hidden="true"
        className="absolute top-1/2 h-0.5 -translate-y-1/2 bg-accent"
        style={{ left: `${lo}%`, width: `${hi - lo}%` }}
      />
      <span
        aria-hidden="true"
        className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-bg"
        style={{ left: `${pct(value)}%` }}
      />
    </div>
  );
}
