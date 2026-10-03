import { memo } from "react";
import { cn } from "../../lib/cn";
import { useAgeLabel, useYoungerThan } from "../../lib/useNow";

/**
 * Relative age (DESIGN.md 3.7): text-2, text-1 while younger than 60 s, tabular. Ticks with the
 * shared clock and re-renders only when its label changes.
 */
export const Age = memo(function Age({ ts, className }: { ts: number; className?: string }) {
  const label = useAgeLabel(ts);
  const fresh = useYoungerThan(ts, 60_000);
  // A caller-supplied text colour wins (cn doesn't merge conflicting utilities).
  const tinted = className !== undefined && /(^|\s)text-(fg|buy|sell|warn|info|risk)/.test(className);
  return <span className={cn("zf-num", !tinted && (fresh ? "text-fg-1" : "text-fg-2"), className)}>{label}</span>;
});
