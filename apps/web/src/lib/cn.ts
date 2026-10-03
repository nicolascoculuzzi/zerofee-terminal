/** Joins class names, skipping falsy values. */
export function cn(...parts: (string | false | null | undefined | 0)[]): string {
  let out = "";
  for (const p of parts) {
    if (!p) continue;
    out = out ? `${out} ${p}` : p;
  }
  return out;
}

let counter = 0;

/** Short unique id for client-side keys (not cryptographic). */
export function uid(prefix = "id"): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
