import { Check, Copy, Minus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";

/*
 * Row controls for the virtualised grids. They match the shared Checkbox and CopyButton
 * (DESIGN.md 4.23) pixel for pixel, but take a tabIndex: grid rows use a roving tabindex, so
 * only the keyboard-cursor row's controls are tab stops (the shared components are always
 * focusable). Remove these once components/ui accepts tabIndex.
 */

/** 14 × 14 checkbox, 2 px radius; checked: accent fill with an ink check. Hit area 22 px (44 on phones). */
export function GridCheckbox({
  checked,
  indeterminate = false,
  onChange,
  label,
  tabIndex,
  touch,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (on: boolean) => void;
  label: string;
  tabIndex?: number;
  touch?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  const on = checked || indeterminate;
  return (
    <label
      className={cn(
        "relative flex shrink-0 cursor-pointer items-center justify-center before:absolute before:content-['']",
        touch ? "size-11" : "size-5 before:-inset-0.5",
      )}
    >
      <input
        ref={ref}
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        tabIndex={tabIndex}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        aria-hidden="true"
        className={cn(
          "flex size-3.5 items-center justify-center rounded-xs border peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus",
          on ? "border-accent bg-accent text-ink" : "border-hairline-strong bg-surface-2",
        )}
      >
        {indeterminate ? <Minus className="icon-xs" /> : checked ? <Check className="icon-xs" /> : null}
      </span>
    </label>
  );
}

/** Copy 12 px in text-3 that swaps to Check in text-1 for 1,200 ms; no toast. */
export function GridCopy({ text, label, tabIndex }: { text: string; label: string; tabIndex?: number }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1200);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      tabIndex={tabIndex}
      aria-label={done ? "Copied" : label}
      title={done ? "Copied" : label}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        void copyText(text).then((ok) => setDone(ok));
      }}
      className={cn(
        "focus-inset relative inline-flex size-5 shrink-0 items-center justify-center rounded-xs transition-colors before:absolute before:-inset-0.5 before:content-['']",
        done ? "text-fg-1" : "text-fg-3 hover:text-fg-1",
      )}
    >
      {done ? <Check className="icon-xs" /> : <Copy className="icon-xs" />}
    </button>
  );
}
