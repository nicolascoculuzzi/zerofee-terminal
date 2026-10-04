import { Check } from "lucide-react";
import { cn } from "../../lib/cn";

export interface StepMeta {
  id: string;
  label: string;
}

/*
 * Vertical stepper (DESIGN.md 4.19): 44 px items, 20 px numbered circles joined by a 1 px
 * hairline. Done: an ink check on accent. Current: accent with the number in ink at 11/600.
 * Upcoming: a hairline-strong ring with the number in text-3. Labels 12/500, text-1 when current;
 * an 11 px text-3 sub-label once done. Done steps can be revisited.
 * Numbered circles and checks after OKX's deposit flow:
 * https://mobbin.com/flows/a6c83dd1-51f7-4e6f-95da-faff776eb1ca
 */
export function Stepper({
  steps,
  current,
  done,
  sublabels,
  canVisit,
  onSelect,
}: {
  steps: readonly StepMeta[];
  current: number;
  done: readonly boolean[];
  sublabels: readonly (string | null)[];
  canVisit: (index: number) => boolean;
  onSelect: (index: number) => void;
}) {
  return (
    <nav aria-label="Setup steps">
      <ol>
        {steps.map((s, i) => {
          const state = i === current ? "current" : done[i] ? "done" : "upcoming";
          const sub = state === "done" ? sublabels[i] : null;
          const last = i === steps.length - 1;
          const body = (
            <>
              <span className="relative flex w-5 shrink-0 justify-center self-stretch">
                {!last && <span aria-hidden="true" className="absolute top-8 -bottom-3 w-px bg-hairline" />}
                <span
                  className={cn(
                    "relative mt-3 flex size-5 items-center justify-center rounded-full text-label font-semibold",
                    state === "upcoming" ? "border border-hairline-strong text-fg-3" : "bg-accent text-ink",
                  )}
                >
                  {state === "done" ? <Check className="icon-xs" /> : <span className="zf-num">{i + 1}</span>}
                </span>
              </span>
              <span className="min-w-0 flex-1 py-2.5">
                <span className={cn("block truncate text-data font-medium", state === "current" ? "text-fg-1" : "text-fg-3")}>
                  {s.label}
                </span>
                {sub && <span className="block truncate text-label text-fg-3">{sub}</span>}
              </span>
            </>
          );
          const visitable = state !== "current" && canVisit(i);
          return (
            <li key={s.id} className="min-h-11">
              {visitable ? (
                <button
                  type="button"
                  onClick={() => onSelect(i)}
                  className="focus-inset -mx-2 flex w-[calc(100%+16px)] gap-3 rounded-sm px-2 text-left transition-colors hover:bg-surface-2"
                >
                  {body}
                </button>
              ) : (
                <div aria-current={state === "current" ? "step" : undefined} className="flex gap-3">
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Phones: a 4 px segmented bar with "Step 2 of 7" at 11 text-3 (DESIGN.md 4.19). Segment bar after Base: https://mobbin.com/screens/21ac15ea-e128-4153-a664-722950025ce9 */
export function StepProgress({ current, total, label }: { current: number; total: number; label: string }) {
  return (
    <div>
      <div
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={1}
        aria-valuemax={total}
        aria-valuenow={current + 1}
        aria-valuetext={`Step ${current + 1} of ${total}: ${label}`}
        className="flex gap-1"
      >
        {Array.from({ length: total }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed segments
          <span key={i} className={cn("h-1 flex-1 rounded-xs", i <= current ? "bg-accent" : "bg-surface-3")} />
        ))}
      </div>
      <p className="mt-2 text-label text-fg-3">
        Step {current + 1} of {total}
      </p>
    </div>
  );
}
