import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/** Width on the 4px spacing grid, for CSS grid templates (no pixel literals in components). */
export function sp(n: number): string {
  return `calc(var(--spacing) * ${n})`;
}

export interface Col {
  label: ReactNode;
  width: string;
  align?: "left" | "right" | "center";
}

export function template(cols: Col[]): string {
  return cols.map((c) => c.width).join(" ");
}

/**
 * Sticky header row for the token page tables: small uppercase dim labels, numeric columns
 * right-aligned. Anatomy after Uniswap's transactions table
 * https://mobbin.com/screens/9a89244a-9b7b-49c1-9d6c-28cd7abdfa3f and Coinbase Advanced's orders table.
 */
export function TableHead({ cols, className }: { cols: Col[]; className?: string }) {
  return (
    <div
      className={cn(
        "sticky top-0 z-10 grid h-7 items-center gap-2 border-b border-line bg-panel px-3 text-2xs tracking-wide text-dim uppercase",
        className,
      )}
      style={{ gridTemplateColumns: template(cols) }}
    >
      {cols.map((c, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: static column definitions
          key={i}
          className={cn("truncate", c.align === "right" && "text-right", c.align === "center" && "text-center")}
        >
          {c.label}
        </span>
      ))}
    </div>
  );
}
