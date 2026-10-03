import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { UnreadBadge } from "./bits";

export interface TabDef<T extends string> {
  id: T;
  label: ReactNode;
  /** Unread count shown next to the label. */
  badge?: number;
}

/*
 * Panel tabs. Anatomy follows Coinbase Advanced's "Watchlist | Spot | Perps" panel header: plain
 * labels, neutral filled active tab, no underline or accent.
 * https://mobbin.com/screens/faec9f03-a00c-4718-ab12-44a3053cdac3
 */
export function TabBar<T extends string>({
  tabs,
  value,
  onChange,
  label,
  className,
}: {
  tabs: TabDef<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className={cn("flex min-w-0 items-center gap-1", className)}>
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={cn(
              "flex h-6 shrink-0 items-center gap-1 rounded-sm px-2 text-data font-medium whitespace-nowrap transition-colors",
              active ? "bg-surface-3 text-fg-1" : "text-fg-2 hover:text-fg-1",
            )}
          >
            {t.label}
            {!active && t.badge ? <UnreadBadge count={t.badge} /> : null}
          </button>
        );
      })}
    </div>
  );
}
