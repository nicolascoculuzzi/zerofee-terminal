import { Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/*
 * Settings building blocks. Row anatomy follows Graphite's preferences page (label and
 * description on the left, control on the right, hairline separators):
 * https://mobbin.com/screens/102736c8-9a2a-4185-a155-025f1c0b3217
 * Grouped hairline boxes follow Kraken's security settings:
 * https://mobbin.com/screens/9171ec76-128d-4006-bed9-8b254cc841e7
 */

/** Colour carries meaning only: buy = done/low risk, warn = needs attention/medium risk, sell = high risk, info = neutral state. */
export type Tone = "neutral" | "info" | "warn" | "buy" | "sell";

export function TabHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <h2 className="text-md font-semibold text-fg">{title}</h2>
        {description && <p className="mt-1 text-xs text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A titled hairline box; children are rows separated by hairlines. */
export function Group({
  title,
  description,
  extra,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  description?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("mb-6 last:mb-0", className)}>
      {(title || extra) && (
        <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
          <div className="min-w-0">
            {title && <h3 className="text-sm font-semibold text-fg">{title}</h3>}
            {description && <p className="text-xs text-dim">{description}</p>}
          </div>
          {extra}
        </div>
      )}
      <div className={cn("divide-y divide-line rounded-lg border border-line", bodyClassName)}>{children}</div>
    </section>
  );
}

/** Label + optional hint on the left, control on the right; stacks on narrow widths. */
export function Row({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  /** Id of the native control, so the label is clickable and announced. */
  htmlFor?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4", className)}>
      <div className="min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="block text-sm text-fg">
            {label}
          </label>
        ) : (
          <div className="text-sm text-fg">{label}</div>
        )}
        {hint && <div className="text-xs text-dim">{hint}</div>}
      </div>
      {children && <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

/** Small uppercase label above a control. */
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
      {hint && <div className="mt-1 text-xs text-dim">{hint}</div>}
    </div>
  );
}

const NOTE_TONE: Record<Tone, { box: string; icon: string; text: string }> = {
  neutral: { box: "border-line bg-panel-2", icon: "text-dim", text: "text-muted" },
  info: { box: "border-info/30 bg-info/5", icon: "text-info", text: "text-muted" },
  warn: { box: "border-warn/30 bg-warn/5", icon: "text-warn", text: "text-fg" },
  buy: { box: "border-buy/30 bg-buy/5", icon: "text-buy", text: "text-fg" },
  sell: { box: "border-sell/30 bg-sell/5", icon: "text-sell", text: "text-fg" },
};

/** Inline callout: hairline box, tone-coloured icon, plain text. */
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
    <div className={cn("flex items-start gap-2 rounded-md border px-3 py-2 text-xs", t.box, t.text, className)}>
      <span className={cn("mt-px flex shrink-0", t.icon)}>{glyph}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

const CHIP_TONE: Record<Tone, string> = {
  neutral: "border-line text-muted",
  info: "border-info/40 text-info",
  warn: "border-warn/40 text-warn",
  buy: "border-buy/40 text-buy",
  sell: "border-sell/40 text-sell",
};

/** Status tag (3px radius chip). */
export function Chip({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn("inline-flex h-4 shrink-0 items-center gap-1 rounded-sm border px-1 text-2xs font-medium", CHIP_TONE[tone], className)}
    >
      {children}
    </span>
  );
}

/*
 * One-of-N option card. Anatomy follows Binance Pool's fee tiers (one choice, a few short
 * facts per option): https://mobbin.com/screens/80e8342c-a30d-494d-8ed5-b7ec84e90759
 * Selected state is neutral (stronger hairline + elevated surface), never the brand accent.
 */
export function RadioCard({
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
  /** Right side of the title line (risk or status). */
  meta?: ReactNode;
  children?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 transition-colors",
        checked ? "border-line-strong bg-elev" : "border-line hover:bg-hover",
        disabled && "cursor-not-allowed opacity-40",
      )}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
        className="mt-px size-3 shrink-0 accent-fg"
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center justify-between gap-x-2">
          <span className="text-sm font-semibold text-fg">{title}</span>
          {meta}
        </span>
        {children && <span className="mt-1 block space-y-1 text-xs text-muted">{children}</span>}
      </span>
    </label>
  );
}
