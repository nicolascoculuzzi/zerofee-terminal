import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface StepMeta {
  id: string;
  title: string;
}

/*
 * Setup progress. Desktop: vertical step list with a "Step n of 6" counter, done steps checked
 * (buy = done) and a one-line result under each, after Melio's and Mercury's account setup:
 * https://mobbin.com/screens/45acbdef-a8f5-466e-920c-3a2f4b3f8fb8
 * https://mobbin.com/screens/8b12e7b5-4bd6-4eea-9a61-7ebbcfa4f855
 * Phones: a compact counter and a segmented bar.
 */
export function StepList({
  steps,
  current,
  done,
  summaries,
  canVisit,
  onSelect,
  disabled,
}: {
  steps: readonly StepMeta[];
  current: number;
  done: readonly boolean[];
  summaries: readonly (string | null)[];
  canVisit: (index: number) => boolean;
  onSelect: (index: number) => void;
  disabled: boolean;
}) {
  return (
    <>
      <div className="md:hidden">
        <div className="flex items-center justify-between gap-2 text-label">
          <span className="text-fg-2">
            Step {current + 1} of {steps.length}
          </span>
          <span className="font-semibold text-fg-1">{steps[current]?.title}</span>
        </div>
        <div className="mt-2 flex gap-1">
          {steps.map((s, i) => (
            <span key={s.id} className={cn("h-1 flex-1 rounded-full", i === current ? "bg-accent" : done[i] ? "bg-buy" : "bg-surface-3")} />
          ))}
        </div>
      </div>

      <nav aria-label="Setup steps" className="hidden md:block">
        <div className="zf-label mb-2">
          Step {current + 1} of {steps.length}
        </div>
        <ol className="space-y-1">
          {steps.map((s, i) => {
            const state = i === current ? "current" : done[i] ? "done" : "todo";
            const summary = summaries[i];
            const body: ReactNode = (
              <>
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full border text-micro font-semibold",
                    state === "done" && "border-buy bg-buy text-ink",
                    state === "current" && "border-fg-1 text-fg-1",
                    state === "todo" && "border-hairline-strong text-fg-3",
                  )}
                >
                  {state === "done" ? <Check className="icon-xs" /> : i + 1}
                </span>
                <span className="min-w-0">
                  <span
                    className={cn("block text-data", state === "todo" ? "text-fg-3" : "text-fg-1", state === "current" && "font-semibold")}
                  >
                    {s.title}
                  </span>
                  {summary && <span className="block truncate text-label text-fg-2">{summary}</span>}
                </span>
              </>
            );
            const base = "flex w-full items-start gap-2 rounded-sm px-2 py-2 text-left";
            return (
              <li key={s.id}>
                {state !== "current" && !disabled && canVisit(i) ? (
                  <button type="button" onClick={() => onSelect(i)} className={cn(base, "transition-colors hover:bg-surface-3")}>
                    {body}
                  </button>
                ) : (
                  <div aria-current={state === "current" ? "step" : undefined} className={cn(base, state === "current" && "bg-surface-3")}>
                    {body}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
    </>
  );
}
