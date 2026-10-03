import { ArrowLeft, CircleAlert } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { Button } from "../../components/ui/Button";
import { errorMessage } from "../settings/format";

export const STEP_TITLE_ID = "zf-onboarding-step-title";

export const PROVIDER_NAME = { phantom: "Phantom", solflare: "Solflare", backpack: "Backpack" } as const;

/** Position and copy of the current step, passed from the page to each step. */
export interface StepFrame {
  index: number;
  total: number;
  title: string;
  description: string;
}

/*
 * Step panel: hairline card with the step header, body and a footer whose actions sit
 * bottom-right with Back on the left (Melio's setup flow):
 * https://mobbin.com/screens/45acbdef-a8f5-466e-920c-3a2f4b3f8fb8
 */
export function StepPanel({ index, total, title, description, children, footer }: StepFrame & { children: ReactNode; footer: ReactNode }) {
  return (
    <div className="rounded-md border border-hairline bg-surface-1">
      <div className="border-b border-hairline px-4 py-3">
        <div className="zf-label">
          Step {index + 1} of {total}
        </div>
        <h2 id={STEP_TITLE_ID} className="mt-1 text-heading font-semibold text-fg-1">
          {title}
        </h2>
        <p className="text-data text-fg-2">{description}</p>
      </div>
      <div className="space-y-4 p-4">{children}</div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline px-4 py-3">{footer}</div>
    </div>
  );
}

export function StepFooter({ onBack, backDisabled, children }: { onBack?: () => void; backDisabled?: boolean; children: ReactNode }) {
  return (
    <>
      {onBack ? (
        <Button size="lg" variant="ghost" icon={<ArrowLeft className="icon-md" />} disabled={backDisabled} onClick={onBack}>
          Back
        </Button>
      ) : (
        <span />
      )}
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{children}</div>
    </>
  );
}

export function InlineError({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="flex items-start gap-2 text-data text-sell">
      <CircleAlert className="icon-sm mt-px" />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

export type ActionResult<T> = { ok: true; value: T } | { ok: false };

/** Busy + error state for one async step action; reports busy to the page so navigation pauses. */
export function useAction(onBusyChange: (busy: boolean) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<ActionResult<T>> => {
      setBusy(true);
      setError(null);
      onBusyChange(true);
      try {
        return { ok: true, value: await fn() };
      } catch (e) {
        setError(errorMessage(e));
        return { ok: false };
      } finally {
        setBusy(false);
        onBusyChange(false);
      }
    },
    [onBusyChange],
  );
  return { busy, error, setError, run };
}
