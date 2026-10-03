import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { useMediaQuery } from "../../lib/useMediaQuery";

/**
 * Hold-to-confirm (DESIGN.md 1.7, 4.17): the fill grows left to right over `ms` while the
 * pointer, Space or Enter is held; releasing early cancels. With reduced motion it reads
 * "Hold 1 s" and counts down instead of filling. For Panic, key export and new withdrawal
 * destinations. Countdown pattern after Monzo: https://mobbin.com/screens/c73a3c93-eb1e-4c54-80c9-27e68531e9d0
 */
export function HoldButton({
  onConfirm,
  children,
  ms = 1000,
  tone = "danger",
  className,
  disabled,
}: {
  onConfirm: () => void;
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

  const stop = useCallback(() => {
    start.current = null;
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    if (!done.current) setProgress(0);
  }, []);

  const tick = useCallback(() => {
    if (start.current === null) return;
    const p = Math.min(1, (performance.now() - start.current) / ms);
    setProgress(p);
    if (p >= 1) {
      done.current = true;
      start.current = null;
      onConfirm();
      return;
    }
    raf.current = requestAnimationFrame(tick);
  }, [ms, onConfirm]);

  const begin = useCallback(() => {
    if (disabled || start.current !== null || done.current) return;
    start.current = performance.now();
    raf.current = requestAnimationFrame(tick);
  }, [disabled, tick]);

  useEffect(() => () => stop(), [stop]);

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
