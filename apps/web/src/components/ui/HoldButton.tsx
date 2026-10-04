import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { useMediaQuery } from "../../lib/useMediaQuery";

/** How long a completed hold stays filled when its action is synchronous. */
const RESET_MS = 1200;

/**
 * Hold-to-confirm (DESIGN.md 1.7, 4.17): the fill grows left to right over `ms` while the
 * pointer, Space or Enter is held; releasing early cancels. With reduced motion it reads
 * "Hold 1 s" and counts down instead of filling. For Panic, key export and new withdrawal
 * destinations. Countdown pattern after Monzo: https://mobbin.com/screens/c73a3c93-eb1e-4c54-80c9-27e68531e9d0
 *
 * After a completed hold the button stays filled while the action runs, then re-arms itself:
 * when the promise `onConfirm` returns settles, after `RESET_MS` for a synchronous action, or
 * as soon as the button is re-enabled. Callers never need to remount it.
 */
export function HoldButton({
  onConfirm,
  children,
  ms = 1000,
  tone = "danger",
  className,
  disabled,
}: {
  /** Return a promise to keep the button filled until the action settles. */
  onConfirm: () => unknown;
  children: ReactNode;
  ms?: number;
  tone?: "danger" | "primary";
  className?: string;
  disabled?: boolean;
}) {
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [progress, setProgress] = useState(0);
  const start = useRef<number | null>(null);
  const raf = useRef<number | null>(null);
  const done = useRef(false);
  const mounted = useRef(true);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = useCallback(() => {
    start.current = null;
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    if (!done.current) setProgress(0);
  }, []);

  /** Re-arms after a completed hold. */
  const reset = useCallback(() => {
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    resetTimer.current = null;
    if (!mounted.current) return;
    done.current = false;
    start.current = null;
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    setProgress(0);
  }, []);

  const tick = useCallback(() => {
    if (start.current === null) return;
    const p = Math.min(1, (performance.now() - start.current) / ms);
    setProgress(p);
    if (p >= 1) {
      done.current = true;
      start.current = null;
      let result: unknown;
      try {
        result = onConfirm();
      } catch (e) {
        reset();
        throw e;
      }
      if (result instanceof Promise) result.then(reset, reset);
      else resetTimer.current = setTimeout(reset, RESET_MS);
      return;
    }
    raf.current = requestAnimationFrame(tick);
  }, [ms, onConfirm, reset]);

  const begin = useCallback(() => {
    if (disabled || start.current !== null || done.current) return;
    start.current = performance.now();
    raf.current = requestAnimationFrame(tick);
  }, [disabled, tick]);

  // Re-enabled (e.g. a busy flag cleared after a failed or cancelled action): ready again.
  const wasDisabled = useRef(disabled);
  useEffect(() => {
    if (wasDisabled.current && !disabled) reset();
    wasDisabled.current = disabled;
  }, [disabled, reset]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
      stop();
    };
  }, [stop]);

  const remaining = Math.max(0, Math.ceil(((1 - progress) * ms) / 1000));
  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        begin();
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onPointerLeave={stop}
      onKeyDown={(e) => {
        if ((e.key === " " || e.key === "Enter") && !e.repeat) {
          e.preventDefault();
          begin();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === " " || e.key === "Enter") stop();
      }}
      className={cn(
        "relative inline-flex h-8 items-center justify-center overflow-hidden rounded-sm border px-3 text-body font-semibold select-none disabled:cursor-not-allowed disabled:text-fg-4",
        tone === "danger" ? "border-sell-edge bg-sell-tint text-sell" : "border-transparent bg-accent text-ink",
        className,
      )}
    >
      {!reduced && (
        <span
          aria-hidden="true"
          className={cn("absolute inset-y-0 left-0", tone === "danger" ? "bg-sell-tint-press" : "bg-accent-press")}
          style={{ width: `${progress * 100}%` }}
        />
      )}
      <span className="relative">
        {children}
        {reduced && progress > 0 && progress < 1 && ` · ${remaining}`}
        {reduced && progress === 0 && " · Hold 1 s"}
      </span>
    </button>
  );
}
