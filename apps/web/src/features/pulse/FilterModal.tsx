import { Check, Download, Upload } from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { NumberInput, Segmented } from "../../components/ui/controls";
import { Modal } from "../../components/ui/Modal";
import { copyText, downloadText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import {
  AUDIT_FIELDS,
  activeFilterCount,
  compileBlacklists,
  compileFilter,
  emptyFilter,
  exportFilters,
  isBlacklisted,
  MONEY_FIELDS,
  matchesFilter,
  normalizeFilter,
  type PulseFilter,
  parseFilterImport,
  type Range,
} from "../../lib/filters";
import { LAUNCHPADS, QUOTES } from "../../lib/metrics";
import type { PulseColumnId } from "../../protocol";
import { useMarket } from "../../state/market";
import { type ColumnSettings, useSettings } from "../../state/settings";
import { useToasts } from "../../state/toasts";

/*
 * Filter modal. Anatomy: GetYourGuide's filters (min/max side by side with a unit prefix,
 * "Reset all" + "Show N results") https://mobbin.com/screens/6a1fb39a-89fe-45ae-9c8a-10cc20e4664a
 * and Square's live match count https://mobbin.com/screens/53162374-2076-479b-bb1d-5c473647d50f.
 * Field set and labels follow Axiom's Pulse filters (keywords, Protocols, Quote Tokens, Audit,
 * $ Metrics, Socials, presets 1-3, import/export, Apply All).
 */

const COLUMN_LABEL: Record<PulseColumnId, string> = { new: "New Pairs", final: "Final Stretch", migrated: "Migrated" };
type Tab = "protocols" | "quotes" | "audit" | "metrics" | "socials";

function RangeRow({ label, unit, value, onChange }: { label: string; unit: string; value: Range; onChange: (r: Range) => void }) {
  const prefix = unit === "$" ? "$" : undefined;
  const suffix = unit === "%" ? "%" : unit === "min" ? "min" : undefined;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2">
      <span className="truncate text-data text-fg-2">{label}</span>
      <NumberInput
        value={value.min}
        onChange={(min) => onChange({ ...value, min })}
        placeholder="Min"
        prefix={prefix}
        suffix={suffix}
        min={0}
        className="w-22"
        ariaLabel={`${label} minimum`}
      />
      <NumberInput
        value={value.max}
        onChange={(max) => onChange({ ...value, max })}
        placeholder="Max"
        prefix={prefix}
        suffix={suffix}
        min={0}
        className="w-22"
        ariaLabel={`${label} maximum`}
      />
    </div>
  );
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "flex h-7 items-center gap-2 rounded-sm border px-2 text-left text-data",
        on ? "border-hairline-strong bg-surface-3 text-fg-1" : "border-hairline text-fg-2 hover:text-fg-1",
      )}
    >
      <span
        className={cn(
          "flex size-3 items-center justify-center rounded-xs border",
          on ? "border-fg-1 bg-accent text-bg" : "border-hairline-strong",
        )}
      >
        {on && <Check className="icon-xs" strokeWidth={3} />}
      </span>
      {children}
    </button>
  );
}

export function FilterModal({ open, column: initialColumn, onClose }: { open: boolean; column: PulseColumnId; onClose: () => void }) {
  const columns = useSettings((s) => s.columns);
  const setColumn = useSettings((s) => s.setColumn);
  const setColumnFilter = useSettings((s) => s.setColumnFilter);
  const applyFilterToAll = useSettings((s) => s.applyFilterToAll);
  const blacklists = useSettings((s) => s.blacklists);
  const tokens = useMarket((s) => s.tokens);
  const columnMints = useMarket((s) => s.columns);
  const [column, setColumnTab] = useState<PulseColumnId>(initialColumn);
  const [preset, setPreset] = useState<0 | 1 | 2>(columns[initialColumn].activeFilter);
  const [draft, setDraft] = useState<PulseFilter>(() =>
    normalizeFilter(columns[initialColumn].filters[columns[initialColumn].activeFilter]),
  );
  const [tab, setTab] = useState<Tab>("protocols");
  const [importText, setImportText] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Read settings through a ref so the effects below only re-run on slot changes, not on every settings write.
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  // Re-seed the draft whenever the column or preset slot changes.
  useEffect(() => {
    if (!open) return;
    setDraft(normalizeFilter(columnsRef.current[column].filters[preset]));
  }, [open, column, preset]);

  // Reset to the column's active preset each time the modal is (re)opened.
  useEffect(() => {
    if (!open) return;
    setColumnTab(initialColumn);
    setPreset(columnsRef.current[initialColumn].activeFilter);
  }, [open, initialColumn]);

  const matches = useMemo(() => {
    const compiled = compileFilter(draft);
    const bl = compileBlacklists(blacklists);
    const now = Date.now();
    const mints = columnMints[column];
    let n = 0;
    for (const m of mints) {
      const t = tokens[m];
      if (t && !isBlacklisted(t, bl) && matchesFilter(t, compiled, now)) n++;
    }
    return { n, total: mints.length };
  }, [draft, blacklists, columnMints, column, tokens]);

  const patch = (p: Partial<PulseFilter>) => setDraft((d) => ({ ...d, ...p }));
  const toggleIn = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const apply = () => {
    setColumnFilter(column, preset, draft);
    setColumn(column, { activeFilter: preset });
    onClose();
  };

  const exportAll = () => {
    const payload: Partial<Record<PulseColumnId, PulseFilter[]>> = {};
    for (const c of ["new", "final", "migrated"] as const) {
      const list = [...columns[c].filters] as ColumnSettings["filters"];
      if (c === column) list[preset] = draft;
      payload[c] = list;
    }
    return exportFilters(payload);
  };

  const runImport = (text: string) => {
    try {
      const parsed = parseFilterImport(text);
      if (parsed.kind === "single") {
        setDraft(parsed.filter);
        useToasts.getState().push({
          kind: "success",
          title: "Filter imported",
          body: `Loaded into ${COLUMN_LABEL[column]} preset ${preset + 1}. Apply to save.`,
        });
      } else {
        for (const c of ["new", "final", "migrated"] as const) {
          const list = parsed.columns[c];
          if (!list) continue;
          for (const [i, f] of list.entries()) setColumnFilter(c, i as 0 | 1 | 2, f);
        }
        setDraft(normalizeFilter(parsed.columns[column]?.[preset] ?? draft));
        useToasts.getState().push({ kind: "success", title: "Filter presets imported", body: "All columns updated." });
      }
      setImportText(null);
    } catch (e) {
      useToasts.getState().push({ kind: "error", title: "Import failed", body: e instanceof Error ? e.message : String(e) });
    }
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    void file.text().then(runImport);
    e.target.value = "";
  };

  const tabs: { value: Tab; label: string }[] = [
    { value: "protocols", label: `Protocols${draft.protocols.length !== LAUNCHPADS.length ? ` · ${draft.protocols.length}` : ""}` },
    { value: "quotes", label: "Quote tokens" },
    { value: "audit", label: "Audit" },
    { value: "metrics", label: "$ Metrics" },
    { value: "socials", label: "Socials" },
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Filters"
      width={680}
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-data text-fg-2">
            <span className="font-semibold text-fg-1">{matches.n}</span> of {matches.total} in {COLUMN_LABEL[column]} match now
            {activeFilterCount(draft) > 0 && <span className="text-fg-3"> · {activeFilterCount(draft)} conditions</span>}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button size="md" variant="ghost" onClick={() => setDraft(emptyFilter())}>
              Reset
            </Button>
            <Button
              size="md"
              variant="secondary"
              onClick={() => {
                applyFilterToAll(draft);
                setColumn(column, { activeFilter: preset });
                useToasts
                  .getState()
                  .push({ kind: "success", title: "Applied to all columns", body: "Written into each column's active preset." });
                onClose();
              }}
            >
              Apply to all columns
            </Button>
            <Button size="md" variant="primary" onClick={apply}>
              Apply
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<PulseColumnId>
            value={column}
            onChange={setColumnTab}
            options={(["new", "final", "migrated"] as const).map((c) => ({ value: c, label: COLUMN_LABEL[c] }))}
            label="Column"
          />
          <span className="zf-label ml-2">Preset</span>
          <Segmented<"0" | "1" | "2">
            value={String(preset) as "0" | "1" | "2"}
            onChange={(v) => setPreset(Number(v) as 0 | 1 | 2)}
            options={[
              { value: "0", label: "1" },
              { value: "1", label: "2" },
              { value: "2", label: "3" },
            ]}
            label="Filter preset"
          />
          <div className="ml-auto flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              icon={<Upload className="icon-sm" />}
              onClick={() => setImportText(importText === null ? "" : null)}
            >
              Import
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<Download className="icon-sm" />}
              onClick={() => downloadText("zerofee-pulse-filters.json", exportAll())}
            >
              Export
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void copyText(exportAll());
                useToasts
                  .getState()
                  .push({ kind: "info", title: "Filter JSON copied", body: "Share it; anyone can import it.", ttl: 2500 });
              }}
            >
              Copy JSON
            </Button>
          </div>
        </div>

        {importText !== null && (
          <div className="space-y-2 rounded-md border border-hairline bg-surface-2 p-3">
            <div className="text-data text-fg-2">Paste a filter or preset export (zerofee JSON; Axiom-style field names are accepted).</div>
            <textarea
              className="h-24 w-full rounded-sm border border-hairline-strong bg-bg p-2 font-mono text-label outline-none focus:border-accent"
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder='{"app":"zerofee","kind":"pulse-filters","v":1,"filters":{…}}'
            />
            <div className="flex gap-2">
              <Button size="sm" variant="primary" disabled={!importText.trim()} onClick={() => runImport(importText)}>
                Import
              </Button>
              <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()}>
                Load file
              </Button>
              <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={onFile} />
            </div>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="zf-label">Search keywords</span>
            <input
              className="zf-input"
              value={draft.include}
              onChange={(e) => patch({ include: e.target.value })}
              placeholder="keyword1, keyword2"
            />
          </label>
          <label className="space-y-1">
            <span className="zf-label">Exclude keywords</span>
            <input
              className="zf-input"
              value={draft.exclude}
              onChange={(e) => patch({ exclude: e.target.value })}
              placeholder="keyword1, keyword2"
            />
          </label>
        </div>

        <div className="flex border-b border-hairline">
          {tabs.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setTab(t.value)}
              className={cn(
                "-mb-px border-b-2 px-3 pb-2 text-data font-medium",
                tab === t.value ? "border-fg-1 text-fg-1" : "border-transparent text-fg-2 hover:text-fg-1",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "protocols" && (
          <div className="space-y-2">
            <div className="flex gap-3 text-label">
              <button type="button" className="text-fg-2 hover:text-fg-1" onClick={() => patch({ protocols: LAUNCHPADS.map((l) => l.id) })}>
                Select all
              </button>
              <button type="button" className="text-fg-2 hover:text-fg-1" onClick={() => patch({ protocols: [] })}>
                Unselect all
              </button>
              {draft.protocols.length === 0 && <span className="text-warn">No protocols selected: nothing will match.</span>}
            </div>
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
              {LAUNCHPADS.map((l) => (
                <Toggle
                  key={l.id}
                  on={draft.protocols.includes(l.id)}
                  onClick={() => patch({ protocols: toggleIn(draft.protocols, l.id) })}
                >
                  {l.label}
                </Toggle>
              ))}
            </div>
          </div>
        )}

        {tab === "quotes" && (
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
            {QUOTES.map((q) => (
              <Toggle key={q} on={draft.quotes.includes(q)} onClick={() => patch({ quotes: toggleIn(draft.quotes, q) })}>
                {q === "OTHER" ? "Other" : q}
              </Toggle>
            ))}
          </div>
        )}

        {tab === "audit" && (
          <div className="grid gap-x-6 gap-y-2 md:grid-cols-2">
            {AUDIT_FIELDS.map((f) => (
              <RangeRow
                key={f.key}
                label={f.label}
                unit={f.unit}
                value={draft.audit[f.key]}
                onChange={(r) => patch({ audit: { ...draft.audit, [f.key]: r } })}
              />
            ))}
          </div>
        )}

        {tab === "metrics" && (
          <div className="grid gap-x-6 gap-y-2 md:grid-cols-2">
            {MONEY_FIELDS.map((f) => (
              <RangeRow
                key={f.key}
                label={f.label}
                unit={f.unit}
                value={draft.metrics[f.key]}
                onChange={(r) => patch({ metrics: { ...draft.metrics, [f.key]: r } })}
              />
            ))}
          </div>
        )}

        {tab === "socials" && (
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            <Toggle on={draft.socials.x} onClick={() => patch({ socials: { ...draft.socials, x: !draft.socials.x } })}>
              Has X account
            </Toggle>
            <Toggle on={draft.socials.telegram} onClick={() => patch({ socials: { ...draft.socials, telegram: !draft.socials.telegram } })}>
              Has Telegram
            </Toggle>
            <Toggle on={draft.socials.website} onClick={() => patch({ socials: { ...draft.socials, website: !draft.socials.website } })}>
              Has website
            </Toggle>
            <Toggle
              on={draft.socials.atLeastOne}
              onClick={() => patch({ socials: { ...draft.socials, atLeastOne: !draft.socials.atLeastOne } })}
            >
              At least one social
            </Toggle>
            <Toggle on={draft.socials.dexPaid} onClick={() => patch({ socials: { ...draft.socials, dexPaid: !draft.socials.dexPaid } })}>
              Dex Paid
            </Toggle>
          </div>
        )}
      </div>
    </Modal>
  );
}
