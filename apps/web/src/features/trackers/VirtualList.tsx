import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useRef } from "react";
import { cn } from "../../lib/cn";

export interface VirtualListProps {
  count: number;
  /** Fixed row height in px (the --zf-row token; rows render with h-7). */
  rowHeight: number;
  getKey: (index: number) => string | number;
  renderRow: (index: number) => ReactNode;
  className?: string;
  overscan?: number;
  label?: string;
}

/** Fixed-height virtual list in its own scroll container (fills the remaining flex space). */
export function VirtualList({ count, rowHeight, getKey, renderRow, className, overscan = 10, label }: VirtualListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    getItemKey: getKey,
    overscan,
    useFlushSync: false,
  });
  return (
    <div ref={scrollRef} className={cn("min-h-0 flex-1 overflow-y-auto", className)}>
      <ul aria-label={label} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => (
          <li
            key={item.key}
            className="absolute top-0 left-0 w-full"
            style={{ height: item.size, transform: `translateY(${item.start}px)` }}
          >
            {renderRow(item.index)}
          </li>
        ))}
      </ul>
    </div>
  );
}
