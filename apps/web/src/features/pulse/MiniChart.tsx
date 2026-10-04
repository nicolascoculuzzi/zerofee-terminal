import { memo } from "react";
import { SPARK_MINUTES, useSpark } from "./spark";

const W = 64;
const H = 24;
const PAD = 2;
const DOT_R = 1.5;
/** Leaves room for the 3 px end dot inside the 64 px box. */
const STEP = (W - PAD * 2 - DOT_R) / (SPARK_MINUTES - 1);

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Wide+ card mini chart (DESIGN.md 4.4): a 64 × 24 px line of 1-minute closes over the last 30
 * minutes, 1 px text-2, no fill, a 3 px dot on the last point. Tokens younger than 30 minutes
 * draw from their first minute, so the line starts part-way across. Flat when the price is.
 */
export const MiniChart = memo(function MiniChart({ mint }: { mint: string }) {
  const points = useSpark(mint);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of points ?? []) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!points || !Number.isFinite(min)) return <span data-tip="chart" aria-hidden="true" className="block h-6 w-16" />;
  const span = max - min;
  const coords: string[] = [];
  let lastX = 0;
  let lastY = H / 2;
  points.forEach((v, i) => {
    if (!Number.isFinite(v)) return;
    lastX = round1(PAD + i * STEP);
    lastY = span > 0 ? round1(PAD + (1 - (v - min) / span) * (H - PAD * 2)) : H / 2;
    coords.push(`${lastX},${lastY}`);
  });
  return (
    <svg data-tip="chart" width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block text-fg-2" aria-hidden="true">
      {coords.length > 1 && (
        <polyline
          points={coords.join(" ")}
          fill="none"
          stroke="currentColor"
          strokeWidth={1}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
      <circle cx={lastX} cy={lastY} r={DOT_R} fill="currentColor" />
    </svg>
  );
});
