/**
 * Pulse columns. Classification (configurable, defaults from the task spec):
 *   new       not migrated, progress <  finalStretchBps (60%), created within newMaxAge
 *   final     not migrated, progress >= finalStretchBps (or curve complete), traded within finalMaxIdle
 *   migrated  migrated within migratedWindow (24 h)
 * Only pump.fun coins appear (PumpSwap-only tokens are tracked but not listed).
 *
 * Each column keeps every candidate's sort key (cheap) and publishes the top `listLimit`:
 *   new = newest first, final = highest progress first (then most recent trade), migrated = most recent first.
 * update() returns per-column deltas: full summaries for tokens entering a list, field patches for
 * members that changed, removals for tokens that left (or fell below the cap).
 */
import type { PulseColumn, PulseDelta, TokenPatch, TokenSummary } from "@zerofee/protocol";

export interface PulseConfig {
  finalStretchBps: number;
  migratedWindowMs: number;
  newMaxAgeMs: number;
  finalMaxIdleMs: number;
  listLimit: number;
}

export const COLUMNS: readonly PulseColumn[] = ["new", "final", "migrated"];

export function classify(s: TokenSummary, cfg: PulseConfig, now: number): PulseColumn | null {
  if (s.launchpad !== "pump") return null;
  if (s.migrated) return s.migratedAt !== null && now - s.migratedAt <= cfg.migratedWindowMs ? "migrated" : null;
  if (s.complete || s.bondingProgressBps >= cfg.finalStretchBps) {
    const last = s.lastTradeAt ?? s.createdAt ?? 0;
    return now - last <= cfg.finalMaxIdleMs ? "final" : null;
  }
  if (s.createdAt !== null && now - s.createdAt <= cfg.newMaxAgeMs) return "new";
  return null;
}

/** Larger = earlier in the list. */
function sortKey(col: PulseColumn, s: TokenSummary): [number, number] {
  switch (col) {
    case "new":
      return [s.createdAt ?? 0, 0];
    case "final":
      return [s.bondingProgressBps, s.lastTradeAt ?? 0];
    case "migrated":
      return [s.migratedAt ?? 0, 0];
  }
}

const cmpDesc = (a: [number, number], b: [number, number]) => b[0] - a[0] || b[1] - a[1];

/** Changed fields of `next` relative to `prev` (always includes the mint); null when nothing changed. */
export function diffSummary(prev: TokenSummary, next: TokenSummary): TokenPatch | null {
  const patch: Record<string, unknown> = { mint: next.mint };
  let changed = false;
  for (const k of Object.keys(next) as (keyof TokenSummary)[]) {
    if (k === "updatedAt") continue;
    const a = prev[k];
    const b = next[k];
    if (a === b) continue;
    if (typeof a === "object" && a !== null && typeof b === "object" && b !== null && JSON.stringify(a) === JSON.stringify(b)) continue;
    patch[k] = b;
    changed = true;
  }
  if (!changed) return null;
  patch.updatedAt = next.updatedAt;
  return patch as TokenPatch;
}

export class PulseBoard {
  private readonly candidates: Record<PulseColumn, Map<string, [number, number]>> = {
    new: new Map(),
    final: new Map(),
    migrated: new Map(),
  };
  private readonly column = new Map<string, PulseColumn>();
  private readonly published: Record<PulseColumn, Map<string, TokenSummary>> = { new: new Map(), final: new Map(), migrated: new Map() };
  private readonly orderDirty: Record<PulseColumn, boolean> = { new: true, final: true, migrated: true };
  /** Bumped whenever a column's published list changes (snapshot caches key on it). */
  readonly version: Record<PulseColumn, number> = { new: 0, final: 0, migrated: 0 };
  private readonly snapshotCache: Record<PulseColumn, { version: number; json: string } | null> = {
    new: null,
    final: null,
    migrated: null,
  };

  constructor(private readonly cfg: PulseConfig) {}

  columnOf(mint: string): PulseColumn | null {
    return this.column.get(mint) ?? null;
  }

  /** True when the token is in a published list (eviction guard). */
  isListed(mint: string): boolean {
    const c = this.column.get(mint);
    return c ? this.published[c].has(mint) : false;
  }

  counts(): Record<PulseColumn, number> {
    return { new: this.candidates.new.size, final: this.candidates.final.size, migrated: this.candidates.migrated.size };
  }

  private place(mint: string, s: TokenSummary | null, now: number): void {
    const prev = this.column.get(mint) ?? null;
    const next = s ? classify(s, this.cfg, now) : null;
    if (prev && prev !== next) {
      this.candidates[prev].delete(mint);
      this.orderDirty[prev] = true;
    }
    if (next && s) {
      const key = sortKey(next, s);
      const old = this.candidates[next].get(mint);
      if (!old || old[0] !== key[0] || old[1] !== key[1]) this.orderDirty[next] = true;
      this.candidates[next].set(mint, key);
      this.column.set(mint, next);
    } else this.column.delete(mint);
  }

  /** Re-checks time-based membership (aging out of New / Final / Migrated). */
  expire(summaryOf: (mint: string) => TokenSummary | null, now: number): void {
    for (const col of COLUMNS) {
      for (const mint of [...this.candidates[col].keys()]) {
        const s = summaryOf(mint);
        if (!s || classify(s, this.cfg, now) !== col) this.place(mint, s, now);
      }
    }
  }

  /** Applies changed tokens and returns the delta for every column (empty deltas included). */
  update(changed: Iterable<string>, summaryOf: (mint: string) => TokenSummary | null, now: number): Record<PulseColumn, PulseDelta> {
    const fresh = new Map<string, TokenSummary | null>();
    const summary = (mint: string) => {
      if (!fresh.has(mint)) fresh.set(mint, summaryOf(mint));
      return fresh.get(mint) ?? null;
    };
    for (const mint of changed) this.place(mint, summary(mint), now);
    const out = {} as Record<PulseColumn, PulseDelta>;
    for (const col of COLUMNS) {
      const delta: PulseDelta = { upsert: [], remove: [] };
      const pub = this.published[col];
      let top: string[];
      if (this.orderDirty[col]) {
        top = this.top(col);
        this.orderDirty[col] = false;
        const keep = new Set(top);
        for (const mint of [...pub.keys()]) {
          if (!keep.has(mint)) {
            pub.delete(mint);
            delta.remove.push(mint);
          }
        }
      } else top = [...pub.keys()];
      for (const mint of top) {
        const prev = pub.get(mint);
        if (prev && !fresh.has(mint)) continue; // unchanged member
        const s = summary(mint);
        if (!s) continue;
        if (!prev) delta.upsert.push(s);
        else {
          const patch = diffSummary(prev, s);
          if (patch) delta.upsert.push(patch);
        }
        pub.set(mint, s);
      }
      if (delta.upsert.length || delta.remove.length) this.version[col]++;
      out[col] = delta;
    }
    return out;
  }

  /** Best `listLimit` candidates by sort key, via a bounded insertion buffer (O(n log limit)). */
  private top(col: PulseColumn): string[] {
    const n = this.cfg.listLimit;
    const best: [string, [number, number]][] = [];
    for (const entry of this.candidates[col]) {
      if (best.length === n && cmpDesc(entry[1], (best[n - 1] as [string, [number, number]])[1]) >= 0) continue;
      let lo = 0;
      let hi = best.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cmpDesc((best[mid] as [string, [number, number]])[1], entry[1]) <= 0) lo = mid + 1;
        else hi = mid;
      }
      best.splice(lo, 0, entry);
      if (best.length > n) best.pop();
    }
    return best.map(([mint]) => mint);
  }

  /**
   * The column's published list as JSON (`snapshot(col)` serialized), cached until the list changes: every
   * client connecting between two flushes shares one serialization.
   */
  snapshotJson(col: PulseColumn): string {
    const c = this.snapshotCache[col];
    if (c && c.version === this.version[col]) return c.json;
    const json = JSON.stringify(this.snapshot(col));
    this.snapshotCache[col] = { version: this.version[col], json };
    return json;
  }

  /** Current published list in display order (full summaries as last published). */
  snapshot(col: PulseColumn): TokenSummary[] {
    const pub = this.published[col];
    return [...pub.values()].sort((a, b) => cmpDesc(sortKey(col, a), sortKey(col, b)));
  }
}
