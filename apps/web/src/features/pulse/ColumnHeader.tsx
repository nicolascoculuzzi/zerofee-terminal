import { Pause, Search, SlidersHorizontal, X, Zap } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { IconButton } from "../../components/ui/Button";
import { CountBadge } from "../../components/ui/bits";
import { Hotkey, NumberInput, Segmented } from "../../components/ui/controls";
import { Tooltip } from "../../components/ui/Tooltip";
import { COLUMN_TITLE, columnDefinition } from "../../config";
import { cn } from "../../lib/cn";
import { activeFilterCount } from "../../lib/filters";
import { fmtSolShort } from "../../lib/format";
import type { PulseColumnId } from "../../protocol";
import { PRESET_IDS, type PresetId, useSettings } from "../../state/settings";
import { ColumnMenu } from "./ColumnMenu";
import { usePulseUi } from "./store";

/** Presets move into the "..." menu below this column width (DESIGN.md 4.3). */
const PRESETS_MIN_W = 380;
/** The "Paused" chip drops its word below this width (the icon and its label stay). */
const PAUSED_WORD_MIN_W = 460;

export interface ColumnHeaderProps {
  column: PulseColumnId;
  count: number;
  /** The first snapshot hasn't arrived: the count is left out rather than shown as 0. */
  loading?: boolean;
  paused: boolean;
  width: number;
  /** "Still loading · feed lag 4.2 s" after 3 s of skeletons (DESIGN.md 4.18). */
  loadingNote: string | null;
  /** Replaces the title (768–1023 px: column 2 switches between Final Stretch and Migrated). */
  titleSlot?: ReactNode;
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  searchRef: RefObject<HTMLInputElement | null>;
}

/**
 * Pulse column header (DESIGN.md 4.3), 36 / 40 px with a hairline under it:
 * title 12/600 (definition on hover) and count (left out until the column has loaded), a quiet "Paused" chip, then search (24 px, opens
 * to a 160 px input), the column quick-buy amount (76 px), P1–P3 (22 px segments), filters with
 * an active-count badge, and the "..." menu. Per-column controls after Axiom's Pulse header;
 * the quiet paused chip after Canny: https://mobbin.com/screens/8794989c-4116-4894-9684-2fd8f4761652
 */
export function ColumnHeader(props: ColumnHeaderProps) {
  const { column, count, paused, width, searchOpen, setSearchOpen, searchRef } = props;
  const title = COLUMN_TITLE[column];
  const search = useSettings((s) => s.columns[column].search);
  const quickBuy = useSettings((s) => s.columns[column].quickBuySol);
  const globalQuickBuy = useSettings((s) => s.quickBuySol);
  const preset = useSettings((s) => s.columns[column].preset ?? s.activePreset);
  const filterCount = useSettings((s) => activeFilterCount(s.columns[column].filters[s.columns[column].activeFilter]));
  const setColumn = useSettings((s) => s.setColumn);
  const filtersKey = useSettings((s) => s.hotkeys["pulse.filters"]?.[0]);
  const showPresets = width >= PRESETS_MIN_W;
  const expanded = searchOpen || search.length > 0;
  // Narrow columns make room for the open search by tucking the amount away while it's open.
  const showQuickBuy = !expanded || width >= 480;

  return (
    <div className="flex h-col-header shrink-0 items-center gap-2 border-b border-hairline bg-surface-1 px-2">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {props.titleSlot ?? (
          <Tooltip content={columnDefinition(column)} wrapperClassName="min-w-0">
            <h2 className="truncate text-data font-semibold text-fg-1">{title}</h2>
          </Tooltip>
        )}
        {!props.loading && <span className="zf-num min-w-[3ch] shrink-0 text-label font-medium text-fg-3">{count}</span>}
        {paused && (
          <span
            role="img"
            aria-label="Paused"
            className="inline-flex h-4 shrink-0 items-center gap-1 rounded-xs bg-surface-3 px-1 text-micro font-medium text-fg-2"
          >
            <Pause className="icon-xs" />
            {width >= PAUSED_WORD_MIN_W && !expanded && "Paused"}
          </span>
        )}
        {props.loadingNote && <span className="truncate text-label text-fg-3">{props.loadingNote}</span>}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {expanded ? (
          <label className="flex h-control w-40 items-center gap-1 rounded-sm border border-hairline-strong bg-surface-2 pr-0.5 pl-1.5 text-data focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus">
            <Search className="icon-xs shrink-0 text-fg-3" />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setColumn(column, { search: e.target.value })}
              onBlur={() => {
                if (!search) setSearchOpen(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setColumn(column, { search: "" });
                  setSearchOpen(false);
                }
              }}
              placeholder="Name, ticker or CA"
              aria-label={`Search ${title}`}
              className="min-w-0 flex-1 bg-transparent placeholder:text-fg-4 focus-visible:outline-none"
            />
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setColumn(column, { search: "" });
                setSearchOpen(false);
              }}
              className="flex size-5 shrink-0 items-center justify-center rounded-xs text-fg-3 transition-colors hover:bg-surface-3 hover:text-fg-1"
            >
              <X className="icon-xs" />
            </button>
          </label>
        ) : (
          <Tooltip
            content={
              <span className="flex items-center gap-2">
                Search this column <Hotkey binding="/" />
              </span>
            }
          >
            <IconButton label={`Search ${title}`} title="" onClick={() => setSearchOpen(true)}>
              <Search />
            </IconButton>
          </Tooltip>
        )}

        {showQuickBuy && (
          <Tooltip content={`Quick-buy amount for this column. Empty uses the global ${fmtSolShort(globalQuickBuy)} SOL.`}>
            <NumberInput
              value={quickBuy}
              onChange={(v) => setColumn(column, { quickBuySol: v })}
              placeholder={fmtSolShort(globalQuickBuy)}
              prefix={<Zap />}
              min={0}
              step={(v) => (v < 1 ? 0.01 : 0.1)}
              className="w-19"
              inputClassName="font-semibold"
              ariaLabel={`${title} quick-buy amount in SOL`}
            />
          </Tooltip>
        )}

        {showPresets && (
          <Segmented<PresetId>
            size="xs"
            value={preset}
            onChange={(p) => setColumn(column, { preset: p })}
            options={PRESET_IDS.map((p) => ({ value: p, label: p, title: `Use preset ${p} for this column` }))}
            label={`${title} preset`}
            className="*:w-[22px] *:flex-none *:px-0"
          />
        )}

        <Tooltip
          content={
            <span className="flex items-center gap-2">
              Filters{filterCount > 0 ? ` · ${filterCount} active` : ""} <Hotkey binding={filtersKey} />
            </span>
          }
        >
          <button
            type="button"
            aria-label={filterCount > 0 ? `Filters, ${filterCount} active` : "Filters"}
            onClick={() => usePulseUi.getState().openFilters(column)}
            className={cn(
              "inline-flex h-6 min-w-6 items-center justify-center gap-1 rounded-sm px-1 transition-colors hover:bg-surface-3 hover:text-fg-1",
              filterCount > 0 ? "text-fg-1" : "text-fg-3",
            )}
          >
            <SlidersHorizontal className="icon-sm" />
            {filterCount > 0 && <CountBadge count={filterCount} />}
          </button>
        </Tooltip>

        <ColumnMenu column={column} paused={paused} presetsInMenu={!showPresets} />
      </div>
    </div>
  );
}
