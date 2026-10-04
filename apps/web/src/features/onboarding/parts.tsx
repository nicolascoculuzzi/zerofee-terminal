import { ArrowLeft, CircleAlert, LoaderCircle } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import { fmtMs } from "../../lib/format";
import { useMediaQuery } from "../../lib/useMediaQuery";
import { errorMessage } from "../settings/format";

export const STEP_TITLE_ID = "zf-onboarding-step-title";

export const PROVIDER_NAME = { phantom: "Phantom", solflare: "Solflare", backpack: "Backpack" } as const;

/** Copy for the current step, passed from the page to each step. */
export interface StepFrame {
  title: string;
  description: string;
  /** Null on the first step and while an action is in flight. */
  onBack: (() => void) | null;
}

/*
 * Step layout (DESIGN.md 4.19, 5.6): a "Back" ghost xs at the top-left of the content, the title
 * at 16/600, one line of description at 13 text-2, the body, then one primary action. Top-left
 * aligned, never centred, no hero and no illustration.
 */
export function StepHeader({ frame }: { frame: StepFrame }) {
  return (
    <header className="mb-6">
      <div className="mb-4 h-5">
        {frame.onBack && (
          <Button size="xs" variant="ghost" icon={<ArrowLeft />} onClick={frame.onBack} className="-ml-1.5 max-md:h-11 [&_svg]:size-3.5">
            Back
          </Button>
        )}
      </div>
      <h1 id={STEP_TITLE_ID} className="text-title font-semibold text-fg-1">
        {frame.title}
      </h1>
      <p className="mt-1 text-body text-fg-2">{frame.description}</p>
    </header>
  );
}

/** The step's actions: the one primary action first, then at most a quiet secondary. */
export function StepActions({ children }: { children: ReactNode }) {
  return <div className="mt-6 flex flex-wrap items-center gap-2">{children}</div>;
}

export function InlineError({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="mt-3 flex items-start gap-2 text-data text-sell">
      <CircleAlert className="icon-sm mt-px" />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/**
 * In-flight indicator for user actions only: a 14 px spinner, or, with reduced motion, the
 * elapsed time (DESIGN.md 2.8, 4.18).
 */
export function Spinner({ className }: { className?: string }) {
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [started] = useState(() => Date.now());
  const [now, setNow] = useState(started);
  useEffect(() => {
    if (!reduced) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [reduced]);
  if (reduced) return <span className={cn("zf-num text-label text-fg-2", className)}>{fmtMs(now - started)}</span>;
  return <LoaderCircle aria-hidden="true" className={cn("icon-sm animate-spin text-fg-2", className)} />;
}

export type ActionResult<T> = { ok: true; value: T } | { ok: false };

/** Busy and error state for one async step action; reports busy to the page so navigation pauses. */
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
