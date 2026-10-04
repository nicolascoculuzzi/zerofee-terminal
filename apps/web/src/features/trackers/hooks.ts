import { type FocusEvent, type PointerEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { registerHotkey } from "../../lib/hotkeys";
import { buy } from "../../lib/tradeActions";
import { useMediaQuery } from "../../lib/useMediaQuery";
import { useSettings } from "../../state/settings";
import { useToasts } from "../../state/toasts";
import { useTrackers } from "../../state/trackers";
import { useUi } from "../../state/ui";

/** Phones use touch sizes: 44 px targets, 64 px list rows (DESIGN.md 2.10, 5.8). */
export const MOBILE_QUERY = "(max-width: 767px)";
export const MOBILE_ROW_PX = 64;

export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}

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

/** Time after pointer leave before a paused list applies its queue (DESIGN.md 6.7). */
const RELEASE_MS = 300;

/**
 * Hover or focus freezes a live list's order and membership (DESIGN.md 6.7): the row under the
 * cursor never moves before a click. Values keep updating in place (the frozen list holds keys
 * and maps them back to the latest items). `pending` counts items that arrived meanwhile; they
 * apply in one batch 300 ms after the pointer and focus leave, or at once via `release`.
 * `getKey` must be stable (module level).
 */
export function useLivePause<T>(items: readonly T[], getKey: (item: T) => string) {
  const [frozen, setFrozen] = useState<{ keys: string[]; set: Set<string>; snapshot: Map<string, T> } | null>(null);
  const hovered = useRef(false);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const capture = useCallback(() => {
    const list = itemsRef.current;
    const keys = list.map(getKey);
    return { keys, set: new Set(keys), snapshot: new Map(list.map((it, i) => [keys[i] as string, it])) };
  }, [getKey]);

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const freeze = () => {
    cancel();
    setFrozen((f) => f ?? capture());
  };
  const scheduleRelease = () => {
    if (hovered.current || focused.current) return;
    cancel();
    timer.current = setTimeout(() => setFrozen(null), RELEASE_MS);
  };

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  /** Apply the queue now; the list stays paused while the pointer or focus is still inside. */
  const release = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setFrozen(hovered.current || focused.current ? capture() : null);
  }, [capture]);

  const bind = {
    onPointerEnter: (e: PointerEvent<HTMLElement>) => {
      if (e.pointerType !== "mouse") return;
      hovered.current = true;
      freeze();
    },
    onPointerLeave: (e: PointerEvent<HTMLElement>) => {
      if (e.pointerType !== "mouse") return;
      hovered.current = false;
      scheduleRelease();
    },
    onFocus: () => {
      focused.current = true;
      freeze();
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
      focused.current = false;
      scheduleRelease();
    },
  };

  const { shown, pending } = useMemo(() => {
    if (!frozen) return { shown: items, pending: 0 };
    const byKey = new Map<string, T>();
    let fresh = 0;
    for (const it of items) {
      const k = getKey(it);
      byKey.set(k, it);
      if (!frozen.set.has(k)) fresh++;
    }
    const out: T[] = [];
    for (const k of frozen.keys) {
      const it = byKey.get(k) ?? frozen.snapshot.get(k);
      if (it !== undefined) out.push(it);
    }
    return { shown: out, pending: fresh };
  }, [items, frozen, getKey]);

  return { shown, paused: frozen !== null, pending, bind, release };
}

/** New tape-row flash and new-row highlight durations (DESIGN.md 2.8, 6.6). */
export const FLASH_MS = 600;
export const HIGHLIGHT_MS = 1200;

/**
 * New rows in a newest-first list: the keys that appear above the previous first row since the
 * last render. Filter changes and the first render flash nothing. Returns a predicate that is
 * true for `ms` after a row's arrival, so rows keep zf-flash-* (600 ms) or zf-enter (1,200 ms)
 * until the animation is over.
 */
export function useInsertions<T>(items: readonly T[], getKey: (item: T) => string, ms = FLASH_MS): (key: string) => boolean {
  const state = useRef<{ head: string | null; at: Map<string, number> }>({ head: null, at: new Map() });
  return useMemo(() => {
    const now = performance.now();
    const s = state.current;
    const first = items[0];
    const head = first === undefined ? null : getKey(first);
    if (s.head !== null && head !== null && head !== s.head) {
      const idx = items.findIndex((it) => getKey(it) === s.head);
      for (let i = 0; i < idx; i++) {
        const it = items[i];
        if (it !== undefined) {
          const k = getKey(it);
          if (!s.at.has(k)) s.at.set(k, now);
        }
      }
    }
    if (head !== null) s.head = head;
    if (s.at.size > 200) for (const [k, t] of s.at) if (now - t > ms * 4) s.at.delete(k);
    return (key: string) => {
      const t = s.at.get(key);
      return t !== undefined && now - t < ms;
    };
  }, [items, getKey, ms]);
}

/** Sorted lists re-sort at most every 2 s, and never while paused (DESIGN.md 6.7). */
const RESORT_MS = 2000;

/**
 * Hover or focus state for a list whose membership must stay live (the wallet manager: a row
 * removed from its own menu has to disappear at once), so only its re-sorts pause. Leaving
 * releases after the same 300 ms as useLivePause.
 */
export function useHoverFocusPause() {
  const [paused, setPaused] = useState(false);
  const hovered = useRef(false);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const sync = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (hovered.current || focused.current) setPaused(true);
    else timer.current = setTimeout(() => setPaused(false), RELEASE_MS);
  };
  const bind = {
    onPointerEnter: (e: PointerEvent<HTMLElement>) => {
      if (e.pointerType !== "mouse") return;
      hovered.current = true;
      sync();
    },
    onPointerLeave: (e: PointerEvent<HTMLElement>) => {
      if (e.pointerType !== "mouse") return;
      hovered.current = false;
      sync();
    },
    onFocus: () => {
      focused.current = true;
      sync();
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
      focused.current = false;
      sync();
    },
  };
  return { paused, bind };
}

/**
 * Keeps a sorted list stable between re-sorts: existing rows hold their places, new rows are
 * slotted in by the comparator, rows that left drop out. A full re-sort happens when the
 * comparator changes (a header click) or at most every 2 s, and never while `paused`.
 * `getKey` must be stable.
 */
export function useStableOrder<T>(items: readonly T[], getKey: (item: T) => string, compare: (a: T, b: T) => number, paused = false): T[] {
  const state = useRef<{ order: string[]; sortedAt: number; compare: ((a: T, b: T) => number) | null }>({
    order: [],
    sortedAt: 0,
    compare: null,
  });
  const [, setTick] = useState(0);
  const result = useMemo(() => {
    const now = Date.now();
    const s = state.current;
    const byKey = new Map<string, T>();
    for (const it of items) byKey.set(getKey(it), it);
    if (s.compare !== compare || (!paused && now - s.sortedAt >= RESORT_MS)) {
      const sorted = [...items].sort(compare);
      s.order = sorted.map(getKey);
      s.sortedAt = now;
      s.compare = compare;
      return sorted;
    }
    const kept: T[] = [];
    for (const k of s.order) {
      const it = byKey.get(k);
      if (it !== undefined) {
        kept.push(it);
        byKey.delete(k);
      }
    }
    for (const it of byKey.values()) {
      let at = kept.findIndex((other) => compare(it, other) < 0);
      if (at < 0) at = kept.length;
      kept.splice(at, 0, it);
    }
    s.order = kept.map(getKey);
    return kept;
  }, [items, getKey, compare, paused]);

  // Make sure a change inside the 2 s window still gets its re-sort when the feed goes quiet.
  useEffect(() => {
    if (result.length < 2 || paused) return;
    const wait = RESORT_MS - (Date.now() - state.current.sortedAt);
    if (wait <= 0) return;
    const t = setTimeout(() => setTick((n) => n + 1), wait + 20);
    return () => clearTimeout(t);
  }, [result, paused]);

  return result;
}

/**
 * Row targets for Space+B on the Trackers and Discover pages: the hovered row (shared with
 * Pulse through `useUi.hoverMint`) or the keyboard-cursor row. `pageHotkey` tells the docks
 * whether Space+B is live, so their tooltips only show keycaps that work.
 */
export const useRowTargets = create<{ cursorMint: string | null; pageHotkey: boolean }>()(() => ({
  cursorMint: null,
  pageHotkey: false,
}));

/** Pointer handlers for a row that holds a token: the hover target for trade hotkeys. */
export function hoverTarget(mint: string) {
  return {
    onPointerEnter: () => useUi.getState().setHoverMint(mint),
    onPointerLeave: () => {
      if (useUi.getState().hoverMint === mint) useUi.getState().setHoverMint(null);
    },
  };
}

/**
 * Space+B on this page buys the hovered or cursor row with the global quick-buy amount (the
 * "hotkey" source: keyboard repeats need a fresh keydown instead of the mouse repeat guard).
 */
export function useQuickBuyHotkey(): void {
  useEffect(() => {
    useRowTargets.setState({ pageHotkey: true });
    const off = registerHotkey("buy.quick", () => {
      const mint = useUi.getState().hoverMint ?? useRowTargets.getState().cursorMint;
      if (!mint) {
        useToasts
          .getState()
          .push({ kind: "info", title: "Hover or select a row first", body: "Space+B buys the row under the cursor.", ttl: 2000 });
        return;
      }
      void buy({ mint, sol: useSettings.getState().quickBuySol, source: "hotkey" });
    });
    return () => {
      off();
      useRowTargets.setState({ pageHotkey: false, cursorMint: null });
      useUi.getState().setHoverMint(null);
    };
  }, []);
}
