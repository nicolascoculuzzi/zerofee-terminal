import { type KeyboardEvent, type ReactNode, useRef } from "react";
import { cn } from "../../lib/cn";
import { fmtCount } from "../../lib/format";

export interface TabItem<T extends string> {
  id: T;
  label: string;
  /** Count after the label in text-3 ("Armed 7"); hidden when null or zero. */
  count?: number | null;
  /** Count in warn (needs attention), e.g. "Needs re-arm 3". */
  attention?: boolean;
}

/** DOM ids so a tab panel can point back at its tab (aria-labelledby). */
export function tabId(base: string, id: string): string {
  return `${base}-tab-${id}`;
}
export function panelId(base: string, id: string): string {
  return `${base}-panel-${id}`;
}

/**
 * Panel tabs (DESIGN.md 4.8): the panel-header height (32/36 px), label 12/500, inactive text-3,
 * hover text-2, active text-1 with a 2 px accent bar inset at the bottom; counts follow the
 * label in text-3. Tablist pattern with roving tabindex, Left/Right, Home/End. Underline tabs
 * after Coinbase Advanced and OKX:
 * https://mobbin.com/screens/f8afc154-e5c8-4587-ab43-93c4799a979a
 * https://mobbin.com/screens/c3ca83ef-f1de-4703-abbf-aa02ff6fa1ff
 * Status tabs with counts after Square: https://mobbin.com/screens/14618499-6730-4721-9822-bad566504229
 */
export function PanelTabs<T extends string>({
  base,
  tabs,
  value,
  onChange,
  label,
  className,
  children,
}: {
  /** Prefix for tab and panel ids (unique on the page). */
  base: string;
  tabs: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  className?: string;
  /** Right-aligned controls in the same 32 px bar. */
  children?: ReactNode;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === value);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const t = tabs[next];
    if (t) {
      onChange(t.id);
      refs.current[next]?.focus();
    }
  };
  return (
    <div className={cn("flex h-panel-header shrink-0 items-stretch gap-2 border-b border-hairline bg-surface-1 pr-2", className)}>
      <div role="tablist" aria-label={label} onKeyDown={onKey} className="flex min-w-0 items-stretch overflow-x-auto">
        {tabs.map((t, i) => {
          const active = t.id === value;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              id={tabId(base, t.id)}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={panelId(base, t.id)}
              tabIndex={active ? 0 : -1}
              onClick={() => onChange(t.id)}
              className={cn(
                "focus-inset relative flex shrink-0 items-center gap-1 px-3 text-data font-medium whitespace-nowrap transition-colors",
                active ? "text-fg-1" : "text-fg-3 hover:text-fg-2",
              )}
            >
              {t.label}
              {t.count !== undefined && t.count !== null && t.count > 0 && (
                <span className={cn("zf-num text-label font-normal", t.attention ? "text-warn" : "text-fg-3")}>{fmtCount(t.count)}</span>
              )}
              {active && <span aria-hidden="true" className="absolute inset-x-3 bottom-0 h-0.5 bg-accent" />}
            </button>
          );
        })}
      </div>
      {children && <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}
