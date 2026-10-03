import { cn } from "../lib/cn";

/** zerofee mark: a slashed zero in the brand colour. Our own brand, not derived from any other terminal. */
export function Logo({ className, compact, wordmarkClassName }: { className?: string; compact?: boolean; wordmarkClassName?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <svg className="icon-lg" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="1" y="1" width="22" height="22" rx="5" className="fill-accent" />
        <ellipse cx="12" cy="12" rx="5" ry="6.8" fill="none" className="stroke-bg" strokeWidth="2.4" />
        <path d="M7.6 18.4 L16.4 5.6" className="stroke-bg" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
      {!compact && <span className={cn("text-md font-bold tracking-tight", wordmarkClassName)}>zerofee</span>}
    </span>
  );
}
