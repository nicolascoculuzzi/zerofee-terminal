import { ArrowBigUp, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, Command, Copy, Minus, Option } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { parseAmount } from "../../lib/format";
import { bindingLabel, IS_MAC } from "../../lib/hotkeys";

// ---------------------------------------------------------------------------
// Segmented control (DESIGN.md 4.8): transparent container with a hairline-strong border,
// active segment on surface-3. Tones: neutral, or buy/sell for the side switch only.
// Side-tinted Buy/Sell after Binance: https://mobbin.com/screens/14a47c59-4122-498b-ab2e-4ff6d611c85c
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
  /** xs: 20px (14px segments) · sm: 24px (18px segments) · side: 28px Buy | Sell. */
  size?: "xs" | "sm" | "side";
  className?: string;
  /** Colour the active segment: only for buy/sell switches. */
  tone?: (value: T) => "buy" | "sell" | "neutral";
  label?: string;
}

export function Segmented<T extends string>({ value, onChange, options, size = "sm", className, tone, label }: SegmentedProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = options.findIndex((o) => o.value === value);
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % options.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + options.length) % options.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = options.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const o = options[next];
    if (o) {
      onChange(o.value);
      refs.current[next]?.focus();
    }
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={move}
      className={cn(
        "inline-flex items-center gap-px rounded-sm border border-hairline-strong p-0.5",
        size === "xs" ? "h-5" : size === "side" ? "h-7" : "h-6",
        className,
      )}
    >
      {options.map((o, i) => {
        const active = o.value === value;
        const t = active ? (tone?.(o.value) ?? "neutral") : null;
        return (
          // biome-ignore lint/a11y/useSemanticElements: compact segmented radio built from buttons
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              "focus-inset flex h-full flex-1 items-center justify-center rounded-xs px-2 font-medium whitespace-nowrap transition-colors",
              size === "xs" ? "text-micro" : size === "side" ? "text-data" : "text-label",
              !active && "text-fg-3 hover:bg-surface-2 hover:text-fg-1",
              t === "neutral" && "bg-surface-3 text-fg-1",
              t === "buy" && "bg-buy-tint text-buy",
              t === "sell" && "bg-sell-tint text-sell",
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
// Number input (DESIGN.md 4.23 and 4.7): surface-2, hairline-strong, 4px radius, numbers
// right-aligned with a text-3 unit suffix, 2px focus ring outside. Keeps the raw string while
// typing; accepts "1.5", "1,5" and "2k". Up/Down step (Shift x10) when `step` is set.
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
  /** Right-align the value (default: numbers are right-aligned). */
  alignRight?: boolean;
  id?: string;
  /** control: 24/28px · amount: 32/36px (44 on mobile) with a 14px value. */
  size?: "control" | "amount";
  invalid?: boolean;
  /** Arrow-key step; a function lets the step depend on the value (0.01 below 1 SOL, 0.1 above). */
  step?: number | ((value: number) => number);
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
  alignRight = true,
  id,
  size = "control",
  invalid,
  step,
}: NumberInputProps) {
  const [text, setText] = useState(display(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(display(value));
  }, [value]);
  const clamp = (n: number) => {
    let v = n;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    return v;
  };
  const commit = (raw: string) => {
    const n = parseAmount(raw);
    onChange(n === null ? null : clamp(n));
  };
  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-sm border bg-surface-2 px-2 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus",
        size === "amount" ? "h-8 text-amount font-medium in-data-[density=comfortable]:h-9 max-md:h-11" : "h-control text-data",
        invalid ? "border-sell" : "border-hairline-strong",
        !invalid && !disabled && "hover:border-fg-4",
        disabled && "bg-surface-1 text-fg-4",
        className,
      )}
    >
      {prefix && <span className="flex shrink-0 items-center text-fg-3 [&_svg]:size-3">{prefix}</span>}
      <input
        id={id}
        inputMode="decimal"
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        // biome-ignore lint/a11y/noAutofocus: used only inside freshly opened dialogs
        autoFocus={autoFocus}
        className={cn(
          "zf-num min-w-0 flex-1 bg-transparent placeholder:text-fg-4 focus-visible:outline-none",
          alignRight && "text-right",
          inputClassName,
        )}
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
          else if (e.key === "Escape") e.currentTarget.blur();
          else if (step !== undefined && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
            e.preventDefault();
            const current = value ?? 0;
            const base = typeof step === "function" ? step(current) : step;
            const delta = (e.shiftKey ? base * 10 : base) * (e.key === "ArrowUp" ? 1 : -1);
            const next = clamp(Number((current + delta).toPrecision(10)));
            onChange(next);
            setText(display(next));
          }
        }}
      />
      {suffix && <span className="flex shrink-0 items-center text-label text-fg-3">{suffix}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Switch, checkbox, keycaps (DESIGN.md 4.23)
// ---------------------------------------------------------------------------

/** 28 × 16 track. Off: surface-3 with a text-3 knob. On: accent track with an ink knob. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  size?: "xs" | "sm";
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "group relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        checked
          ? "border-accent bg-accent enabled:hover:border-accent-hover enabled:hover:bg-accent-hover"
          : "border-hairline-strong bg-surface-3 enabled:hover:border-fg-4 enabled:hover:bg-surface-3-hover",
      )}
    >
      <span
        className={cn(
          "inline-block size-3 rounded-full transition-transform duration-(--zf-dur-2)",
          checked ? "translate-x-3 bg-ink" : "translate-x-px bg-fg-3 group-hover:bg-fg-2",
        )}
      />
    </button>
  );
}

/**
 * 14 × 14 box, 2px radius. Checked: accent fill with an ink check; indeterminate: a minus.
 * `hideLabel` drops the visible label (it stays the accessible name) and gives the box a
 * 22 px hit area (44 px with `touch`), for selection columns in grids. `tabIndex` lets
 * roving-tabindex grids make only the cursor row's controls tab stops.
 */
export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  indeterminate,
  disabled,
  className,
  tabIndex,
  hideLabel,
  touch,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  indeterminate?: boolean;
  disabled?: boolean;
  className?: string;
  tabIndex?: number;
  hideLabel?: boolean;
  touch?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate;
  }, [indeterminate]);
  const on = checked || indeterminate;
  const box = (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-3.5 shrink-0 items-center justify-center rounded-xs border peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus",
        !hideLabel && "mt-0.5",
        on ? "border-accent bg-accent text-ink" : "border-hairline-strong bg-surface-2 peer-enabled:group-hover/cb:border-fg-4",
      )}
    >
      {indeterminate ? <Minus className="icon-xs" /> : checked ? <Check className="icon-xs" /> : null}
    </span>
  );
  if (hideLabel) {
    return (
      <label
        className={cn(
          "group/cb relative flex shrink-0 cursor-pointer items-center justify-center before:absolute before:content-['']",
          touch ? "size-11" : "size-5 before:-inset-0.5",
          disabled && "cursor-not-allowed",
          className,
        )}
      >
        <input
          ref={ref}
          type="checkbox"
          className="peer sr-only"
          checked={checked}
          disabled={disabled}
          tabIndex={tabIndex}
          onChange={(e) => onChange(e.target.checked)}
        />
        {box}
        <span className="sr-only">{label}</span>
      </label>
    );
  }
  return (
    <label
      className={cn("group/cb flex cursor-pointer items-start gap-2 text-data", disabled && "cursor-not-allowed text-fg-4", className)}
    >
      <input
        ref={ref}
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        tabIndex={tabIndex}
        onChange={(e) => onChange(e.target.checked)}
      />
      {box}
      <span>
        <span className="text-fg-1">{label}</span>
        {hint && <span className="block text-label text-fg-3">{hint}</span>}
      </span>
    </label>
  );
}

/** Keycap: 16px tall, Plex Mono 500 at 10px. */
export function Kbd({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <kbd
      aria-label={label}
      className={cn(
        "inline-flex h-4 min-w-4 items-center justify-center rounded-xs border border-hairline-strong bg-surface-3 px-1 font-mono text-micro font-medium text-fg-2 [&_svg]:size-2.5",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

const MAC_ICON: Record<string, ReactNode> = {
  Cmd: <Command />,
  Shift: <ArrowBigUp />,
  Option: <Option />,
};

/** Arrow keys read as icons on every platform ("ArrowLeft" is too long for a keycap). */
const ARROW_ICON: Record<string, { icon: ReactNode; label: string }> = {
  ArrowUp: { icon: <ArrowUp />, label: "Up arrow" },
  ArrowDown: { icon: <ArrowDown />, label: "Down arrow" },
  ArrowLeft: { icon: <ArrowLeft />, label: "Left arrow" },
  ArrowRight: { icon: <ArrowRight />, label: "Right arrow" },
  "\u2191": { icon: <ArrowUp />, label: "Up arrow" },
  "\u2193": { icon: <ArrowDown />, label: "Down arrow" },
};

/** One key: macOS modifiers as lucide icons, words elsewhere ("Ctrl", "Shift", "Alt"); arrows as icons. */
export function KeyCap({ k }: { k: string }) {
  if (IS_MAC && MAC_ICON[k]) return <Kbd label={k}>{MAC_ICON[k]}</Kbd>;
  const arrow = ARROW_ICON[k];
  if (arrow) return <Kbd label={arrow.label}>{arrow.icon}</Kbd>;
  return <Kbd>{k}</Kbd>;
}

/** Renders a binding like "Space+Q" or "G P" ("G then P") as keycaps. */
export function Hotkey({ binding, className }: { binding: string | undefined; className?: string }) {
  if (!binding) return null;
  const steps = bindingLabel(binding);
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {steps.map((keys, i) => (
        <span key={keys.join("") + String(i)} className="inline-flex items-center gap-0.5">
          {i > 0 && <span className="pr-1 text-micro text-fg-3">then</span>}
          {keys.map((k) => (
            <KeyCap key={k} k={k} />
          ))}
        </span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Copy control (DESIGN.md 4.23): Copy 12px text-3 swaps to Check text-1 for 1,200 ms. No toast.
// ---------------------------------------------------------------------------

export function CopyButton({
  text,
  label = "Copy",
  className,
  tabIndex,
}: {
  text: string;
  label?: string;
  size?: number;
  className?: string;
  /** Roving-tabindex grids: only the cursor row's copy button is a tab stop. */
  tabIndex?: number;
}) {
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
        className,
      )}
    >
      {done ? <Check className="icon-xs" /> : <Copy className="icon-xs" />}
    </button>
  );
}
