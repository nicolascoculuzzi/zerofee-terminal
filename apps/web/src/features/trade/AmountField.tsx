import { Check, Pencil } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { NumberInput } from "../../components/ui/controls";
import { cn } from "../../lib/cn";
import { parseAmount } from "../../lib/format";
import type { AmountIssue } from "./tradeMath";

/*
 * Amount input with preset chips (DESIGN.md 4.7): a 16 px label row ("Amount" left, balance and
 * Max right), the 32/36/44 px amount input (14/500, right-aligned, unit suffix), an 11 px
 * validation line, then four equal preset chips and a pencil that turns them into inputs
 * (Enter saves, Esc cancels). Chips under the field after Coinbase Advanced
 * https://mobbin.com/screens/f8afc154-e5c8-4587-ab43-93c4799a979a and the selected-chip state
 * after Whop https://mobbin.com/screens/b5f3bb6c-2fc1-497f-8386-29d3a6f7e763
 */

/** Up/Down step: 0.01 below 1 SOL, 0.1 from 1 SOL (Shift multiplies by 10 in NumberInput). */
export function solStep(v: number): number {
  return v < 1 ? 0.01 : 0.1;
}

export function AmountField({
  label = "Amount",
  right,
  value,
  onChange,
  unit,
  step,
  max,
  presets,
  presetLabel,
  onSavePresets,
  issue,
  onIssueAction,
  onEnter,
  ariaLabel,
  className,
  inputId,
  tone,
}: {
  label?: string;
  right?: ReactNode;
  value: number | null;
  onChange: (v: number | null) => void;
  unit: string;
  step: number | ((v: number) => number);
  max?: number;
  presets: number[];
  presetLabel: (v: number) => string;
  onSavePresets: (values: number[]) => void;
  issue?: AmountIssue | null;
  onIssueAction?: () => void;
  onEnter?: () => void;
  ariaLabel: string;
  className?: string;
  inputId?: string;
  /** Side colour for the selected preset (trade panel); neutral elsewhere. */
  tone?: "buy" | "sell";
}) {
  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex h-4 items-center justify-between gap-2 text-label">
        <label htmlFor={inputId} className="font-medium text-fg-3">
          {label}
        </label>
        {right && <span className="flex min-w-0 items-center gap-1 truncate text-fg-3">{right}</span>}
      </div>
      <NumberInput
        id={inputId}
        size="amount"
        value={value}
        onChange={onChange}
        suffix={<span className="text-data text-fg-3">{unit}</span>}
        min={0}
        max={max}
        step={step}
        invalid={issue?.tone === "sell"}
        onEnter={onEnter}
        ariaLabel={ariaLabel}
      />
      {issue && (
        <p className={cn("text-label", issue.tone === "sell" ? "text-sell" : "text-warn")}>
          {issue.text}
          {issue.action === "caps" && onIssueAction && (
            <>
              {" · "}
              <button type="button" onClick={onIssueAction} className="underline-offset-2 hover:underline">
                Change
              </button>
            </>
          )}
        </p>
      )}
      <PresetChips values={presets} active={value} label={presetLabel} onPick={onChange} onSave={onSavePresets} unit={unit} tone={tone} />
    </div>
  );
}

/**
 * Four equal presets joined in one 28 px hairline-strong strip with hairline dividers, plus an edit
 * pencil (DESIGN.md 4.7 "Presets" and "Edit mode"). The preset matching the value fills with the
 * side tint and side-coloured text (Axiom's panel), or surface-3 and text-1 when neutral. Equal
 * 25/50/75/100% chips after Gemini https://mobbin.com/screens/04be92d6-0eb8-48bf-859b-15f00f38b00d
 */
export function PresetChips({
  values,
  active,
  label,
  onPick,
  onSave,
  unit,
  tone,
}: {
  values: number[];
  active: number | null;
  label: (v: number) => string;
  onPick: (v: number) => void;
  /** Omit for fixed chips (no edit pencil). */
  onSave?: (values: number[]) => void;
  unit: string;
  tone?: "buy" | "sell";
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const firstInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) firstInput.current?.focus();
  }, [editing]);

  const start = () => {
    setDraft(values.map((v) => String(v)));
    setEditing(true);
  };
  const save = () => {
    const next = values.map((v, i) => {
      const n = parseAmount(draft[i] ?? "");
      return n !== null && n > 0 ? n : v;
    });
    onSave?.(next);
    setEditing(false);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setEditing(false);
    }
  };

  return (
    <div className="flex items-center gap-1">
      <div className="grid h-7 min-w-0 flex-1 grid-cols-4 divide-x divide-hairline overflow-hidden rounded-sm border border-hairline-strong">
        {values.map((v, i) =>
          editing ? (
            <input
              // biome-ignore lint/suspicious/noArrayIndexKey: four fixed preset slots
              key={i}
              ref={i === 0 ? firstInput : undefined}
              inputMode="decimal"
              aria-label={`Preset ${i + 1} in ${unit}`}
              value={draft[i] ?? ""}
              onChange={(e) => setDraft((d) => d.map((x, j) => (j === i ? e.target.value : x)))}
              onKeyDown={onKey}
              className="zf-num focus-inset h-full min-w-0 bg-surface-2 px-1 text-center text-data font-medium text-fg-1"
            />
          ) : (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: four fixed preset slots
              key={i}
              type="button"
              aria-pressed={active === v}
              onClick={() => onPick(v)}
              className={cn(
                "zf-num focus-inset h-full min-w-0 truncate px-1 text-data font-medium transition-colors",
                active !== v && "text-fg-2 hover:bg-surface-3 hover:text-fg-1",
                active === v &&
                  (tone === "buy" ? "bg-buy-tint text-buy" : tone === "sell" ? "bg-sell-tint text-sell" : "bg-surface-3 text-fg-1"),
              )}
            >
              {label(v)}
            </button>
          ),
        )}
      </div>
      {onSave && (
        <button
          type="button"
          aria-label={editing ? "Save presets" : "Edit presets"}
          title={editing ? "Save presets (Enter)" : "Edit presets"}
          onClick={editing ? save : start}
          className="flex size-7 shrink-0 items-center justify-center rounded-sm text-fg-3 transition-colors hover:bg-surface-3 hover:text-fg-1"
        >
          {editing ? <Check className="icon-sm" /> : <Pencil className="icon-sm" />}
        </button>
      )}
    </div>
  );
}
