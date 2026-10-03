import { cn } from "../lib/cn";

/** zerofee mark: a slashed zero. Our own brand, not derived from any other terminal. */
export function Logo({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="1" y="1" width="22" height="22" rx="6" fill="var(--zf-accent)" />
        <ellipse cx="12" cy="12" rx="5.2" ry="7" fill="none" stroke="var(--zf-accent-fg)" strokeWidth="2.4" />
        <path d="M7.5 18.5 L16.5 5.5" stroke="var(--zf-accent-fg)" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
      {!compact && <span className="text-[15px] font-bold tracking-tight">zerofee</span>}
    </span>
  );
}
