import { ArrowUpRight, Check, Globe, Send } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { METRICS, type MetricKey, TAG_LABEL, TAG_STYLE } from "../../lib/metrics";
import type { TokenSocials, WalletTag } from "../../protocol";
import { getServices } from "../../services";
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
}: {
  icon?: ReactNode;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex max-h-60 min-h-30 flex-col items-center justify-center px-4 py-6 text-center", className)}>
      <div className="flex max-w-80 flex-col items-center gap-1">
        {icon && <span className="mb-1 text-fg-3 [&_svg]:size-4">{icon}</span>}
        <span className="text-body font-medium text-fg-2">{title}</span>
        {body && <span className="text-data text-fg-3">{body}</span>}
        {action && <span className="mt-2">{action}</span>}
      </div>
    </div>
  );
}

/** SOL glyph as SVG (the U+25CE character isn't in our fonts). Only where a unit word doesn't fit. */
export function SolGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 12 12" className={cn("inline-block size-3 shrink-0", className)} role="img" aria-label="SOL">
      <circle cx="6" cy="6" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      <circle cx="6" cy="6" r="2" fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** X links show the letter "X" in Plex Sans 600 (no brand logos, no U+1D54F fallback glyph). */
export function XGlyph({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn("inline-flex w-3 justify-center text-label font-semibold leading-none", className)}>
      X
    </span>
  );
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

function SocialButton({ label, url, icon }: { label: string; url: string; icon: ReactNode }) {
  const [copied, flash] = useFlag();
  const simulated = getServices().simulated;
  return (
    <Tooltip content={copied ? "Copied" : `${label}${simulated ? " · simulated, click copies the link" : ""}`}>
      <button
        type="button"
        aria-label={copied ? "Copied" : label}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          void copyText(url).then((ok) => ok && flash());
        }}
        className="inline-flex size-4 items-center justify-center text-fg-3 transition-colors hover:text-fg-1 [&_svg]:size-3"
      >
        {copied ? <Check /> : icon}
      </button>
    </Tooltip>
  );
}

/**
 * Social links: X letter, Globe, Send, 12px in 16px hit areas. With simulated data the handles
 * are fictional, so clicking copies the link (no network calls from the app). The icon swaps to a
 * check instead of toasting (DESIGN.md 4.13 "never toast").
 */
export function SocialLinks({ socials, className }: { socials: TokenSocials; size?: number; className?: string }) {
  const items: { key: string; url: string; icon: ReactNode; label: string }[] = [];
  if (socials.x) {
    items.push({
      key: "x",
      url: `https://x.com/${socials.x}`,
      icon: <XGlyph />,
      label: socials.x.includes("/status/") ? "Tweet" : `@${socials.x}`,
    });
  }
  if (socials.website) {
    items.push({ key: "web", url: `https://${socials.website}`, icon: <Globe />, label: socials.website });
  }
  if (socials.telegram) {
    items.push({ key: "tg", url: `https://t.me/${socials.telegram}`, icon: <Send />, label: `t.me/${socials.telegram}` });
  }
  if (items.length === 0) return null;
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {items.map((it) => (
        <SocialButton key={it.key} label={it.label} url={it.url} icon={it.icon} />
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
