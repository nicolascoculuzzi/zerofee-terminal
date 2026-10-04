import { type RefObject, useLayoutEffect, useRef, useState } from "react";

/**
 * Scrolled lists keep still (DESIGN.md 6.7): when rows insert or leave above the viewport, the
 * first visible card stays where it was (scrollTop moves by the inserted height before paint),
 * and the rows inserted above are counted for the "↑ N new" bar until the list is back at the
 * top. At the top, live inserts push the list down as usual.
 */
export function useScrollAnchor(scrollRef: RefObject<HTMLElement | null>, shown: readonly string[], rowH: number) {
  const [unseen, setUnseen] = useState(0);
  const prevShown = useRef(shown);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const prev = prevShown.current;
    prevShown.current = shown;
    if (!el || prev === shown || el.scrollTop <= 0) return;
    const first = Math.floor(el.scrollTop / rowH);
    const anchor = prev[first];
    if (!anchor) return;
    const at = shown.indexOf(anchor);
    if (at < 0 || at === first) return;
    el.scrollTop += (at - first) * rowH;
    const before = new Set(prev);
    let added = 0;
    for (let i = 0; i < at; i++) if (!before.has(shown[i] ?? "")) added++;
    if (added > 0) setUnseen((n) => n + added);
  }, [scrollRef, shown, rowH]);

  return {
    unseen,
    /** Call from the list's scroll handler: back at the top, nothing is unseen. */
    onScroll: (scrollTop: number) => {
      if (scrollTop <= 0 && unseen > 0) setUnseen(0);
    },
    jumpToTop: () => {
      scrollRef.current?.scrollTo({ top: 0 });
      setUnseen(0);
    },
  };
}
