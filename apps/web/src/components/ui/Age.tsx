import { memo } from "react";
import { fmtAge } from "../../lib/format";
import { useNow } from "../../lib/useNow";

/** Relative age that ticks with the shared 1 Hz clock; only this span re-renders. */
export const Age = memo(function Age({ ts, className }: { ts: number; className?: string }) {
  const now = useNow();
  return <span className={className}>{fmtAge(ts, now)}</span>;
});
