import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Hotkey } from "../../components/ui/controls";
import { Modal } from "../../components/ui/Modal";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import { compileBlacklists, compileFilter, isBlacklisted, matchesFilter, type PulseFilter } from "../../lib/filters";
import { fmtCount } from "../../lib/format";
import { IS_MAC } from "../../lib/hotkeys";
import type { PulseColumnId } from "../../protocol";
import { useMarket } from "../../state/market";
import { useSettings } from "../../state/settings";
import { FilterHeader } from "./FilterHeader";
import { FilterSections, SECTIONS, type SectionId, sectionActive } from "./FilterSections";
import { usePulseUi } from "./store";
import { useFilterDrafts } from "./useFilterDrafts";

const NOTE_MS = 2400;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Live match count and per-launchpad / per-quote counts against the in-memory feed. */
function useCounts(column: PulseColumnId, draft: PulseFilter) {
  const mints = useMarket((s) => s.columns[column]);
  const tokens = useMarket((s) => s.tokens);
  const blacklists = useSettings((s) => s.blacklists);
  const debounced = useDebounced(draft, 250);
  return useMemo(() => {
    const compiled = compileFilter(debounced);
    const blocked = compileBlacklists(blacklists);
    const now = Date.now();
    const protocols: Record<string, number> = {};
    const quotes: Record<string, number> = {};
    let matches = 0;
    for (const m of mints) {
      const t = tokens[m];
      if (!t || isBlacklisted(t, blocked)) continue;
      protocols[t.launchpad] = (protocols[t.launchpad] ?? 0) + 1;
      quotes[t.quote] = (quotes[t.quote] ?? 0) + 1;
      if (matchesFilter(t, compiled, now)) matches++;
    }
    return { matches, protocols, quotes };
  }, [debounced, mints, tokens, blacklists]);
}

/**
 * Pulse filter modal (DESIGN.md 4.16): 720 px, at most 640 px tall. Header with column tabs and
 * preset slots; a 168 px section nav (a dot marks sections with active filters) beside one
 * scrolling column of sections; a footer with Reset column, Apply to all columns, the live match
 * count and Apply. Edits are drafts until Apply. Esc with unsaved changes asks for a second Esc.
 * Keys: Mod+Enter applies, Mod+S saves the slot, Ctrl+1–6 jump to sections, Up/Down move between
 * range rows. Section nav with active dots and a live count after Juicebox:
 * https://mobbin.com/screens/b94f8a11-6713-466e-a9d5-d08e558ba525 and "Show 128 results" after
 * GetYourGuide: https://mobbin.com/screens/6a1fb39a-89fe-45ae-9c8a-10cc20e4664a
 */
export function FilterModal() {
  const column = usePulseUi((s) => s.filterColumn);
  if (!column) return null;
  return <FilterModalBody initial={column} />;
}

function FilterModalBody({ initial }: { initial: PulseColumnId }) {
  const d = useFilterDrafts(initial);
  const counts = useCounts(d.column, d.draft);
  const content = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [section, setSection] = useState<SectionId>("keywords");
  const [armed, setArmed] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const close = () => usePulseUi.getState().openFilters(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: any edit cancels a pending "press Esc again"
  useEffect(() => setArmed(false), [d.draft, d.column, d.slot]);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(t);
  }, [note]);

  const guardedClose = () => {
    if (d.dirty && !armed) {
      setArmed(true);
      return;
    }
    close();
  };
  const apply = () => {
    d.commit();
    close();
  };
  const jump = (id: SectionId) => {
    const box = content.current;
    const el = box?.querySelector<HTMLElement>(`[data-section="${id}"]`);
    if (!box || !el) return;
    box.scrollTo({ top: el.offsetTop - 16 });
    setSection(id);
  };
  const spy = () => {
    const box = content.current;
    if (!box) return;
    let current: SectionId = "keywords";
    for (const el of box.querySelectorAll<HTMLElement>("[data-section]")) {
      if (el.offsetTop - 24 <= box.scrollTop) current = el.dataset.section as SectionId;
    }
    if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2) current = "socials";
    setSection(current);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    if (mod && e.key === "Enter") {
      e.preventDefault();
      apply();
    } else if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      d.save();
      setNote(`Saved to slot ${d.slot + 1}`);
    } else if (e.ctrlKey && !e.metaKey && /^Digit[1-6]$/.test(e.code)) {
      e.preventDefault();
      const target = SECTIONS[Number(e.code.slice(5)) - 1];
      if (target) jump(target.id);
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && (e.target as HTMLElement).classList.contains("zfp-range")) {
      const inputs = Array.from(root.current?.querySelectorAll<HTMLInputElement>("input.zfp-range") ?? []);
      const next = inputs[inputs.indexOf(e.target as HTMLInputElement) + (e.key === "ArrowDown" ? 2 : -2)];
      if (next) {
        e.preventDefault();
        next.focus();
      }
    }
  };

  const status = armed ? (
    <span className="text-data text-fg-1">Discard changes? Press Esc again</span>
  ) : note ? (
    <span className="text-data text-fg-2">{note}</span>
  ) : (
    <span className="zf-num text-data text-fg-2">
      {fmtCount(counts.matches)} {counts.matches === 1 ? "token matches" : "tokens match"} now
    </span>
  );

  return (
    <Modal open onClose={guardedClose} bare width={720} label="Filters">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: modal-level shortcuts (DESIGN.md 4.16) */}
      <div ref={root} onKeyDown={onKeyDown} className="flex h-[min(638px,calc(84vh-2px))] flex-col">
        <FilterHeader
          column={d.column}
          onColumn={d.setColumn}
          counts={d.tabCounts}
          slot={d.slot}
          onSlot={d.setSlot}
          onImport={(text) => {
            try {
              setNote(d.load(text));
              return null;
            } catch (err) {
              return err instanceof Error ? err.message : String(err);
            }
          }}
          exportJson={d.exportJson}
          shareJson={d.shareJson}
          onClose={close}
        />
        <div className="flex min-h-0 flex-1">
          <nav aria-label="Filter sections" className="w-42 shrink-0 space-y-px border-r border-hairline bg-surface-1 p-2">
            {SECTIONS.map((s, i) => (
              <Tooltip key={s.id} content={<Hotkey binding={`Ctrl+${i + 1}`} />} wrapperClassName="w-full">
                <button
                  type="button"
                  aria-current={section === s.id ? "true" : undefined}
                  onClick={() => jump(s.id)}
                  className={cn(
                    "focus-inset flex h-7 w-full items-center gap-1.5 rounded-sm px-2 text-left text-data font-medium transition-colors",
                    section === s.id ? "bg-surface-3 text-fg-1" : "text-fg-2 hover:text-fg-1",
                  )}
                >
                  {s.label}
                  {sectionActive(d.draft, s.id) && (
                    <>
                      <span aria-hidden="true" className="size-1.5 rounded-full bg-fg-1" />
                      <span className="sr-only">, has active filters</span>
                    </>
                  )}
                </button>
              </Tooltip>
            ))}
          </nav>
          <div ref={content} onScroll={spy} className="relative min-h-0 flex-1 overflow-y-auto p-4">
            <FilterSections draft={d.draft} patch={d.patch} counts={counts} />
          </div>
        </div>
        <div className="flex h-13 shrink-0 items-center gap-2 border-t border-hairline px-4">
          <Button size="md" variant="ghost" onClick={d.reset}>
            Reset column
          </Button>
          <Button
            size="md"
            variant="secondary"
            onClick={() => {
              d.commitAll();
              close();
            }}
          >
            Apply to all columns
          </Button>
          <div className="ml-auto flex min-w-0 items-center gap-3">
            <span className="truncate">{status}</span>
            <Tooltip
              content={
                <span className="flex items-center gap-2">
                  Apply and close <Hotkey binding="Mod+Enter" />
                </span>
              }
            >
              <Button size="md" variant="primary" onClick={apply}>
                Apply filters
              </Button>
            </Tooltip>
          </div>
        </div>
      </div>
    </Modal>
  );
}
