import { useVirtualizer } from "@tanstack/react-virtual";
import { X } from "lucide-react";
import { memo, useMemo, useRef, useState } from "react";
import { Age } from "../../components/ui/Age";
import { ExplorerLink, Tag } from "../../components/ui/bits";
import { NumberInput, Segmented } from "../../components/ui/controls";
import { cn } from "../../lib/cn";
import { cssPx } from "../../lib/cssVar";
import { fmtClock, fmtSol, fmtTokens, fmtUsd, shortAddr } from "../../lib/format";
import type { Trade, WalletTag } from "../../protocol";
import { useToken } from "../../state/token";
import { type TrackedWallet, useTrackedMap } from "../../state/trackers";
import { type Col, sp, TableHead, template } from "./table";
import { useTokenUi } from "./tokenUi";

type MakerKind = "all" | "you" | "dev" | "tracked";

const COLS: Col[] = [
  { label: "Age", width: sp(12) },
  { label: "Type", width: sp(10) },
  { label: "MC", width: sp(16), align: "right" },
  { label: "Amount", width: sp(16), align: "right" },
  { label: "SOL", width: sp(16), align: "right" },
  { label: "Maker", width: "minmax(0,1fr)" },
  { label: "", width: sp(4) },
];

const SHOWN_TAGS: WalletTag[] = ["you", "dev", "sniper", "insider", "bundler", "kol", "whale", "pro"];

const TradeRow = memo(function TradeRow({
  trade,
  tracked,
  onMaker,
}: {
  trade: Trade;
  tracked: TrackedWallet | undefined;
  onMaker: (address: string) => void;
}) {
  const buy = trade.side === "buy";
  const flash = Date.now() - trade.ts < 1200 ? (buy ? "zf-flash-buy" : "zf-flash-sell") : "";
  return (
    <div
      className={cn(
        "grid h-row items-center gap-2 border-b border-line px-3 text-xs hover:bg-panel-2",
        flash,
        trade.tags.includes("you") && "bg-fg/5",
      )}
      style={{ gridTemplateColumns: template(COLS) }}
    >
      <span className="text-muted" title={fmtClock(trade.ts)}>
        <Age ts={trade.ts} />
      </span>
      <span className={cn("font-medium", buy ? "text-buy" : "text-sell")}>{buy ? "Buy" : "Sell"}</span>
      <span className="text-right">{fmtUsd(trade.marketCapUsd)}</span>
      <span className="text-right text-muted">{fmtTokens(trade.tokenAmount)}</span>
      <span className={cn("text-right font-medium", buy ? "text-buy" : "text-sell")}>{fmtSol(trade.solAmount)}</span>
      <span className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          onClick={() => onMaker(trade.maker)}
          className="truncate font-mono text-muted hover:text-fg"
          title="Filter trades by this maker"
        >
          {shortAddr(trade.maker, 4, 4)}
        </button>
        {tracked && <Tag tag="tracked" label={tracked.name} className="max-w-28 truncate" />}
        {SHOWN_TAGS.filter((t) => trade.tags.includes(t))
          .slice(0, 2)
          .map((t) => (
            <Tag key={t} tag={t} />
          ))}
      </span>
      <ExplorerLink signature={trade.signature} />
    </div>
  );
});

/**
 * Trades tape for the focused token (flushed every 80 ms). Filters: maker kind (YOU / DEV /
 * TRACKED), minimum size, a single maker, and a clicked candle from the chart.
 */
export function TradesTable() {
  const trades = useToken((s) => s.trades);
  const tracked = useTrackedMap();
  const candle = useTokenUi((s) => s.candle);
  const setCandle = useTokenUi((s) => s.setCandle);
  const maker = useTokenUi((s) => s.maker);
  const setMaker = useTokenUi((s) => s.setMaker);
  const [kind, setKind] = useState<MakerKind>("all");
  const [minSol, setMinSol] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(
    () =>
      trades.filter((t) => {
        if (minSol !== null && t.solAmount < minSol) return false;
        if (maker && t.maker !== maker) return false;
        if (candle) {
          const sec = t.ts / 1000;
          if (sec < candle.from || sec >= candle.to) return false;
        }
        if (kind === "you") return t.tags.includes("you");
        if (kind === "dev") return t.tags.includes("dev");
        if (kind === "tracked") return tracked.has(t.maker);
        return true;
      }),
    [trades, minSol, maker, candle, kind, tracked],
  );

  const rowH = cssPx("--zf-row-h", 28);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 10,
    getItemKey: (i) => rows[i]?.id ?? i,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 flex-wrap items-center gap-2 border-b border-line px-3">
        <Segmented<MakerKind>
          size="xs"
          value={kind}
          onChange={setKind}
          options={[
            { value: "all", label: "All" },
            { value: "you", label: "You" },
            { value: "dev", label: "Dev" },
            { value: "tracked", label: "Tracked" },
          ]}
          label="Maker filter"
        />
        <div className="flex items-center gap-1">
          {[0.5, 1, 5].map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={minSol === v}
              onClick={() => setMinSol(minSol === v ? null : v)}
              className={cn("h-5 rounded-sm px-2 text-2xs font-medium", minSol === v ? "bg-elev text-fg" : "text-muted hover:text-fg")}
            >
              ≥{v} SOL
            </button>
          ))}
          <NumberInput
            value={minSol}
            onChange={setMinSol}
            placeholder="Min SOL"
            className="h-6 w-20"
            min={0}
            ariaLabel="Minimum trade size in SOL"
          />
        </div>
        {maker && (
          <button
            type="button"
            onClick={() => setMaker(null)}
            className="flex h-5 items-center gap-1 rounded-sm border border-line-strong px-2 text-2xs text-fg"
          >
            Maker {shortAddr(maker, 4, 4)}
            <X className="icon-xs" />
          </button>
        )}
        {candle && (
          <button
            type="button"
            onClick={() => setCandle(null)}
            className="flex h-5 items-center gap-1 rounded-sm border border-line-strong px-2 text-2xs text-fg"
          >
            Candle {fmtClock(candle.from * 1000)}
            <X className="icon-xs" />
          </button>
        )}
        <span className="ml-auto text-2xs text-dim">{rows.length} trades</span>
      </div>
      <section ref={scrollRef} className="min-h-0 flex-1 overflow-auto" aria-label="Trades">
        <div className="min-w-160">
          <TableHead cols={COLS} />
          {rows.length === 0 ? (
            <div className="px-3 py-4 text-sm text-dim">No trades match these filters.</div>
          ) : (
            <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const t = rows[item.index];
                if (!t) return null;
                return (
                  <div key={item.key} className="absolute top-0 left-0 w-full" style={{ transform: `translateY(${item.start}px)` }}>
                    <TradeRow trade={t} tracked={tracked.get(t.maker)} onMaker={setMaker} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
