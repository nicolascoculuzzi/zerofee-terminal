import { Check, Copy } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { parseAmount } from "../../lib/format";
import { bindingLabel } from "../../lib/hotkeys";

// ---------------------------------------------------------------------------
// Segmented control
// Anatomy: Coinbase Advanced order-type chips and Buy/Sell toggle; neutral active state,
// green/red only for the Buy/Sell switch. https://mobbin.com/screens/ff785484-4dd2-4fc0-a5f4-658e033b3b08
// ---------------------------------------------------------------------------

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
}

export interface SegmentedProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  size?: "xs" | "sm";
  className?: string;
  /** Colour the active segment: only for buy/sell switches. */
  tone?: (value: T) => "buy" | "sell" | "neutral";
  label?: string;
}

export function Segmented<T extends string>({ value, onChange, options, size = "sm", className, tone, label }: SegmentedProps<T>) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex rounded-md border border-line bg-bg p-px", className)}>
      {options.map((o) => {
        const active = o.value === value;
        const t = active ? (tone?.(o.value) ?? "neutral") : null;
        return (
          // biome-ignore lint/a11y/useSemanticElements: compact segmented radio built from buttons
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              "flex-1 whitespace-nowrap rounded-sm font-medium transition-colors",
              size === "xs" ? "h-5 px-2 text-2xs" : "h-6 px-2 text-xs",
              !active && "text-muted hover:text-fg",
              t === "neutral" && "bg-elev text-fg",
              t === "buy" && "bg-buy/15 text-buy",
              t === "sell" && "bg-sell/15 text-sell",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Number input (keeps the raw string while typing). Label-left / value-right variant
// follows Coinbase Advanced's order inputs ("LIMIT PRICE ... 70462.56 USDC").
// ---------------------------------------------------------------------------

export interface NumberInputProps {
  value: number | null;
  onChange: (value: number | null) => void;
  placeholder?: string;
  prefix?: ReactNode;
  suffix?: ReactNode;
  min?: number;
  max?: number;
  className?: string;
  inputClassName?: string;
  onEnter?: () => void;
  ariaLabel?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  /** Right-align the value (order-form style). */
  alignRight?: boolean;
  id?: string;
}

function display(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "";
  return String(Number(v.toPrecision(10)));
}

export function NumberInput({
  value,
  onChange,
  placeholder,
  prefix,
  suffix,
  min,
  max,
  className,
  inputClassName,
  onEnter,
  ariaLabel,
  autoFocus,
  disabled,
  alignRight,
  id,
}: NumberInputProps) {
  const [text, setText] = useState(display(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(display(value));
  }, [value]);
  const commit = (raw: string) => {
    const n = parseAmount(raw);
    if (n === null) {
      onChange(null);
      return;
    }
    let v = n;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    onChange(v);
  };
  return (
    <div
      className={cn(
        "flex h-7 items-center gap-1 rounded-md border border-line-strong bg-bg px-2 text-sm focus-within:border-accent",
        disabled && "opacity-50",
        className,
      )}
    >
      {prefix && <span className="flex shrink-0 items-center text-dim">{prefix}</span>}
      <input
        id={id}
        inputMode="decimal"
        aria-label={ariaLabel}
        disabled={disabled}
        // biome-ignore lint/a11y/noAutofocus: used only inside freshly opened dialogs
        autoFocus={autoFocus}
        className={cn("min-w-0 flex-1 bg-transparent outline-none placeholder:text-dim", alignRight && "text-right", inputClassName)}
        value={text}
        placeholder={placeholder}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          setText(display(value));
        }}
        onChange={(e) => {
          setText(e.target.value);
          commit(e.target.value);
        }}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === "Enter") onEnter?.();
        }}
      />
      {suffix && <span className="flex shrink-0 items-center text-xs text-dim">{suffix}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Switch, checkbox, keycaps
// ---------------------------------------------------------------------------

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  size?: "xs" | "sm";
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors",
        checked ? "border-fg bg-fg" : "border-line-strong bg-elev",
      )}
    >
      <span
        className={cn("inline-block size-3 rounded-full transition-transform", checked ? "translate-x-3 bg-bg" : "translate-x-px bg-dim")}
      />
    </button>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-sm">
      <input type="checkbox" className="mt-px size-3 accent-fg" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="text-fg">{label}</span>
        {hint && <span className="block text-xs text-dim">{hint}</span>}
      </span>
    </label>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-4 min-w-4 items-center justify-center rounded-sm border border-line-strong bg-elev px-1 font-mono text-2xs text-muted",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** Renders a binding like "Space+Q" as keycaps. */
export function Hotkey({ binding, className }: { binding: string | undefined; className?: string }) {
  if (!binding) return null;
  const steps = bindingLabel(binding);
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {steps.map((keys, i) => (
        <span key={keys.join("") + String(i)} className="inline-flex items-center gap-px">
          {i > 0 && <span className="pr-1 text-2xs text-dim">then</span>}
          {keys.map((k) => (
            <Kbd key={k}>{k}</Kbd>
          ))}
        </span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Copy button
// ---------------------------------------------------------------------------

export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; size?: number; className?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1200);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        void copyText(text).then((ok) => setDone(ok));
      }}
      className={cn("inline-flex shrink-0 items-center justify-center rounded-sm text-dim hover:text-fg", className)}
    >
      {done ? <Check className="icon-sm text-buy" /> : <Copy className="icon-sm" />}
    </button>
  );
}
