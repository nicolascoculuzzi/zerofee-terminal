import { ExternalLink, Globe, Send } from "lucide-react";
import type { ReactNode } from "react";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { METRICS, type MetricKey, TAG_LABEL, TAG_STYLE } from "../../lib/metrics";
import type { TokenSocials, WalletTag } from "../../protocol";
import { getServices } from "../../services";
import { useToasts } from "../../state/toasts";
import { Tooltip } from "./Tooltip";

/** Wallet tag chip (YOU, DEV, SNIPER…). Only risk tags carry colour. */
export function Tag({ tag, label, className }: { tag: WalletTag; label?: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded-sm border px-1 text-2xs font-semibold tracking-wide",
        TAG_STYLE[tag],
        className,
      )}
    >
      {label ?? TAG_LABEL[tag]}
    </span>
  );
}

export function Pill({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex h-5 items-center gap-1 rounded-full border px-2 text-2xs font-medium", className)}>
      {children}
    </span>
  );
}

export function ProgressBar({ value, className, color = "bg-muted" }: { value: number; className?: string; color?: string }) {
  const pct = Math.max(0, Math.min(100, value * 100));
  return (
    <div className={cn("h-1 w-full overflow-hidden rounded-full bg-elev", className)}>
      <div className={cn("h-full rounded-full transition-[width]", color)} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Metric label with its published definition on hover (SPEC "Token metric definitions"). */
export function MetricLabel({ metric, children, className }: { metric: MetricKey; children?: ReactNode; className?: string }) {
  const def = METRICS[metric];
  return (
    <Tooltip
      content={
        <span>
          <span className="font-semibold">{def.label}</span>
          <span className="mt-1 block text-muted">{def.definition}</span>
        </span>
      }
    >
      <span className={cn("cursor-help underline decoration-line-strong decoration-dotted underline-offset-2", className)}>
        {children ?? def.label}
      </span>
    </Tooltip>
  );
}

/** One short muted line; an action may follow. No hero layout, no illustration. */
export function EmptyState({
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
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-4 text-sm text-dim", className)}>
      <span className="text-muted">{title}</span>
      {body && <span>{body}</span>}
      {action}
    </div>
  );
}

export function SolMark({ className }: { className?: string }) {
  return (
    <span role="img" className={cn("font-semibold text-dim", className)} aria-label="SOL">
      ◎
    </span>
  );
}

/** "𝕏" glyph for X links; third-party logos are not shipped. */
export function XGlyph({ className }: { className?: string }) {
  return <span className={cn("text-xs font-bold leading-none", className)}>𝕏</span>;
}

/**
 * Social links. With simulated data the handles are fictional, so clicking copies the link
 * instead of opening it (no network calls from the app).
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
  if (socials.telegram) {
    items.push({
      key: "tg",
      url: `https://t.me/${socials.telegram}`,
      icon: <Send className="icon-sm" />,
      label: `t.me/${socials.telegram}`,
    });
  }
  if (socials.website) {
    items.push({ key: "web", url: `https://${socials.website}`, icon: <Globe className="icon-sm" />, label: socials.website });
  }
  if (items.length === 0) return null;
  return (
    <span className={cn("inline-flex items-center gap-1 text-dim", className)}>
      {items.map((it) => (
        <Tooltip key={it.key} content={`${it.label}${getServices().simulated ? " (simulated; click copies the link)" : ""}`}>
          <button
            type="button"
            aria-label={it.label}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              void copyText(it.url);
              useToasts.getState().push({ kind: "info", title: "Link copied", body: it.url, ttl: 2000 });
            }}
            className="inline-flex size-4 items-center justify-center hover:text-fg"
          >
            {it.icon}
          </button>
        </Tooltip>
      ))}
    </span>
  );
}

/** Explorer link: copies the signature while data is simulated (fake signatures). */
export function ExplorerLink({ signature, className }: { signature: string; className?: string }) {
  return (
    <button
      type="button"
      title="Copy signature (explorer links are disabled on simulated data)"
      aria-label="Copy transaction signature"
      onClick={(e) => {
        e.stopPropagation();
        void copyText(signature);
        useToasts.getState().push({ kind: "info", title: "Signature copied", body: `${signature.slice(0, 20)}…`, ttl: 2000 });
      }}
      className={cn("inline-flex items-center text-dim hover:text-fg", className)}
    >
      <ExternalLink className="icon-sm" />
    </button>
  );
}

/** Hairline panel with a compact header (Kraken Pro module anatomy). */
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
    <section className={cn("rounded-lg border border-line bg-panel", className)}>
      <div className="flex h-8 items-center justify-between border-b border-line px-3">
        <div className="text-sm font-semibold text-fg">{title}</div>
        {extra}
      </div>
      <div>{children}</div>
    </section>
  );
}
