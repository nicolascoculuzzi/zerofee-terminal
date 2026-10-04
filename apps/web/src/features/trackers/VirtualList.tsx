import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/cn";
import { NewRowsPill } from "./bits";
import { useRowTargets } from "./hooks";

type Handlers = {
  onPointerEnter?: (e: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (e: PointerEvent<HTMLElement>) => void;
  onFocus?: (e: FocusEvent<HTMLElement>) => void;
  onBlur?: (e: FocusEvent<HTMLElement>) => void;
};

export interface RowContext {
  index: number;
  /** Keyboard cursor row (only while the grid has focus). */
  active: boolean;
}

export interface VirtualGridProps<T> {
  items: readonly T[];
  /** Stable (module-level) key function. */
  getKey: (item: T) => string;
  /** Fixed row height in px: a density token read with useCssPx, or 64 on phones. */
  rowHeight: number;
  label: string;
  renderRow: (item: T, ctx: RowContext) => ReactNode;
  /** A HeaderRow; it stays put while the body scrolls. */
  header?: ReactNode;
  /** Shown in the body when there are no rows. */
  empty?: ReactNode;
  /** Hover / focus pause from useLivePause. */
  paused?: boolean;
  pending?: number;
  onRelease?: () => void;
  bind?: Handlers;
  /** Enter opens; Mod+Enter in a new tab; Shift+Enter shows details (DESIGN.md 6.4 "Tables"). */
  onOpen?: (item: T, how: { newTab: boolean; details: boolean }) => void;
  /** "C" copies the row's address. */
  onCopy?: (item: T) => void;
  /** Token the cursor row stands for: the Space+B target. */
  mintOf?: (item: T) => string | null;
  isSelected?: (item: T) => boolean;
  overscan?: number;
  className?: string;
}

/**
 * Virtualised live grid (DESIGN.md 4.9, 6.7, 7.7): role="grid" with aria-rowcount and
 * aria-rowindex, fixed row heights, a keyboard cursor (Up/Down, Home/End, PgUp/PgDn, Enter,
 * C), and calm inserts. While the body is scrolled away from the top, new rows above it don't
 * move the viewport: scrollTop grows by the inserted height and an "↑ N new" pill appears.
 * While hover or focus pauses the list, the same pill counts the queued rows; a click applies
 * them and scrolls to the top.
 */
export function VirtualGrid<T>({
  items,
  getKey,
  rowHeight,
  label,
  renderRow,
  header,
  empty,
  paused = false,
  pending = 0,
  onRelease,
  bind,
  onOpen,
  onCopy,
  mintOf,
  isSelected,
  overscan = 8,
  className,
}: VirtualGridProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const keys = useMemo(() => items.map(getKey), [items, getKey]);
  const indexOf = useMemo(() => new Map(keys.map((k, i) => [k, i])), [keys]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [focusWithin, setFocusWithin] = useState(false);
  const [inserted, setInserted] = useState(0);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    getItemKey: (i) => keys[i] ?? i,
    overscan,
    useFlushSync: false,
  });

  // Density switches change the row height at runtime: re-measure.
  useEffect(() => {
    if (rowHeight > 0) virtualizer.measure();
  }, [rowHeight, virtualizer]);

  // Keep the viewport on the same rows when rows are inserted above it (DESIGN.md 6.7).
  const prevKeys = useRef<string[]>(keys);
  useLayoutEffect(() => {
    const prev = prevKeys.current;
    prevKeys.current = keys;
    const el = scrollRef.current;
    if (!el || prev === keys || prev.length === 0) return;
    const top = el.scrollTop;
    if (top < rowHeight / 2) {
      setInserted(0);
      return;
    }
    const firstVisible = Math.floor(top / rowHeight);
    const anchor = prev[firstVisible];
    const now = anchor === undefined ? undefined : indexOf.get(anchor);
    if (now === undefined || now === firstVisible) return;
    el.scrollTop = top + (now - firstVisible) * rowHeight;
    if (now > firstVisible) {
      const before = new Set(prev);
      let fresh = 0;
      for (let i = 0; i < now; i++) if (!before.has(keys[i] as string)) fresh++;
      if (fresh > 0) setInserted((n) => n + fresh);
    }
  }, [keys, indexOf, rowHeight]);

  const activeIndex = activeKey === null ? -1 : (indexOf.get(activeKey) ?? -1);
  const activeItem = activeIndex >= 0 ? items[activeIndex] : undefined;
  const cursorMint = focusWithin && activeItem !== undefined && mintOf ? mintOf(activeItem) : null;
  useEffect(() => {
    if (!mintOf) return;
    useRowTargets.setState({ cursorMint });
    return () => {
      if (useRowTargets.getState().cursorMint === cursorMint) useRowTargets.setState({ cursorMint: null });
    };
  }, [cursorMint, mintOf]);

  const moveTo = (index: number) => {
    if (items.length === 0) return;
    const i = Math.max(0, Math.min(items.length - 1, index));
    const k = keys[i];
    if (k === undefined) return;
    setActiveKey(k);
    virtualizer.scrollToIndex(i, { align: "auto" });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.altKey) return;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? rowHeight) / rowHeight) - 1);
    const from = activeIndex;
    let handled = true;
    switch (e.key) {
      case "ArrowDown":
        moveTo(from < 0 ? 0 : from + 1);
        break;
      case "ArrowUp":
        moveTo(from < 0 ? 0 : from - 1);
        break;
      case "Home":
        moveTo(0);
        break;
      case "End":
        moveTo(items.length - 1);
        break;
      case "PageDown":
        moveTo(from < 0 ? page : from + page);
        break;
      case "PageUp":
        moveTo(from < 0 ? 0 : from - page);
        break;
      case "Enter":
        if (activeItem !== undefined && onOpen) onOpen(activeItem, { newTab: e.metaKey || e.ctrlKey, details: e.shiftKey });
        else handled = false;
        break;
      case "c":
      case "C":
        if (activeItem !== undefined && onCopy && !e.metaKey && !e.ctrlKey && !e.shiftKey) onCopy(activeItem);
        else handled = false;
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const queued = inserted + (paused ? pending : 0);
  const showAll = () => {
    onRelease?.();
    setInserted(0);
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
  };

  const rowId = (k: string) => `${id}-r-${k.replace(/[^\w-]/g, "_")}`;
  const virtualItems = virtualizer.getVirtualItems();

  return (
    // biome-ignore lint/a11y/useSemanticElements: virtualised rows can't live in a <table>; ARIA grid per DESIGN.md 7.7
    <div
      role="grid"
      aria-label={label}
      aria-rowcount={items.length + (header ? 1 : 0)}
      aria-activedescendant={focusWithin && activeKey !== null && activeIndex >= 0 ? rowId(activeKey) : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerEnter={bind?.onPointerEnter}
      onPointerLeave={bind?.onPointerLeave}
      onFocus={(e) => {
        setFocusWithin(true);
        bind?.onFocus?.(e);
      }}
      onBlur={(e) => {
        if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setFocusWithin(false);
        bind?.onBlur?.(e);
      }}
      // The base :focus-visible ring (2 px focus colour), inset by 1 px so it isn't clipped (DESIGN.md 6.3).
      className={cn("focus-inset relative flex min-h-0 min-w-0 flex-1 flex-col", className)}
    >
      {header}
      {/* The rowgroup of the ARIA grid above; a plain box while it shows the empty state. */}
      <div
        ref={scrollRef}
        role={items.length === 0 ? undefined : "rowgroup"}
        onScroll={(e) => {
          if (inserted > 0 && e.currentTarget.scrollTop < rowHeight / 2) setInserted(0);
        }}
        className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
      >
        {items.length === 0 ? (
          empty
        ) : (
          <div role="presentation" className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualItems.map((v) => {
              const item = items[v.index];
              if (item === undefined) return null;
              const k = keys[v.index] as string;
              return (
                // biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: virtual row of the ARIA grid; the grid holds focus via aria-activedescendant
                <div
                  key={v.key}
                  id={rowId(k)}
                  role="row"
                  aria-rowindex={v.index + (header ? 2 : 1)}
                  aria-selected={isSelected ? isSelected(item) : undefined}
                  className="absolute top-0 left-0 w-full"
                  style={{ height: rowHeight, transform: `translateY(${v.start}px)` }}
                >
                  {renderRow(item, { index: v.index, active: focusWithin && k === activeKey })}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {queued > 0 && (
        <NewRowsPill
          count={queued}
          paused={paused}
          onClick={showAll}
          className={header ? "top-[calc(var(--zf-header-row)+4px)]" : "top-1"}
        />
      )}
    </div>
  );
}
