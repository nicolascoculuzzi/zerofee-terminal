import { Check, Download, Link, Upload, X } from "lucide-react";
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { Button, IconButton } from "../../components/ui/Button";
import { Segmented } from "../../components/ui/controls";
import { Popover } from "../../components/ui/Popover";
import { Tooltip } from "../../components/ui/Tooltip";
import { COLUMN_TITLE } from "../../config";
import { copyText, downloadText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import type { PulseColumnId } from "../../protocol";

const COLUMNS: PulseColumnId[] = ["new", "final", "migrated"];

function ImportButton({ onImport }: { onImport: (text: string) => string | null }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const run = (raw: string) => {
    const err = onImport(raw);
    setError(err);
    if (!err) {
      setOpen(false);
      setText("");
    }
  };
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) void f.text().then(run);
    e.target.value = "";
  };
  return (
    <>
      <Tooltip content="Import filters (zerofee or Axiom-style JSON)">
        <IconButton ref={anchor} label="Import filters" title="" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <Upload />
        </IconButton>
      </Tooltip>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} align="end" width={360} padding="form">
        <label className="zf-label mb-1 block" htmlFor="zfp-filter-import">
          Paste a filter export: zerofee JSON or Axiom-style field names
        </label>
        <textarea
          id="zfp-filter-import"
          className="h-24 w-full resize-none rounded-sm border border-hairline-strong bg-surface-2 p-2 font-mono text-label text-fg-1 placeholder:text-fg-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          placeholder='{"Top 10 Holders %": {"max": 30}}'
          aria-invalid={error !== null}
        />
        {error && <div className="mt-1 text-label text-sell">{error}</div>}
        <div className="mt-2 flex items-center justify-end gap-2">
          <Button size="xs" variant="secondary" onClick={() => file.current?.click()}>
            Choose file
          </Button>
          <input ref={file} type="file" accept="application/json,.json" className="hidden" onChange={onFile} />
          <Button size="xs" variant="primary" disabled={!text.trim()} onClick={() => run(text)}>
            Import filters
          </Button>
        </div>
      </Popover>
    </>
  );
}

function ShareButton({ json }: { json: () => string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Tooltip content={copied ? "Copied" : "Copy this filter as JSON to share"}>
      <IconButton
        label={copied ? "Copied" : "Copy filter JSON"}
        title=""
        onClick={() => void copyText(json()).then((ok) => setCopied(ok))}
        className={copied ? "text-fg-1" : undefined}
      >
        {copied ? <Check /> : <Link />}
      </IconButton>
    </Tooltip>
  );
}

/**
 * Filter modal header (DESIGN.md 4.16), 44 px: "Filters" 14/600, column tabs with active-filter
 * counts, then preset slots 1 | 2 | 3, Import, Export, Share and close. Export downloads a local
 * file and Share copies the JSON (check swap, no toast).
 */
export function FilterHeader({
  column,
  onColumn,
  counts,
  slot,
  onSlot,
  onImport,
  exportJson,
  shareJson,
  onClose,
}: {
  column: PulseColumnId;
  onColumn: (c: PulseColumnId) => void;
  counts: Record<PulseColumnId, number>;
  slot: 0 | 1 | 2;
  onSlot: (s: 0 | 1 | 2) => void;
  onImport: (text: string) => string | null;
  exportJson: () => string;
  shareJson: () => string;
  onClose: () => void;
}) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-hairline pr-2 pl-4">
      <h2 className="text-heading font-semibold text-fg-1">Filters</h2>
      <div role="tablist" aria-label="Column" className="flex h-full min-w-0 items-stretch">
        {COLUMNS.map((c) => {
          const active = c === column;
          return (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onColumn(c)}
              onKeyDown={(e) => {
                if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                e.preventDefault();
                const i = COLUMNS.indexOf(column);
                const next = COLUMNS[(i + (e.key === "ArrowRight" ? 1 : COLUMNS.length - 1)) % COLUMNS.length];
                if (next) onColumn(next);
              }}
              className={cn(
                "focus-inset relative flex items-center gap-1 px-2 text-data font-medium whitespace-nowrap transition-colors",
                active
                  ? "text-fg-1 after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-accent after:content-['']"
                  : "text-fg-3 hover:text-fg-2",
              )}
            >
              {COLUMN_TITLE[c]}
              {counts[c] > 0 && <span className="zf-num text-fg-3">{counts[c]}</span>}
            </button>
          );
        })}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Segmented<"0" | "1" | "2">
          size="xs"
          value={String(slot) as "0" | "1" | "2"}
          onChange={(v) => onSlot(Number(v) as 0 | 1 | 2)}
          options={[
            { value: "0", label: "1", title: "Preset slot 1" },
            { value: "1", label: "2", title: "Preset slot 2" },
            { value: "2", label: "3", title: "Preset slot 3" },
          ]}
          label="Filter preset slot"
          className="mr-1"
        />
        <ImportButton onImport={onImport} />
        <Tooltip content="Export every column's presets as a JSON file">
          <IconButton label="Export filters" title="" onClick={() => downloadText("zerofee-pulse-filters.json", exportJson())}>
            <Download />
          </IconButton>
        </Tooltip>
        <ShareButton json={shareJson} />
        <IconButton label="Close" title="Close (Esc)" size="nav" onClick={onClose}>
          <X />
        </IconButton>
      </div>
    </div>
  );
}
