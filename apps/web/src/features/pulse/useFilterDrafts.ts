import { useState } from "react";
import { COLUMN_TITLE } from "../../config";
import { activeFilterCount, emptyFilter, exportFilters, normalizeFilter, type PulseFilter } from "../../lib/filters";
import type { PulseColumnId } from "../../protocol";
import { useSettings } from "../../state/settings";
import { importFilters } from "./filterImport";

type Slot = 0 | 1 | 2;
const COLUMNS: PulseColumnId[] = ["new", "final", "migrated"];

const keyOf = (column: PulseColumnId, slot: Slot) => `${column}:${slot}`;
function parseKey(key: string): [PulseColumnId, Slot] {
  const [c, s] = key.split(":");
  return [c as PulseColumnId, Number(s) as Slot];
}

/**
 * Edits in the filter modal (DESIGN.md 4.16) stay drafts, per column and preset slot, until
 * Apply. Apply writes every changed draft and makes the selected slot active; Mod+S saves the
 * current draft into its slot without closing; Reset column clears the current draft.
 */
export function useFilterDrafts(initialColumn: PulseColumnId) {
  const saved = useSettings((s) => s.columns);
  const [column, setColumn] = useState(initialColumn);
  const [slots, setSlots] = useState<Record<PulseColumnId, Slot>>(() => ({
    new: saved.new.activeFilter,
    final: saved.final.activeFilter,
    migrated: saved.migrated.activeFilter,
  }));
  const [drafts, setDrafts] = useState<Record<string, PulseFilter>>({});

  const savedOf = (c: PulseColumnId, s: Slot) => normalizeFilter(saved[c].filters[s]);
  const draftOf = (c: PulseColumnId, s: Slot) => drafts[keyOf(c, s)] ?? savedOf(c, s);
  const slot = slots[column];
  const draft = draftOf(column, slot);
  const dirtyKeys = Object.keys(drafts).filter((k) => {
    const [c, s] = parseKey(k);
    return JSON.stringify(drafts[k]) !== JSON.stringify(savedOf(c, s));
  });

  const patch = (p: Partial<PulseFilter>) =>
    setDrafts((d) => {
      const k = keyOf(column, slot);
      return { ...d, [k]: { ...(d[k] ?? savedOf(column, slot)), ...p } };
    });

  const exportAll = () => {
    const payload: Partial<Record<PulseColumnId, PulseFilter[]>> = {};
    for (const c of COLUMNS) payload[c] = ([0, 1, 2] as Slot[]).map((s) => draftOf(c, s));
    return exportFilters(payload);
  };

  return {
    column,
    setColumn,
    slot,
    setSlot: (s: Slot) => setSlots((all) => ({ ...all, [column]: s })),
    draft,
    patch,
    dirty: dirtyKeys.length > 0,
    tabCounts: Object.fromEntries(COLUMNS.map((c) => [c, activeFilterCount(draftOf(c, slots[c]))])) as Record<PulseColumnId, number>,
    reset: () => setDrafts((d) => ({ ...d, [keyOf(column, slot)]: emptyFilter() })),
    /** Writes every changed draft; the current column (and any edited one) switches to its selected slot. */
    commit: () => {
      const s = useSettings.getState();
      const touched = new Set<PulseColumnId>([column]);
      for (const k of dirtyKeys) {
        const [c, sl] = parseKey(k);
        const f = drafts[k];
        if (f) s.setColumnFilter(c, sl, f);
        touched.add(c);
      }
      for (const c of touched) if (s.columns[c].activeFilter !== slots[c]) s.setColumn(c, { activeFilter: slots[c] });
    },
    /** Apply to all columns: this draft goes into every column's active slot. */
    commitAll: () => {
      const s = useSettings.getState();
      s.setColumn(column, { activeFilter: slot });
      s.applyFilterToAll(draft);
    },
    /** Mod+S: saves the current draft into its slot and keeps the modal open. */
    save: () => useSettings.getState().setColumnFilter(column, slot, draft),
    exportJson: exportAll,
    shareJson: () => exportFilters(draft),
    /** Loads an import into the drafts; returns a confirmation line or throws with the reason. */
    load: (text: string): string => {
      const parsed = importFilters(text);
      if (parsed.kind === "single") {
        setDrafts((d) => ({ ...d, [keyOf(column, slot)]: parsed.filter }));
        return `Loaded into ${COLUMN_TITLE[column]} slot ${slot + 1}. Apply to keep it.`;
      }
      setDrafts((d) => {
        const next = { ...d };
        for (const c of COLUMNS) {
          for (const [i, f] of (parsed.columns[c] ?? []).entries()) next[keyOf(c, i as Slot)] = f;
        }
        return next;
      });
      return "Loaded presets for every column in the file. Apply to keep them.";
    },
  };
}
