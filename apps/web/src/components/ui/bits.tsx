import { ExternalLink, Globe, Send } from "lucide-react";
import type { ReactNode } from "react";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { METRICS, type MetricKey, TAG_LABEL, TAG_STYLE } from "../../lib/metrics";
import type { TokenSocials, WalletTag } from "../../protocol";
import { getServices } from "../../services";
import { useToasts } from "../../state/toasts";
import { Tooltip } from "./Tooltip";

export function Tag({ tag, label, className }: { tag: WalletTag; label?: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded border px-1 text-[9px] font-semibold leading-none tracking-wide",
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
    <span title={title} className={cn("inline-flex h-5 items-center gap-1 rounded-full border px-2 text-[10px] font-medium", className)}>
      {children}
    </span>
  );
}

export function ProgressBar({ value, className, color = "bg-accent" }: { value: number; className?: string; color?: string }) {
  const pct = Math.max(0, Math.min(100, value * 100));
  return (
    <div className={cn("h-1 w-full overflow-hidden rounded-full bg-elev", className)}>
      <div className={cn("h-full rounded-full transition-[width] duration-300", color)} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Metric label with its published definition on hover. */
export function MetricLabel({ metric, children, className }: { metric: MetricKey; children?: ReactNode; className?: string }) {
  const def = METRICS[metric];
  return (
    <Tooltip
      content={
        <span>
          <span className="font-semibold">{def.label}</span>
          <span className="mt-0.5 block text-muted">{def.definition}</span>
        </span>
      }
    >
      <span className={cn("cursor-help border-b border-dotted border-line-strong", className)}>{children ?? def.label}</span>
    </Tooltip>
  );
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      {icon && <div className="text-dim">{icon}</div>}
      <div className="text-sm font-medium text-fg">{title}</div>
      {body && <div className="max-w-sm text-xs text-muted">{body}</div>}
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

/** "𝕏" glyph for X links; we don't ship third-party logos. */
export function XGlyph({ className }: { className?: string }) {
  return <span className={cn("text-[11px] font-bold leading-none", className)}>𝕏</span>;
}

/**
 * Social links. With simulated data the handles are fictional, so clicking copies the link
 * instead of opening it (no network calls from the app).
 */
export function SocialLinks({ socials, size = 12, className }: { socials: TokenSocials; size?: number; className?: string }) {
  const items: { key: string; url: string; icon: ReactNode; label: string }[] = [];
  if (socials.x) {
    const url = socials.x.includes("/status/") ? `https://x.com/${socials.x}` : `https://x.com/${socials.x}`;
    items.push({ key: "x", url, icon: <XGlyph />, label: socials.x.includes("/status/") ? "Tweet" : `@${socials.x}` });
  }
  if (socials.telegram) {
    items.push({ key: "tg", url: `https://t.me/${socials.telegram}`, icon: <Send size={size - 1} />, label: `t.me/${socials.telegram}` });
  }
  if (socials.website) {
    items.push({ key: "web", url: `https://${socials.website}`, icon: <Globe size={size} />, label: socials.website });
  }
  if (items.length === 0) return null;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-dim", className)}>
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
            className="inline-flex items-center hover:text-fg"
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
      <ExternalLink size={12} />
    </button>
  );
}

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
      <div className="flex h-9 items-center justify-between border-b border-line px-3">
        <div className="text-xs font-semibold text-fg">{title}</div>
        {extra}
      </div>
      <div>{children}</div>
    </section>
  );
}
