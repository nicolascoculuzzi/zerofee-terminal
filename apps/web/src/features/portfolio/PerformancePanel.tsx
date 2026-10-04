import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import { fmtCount } from "../../lib/format";
import { PNL_BUCKETS, type PnlRange, RANGE_LABEL, RANGE_WORDS, type WalletSummary } from "./helpers";
import { Money } from "./quote";

/** Metric label with its definition (DESIGN.md 4.14): dotted underline, tooltip on hover or focus. */
export function DefLabel({ label, children, className }: { label: string; children: string; className?: string }) {
  return (
    <Tooltip
      content={
        <span className="block">
          <span className="block text-data font-semibold text-fg-1">{label}</span>
          <span className="mt-1 block text-label text-fg-2">{children}</span>
        </span>
      }
    >
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so keyboard users get the definition */}
      <span tabIndex={0} className={cn("zf-metric rounded-xs", className)}>
        {label}
      </span>
    </Tooltip>
  );
}

/*
 * Performance (DESIGN.md 5.3): Total PnL at 16/600 signed, the trade count with a 4 px buy/sell
 * split bar, then five 24 px bucket rows (6 px dot, label, proportional bar in text-3 at 50%,
 * count on the right). Label/value rows after Binance's copy-trader performance block:
 * https://mobbin.com/screens/b92a460e-23dc-40d5-8a9b-cd79d8eb9b7d
 * Bought/sold split bar after Coinbase Wallet: https://mobbin.com/screens/5420b26c-19a1-4d3b-bb6e-7b68d373d175
 * Dot + label + thin proportional bar rows after Vercel usage: https://mobbin.com/screens/e828f30f-3564-432d-8a2f-33b3116dd465
 */
export function PerformancePanel({ summary, range, className }: { summary: WalletSummary | null; range: PnlRange; className?: string }) {
  const s = summary;
  const trades = s ? s.buys + s.sells : 0;
  const buyShare = trades > 0 && s ? s.buys / trades : 0;
  const maxBucket = s ? Math.max(1, ...s.buckets) : 1;
  const words = RANGE_WORDS[range];
  return (
    <section aria-label="Performance" className={cn("flex min-w-0 flex-col bg-surface-1", className)}>
      <header className="flex h-panel-header shrink-0 items-center justify-between gap-2 border-b border-hairline px-3">
        <h2 className="text-data font-semibold text-fg-1">Performance</h2>
        <span className="text-label text-fg-3">{RANGE_LABEL[range]}</span>
      </header>
      <div className="flex flex-col p-pad">
        <div className="flex h-6 items-center justify-between gap-2">
          <DefLabel label="Total PnL" className="text-label text-fg-3">
            {`Realized plus unrealized PnL of every position traded ${words}, after venue fees, priority fees and tips.`}
          </DefLabel>
          {s ? (
            <Money sol={s.totalPnlSol} signed className="text-title font-semibold" />
          ) : (
            <span className="h-2 w-16 rounded-xs bg-surface-3" />
          )}
        </div>
        <div className="flex h-6 items-center gap-2">
          <DefLabel label="Trades" className="text-label text-fg-3">
            {`Buys and sells from this wallet ${words}. The bar is the buy share.`}
          </DefLabel>
          <span className="zf-num text-data font-semibold text-fg-1">{s ? fmtCount(trades) : ""}</span>
          <Tooltip wrapperClassName="ml-auto w-28" content={s ? `${fmtCount(s.buys)} buys · ${fmtCount(s.sells)} sells` : null}>
            <span
              role="img"
              aria-label={s ? `${fmtCount(s.buys)} buys, ${fmtCount(s.sells)} sells` : "No trades"}
              className="flex h-1 w-full gap-px overflow-hidden rounded-xs bg-surface-3"
            >
              {trades > 0 && (
                <>
                  <span className="h-full bg-buy" style={{ width: `${buyShare * 100}%` }} />
                  <span className="h-full flex-1 bg-sell" />
                </>
              )}
            </span>
          </Tooltip>
        </div>
        <ul aria-label="Positions by return" className="mt-1 flex flex-col">
          {PNL_BUCKETS.map((b, i) => {
            const n = s?.buckets[i] ?? 0;
            return (
              <li key={b.label} className="grid h-6 grid-cols-[6px_minmax(0,7.5rem)_1fr_4ch] items-center gap-2 text-label">
                <span aria-hidden="true" className={cn("size-1.5 rounded-full", b.tone === "buy" ? "bg-buy" : "bg-sell")} />
                <span className="truncate text-fg-2">{b.label}</span>
                <span aria-hidden="true" className="h-1 min-w-0">
                  {n > 0 && <span className="block h-full rounded-xs bg-fg-3/50" style={{ width: `${(n / maxBucket) * 100}%` }} />}
                </span>
                <span className="zf-num text-right font-medium text-fg-1">{s ? fmtCount(n) : ""}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
