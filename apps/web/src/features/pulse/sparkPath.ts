/*
 * Geometry for the Pulse mini chart (DESIGN.md 4.4), pure so it is unit-tested: a polyline over the
 * known closes, the end-dot position, and the rules that keep it free of artefacts.
 * - Float noise is not drawn as a zigzag: a range thinner than MIN_REL of the price is centred flat.
 * - One known minute (a token younger than a minute, or a single sample) is a flat line across the
 *   box with the dot at the end, never a lone dot.
 * - Gaps (NaN) before the first close leave the line starting part-way, like a young token.
 */

export const MIN_REL = 0.002;

export interface SparkGeometry {
  /** SVG polyline points ("x,y x,y"). */
  points: string;
  dotX: number;
  dotY: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function sparkGeometry(
  values: readonly number[] | null,
  width: number,
  height: number,
  pad: number,
  dotR: number,
): SparkGeometry | null {
  if (!values || values.length === 0) return null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let known = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    known++;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (known === 0) return null;
  const mid = (min + max) / 2;
  const need = Math.abs(mid) * MIN_REL;
  if (max - min < need) {
    min = mid - need / 2;
    max = mid + need / 2;
  }
  const span = max - min;
  const step = values.length > 1 ? (width - pad * 2 - dotR) / (values.length - 1) : 0;
  const y = (v: number) => (span > 0 ? round1(pad + (1 - (v - min) / span) * (height - pad * 2)) : height / 2);
  const coords: string[] = [];
  let dotX = 0;
  let dotY = height / 2;
  values.forEach((v, i) => {
    if (!Number.isFinite(v)) return;
    dotX = round1(pad + i * step);
    dotY = y(v);
    coords.push(`${dotX},${dotY}`);
  });
  if (coords.length === 1) {
    // A single close: a flat line across the box at that level.
    dotX = round1(width - pad - dotR);
    return { points: `${pad},${dotY} ${dotX},${dotY}`, dotX, dotY };
  }
  return { points: coords.join(" "), dotX, dotY };
}
