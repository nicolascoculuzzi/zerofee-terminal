import { useVirtualizer } from "@tanstack/react-virtual";
import { Pause, Search, SlidersHorizontal, Volume2, VolumeX, Zap } from "lucide-react";
import { memo, useMemo, useRef, useState } from "react";
import { IconButton } from "../../components/ui/Button";
import { NumberInput, Segmented } from "../../components/ui/controls";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import { cssPx } from "../../lib/cssVar";
import { activeFilterCount, compileBlacklists, compileFilter, isBlacklisted, matchesFilter } from "../../lib/filters";
import { useNow } from "../../lib/useNow";
import type { PulseColumnId, TokenSummary } from "../../protocol";
import { useMarket } from "../../state/market";
import { PRESET_IDS, type PresetId, useSettings } from "../../state/settings";
import { TokenCard } from "./TokenCard";

export const COLUMN_TITLE: Record<PulseColumnId, string> = {
  new: "New Pairs",
  final: "Final Stretch",
  migrated: "Migrated",
};

const FRESH_MS = 4000;

function matchesSearch(t: TokenSummary, q: string): boolean {
  if (!q) return true;
  const s = q.toLowerCase();
  return t.symbol.toLowerCase().includes(s) || t.name.toLowerCase().includes(s) || t.mint.toLowerCase().startsWith(s);
}

/**
 * Column header: title + count, pause state, sound and filters on row one; search, quick-buy
 * amount and preset on row two (Axiom's per-column controls). Toolbar density after Coinbase
 * Advanced's panel headers: https://mobbin.com/screens/ff785484-4dd2-4fc0-a5f4-658e033b3b08
 */
const ColumnHeader = memo(function ColumnHeader({
  column,
  count,
  paused,
  pending,
  onOpenFilters,
}: {
  column: PulseColumnId;
  count: number;
  paused: boolean;
  pending: number;
  onOpenFilters: () => void;
}) {
  const settings = useSettings((s) => s.columns[column]);
  const globalQuickBuy = useSettings((s) => s.quickBuySol);
  const globalPreset = useSettings((s) => s.activePreset);
  const setColumn = useSettings((s) => s.setColumn);
  const filterCount = activeFilterCount(settings.filters[settings.activeFilter]);
  return (
    <div className="shrink-0 border-b border-hairline bg-surface-1">
      <div className="flex h-9 items-center gap-2 px-3">
        <h2 className="text-heading font-semibold">{COLUMN_TITLE[column]}</h2>
        <span className="text-label text-fg-3">{count}</span>
        {paused && (
          <span className="flex h-5 items-center gap-1 rounded-xs border border-info/40 px-1 text-micro font-semibold text-info">
            <Pause className="icon-xs" />
            Paused{pending > 0 ? ` · ${pending} new` : ""}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <IconButton
            label={settings.sound ? "Mute new-token sound" : "Play a sound for new tokens"}
            active={settings.sound}
            onClick={() => setColumn(column, { sound: !settings.sound })}
          >
            {settings.sound ? <Volume2 className="icon-sm" /> : <VolumeX className="icon-sm" />}
          </IconButton>
          <button
            type="button"
            onClick={onOpenFilters}
            className={cn(
              "flex h-6 items-center gap-1 rounded-sm border px-2 text-label",
              filterCount > 0 ? "border-hairline-strong bg-surface-3 text-fg-1" : "border-hairline text-fg-2 hover:text-fg-1",
            )}
          >
            <SlidersHorizontal className="icon-sm" />
            Filters
            {filterCount > 0 && <span className="font-semibold">{filterCount}</span>}
            <span className="text-fg-3">P{settings.activeFilter + 1}</span>
          </button>
        </div>
      </div>
      <div className="flex h-9 items-center gap-2 px-3 pb-1">
        <label className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-sm border border-hairline-strong bg-bg px-2 text-data focus-within:border-accent">
          <Search className="icon-sm shrink-0 text-fg-3" />
          <input
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-fg-3"
            placeholder="Search"
            value={settings.search}
            onChange={(e) => setColumn(column, { search: e.target.value })}
            aria-label={`Search ${COLUMN_TITLE[column]}`}
          />
        </label>
        <Tooltip content="Quick-buy amount for this column (empty = global amount)">
          <NumberInput
            value={settings.quickBuySol}
            onChange={(v) => setColumn(column, { quickBuySol: v })}
            placeholder={String(globalQuickBuy)}
            prefix={<Zap className="icon-sm" />}
            min={0}
            alignRight
            className="w-20"
            ariaLabel={`${COLUMN_TITLE[column]} quick-buy amount`}
          />
        </Tooltip>
        <Segmented<PresetId>
          size="xs"
          value={settings.preset ?? globalPreset}
          onChange={(p) => setColumn(column, { preset: p })}
          options={PRESET_IDS.map((p) => ({ value: p, label: p, title: `Use preset ${p} for this column` }))}
          label={`${COLUMN_TITLE[column]} preset`}
        />
      </div>
    </div>
  );
});

/**
 * One Pulse column. Updates arrive coalesced (4–10 Hz) from the market store; hovering the list
 * freezes membership and order so the card under the cursor never moves, and buffered changes
 * apply on leave.
 */
export function PulseColumn({ column, onOpenFilters }: { column: PulseColumnId; onOpenFilters: (c: PulseColumnId) => void }) {
  const mints = useMarket((s) => s.columns[column]);
  const tokens = useMarket((s) => s.tokens);
  const settings = useSettings((s) => s.columns[column]);
  const blacklists = useSettings((s) => s.blacklists);
  const display = useSettings((s) => s.display);
  const globalQuickBuy = useSettings((s) => s.quickBuySol);
  const globalPreset = useSettings((s) => s.activePreset);
  const now = useNow();

  const filter = settings.filters[settings.activeFilter];
  const compiled = useMemo(() => compileFilter(filter), [filter]);
  const compiledBl = useMemo(() => compileBlacklists(blacklists), [blacklists]);
  const search = settings.search.trim();

  const visible = useMemo(
    () =>
      mints.filter((m) => {
        const t = tokens[m];
        return t !== undefined && !isBlacklisted(t, compiledBl) && matchesFilter(t, compiled, now) && matchesSearch(t, search);
      }),
    [mints, tokens, compiledBl, compiled, now, search],
  );

  const [frozen, setFrozen] = useState<{ order: string[]; set: Set<string>; snapshot: Record<string, TokenSummary> } | null>(null);
  const shown = frozen ? frozen.order : visible;
  const pending = frozen ? visible.filter((m) => !frozen.set.has(m)).length : 0;

  const scrollRef = useRef<HTMLDivElement>(null);
  const rowH = cssPx(display.compactCards ? "--zf-card" : "--zf-card", display.compactCards ? 56 : 76);
  const virtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 6,
    getItemKey: (i) => shown[i] ?? i,
  });

  const quickBuy = settings.quickBuySol ?? globalQuickBuy;
  const preset = settings.preset ?? globalPreset;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg" aria-label={COLUMN_TITLE[column]}>
      <ColumnHeader
        column={column}
        count={visible.length}
        paused={frozen !== null}
        pending={pending}
        onOpenFilters={() => onOpenFilters(column)}
      />
      <div
        ref={scrollRef}
        className="@container min-h-0 flex-1 overflow-y-auto"
        onPointerEnter={() => setFrozen({ order: visible, set: new Set(visible), snapshot: { ...tokens } })}
        onPointerLeave={() => setFrozen(null)}
      >
        {shown.length === 0 ? (
          <div className="px-3 py-4 text-data text-fg-3">
            {mints.length === 0 ? "Waiting for the feed…" : "No tokens match this column's filters or search."}
          </div>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const mint = shown[item.index];
              if (!mint) return null;
              const t = tokens[mint] ?? frozen?.snapshot[mint];
              if (!t) return null;
              const freshTs = column === "migrated" ? (t.migratedAt ?? 0) : column === "new" ? t.createdAt : 0;
              return (
                <div key={item.key} className="absolute top-0 left-0 w-full" style={{ transform: `translateY(${item.start}px)` }}>
                  <TokenCard
                    token={t}
                    column={column}
                    quickBuySol={quickBuy}
                    preset={preset}
                    compact={display.compactCards}
                    metricColors={display.metricColors}
                    showRing={display.showProgressRing}
                    largeQuickBuy={display.largeQuickBuy}
                    fresh={now - freshTs < FRESH_MS}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
