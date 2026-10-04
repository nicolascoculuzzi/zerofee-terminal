import { AlertTriangle } from "lucide-react";
import { memo } from "react";
import type { FeedStatus, HistoryInfo } from "./dataSource";

/*
 * What covers the chart canvas until there is something to draw (DESIGN.md 4.10 "States", 4.18): a
 * static skeleton of candles and volume in surface-3 (no shimmer, no spinner) with "Loading 15s
 * candles…", an empty state, or the inline error with Retry. It covers the grid and axes too, so an
 * empty pane never shows a bare grid or a stretched bar. Once bars are on the chart, only the small
 * "Loading history" hint remains while older pages load or the server backfills.
 */

const COUNT = 42;

/** Deterministic skeleton candles: a gentle drift with alternating bodies. */
const SKELETON = Array.from({ length: COUNT }, (_, i) => {
  const wave = Math.sin(i / 5) * 18 + Math.sin(i / 2.3) * 6 + i * 0.6;
  const body = 6 + ((i * 37) % 11);
  const top = 60 - wave - body / 2;
  return { top, body, wick: body + 4 + ((i * 13) % 7), vol: 4 + ((i * 29) % 14) };
});

function Skeleton() {
  return (
    <svg className="absolute inset-0 size-full text-surface-3" preserveAspectRatio="none" viewBox="0 0 100 100" aria-hidden="true">
      {SKELETON.map((c, i) => {
        const x = 4 + (i * 84) / COUNT;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: a static decorative list
          <g key={i} fill="currentColor">
            <rect x={x + 0.42} y={c.top - (c.wick - c.body) / 2} width={0.16} height={c.wick} />
            <rect x={x} y={c.top} width={1} height={c.body} rx={0.1} />
            <rect x={x} y={100 - c.vol - 6} width={1} height={c.vol} opacity={0.6} />
          </g>
        );
      })}
    </svg>
  );
}

export const ChartStateOverlay = memo(function ChartStateOverlay({
  status,
  tf,
  history,
  onRetry,
}: {
  status: FeedStatus;
  tf: string;
  history: HistoryInfo;
  onRetry: () => void;
}) {
  if (status === "ready") {
    const busy = history.loading || history.state === "backfilling";
    if (!busy) return null;
    return (
      <div className="pointer-events-none absolute bottom-9 left-2 z-chart-ui rounded-sm bg-surface-2/90 px-1.5 py-0.5 text-label text-fg-3">
        {history.state === "backfilling" ? "Loading full history…" : "Loading older candles…"}
      </div>
    );
  }
  return (
    <div className="absolute inset-0 z-[5] bg-surface-1">
      {status === "loading" && (
        <>
          <Skeleton />
          <div className="pointer-events-none absolute top-8 left-2 text-data text-fg-3">
            {history.loading ? `Looking for older ${tf} candles…` : `Loading ${tf} candles…`}
          </div>
        </>
      )}
      {status === "empty" && (
        <div className="absolute inset-x-0 top-0 flex h-60 max-h-full items-center justify-center px-4">
          <div className="max-w-80 text-center">
            <div className="text-body font-medium text-fg-2">No trades yet</div>
            <div className="mt-1 text-data text-fg-3">Candles appear here within about a second of the first trade.</div>
          </div>
        </div>
      )}
      {status === "error" && (
        <div className="absolute top-8 left-2 flex items-center gap-1.5 text-data text-fg-3">
          <AlertTriangle className="icon-sm text-warn" aria-hidden="true" />
          Couldn't load candles ·
          <button type="button" className="text-fg-1 hover:underline" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
});
