import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

/**
 * Pulse toolbar control: the ghost button (DESIGN.md 4.6, sm: 24 px, 12/500, 14 px icons) with a
 * pressed state for toggles (`active`: text-1 on surface-3, like an active IconButton). Hover
 * changes colour only.
 */
export function ToolbarButton({ active, className, children, type, ...rest }: ComponentProps<"button"> & { active?: boolean }) {
  return (
    <button
      type={type ?? "button"}
      aria-pressed={active}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-sm px-2 text-data font-medium whitespace-nowrap transition-colors [&_svg]:size-3.5",
        active ? "bg-surface-3 text-fg-1" : "text-fg-2 hover:bg-surface-3 hover:text-fg-1",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
