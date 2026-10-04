/**
 * Live-calm list engine for Pulse columns (DESIGN.md 6.7). Pure: the column feeds it the
 * filtered, sorted mints on every store flush and renders `shown`.
 *
 * - Frozen (hover, keyboard focus, P, Shift+P, or the 300 ms after leaving): order and
 *   membership hold still; values keep updating in place. New mints queue behind "N new".
 * - Calm mode commits membership and order at most once per second, in one batch.
 * - Value-sorted lists (Final Stretch by progress, or a user sort) re-sort at most every 2 s;
 *   between re-sorts, existing cards keep their places and new ones slot in near their rank.
 * - A changed query (search, filters, sort) re-syncs at once: the user asked for it.
 * - An "N new" click applies the queue at once, even while frozen.
 */

export const CALM_MS = 1000;
export const RESORT_MS = 2000;
export const HIGHLIGHT_MS = 1200;
export const RELEASE_MS = 300;

export interface ListState {
  /** Committed order and membership. */
  shown: readonly string[];
  /** When the list was last fully re-sorted. */
  sortedAt: number;
  /** When membership or order last changed. */
  committedAt: number;
  /** When each mint entered the list (drives the new-card highlight). */
  inserted: ReadonlyMap<string, number>;
  /** False until the first non-empty list, so the initial snapshot isn't highlighted. */
  ready: boolean;
  /** Last query key and apply nonce seen. */
  query: string;
  nonce: number;
}

export interface ListInput {
  /** Filtered mints in the column's sort order. */
  incoming: readonly string[];
  now: number;
  frozen: boolean;
  calm: boolean;
  /** 0 when existing cards can't change order (newest first); otherwise the re-sort interval. */
  resortMs: number;
  /** Changes when the user edits search, filters or sort. */
  query: string;
  /** Bumped by an "N new" click. */
  nonce: number;
}

export function emptyList(): ListState {
  return { shown: [], sortedAt: 0, committedAt: 0, inserted: new Map(), ready: false, query: "", nonce: 0 };
}

export function sameList(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Keeps the previous relative order of cards that are still present and places each new card
 * right after its nearest preceding survivor in `incoming` (or first, if none precedes it).
 */
export function stableMerge(prev: readonly string[], incoming: readonly string[]): string[] {
  const live = new Set(incoming);
  const kept = prev.filter((m) => live.has(m));
  const keptSet = new Set(kept);
  const after = new Map<string | null, string[]>();
  let anchor: string | null = null;
  for (const m of incoming) {
    if (keptSet.has(m)) {
      anchor = m;
      continue;
    }
    const list = after.get(anchor);
    if (list) list.push(m);
    else after.set(anchor, [m]);
  }
  const out: string[] = [...(after.get(null) ?? [])];
  for (const m of kept) {
    out.push(m);
    const extra = after.get(m);
    if (extra) out.push(...extra);
  }
  return out;
}

function pruneInserted(inserted: ReadonlyMap<string, number>, now: number): ReadonlyMap<string, number> {
  let stale = false;
  for (const at of inserted.values()) {
    if (now - at > HIGHLIGHT_MS * 2) {
      stale = true;
      break;
    }
  }
  if (!stale) return inserted;
  const next = new Map<string, number>();
  for (const [m, at] of inserted) if (now - at <= HIGHLIGHT_MS * 2) next.set(m, at);
  return next;
}

export function stepList(prev: ListState, input: ListInput): ListState {
  const { incoming, now } = input;

  // First load or a user-changed query: show the result as it is, without highlights.
  if (!prev.ready || input.query !== prev.query) {
    return {
      shown: sameList(prev.shown, incoming) ? prev.shown : [...incoming],
      sortedAt: now,
      committedAt: now,
      inserted: pruneInserted(prev.inserted, now),
      ready: prev.ready || incoming.length > 0,
      query: input.query,
      nonce: input.nonce,
    };
  }

  const apply = input.nonce !== prev.nonce;
  if (!apply) {
    if (input.frozen) return prev;
    if (input.calm && now - prev.committedAt < CALM_MS) return prev;
  }

  const resortDue = apply || input.resortMs <= 0 || now - prev.sortedAt >= input.resortMs;
  const next = resortDue ? incoming : stableMerge(prev.shown, incoming);
  const unchanged = sameList(prev.shown, next);
  if (unchanged && !apply) return prev;

  const before = new Set(prev.shown);
  let inserted = pruneInserted(prev.inserted, now);
  let copied = false;
  for (const m of next) {
    if (before.has(m)) continue;
    if (!copied) {
      inserted = new Map(inserted);
      copied = true;
    }
    (inserted as Map<string, number>).set(m, now);
  }

  return {
    shown: unchanged ? prev.shown : [...next],
    sortedAt: resortDue ? now : prev.sortedAt,
    committedAt: unchanged ? prev.committedAt : now,
    inserted,
    ready: true,
    query: prev.query,
    nonce: input.nonce,
  };
}

/** Mints that match now but aren't on screen yet: the "N new" count while frozen. */
export function queuedCount(shown: readonly string[], incoming: readonly string[]): number {
  if (incoming.length === 0) return 0;
  const on = new Set(shown);
  let n = 0;
  for (const m of incoming) if (!on.has(m)) n++;
  return n;
}
