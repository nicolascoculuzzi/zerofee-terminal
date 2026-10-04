import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { IconButton } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import { fmtDate, fmtSignedSol, fmtSignedUsd, plainDecimal, signClass } from "../../lib/format";
import type { PnlPoint } from "../../protocol";
import { dailyPnl, fmtMonthYear, monthWeeks } from "./helpers";
import { Money, useQuote } from "./quote";
import { PanelError } from "./table";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/*
 * History calendar (DESIGN.md 5.3, P1): a 7-column month grid with 32 px cells, the day's PnL at
 * 10 px in signed colour on a flat buy-tint or sell-tint fill (no intensity scale), the month
 * total in the header. Day number plus amount in small cells, month total above, after Origin:
 * https://mobbin.com/screens/b0ef86f3-b1c6-473b-ac88-982279d52f2b
 * Tinted in/out amounts inside day cells and month arrows after Xero:
 * https://mobbin.com/screens/419b4e5c-9105-4af0-b4d3-9f5ae59c7a7e
 */
export function HistoryCalendar({
  points,
  loading,
  failures,
  onRetry,
}: {
  points: PnlPoint[] | null;
  loading: boolean;
  failures: number;
  onRetry: () => void;
}) {
  const { quote, solUsd } = useQuote();
  const today = new Date();
  const [view, setView] = useState({ year: today.getFullYear(), month: today.getMonth() });
  const daily = useMemo(() => (points ? dailyPnl(points) : new Map<string, number>()), [points]);
  const first = useMemo(() => (points && points.length > 0 ? Math.min(...points.map((p) => p.t)) : null), [points]);

  const startDow = new Date(view.year, view.month, 1).getDay();
  const days = new Date(view.year, view.month + 1, 0).getDate();
  const weeks = monthWeeks(startDow, days);
  let monthTotal = 0;
  let monthHasData = false;
  for (let d = 1; d <= days; d++) {
    const v = daily.get(`${view.year}-${view.month}-${d}`);
    if (v !== undefined) {
      monthTotal += v;
      monthHasData = true;
    }
  }
  const firstDate = first !== null ? new Date(first) : null;
  const canPrev = firstDate !== null && (view.year > firstDate.getFullYear() || view.month > firstDate.getMonth());
  const canNext = view.year < today.getFullYear() || (view.year === today.getFullYear() && view.month < today.getMonth());
  const shift = (delta: number) =>
    setView((v) => {
      const m = v.month + delta;
      return { year: v.year + Math.floor(m / 12), month: ((m % 12) + 12) % 12 };
    });

  const cellText = (sol: number) => (quote === "USD" ? fmtSignedUsd(sol * solUsd) : fmtSignedSol(sol));

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex h-6 max-w-140 items-center gap-2">
        <IconButton size="sm" label="Previous month" disabled={!canPrev} onClick={() => shift(-1)}>
          <ChevronLeft />
        </IconButton>
        <h3 className="min-w-32 text-data font-semibold text-fg-1">{fmtMonthYear(view.year, view.month)}</h3>
        <IconButton size="sm" label="Next month" disabled={!canNext} onClick={() => shift(1)}>
          <ChevronRight />
        </IconButton>
        <span className="ml-auto flex items-baseline gap-2 text-label">
          <span className="text-fg-3">Month PnL</span>
          {monthHasData ? <Money sol={monthTotal} signed className="text-data font-semibold" /> : <span className="text-fg-4">–</span>}
        </span>
      </div>
      {failures > 0 && points === null ? (
        <PanelError what="PnL history" failures={failures} onRetry={onRetry} className="px-0" />
      ) : (
        <>
          <table
            aria-label={`Daily PnL, ${fmtMonthYear(view.year, view.month)}`}
            aria-busy={loading || undefined}
            className="w-full max-w-140 table-fixed border-separate border-spacing-px bg-hairline"
          >
            <thead>
              <tr>
                {WEEKDAYS.map((d) => (
                  <th key={d} scope="col" className="h-5 bg-surface-1 px-1 text-left text-micro font-medium text-fg-3">
                    {d}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks.map((week) => (
                <tr key={week.find((d) => d !== null) ?? 0}>
                  {week.map((day, i) => {
                    if (day === null) {
                      // biome-ignore lint/suspicious/noArrayIndexKey: blank cells before the 1st and after the last day
                      return <td key={`blank-${i}`} aria-hidden="true" className="h-8 bg-surface-1 p-0" />;
                    }
                    const date = new Date(view.year, view.month, day);
                    const v = daily.get(`${view.year}-${view.month}-${day}`);
                    const isToday = date.toDateString() === today.toDateString();
                    const flat = v === undefined || Math.abs(v) < 1e-9;
                    const label = fmtDate(date.getTime());
                    return (
                      <td
                        key={day}
                        aria-label={v === undefined ? `${label}, no data` : `${label}, ${plainDecimal(v)} SOL`}
                        title={v === undefined ? undefined : `${label} · ${cellText(v)}${quote === "SOL" ? " SOL" : ""}`}
                        className="h-8 bg-surface-1 p-0"
                      >
                        {/* Tints are translucent: they sit on the opaque surface-1 cell. */}
                        <span
                          className={cn("flex h-8 flex-col justify-between px-1 py-0.5", !flat && (v > 0 ? "bg-buy-tint" : "bg-sell-tint"))}
                        >
                          <span
                            className={cn("text-micro", isToday ? "font-semibold text-fg-1" : v === undefined ? "text-fg-4" : "text-fg-3")}
                          >
                            {day}
                          </span>
                          {v !== undefined && (
                            <span className={cn("zf-num truncate text-right text-micro font-medium", signClass(flat ? 0 : v))}>
                              {cellText(v)}
                            </span>
                          )}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {loading && points === null && <p className="text-data text-fg-3">Loading daily PnL…</p>}
        </>
      )}
    </div>
  );
}
