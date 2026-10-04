/** 4-character blocks for display (DESIGN.md 4.19). Copy always uses the ungrouped string. */
export function keyGroups(key: string, size = 4): string[] {
  const out: string[] = [];
  for (let i = 0; i < key.length; i += size) out.push(key.slice(i, i + size));
  return out;
}

/** Three distinct 1-based character positions, ascending, at least 3 apart ("characters 7, 19 and 41"). */
export function pickPositions(length: number, count = 3, random: () => number = cryptoRandom): number[] {
  if (length < count) return Array.from({ length }, (_, i) => i + 1);
  const picked: number[] = [];
  for (let guard = 0; picked.length < count && guard < 200; guard++) {
    const p = 1 + Math.floor(random() * length);
    if (picked.every((x) => Math.abs(x - p) >= 3)) picked.push(p);
  }
  for (let p = 1; picked.length < count && p <= length; p++) if (!picked.includes(p)) picked.push(p);
  return picked.sort((a, b) => a - b);
}

function cryptoRandom(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0] ?? 0) / 2 ** 32;
}
