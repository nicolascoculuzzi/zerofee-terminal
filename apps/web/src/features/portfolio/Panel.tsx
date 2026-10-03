import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/*
 * Hairline module with a compact header, after Kraken Pro's home modules
 * https://mobbin.com/screens/fe204312-8607-4018-b0dd-a36dc71f4978
 * Same anatomy as components/ui/bits Section, but the body flexes so modules in one grid row
 * share a height (the PnL chart fills whatever its neighbours leave).
 */
export function Panel({
  title,
  extra,
  children,
  className,
  bodyClassName,
}: {
  title: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col rounded-md border border-hairline bg-surface-1", className)}>
      <header className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-hairline px-3">
        <h2 className="truncate text-data font-semibold text-fg-1">{title}</h2>
        {extra && <div className="flex shrink-0 items-center gap-2">{extra}</div>}
      </header>
      <div className={cn("flex-1", bodyClassName)}>{children}</div>
    </section>
  );
}

/** Small label/value row used in summary modules. */
export function StatRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-6 items-center justify-between gap-2">
      <dt className="truncate text-fg-2">{label}</dt>
      <dd className="flex shrink-0 items-baseline gap-1 text-right">{children}</dd>
    </div>
  );
}
