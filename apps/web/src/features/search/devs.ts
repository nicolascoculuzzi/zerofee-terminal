import type { TokenSummary } from "../../protocol";

export interface DevHit {
  address: string;
  /** Tokens by this creator in the live set. */
  launches: number;
  migrated: number;
  /** The token hit this dev was found through ("Dev of $WIF"), if any. */
  via: TokenSummary | null;
}

/**
 * Devs for the palette's DEVS group. Search returns tokens and wallets only, so devs come from
 * the live token set: creators whose address starts with the query (3+ characters), then the
 * creators of the top token hits. Launch and migration counts cover the live set only.
 */
export function findDevs(query: string, live: Record<string, TokenSummary>, tokenHits: TokenSummary[], limit: number): DevHit[] {
  const q = query.trim().toLowerCase();
  if (!q || limit <= 0) return [];
  const stats = new Map<string, { launches: number; migrated: number }>();
  for (const t of Object.values(live)) {
    const s = stats.get(t.creator) ?? { launches: 0, migrated: 0 };
    s.launches++;
    if (t.migratedAt !== null) s.migrated++;
    stats.set(t.creator, s);
  }
  const out: DevHit[] = [];
  const seen = new Set<string>();
  const add = (address: string, via: TokenSummary | null) => {
    // The live feed can carry a token before its creator is known: no address, no dev row.
    if (!address || seen.has(address) || out.length >= limit) return;
    seen.add(address);
    const s = stats.get(address) ?? { launches: via ? 1 : 0, migrated: via !== null && via.migratedAt !== null ? 1 : 0 };
    out.push({ address, launches: s.launches, migrated: s.migrated, via });
  };
  if (q.length >= 3) {
    for (const address of stats.keys()) if (address.toLowerCase().startsWith(q)) add(address, null);
  }
  for (const t of tokenHits.slice(0, 3)) add(t.creator, t);
  return out;
}
