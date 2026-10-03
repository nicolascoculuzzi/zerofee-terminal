import { type PointerEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cssPx } from "../../lib/cssVar";
import { useTrackers } from "../../state/trackers";

/**
 * Resets the unread counter for a tracker feed for as long as it is mounted (i.e. visible).
 * A layout effect, so the status-bar badge never paints a frame with the count it just cleared.
 */
export function useMarkRead(kind: "trades" | "posts"): void {
  const unread = useTrackers((s) => (kind === "trades" ? s.unreadTrades : s.unreadPosts));
  useLayoutEffect(() => {
    if (unread > 0) useTrackers.getState().markRead(kind);
  }, [unread, kind]);
}

/** Row height token (--zf-row-h), read once so virtualized lists match the `h-7` rows. */
export function useRowHeight(): number {
  const [px] = useState(() => cssPx("--zf-row-h", 28));
  return px;
}

const FRESH_MS = 900;

/**
 * Remembers when each id first appeared (ids present on the first render count as old), so a
 * row can flash once with `zf-enter`. Returns a predicate evaluated at render time. `getId`
 * must be stable (module-level).
 */
export function useArrivals<T>(items: readonly T[], getId: (item: T) => string): (id: string) => boolean {
  const seen = useRef<Map<string, number> | null>(null);
  return useMemo(() => {
    const now = performance.now();
    let map = seen.current;
    if (!map) {
      map = new Map(items.map((it) => [getId(it), 0]));
      seen.current = map;
    } else {
      for (const it of items) {
        const id = getId(it);
        if (!map.has(id)) map.set(id, now);
      }
      if (map.size > items.length * 2 + 200) {
        const keep = new Set(items.map(getId));
        for (const id of map.keys()) if (!keep.has(id)) map.delete(id);
      }
    }
    const snapshot = map;
    return (id: string) => {
      const t = snapshot.get(id);
      return t !== undefined && t > 0 && now - t < FRESH_MS;
    };
  }, [items, getId]);
}

/**
 * Freezes a live list while a mouse is over it, so rows don't shift under the cursor before a
 * quick-buy click (same behaviour as the Pulse columns). `pending` counts items that arrived
 * while paused.
 */
export function useHoverPause<T>(items: T[]) {
  const [frozen, setFrozen] = useState<T[] | null>(null);
  const shown = frozen ?? items;
  let pending = 0;
  if (frozen) {
    const head = frozen[0];
    const at = head === undefined ? items.length : items.indexOf(head);
    pending = at < 0 ? items.length : at;
  }
  const bind = {
    onPointerEnter: (e: PointerEvent<HTMLElement>) => {
      if (e.pointerType === "mouse") setFrozen(items);
    },
    onPointerLeave: () => setFrozen(null),
  };
  return { shown, paused: frozen !== null, pending, bind };
}
