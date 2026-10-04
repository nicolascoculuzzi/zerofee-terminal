import { X } from "lucide-react";
import { type ClipboardEvent, type KeyboardEvent, useState } from "react";
import { NumberInput } from "../../components/ui/controls";
import { cn } from "../../lib/cn";
import type { Range } from "../../lib/filters";

/**
 * Range row (DESIGN.md 4.16): 28 px, label column 160 px | min 88 px | "–" | max 88 px | clear
 * on hover. Label 12/500 text-1 with the unit at 11 text-3; inputs right-aligned with "Min" and
 * "Max" placeholders; "5k" and "1.2m" are accepted. Min above max marks both inputs and says so.
 * Inputs carry the `zfp-range` class so Up/Down can move between rows.
 * Label plus min–max pair per row after OKX's filter drawer: https://mobbin.com/screens/e1788cb5-4baf-4097-966e-527f1193cc64
 */
export function RangeRow({ label, unit, value, onChange }: { label: string; unit?: string; value: Range; onChange: (r: Range) => void }) {
  const invalid = value.min !== null && value.max !== null && value.min > value.max;
  const active = value.min !== null || value.max !== null;
  return (
    <div className="group/range">
      <div className="grid h-7 grid-cols-[160px_88px_auto_88px_20px] items-center gap-2">
        <span className="truncate">
          <span className="text-data font-medium text-fg-1">{label}</span>
          {unit && <span className="text-label text-fg-3"> ({unit})</span>}
        </span>
        <NumberInput
          value={value.min}
          onChange={(min) => onChange({ ...value, min })}
          placeholder="Min"
          min={0}
          invalid={invalid}
          ariaLabel={`${label} minimum`}
          inputClassName="zfp-range"
        />
        <span className="text-data text-fg-3">–</span>
        <NumberInput
          value={value.max}
          onChange={(max) => onChange({ ...value, max })}
          placeholder="Max"
          min={0}
          invalid={invalid}
          ariaLabel={`${label} maximum`}
          inputClassName="zfp-range"
        />
        {active ? (
          <button
            type="button"
            aria-label={`Clear ${label}`}
            onClick={() => onChange({ min: null, max: null })}
            className="flex size-5 items-center justify-center rounded-xs text-fg-3 opacity-0 transition-colors group-focus-within/range:opacity-100 group-hover/range:opacity-100 hover:text-fg-1 focus-visible:opacity-100"
          >
            <X className="icon-xs" />
          </button>
        ) : (
          <span />
        )}
      </div>
      {invalid && (
        <div role="alert" className="pb-1 pl-[168px] text-label text-sell">
          Min is above max
        </div>
      )}
    </div>
  );
}

function split(raw: string): string[] {
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

/**
 * Keyword input with chip tokens (DESIGN.md 4.16): comma or Enter turns the typed word into a
 * chip, Backspace on an empty field removes the last one, pasting "a, b, c" adds three. Stored
 * comma-separated, as the filter format expects.
 */
export function ChipInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const [text, setText] = useState("");
  const words = split(value);
  const commit = (extra: string[]) => {
    const next = [...words];
    for (const w of extra) if (!next.some((x) => x.toLowerCase() === w.toLowerCase())) next.push(w);
    onChange(next.join(", "));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === "," || e.key === "Enter") && text.trim()) {
      e.preventDefault();
      commit(split(text));
      setText("");
    } else if (e.key === "Backspace" && !text && words.length > 0) {
      onChange(words.slice(0, -1).join(", "));
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text");
    if (!pasted.includes(",")) return;
    e.preventDefault();
    commit(split(pasted));
  };
  return (
    <label className="block">
      <span className="zf-label mb-1 block">{label}</span>
      <span className="flex min-h-7 flex-wrap items-center gap-1 rounded-sm border border-hairline-strong bg-surface-2 px-1 py-0.5 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus">
        {words.map((w) => (
          <span key={w} className="inline-flex h-5 items-center gap-0.5 rounded-xs bg-surface-3 pr-0.5 pl-1.5 text-label text-fg-1">
            {w}
            <button
              type="button"
              aria-label={`Remove ${w}`}
              onClick={(e) => {
                e.preventDefault();
                onChange(words.filter((x) => x !== w).join(", "));
              }}
              className="flex size-4 items-center justify-center rounded-xs text-fg-3 hover:text-fg-1"
            >
              <X className="icon-xs" />
            </button>
          </span>
        ))}
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => {
            if (text.trim()) {
              commit(split(text));
              setText("");
            }
          }}
          placeholder={words.length === 0 ? placeholder : ""}
          className={cn("h-5 min-w-24 flex-1 bg-transparent px-1 text-data placeholder:text-fg-4 focus-visible:outline-none")}
        />
      </span>
    </label>
  );
}
