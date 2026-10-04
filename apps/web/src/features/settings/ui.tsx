import { Check, ChevronDown, ChevronRight, Info, TriangleAlert } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { MenuItem, Popover } from "../../components/ui/Popover";
import { cn } from "../../lib/cn";
import { anchorId } from "./sections";

/*
 * Settings building blocks (DESIGN.md 5.5): a section title (14/600) and description (12 text-3),
 * then rows of at least 44 px with hairlines between them, a flexible label column (12/500 label,
 * 11 text-3 help) and a 200 px right-aligned control column.
 * Searchable nav and label-left / control-right rows after Devin and Buffer:
 * https://mobbin.com/screens/93170d84-7435-4c89-82b5-647330913aba
 * https://mobbin.com/screens/8f4e0968-f06d-4fef-a1f1-f714b1f5c5e7
 */

/** Colour carries meaning only: warn = needs attention, sell = destructive or failed, buy = done. */
export type Tone = "neutral" | "info" | "warn" | "buy" | "sell";

export function SectionHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1">
        <h2 className="text-heading font-semibold text-fg-1">{title}</h2>
        {description && <p className="mt-1 max-w-[72ch] text-data text-fg-3">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

/** Group header inside a section: 11/600 text-3, 24 px tall, 16 px above (as in the filter modal, 4.16). */
export function SubHeader({ children, actions, anchor }: { children: ReactNode; actions?: ReactNode; anchor?: string }) {
  return (
    <div id={anchor ? anchorId(anchor) : undefined} className="mt-4 flex min-h-6 scroll-mt-4 items-center justify-between gap-2">
      <h3 className="text-label font-semibold text-fg-3">{children}</h3>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Hairline-separated rows. */
export function Rows({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("divide-y divide-hairline border-y border-hairline", className)}>{children}</div>;
}

/**
 * One settings row: label and help on the left, the control in a 200 px right-aligned column
 * (`control="wide"` lets the control take the space it needs). Stacks below 640 px.
 */
export function Row({
  label,
  help,
  htmlFor,
  children,
  anchor,
  control = "fixed",
  dim,
  className,
}: {
  label: ReactNode;
  help?: ReactNode;
  /** Id of the native control, so the label is clickable and announced. */
  htmlFor?: string;
  children?: ReactNode;
  anchor?: string;
  control?: "fixed" | "wide";
  dim?: boolean;
  className?: string;
}) {
  return (
    <div
      id={anchor ? anchorId(anchor) : undefined}
      className={cn(
        "grid min-h-11 scroll-mt-4 items-center gap-x-4 gap-y-2 py-2",
        control === "fixed" ? "sm:grid-cols-[minmax(0,1fr)_200px]" : "sm:grid-cols-[minmax(0,1fr)_auto]",
        className,
      )}
    >
      <div className="min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className={cn("block text-data font-medium", dim ? "text-fg-3" : "text-fg-1")}>
            {label}
          </label>
        ) : (
          <div className={cn("text-data font-medium", dim ? "text-fg-3" : "text-fg-1")}>{label}</div>
        )}
        {help && <div className="mt-0.5 max-w-[72ch] text-label text-fg-3">{help}</div>}
      </div>
      {children !== undefined && <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">{children}</div>}
    </div>
  );
}

/** A label (11/500 text-3) above a control, with optional help under it. Kept for older callers of this module. */
export function Field({
  label,
  htmlFor,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className="zf-label mb-1 block">
          {label}
        </label>
      ) : (
        <div className="zf-label mb-1">{label}</div>
      )}
      {children}
      {hint && <div className="mt-1 text-label text-fg-3">{hint}</div>}
    </div>
  );
}

/** A full-width row (lists, editors). */
export function Block({ children, className, anchor }: { children: ReactNode; className?: string; anchor?: string }) {
  return (
    <div id={anchor ? anchorId(anchor) : undefined} className={cn("min-h-11 scroll-mt-4 py-2", className)}>
      {children}
    </div>
  );
}

const NOTE_TONE: Record<Tone, { box: string; icon: string; text: string }> = {
  neutral: { box: "bg-surface-2", icon: "text-fg-3", text: "text-fg-2" },
  info: { box: "bg-surface-2", icon: "text-info", text: "text-fg-2" },
  warn: { box: "bg-warn-tint", icon: "text-warn", text: "text-fg-1" },
  buy: { box: "bg-surface-2", icon: "text-buy", text: "text-fg-1" },
  sell: { box: "bg-sell-tint", icon: "text-sell", text: "text-fg-1" },
};

/** Inline callout: flat fill (warn-tint only for warnings), a 14 px icon, plain text. */
export function Note({
  tone = "neutral",
  icon,
  children,
  className,
}: {
  tone?: Tone;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const t = NOTE_TONE[tone];
  const glyph = icon ?? (tone === "warn" || tone === "sell" ? <TriangleAlert className="icon-sm" /> : <Info className="icon-sm" />);
  return (
    <div className={cn("flex items-start gap-2 rounded-sm px-3 py-2 text-label", t.box, t.text, className)}>
      <span className={cn("mt-px flex shrink-0", t.icon)}>{glyph}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

const TAG_TONE: Record<Tone, string> = {
  neutral: "bg-surface-3 text-fg-2",
  info: "bg-info-tint text-info",
  warn: "bg-warn-tint text-warn",
  buy: "bg-buy-tint text-buy",
  sell: "bg-sell-tint text-sell",
};

/** Status tag: 16 px, 2 px radius, micro 10/500, sentence case. */
export function Tag({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-4 shrink-0 items-center gap-1 rounded-xs px-1 text-micro font-medium whitespace-nowrap [&_svg]:size-2.5",
        TAG_TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A value that resets to null after `ms` (inline "Saved" and "Undo" states, 4.13 "never toast"). */
export function useTransient<T>(ms: number): [T | null, (value: T | null) => void] {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    if (value === null) return;
    const id = setTimeout(() => setValue(null), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return [value, setValue];
}

/** Inline confirmation that replaces a toast: "Saved", or "Removed X · Undo". */
export function InlineStatus({ children, onUndo, className }: { children: ReactNode; onUndo?: () => void; className?: string }) {
  return (
    <span role="status" className={cn("inline-flex items-center gap-1 text-label text-fg-2", className)}>
      <Check className="icon-xs text-fg-1" />
      {children}
      {onUndo && (
        <>
          <span className="text-fg-3">·</span>
          <button type="button" onClick={onUndo} className="font-medium text-fg-1 underline-offset-2 hover:underline">
            Undo
          </button>
        </>
      )}
    </span>
  );
}

/** A disclosure row: a 12 px chevron that turns when open, no native triangle (fallback glyph). */
export function Disclosure({ summary, children, className }: { summary: ReactNode; children: ReactNode; className?: string }) {
  return (
    <details className={cn("group/disc", className)}>
      <summary className="zf-summary inline-flex items-center gap-1 rounded-xs text-label text-fg-2 transition-colors hover:text-fg-1">
        <ChevronRight className="icon-xs text-fg-3 transition-transform duration-(--zf-dur-2) group-open/disc:rotate-90" />
        {summary}
      </summary>
      {children}
    </details>
  );
}

// ---------------------------------------------------------------------------
// Select (4.23): the input frame with a 12 px chevron; opens a menu (4.17).
// ---------------------------------------------------------------------------

export function SelectMenu<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: ${current?.label ?? value}`}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-control w-full items-center justify-between gap-2 rounded-sm border border-hairline-strong bg-surface-2 px-2 text-left text-data text-fg-1 transition-colors hover:bg-surface-3",
          className,
        )}
      >
        <span className="truncate">{current?.label ?? value}</span>
        <ChevronDown className="icon-xs text-fg-3" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} align="end" width={200}>
        <div role="menu" aria-label={label}>
          {options.map((o) => (
            <MenuItem
              key={o.value}
              checked={o.value === value}
              icon={o.value === value ? <Check /> : <span className="size-3.5" />}
              onSelect={() => {
                onChange(o.value);
                setOpen(false);
                anchor.current?.focus();
              }}
            >
              {o.label}
            </MenuItem>
          ))}
        </div>
      </Popover>
    </>
  );
}

// ---------------------------------------------------------------------------
// Slider (4.23): 2 px surface-3 track, accent fill, 12 px accent thumb with a 2 px bg ring,
// 1 × 4 px hairline-strong ticks. Left/Right step, Shift ×10, Home/End.
// ---------------------------------------------------------------------------

export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  label,
  valueText,
  ticks,
  className,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  label: string;
  valueText?: string;
  /** Tick positions (values). */
  ticks?: number[];
  className?: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const span = max - min || 1;
  const pct = ((Math.min(max, Math.max(min, value)) - min) / span) * 100;
  const snap = useCallback(
    (v: number) => {
      const stepped = Math.round((v - min) / step) * step + min;
      return Math.min(max, Math.max(min, Number(stepped.toPrecision(10))));
    },
    [min, max, step],
  );
  const fromPointer = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r || r.width === 0) return;
    onChange(snap(min + ((clientX - r.left) / r.width) * span));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const big = e.shiftKey ? step * 10 : step;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = value + big;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = value - big;
    else if (e.key === "Home") next = min;
    else if (e.key === "End") next = max;
    else if (e.key === "PageUp") next = value + step * 10;
    else if (e.key === "PageDown") next = value - step * 10;
    if (next === null) return;
    e.preventDefault();
    onChange(snap(next));
  };
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valueText}
      onKeyDown={onKeyDown}
      onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        fromPointer(e.clientX);
      }}
      onPointerMove={(e: PointerEvent<HTMLDivElement>) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) fromPointer(e.clientX);
      }}
      className={cn("relative flex h-6 min-w-0 flex-1 cursor-pointer touch-none items-center rounded-xs max-md:h-11", className)}
    >
      <div ref={track} className="relative h-0.5 w-full rounded-full bg-surface-3">
        {ticks?.map((tk) => (
          <span
            key={tk}
            aria-hidden="true"
            className="absolute top-1/2 h-1 w-px -translate-y-1/2 bg-hairline-strong"
            style={{ left: `${((tk - min) / span) * 100}%` }}
          />
        ))}
        <span className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${pct}%` }} />
        <span
          aria-hidden="true"
          className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-bg"
          style={{ left: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Underline tabs (4.8): panel-header height, 12/500, active text-1 with a 2 px accent bar.
// ---------------------------------------------------------------------------

export function UnderlineTabs<T extends string>({
  value,
  options,
  onChange,
  label,
  idPrefix,
  bare,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  label: string;
  /** Tab ids are `${idPrefix}-${value}`; the panel uses aria-labelledby. */
  idPrefix: string;
  /** Drop the bottom hairline (the parent row draws one at full width). */
  bare?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = options.findIndex((o) => o.value === value);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % options.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + options.length) % options.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = options.length - 1;
    const o = options[next];
    if (!o) return;
    e.preventDefault();
    onChange(o.value);
    refs.current[next]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={move}
      className={cn("flex h-panel-header items-stretch gap-4", bare ? "-mb-px" : "border-b border-hairline")}
    >
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            id={`${idPrefix}-${o.value}`}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(
              "focus-inset relative flex items-center gap-1 text-data font-medium whitespace-nowrap transition-colors max-md:min-h-11",
              active ? "text-fg-1" : "text-fg-3 hover:text-fg-2",
            )}
          >
            {o.label}
            {active && <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 bg-accent" />}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Radio rows (landing routes, signing mode): a 14 px ring, accent dot when checked.
// ---------------------------------------------------------------------------

export function RadioRow({
  name,
  checked,
  onSelect,
  title,
  meta,
  children,
  disabled,
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  title: ReactNode;
  /** Right side of the title line. */
  meta?: ReactNode;
  children?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={cn("flex min-h-11 cursor-pointer items-start gap-3 py-2", disabled && "cursor-not-allowed text-fg-4")}>
      <input type="radio" name={name} checked={checked} disabled={disabled} onChange={onSelect} className="peer sr-only" />
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus",
          checked ? "border-accent" : "border-hairline-strong bg-surface-2",
        )}
      >
        {checked && <span className="size-1.5 rounded-full bg-accent" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center justify-between gap-x-2">
          <span className="text-data font-medium text-fg-1">{title}</span>
          {meta}
        </span>
        {children && <span className="mt-0.5 block space-y-0.5 text-label text-fg-3">{children}</span>}
      </span>
    </label>
  );
}
