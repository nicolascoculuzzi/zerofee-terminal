/** Random pick used to spread write locks across fee/tip recipients (docs advise random selection). */
export function pickRandom<T>(items: readonly T[]): T {
  if (items.length === 0) throw new Error("pickRandom: empty list");
  return items[Math.floor(Math.random() * items.length)] as T;
}
