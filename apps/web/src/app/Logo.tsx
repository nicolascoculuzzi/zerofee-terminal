import { cn } from "../lib/cn";

/**
 * zerofee mark (DESIGN.md 4.1, 9.5 item 12): a slashed zero in ink on an accent (neutral ink)
 * square, monochrome in both themes; the wordmark at 13/600. Our own mark, derived from no
 * other product.
 */
export function Logo({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <svg className="icon-lg" viewBox="0 0 20 20" aria-hidden="true">
        <rect x="0" y="0" width="20" height="20" rx="4" className="fill-accent" />
        <ellipse cx="10" cy="10" rx="4.2" ry="5.8" fill="none" className="stroke-ink" strokeWidth="2" />
        <path d="M6.3 15.4 L13.7 4.6" className="stroke-ink" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      {!compact && <span className="text-body font-semibold text-fg-1">zerofee</span>}
    </span>
  );
}
