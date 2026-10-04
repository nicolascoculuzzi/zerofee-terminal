import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { parseAmount } from "../../lib/format";

/**
 * Number input that shows the formatted value at rest ("9.80K") and keeps the typed text while
 * focused; accepts "9.8k", "1,5" and plain decimals. Same frame as NumberInput (DESIGN.md 4.23):
 * surface-2, hairline-strong, 4 px radius, right-aligned, unit suffix in text-3, focus ring.
 * Up/Down call `onStep` with ±0.5 (Shift ±5) so the caller decides the step.
 */
export function FormattedInput({
  value,
  format,
  onChange,
  onStep,
  prefix,
  suffix,
  size = "control",
  ariaLabel,
  className,
  onEnter,
}: {
  value: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  onStep?: (delta: number) => void;
  prefix?: ReactNode;
  suffix?: ReactNode;
  size?: "control" | "amount";
  ariaLabel: string;
  className?: string;
  onEnter?: () => void;
}) {
  const [text, setText] = useState(format(value));
  const focused = useRef(false);
  const formatRef = useRef(format);
  formatRef.current = format;
  useEffect(() => {
    if (!focused.current) setText(formatRef.current(value));
  }, [value]);
  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-sm border border-hairline-strong bg-surface-2 px-2 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus",
        size === "amount" ? "h-8 text-amount font-medium in-data-[density=comfortable]:h-9 max-md:h-11" : "h-control text-data",
        className,
      )}
    >
      {prefix && <span className="shrink-0 text-data text-fg-3">{prefix}</span>}
      <input
        inputMode="decimal"
        aria-label={ariaLabel}
        className="zf-num min-w-0 flex-1 bg-transparent text-right text-fg-1 placeholder:text-fg-4 focus-visible:outline-none"
        value={text}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          setText(format(value));
        }}
        onChange={(e) => {
          setText(e.target.value);
          const n = parseAmount(e.target.value);
          if (n !== null && n > 0) onChange(n);
        }}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if ((e.key === "ArrowUp" || e.key === "ArrowDown") && onStep) {
            e.preventDefault();
            onStep((e.key === "ArrowUp" ? 0.5 : -0.5) * (e.shiftKey ? 10 : 1));
          } else if (e.key === "Enter") onEnter?.();
          else if (e.key === "Escape") e.currentTarget.blur();
        }}
      />
      {suffix && <span className="shrink-0 text-data text-fg-3">{suffix}</span>}
    </div>
  );
}
