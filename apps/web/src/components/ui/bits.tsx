import { ArrowUpRight, Check } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { METRICS, type MetricKey, TAG_LABEL, TAG_STYLE } from "../../lib/metrics";
import type { TokenSocials, WalletTag } from "../../protocol";
import { getServices } from "../../services";
import { BrandIcon, LinkIconView } from "./Logo";
import { type SafeLink, socialLink, tokenLinks } from "./socials";
import { Tooltip } from "./Tooltip";

/** Wallet tag (DESIGN.md 4.5): 16px, micro 10/600 uppercase. YOU by contrast, risk tags tinted. */
export function Tag({ tag, label, className }: { tag: WalletTag; label?: string; className?: string }) {
  return (
    <span
      className={cn("inline-flex h-4 shrink-0 items-center rounded-xs border px-1 text-micro font-semibold", TAG_STYLE[tag], className)}
    >
      {label ?? TAG_LABEL[tag]}
    </span>
  );
}

/** Count badge (DESIGN.md 4.5): neutral pill, never coloured. */
export function CountBadge({ count, className }: { count: number | string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-surface-3 px-1 text-micro font-semibold text-fg-1",
        className,
      )}
    >
      {count}
    </span>
  );
}

/** 6px status dot plus its label (colour never carries meaning alone). */
export function StatusDot({
  tone,
  children,
  className,
}: {
  tone: "buy" | "sell" | "warn" | "info" | "neutral";
  children?: ReactNode;
  className?: string;
}) {
  const bg = { buy: "bg-buy", sell: "bg-sell", warn: "bg-warn", info: "bg-info", neutral: "bg-fg-3" }[tone];
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", bg)} />
      {children}
    </span>
  );
}

export function Pill({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex h-5 items-center gap-1 rounded-full border px-2 text-micro font-medium", className)}>
      {children}
    </span>
  );
}

export function ProgressBar({ value, className, color = "bg-fg-2" }: { value: number; className?: string; color?: string }) {
  const pct = Math.max(0, Math.min(100, value * 100));
  return (
    <div className={cn("h-1 w-full overflow-hidden rounded-xs bg-surface-3", className)}>
      <div className={cn("h-full", color)} style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * Metric tooltip content (DESIGN.md 4.14): label and current value on one line, the published
 * definition, the bands written out, and freshness.
 */
export function MetricTip({ metric, value, bands, updated }: { metric: MetricKey; value?: ReactNode; bands?: string; updated?: string }) {
  const def = METRICS[metric];
  return (
    <span className="block">
      <span className="flex items-baseline justify-between gap-3">
        <span className="text-data font-semibold text-fg-1">{def.label}</span>
        {value !== undefined && <span className="text-data font-semibold">{value}</span>}
      </span>
      <span className="mt-1 line-clamp-3 block text-label text-fg-2">{def.definition}</span>
      {bands && <span className="mt-1 block text-micro text-fg-3">{bands}</span>}
      {updated && <span className="mt-1 block text-micro text-fg-3">{updated}</span>}
    </span>
  );
}

/** Metric label: dotted underline plus the definition tooltip (SPEC "Token metric definitions"). */
export function MetricLabel({
  metric,
  children,
  className,
  value,
  bands,
}: {
  metric: MetricKey;
  children?: ReactNode;
  className?: string;
  value?: ReactNode;
  bands?: string;
}) {
  return (
    <Tooltip content={<MetricTip metric={metric} value={value} bands={bands} />}>
      <span className={cn("zf-metric", className)}>{children ?? METRICS[metric].label}</span>
    </Tooltip>
  );
}

/**
 * Empty state inside its panel (DESIGN.md 4.18): centred in the panel's first 240px, max 320px
 * wide, optional 16px icon, a 13/500 title, one 12px sentence, at most one action. No art.
 */
export function EmptyState({
  icon,
  title,
  body,
  action,
  className,
  fill,
}: {
  icon?: ReactNode;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
  /** Centre in the whole parent (flex-1, full height) instead of the panel's first 240 px. */
  fill?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center px-4 py-6 text-center",
        fill ? "h-full min-h-30 flex-1" : "max-h-60 min-h-30",
        className,
      )}
    >
      <div className="flex max-w-80 flex-col items-center gap-1">
        {icon && <span className="mb-1 text-fg-3 [&_svg]:size-4">{icon}</span>}
        <span className="text-body font-medium text-balance text-fg-2">{title}</span>
        {body && <span className="text-data text-balance text-fg-3">{body}</span>}
        {action && <span className="mt-2">{action}</span>}
      </div>
    </div>
  );
}

/**
 * Loading placeholder (DESIGN.md 4.18): a static surface-3 shape, no shimmer and no pulse.
 * "bar" is an 8 px text bar with a 2 px radius (pass a width: 60% of the column for text, 40%
 * right-aligned for numbers); "square" is an avatar (4 px radius) and "circle" a wallet avatar,
 * both sized with `size` (px). Decorative: wrap the loading region in aria-busy instead.
 */
export function Skeleton({
  shape = "bar",
  width,
  size,
  className,
}: {
  shape?: "bar" | "square" | "circle";
  /** Bar width: px number or any CSS length ("60%"). Defaults to the full width. */
  width?: number | string;
  /** Square/circle edge in px. */
  size?: number;
  className?: string;
}) {
  const style = shape === "bar" ? { width: width ?? "100%" } : { width: size ?? 16, height: size ?? 16 };
  return (
    <span
      aria-hidden="true"
      style={style}
      className={cn(
        "block shrink-0 bg-surface-3",
        shape === "bar" && "h-2 rounded-xs",
        shape === "square" && "rounded-sm",
        shape === "circle" && "rounded-full",
        className,
      )}
    />
  );
}

/** The Solana mark (simple-icons) in currentColor, as the SOL unit where a unit word doesn't fit. */
export function SolGlyph({ className }: { className?: string }) {
  return <BrandIcon name="solana" label="SOL" className={className} />;
}

/** The X mark (simple-icons) in currentColor, 12 px. */
export function XGlyph({ className }: { className?: string }) {
  return <BrandIcon name="x" className={className} />;
}

function useFlag(ms = 1200): [boolean, () => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return;
    const t = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return [on, () => setOn(true)];
}

function SocialAnchor({ link }: { link: SafeLink }) {
  const [copied, flash] = useFlag();
  const simulated = getServices().simulated;
  return (
    <Tooltip content={copied ? "Copied" : `${link.label}${simulated ? " · simulated, click copies the link" : ""}`}>
      <a
        href={link.href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={copied ? "Copied" : link.label}
        onClick={(e) => {
          e.stopPropagation();
          if (!simulated) return;
          e.preventDefault();
          void copyText(link.href).then((ok) => ok && flash());
        }}
        onAuxClick={(e) => e.stopPropagation()}
        className="inline-flex size-4 items-center justify-center text-fg-3 transition-colors hover:text-fg-1 [&_svg]:size-3"
      >
        {copied ? <Check /> : <LinkIconView icon={link.icon} />}
      </a>
    </Tooltip>
  );
}

/**
 * Social links (DESIGN.md 2.11): the X, Telegram and Discord marks, a globe for other websites, and with
 * `mint` the token's pump.fun page and DexScreener chart, each 12 px in a 16 px hit area, opening in a new
 * tab (rel="noopener noreferrer"). Only safe https links render (socials.ts). With simulated data the
 * handles are fictional, so a click copies the link instead (no network calls from the app); the icon
 * swaps to a check instead of toasting (DESIGN.md 4.13 "never toast").
 */
export function SocialLinks({
  socials,
  mint,
  pump = false,
  className,
}: {
  socials: TokenSocials;
  /** Adds the pump.fun (when `pump`) and DexScreener links for this token. */
  mint?: string;
  pump?: boolean;
  size?: number;
  className?: string;
}) {
  const items = [
    socialLink("x", socials.x),
    socialLink("website", socials.website),
    socialLink("telegram", socials.telegram),
    ...(mint ? tokenLinks(mint, { pump }) : []),
  ].filter((l): l is SafeLink => l !== null);
  if (items.length === 0) return null;
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {items.map((it) => (
        <SocialAnchor key={it.href} link={it} />
      ))}
    </span>
  );
}

/** Explorer link: copies the signature while data is simulated (fake signatures); check swap, no toast. */
export function ExplorerLink({ signature, className }: { signature: string; className?: string }) {
  const [copied, flash] = useFlag();
  return (
    <button
      type="button"
      title={copied ? "Copied" : "Copy signature (explorer links are off on simulated data)"}
      aria-label={copied ? "Copied" : "Copy transaction signature"}
      onClick={(e) => {
        e.stopPropagation();
        void copyText(signature).then((ok) => ok && flash());
      }}
      className={cn("inline-flex items-center text-fg-3 transition-colors hover:text-fg-1 [&_svg]:size-3", className)}
    >
      {copied ? <Check /> : <ArrowUpRight />}
    </button>
  );
}

/** Tiled panel (DESIGN.md 2.4, 4.9): 0 radius, panel-header row with a hairline, surface-1. */
export function Section({
  title,
  extra,
  children,
  className,
}: {
  title: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("bg-surface-1", className)}>
      <div className="flex h-panel-header items-center justify-between gap-2 border-b border-hairline px-3">
        <div className="text-data font-semibold text-fg-1">{title}</div>
        {extra}
      </div>
      <div>{children}</div>
    </section>
  );
}
