import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";

export interface RowCursor {
  /** Index of the keyboard-cursor row (roving tabindex: this row has tabIndex 0). */
  cursor: number;
  setCursor: (index: number) => void;
  /** Ref callback for row `index`. */
  rowRef: (index: number) => (el: HTMLElement | null) => void;
  /** Put on the element that contains the rows (tbody or list). */
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  /** Moves the cursor to `index` and focuses that row. */
  focusRow: (index: number) => void;
}

/**
 * Keyboard path for data grids (DESIGN.md 4.9, 6.4 "Tables"): Up/Down move the cursor row,
 * Home/End jump, Enter opens and Shift+Enter shows details. Rows use a roving tabindex, so Tab
 * enters the grid on the cursor row and leaves it on the next control. Keys are handled only
 * when a row itself has focus, never when a button inside the row does.
 */
export function useRowCursor(
  count: number,
  opts: { onOpen?: (index: number) => void; onDetails?: (index: number) => void; scrollToIndex?: (index: number) => void } = {},
): RowCursor {
  const [cursor, setCursorState] = useState(0);
  const rows = useRef(new Map<number, HTMLElement>());
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Keep the cursor inside the list when rows go away.
  useEffect(() => {
    if (count > 0 && cursor > count - 1) setCursorState(count - 1);
  }, [count, cursor]);

  const setCursor = useCallback((index: number) => setCursorState(Math.max(0, index)), []);

  const focusRow = useCallback(
    (index: number) => {
      if (count === 0) return;
      const next = Math.max(0, Math.min(count - 1, index));
      setCursorState(next);
      optsRef.current.scrollToIndex?.(next);
      // The row may only mount after the virtualiser scrolls; focus on the next frame.
      requestAnimationFrame(() => rows.current.get(next)?.focus({ preventScroll: false }));
    },
    [count],
  );

  const rowRef = useCallback(
    (index: number) => (el: HTMLElement | null) => {
      if (el) rows.current.set(index, el);
      else rows.current.delete(index);
    },
    [],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const target = e.target as HTMLElement;
      if (!target.matches("[data-row-index]")) return;
      const at = Number(target.dataset.rowIndex);
      const here = Number.isFinite(at) ? at : cursor;
      let next: number | null = null;
      if (e.key === "ArrowDown") next = here + 1;
      else if (e.key === "ArrowUp") next = here - 1;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = count - 1;
      else if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) optsRef.current.onDetails?.(here);
        else optsRef.current.onOpen?.(here);
        return;
      }
      if (next === null) return;
      e.preventDefault();
      focusRow(next);
    },
    [count, cursor, focusRow],
  );

  return { cursor, setCursor, rowRef, onKeyDown, focusRow };
}
