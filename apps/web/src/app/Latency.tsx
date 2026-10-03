import { ArrowRight } from "lucide-react";
import { cn } from "../lib/cn";
import { fmtInt, fmtMs } from "../lib/format";
import type { LatencyBreakdown } from "../protocol";

interface Step {
  label: React.ReactNode;
  delta: number | null;
}

function Arrow() {
  return <ArrowRight className="mx-0.5 inline size-2.5 align-[-1px]" aria-label="to" />;
}

/**
 * Latency breakdown (DESIGN.md 4.13): one 18px row per step with its delta in mono 11px and a
 * 48px bar (text-3 on a surface-3 track; the largest segment in text-2), then the total.
 * The record is cumulative ms since the click; rows show the time each step added.
 */
export function LatencyBreakdownView({ latency, status }: { latency: LatencyBreakdown; status: "confirmed" | "failed" | null }) {
  const lastSent = latency.lanes.reduce((m, l) => Math.max(m, l.sentMs), latency.receivedMs);
  const steps: Step[] = [
    {
      label: (
        <>
          Click <Arrow /> built
        </>
      ),
      delta: latency.builtMs,
    },
    {
      label: (
        <>
          Built <Arrow /> signed
        </>
      ),
      delta: latency.signedMs - latency.builtMs,
    },
    {
      label: (
        <>
          Signed <Arrow /> server
        </>
      ),
      delta: latency.receivedMs - latency.signedMs,
    },
    ...latency.lanes.map((l) => ({ label: `Sent · ${l.lane}`, delta: l.sentMs - latency.receivedMs })),
    { label: status === "failed" ? "Not landed" : "Landed", delta: latency.landedMs === null ? null : latency.landedMs - lastSent },
  ];
  const max = Math.max(1, ...steps.map((s) => s.delta ?? 0));
  return (
    <div className="font-mono text-label leading-4.5">
      {steps.map((s, i) => (
        <div key={String(i)} className="grid grid-cols-[minmax(0,1fr)_56px_48px] items-center gap-2">
          <span className="truncate text-fg-2">{s.label}</span>
          <span className={cn("text-right", s.delta === null ? "text-sell" : "text-fg-1")}>
            {s.delta === null ? "–" : `+${fmtMs(s.delta)}`}
          </span>
          <span className="h-1 overflow-hidden rounded-xs bg-surface-3">
            <span
              className={cn("block h-full", s.delta === max ? "bg-fg-2" : "bg-fg-3")}
              style={{ width: `${s.delta === null ? 0 : Math.max(4, (s.delta / max) * 100)}%` }}
            />
          </span>
        </div>
      ))}
      <div className="mt-1 grid grid-cols-[minmax(0,1fr)_56px_48px] items-center gap-2 border-t border-hairline pt-1">
        <span className="text-fg-2">Total</span>
        <span className="text-right font-medium text-fg-1">{fmtMs(latency.landedMs ?? lastSent)}</span>
        <span />
      </div>
      {latency.slot !== null && <div className="text-fg-3">Slot {fmtInt(latency.slot)}</div>}
    </div>
  );
}
