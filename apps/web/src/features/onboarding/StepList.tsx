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
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-muted">
            Step {current + 1} of {steps.length}
          </span>
          <span className="font-semibold text-fg">{steps[current]?.title}</span>
        </div>
        <div className="mt-2 flex gap-1">
          {steps.map((s, i) => (
            <span key={s.id} className={cn("h-1 flex-1 rounded-full", i === current ? "bg-fg" : done[i] ? "bg-buy" : "bg-elev")} />
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
                    "flex size-5 shrink-0 items-center justify-center rounded-full border text-2xs font-semibold",
                    state === "done" && "border-buy bg-buy text-on-buy",
                    state === "current" && "border-fg text-fg",
                    state === "todo" && "border-line-strong text-dim",
                  )}
                >
                  {state === "done" ? <Check className="icon-xs" /> : i + 1}
                </span>
                <span className="min-w-0">
                  <span className={cn("block text-sm", state === "todo" ? "text-dim" : "text-fg", state === "current" && "font-semibold")}>
                    {s.title}
                  </span>
                  {summary && <span className="block truncate text-xs text-muted">{summary}</span>}
                </span>
              </>
            );
            const base = "flex w-full items-start gap-2 rounded-md px-2 py-2 text-left";
            return (
              <li key={s.id}>
                {state !== "current" && !disabled && canVisit(i) ? (
                  <button type="button" onClick={() => onSelect(i)} className={cn(base, "transition-colors hover:bg-hover")}>
                    {body}
                  </button>
                ) : (
                  <div aria-current={state === "current" ? "step" : undefined} className={cn(base, state === "current" && "bg-elev")}>
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
