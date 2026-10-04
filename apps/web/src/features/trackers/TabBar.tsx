import { type KeyboardEvent, type ReactNode, useRef } from "react";
import { CountBadge } from "../../components/ui/bits";
import { cn } from "../../lib/cn";

export interface TabDef<T extends string> {
  id: T;
  label: ReactNode;
  /** Count after the label in text-3 ("Wallets 128"). */
  count?: ReactNode;
  /** Unread items: a neutral count badge while the tab isn't active. */
  unread?: number;
  title?: string;
}

/*
 * Panel tabs (DESIGN.md 4.8): label 12/500, inactive text-3 (hover text-2), active text-1 with a
 * 2 px accent bar inset at the bottom; counts follow the label in text-3. Roving tabindex with
 * Left/Right and Home/End. Underline tabs after Coinbase Advanced's "Price chart | Depth chart":
 * https://mobbin.com/screens/f8afc154-e5c8-4587-ab43-93c4799a979a
 */
export function TabBar<T extends string>({
  tabs,
  value,
  onChange,
  label,
  idPrefix,
  className,
}: {
  tabs: TabDef<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  /** Ties each tab to its panel (`${idPrefix}-panel-${id}`). */
  idPrefix?: string;
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === value);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    const t = tabs[next];
    if (!t) return;
    e.preventDefault();
    onChange(t.id);
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className={cn("flex h-full min-w-0 items-stretch", className)}>
      {tabs.map((t, i) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={idPrefix ? `${idPrefix}-tab-${t.id}` : undefined}
            aria-controls={idPrefix ? `${idPrefix}-panel-${t.id}` : undefined}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            title={t.title}
            onClick={() => onChange(t.id)}
            className={cn(
              "focus-inset relative flex shrink-0 items-center gap-1 px-2 text-data font-medium whitespace-nowrap transition-colors",
              "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:content-['']",
              active ? "text-fg-1 after:bg-accent" : "text-fg-3 hover:text-fg-2",
            )}
          >
            {t.label}
            {t.count !== undefined && <span className="zf-num text-fg-3">{t.count}</span>}
            {!active && t.unread !== undefined && t.unread > 0 && <CountBadge count={t.unread > 99 ? "99+" : t.unread} />}
          </button>
        );
      })}
    </div>
  );
}
