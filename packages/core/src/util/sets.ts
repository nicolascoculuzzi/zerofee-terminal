/** New set holding the members of `set` that satisfy `keep` (insertion order preserved). */
export function filterSet<T>(set: Iterable<T>, keep: (value: T) => boolean): Set<T> {
  const out = new Set<T>();
  for (const value of set) if (keep(value)) out.add(value);
  return out;
}
