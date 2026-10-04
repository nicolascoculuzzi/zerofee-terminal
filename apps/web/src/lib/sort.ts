import { isKnown, type Maybe } from "./format";

/**
 * Compares two possibly-unknown values (null or NaN from the live server) in direction `dir`
 * (1 = ascending, -1 = descending). Unknown values sort after every known one in either direction,
 * and are never treated as 0.
 */
export function compareKnown(a: Maybe, b: Maybe, dir: 1 | -1): number {
  const ka = isKnown(a);
  const kb = isKnown(b);
  if (ka && kb) return ((a as number) - (b as number)) * dir;
  if (ka === kb) return 0;
  return ka ? -1 : 1;
}
