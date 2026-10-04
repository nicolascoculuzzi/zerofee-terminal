import { memo } from "react";
import { useSpark } from "./spark";
import { sparkGeometry } from "./sparkPath";

const W = 64;
const H = 24;
const PAD = 2;
const DOT_R = 1.5;

/**
 * Wide+ card mini chart (DESIGN.md 4.4): a 64 × 24 px line of 1-minute closes over the last 30
 * minutes, 1 px text-2, no fill, a 3 px dot on the last point. Tokens younger than 30 minutes
 * draw from their first minute, so the line starts part-way across; a single known close is a flat
 * line, and float noise stays flat (sparkPath.ts).
 */
export const MiniChart = memo(function MiniChart({ mint }: { mint: string }) {
  const g = sparkGeometry(useSpark(mint), W, H, PAD, DOT_R);
  if (!g) return <span data-tip="chart" aria-hidden="true" className="block h-6 w-16" />;
  return (
    <svg data-tip="chart" width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block text-fg-2" aria-hidden="true">
      <polyline
        points={g.points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={g.dotX} cy={g.dotY} r={DOT_R} fill="currentColor" />
    </svg>
  );
});
