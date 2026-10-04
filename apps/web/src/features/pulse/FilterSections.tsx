import type { ReactNode } from "react";
import { Checkbox } from "../../components/ui/controls";
import type { AuditRanges, MoneyRanges, PulseFilter } from "../../lib/filters";
import { fmtCount } from "../../lib/format";
import { LAUNCHPADS, QUOTES } from "../../lib/metrics";
import type { Launchpad, QuoteToken } from "../../protocol";
import { ChipInput, RangeRow } from "./FilterInputs";

export type SectionId = "keywords" | "protocols" | "quotes" | "audit" | "metrics" | "socials";

export const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "keywords", label: "Keywords" },
  { id: "protocols", label: "Protocols" },
  { id: "quotes", label: "Quote tokens" },
  { id: "audit", label: "Audit" },
  { id: "metrics", label: "$ Metrics" },
  { id: "socials", label: "Socials" },
];

/** Sections that hold an active condition get a dot in the nav (DESIGN.md 4.16). */
export function sectionActive(f: PulseFilter, id: SectionId): boolean {
  switch (id) {
    case "keywords":
      return f.include.trim() !== "" || f.exclude.trim() !== "";
    case "protocols":
      return f.protocols.length !== LAUNCHPADS.length;
    case "quotes":
      return f.quotes.length !== QUOTES.length;
    case "audit":
      return Object.values(f.audit).some((r) => r.min !== null || r.max !== null);
    case "metrics":
      return Object.values(f.metrics).some((r) => r.min !== null || r.max !== null);
    case "socials":
      return Object.values(f.socials).some(Boolean);
  }
}

const AUDIT_ROWS: { key: keyof AuditRanges; label: string; unit?: string }[] = [
  { key: "ageMin", label: "Age", unit: "min" },
  { key: "top10", label: "Top 10 holders", unit: "%" },
  { key: "dev", label: "Dev holding", unit: "%" },
  { key: "snipers", label: "Snipers", unit: "%" },
  { key: "insiders", label: "Insiders", unit: "%" },
  { key: "bundlers", label: "Bundlers", unit: "%" },
  { key: "holders", label: "Holders" },
  { key: "proTraders", label: "Pro traders" },
];

const MONEY_ROWS: { key: keyof MoneyRanges; label: string; unit?: string }[] = [
  { key: "liquidity", label: "Liquidity", unit: "USD" },
  { key: "volume", label: "Volume", unit: "USD" },
  { key: "marketCap", label: "Market cap", unit: "USD" },
  { key: "txns", label: "Txns" },
  { key: "buys", label: "Buys" },
  { key: "sells", label: "Sells" },
];

const QUOTE_LABEL: Record<QuoteToken, string> = { SOL: "SOL", USDC: "USDC", USD1: "USD1", OTHER: "Other" };

function Section({ id, title, children, extra }: { id: SectionId; title: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <section data-section={id} aria-label={title} className="mt-4 first:mt-0">
      <h3 className="flex h-6 items-center justify-between text-label font-semibold text-fg-3">
        {title}
        {extra}
      </h3>
      {children}
    </section>
  );
}

function toggle<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

function TextButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="rounded-xs px-1 text-label font-medium text-fg-2 transition-colors hover:text-fg-1">
      {children}
    </button>
  );
}

/**
 * The filter modal's content (DESIGN.md 4.16), one scrolling column: keywords, protocols with
 * live token counts, quote tokens, the eight audit and six money ranges, and socials.
 */
export function FilterSections({
  draft,
  patch,
  counts,
}: {
  draft: PulseFilter;
  patch: (p: Partial<PulseFilter>) => void;
  /** Tokens in the column's feed per launchpad and per quote (live, ignoring filters). */
  counts: { protocols: Record<string, number>; quotes: Record<string, number> };
}) {
  return (
    <>
      <Section id="keywords" title="Keywords">
        <div className="grid grid-cols-2 gap-3">
          <ChipInput label="Include" value={draft.include} onChange={(include) => patch({ include })} placeholder="pepe, cat" />
          <ChipInput label="Exclude" value={draft.exclude} onChange={(exclude) => patch({ exclude })} placeholder="rug, test" />
        </div>
        <p className="mt-1 text-label text-fg-3">Matches name or ticker, case-insensitive.</p>
      </Section>

      <Section
        id="protocols"
        title="Protocols"
        extra={
          <span className="flex items-center gap-1">
            <TextButton onClick={() => patch({ protocols: LAUNCHPADS.map((l) => l.id) })}>Select all</TextButton>
            <span className="text-fg-4">/</span>
            <TextButton onClick={() => patch({ protocols: [] })}>None</TextButton>
          </span>
        }
      >
        {draft.protocols.length === 0 && <p className="mb-1 text-label text-warn">No protocols selected, so nothing matches.</p>}
        <div className="grid grid-cols-2 gap-x-6">
          {LAUNCHPADS.map((l) => (
            <div key={l.id} className="flex h-6 items-center justify-between gap-2">
              <Checkbox
                checked={draft.protocols.includes(l.id)}
                onChange={() => patch({ protocols: toggle<Launchpad>(draft.protocols, l.id) })}
                label={l.label}
              />
              <span className="zf-num text-label text-fg-3">{fmtCount(counts.protocols[l.id] ?? 0)}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section id="quotes" title="Quote tokens">
        <div className="grid grid-cols-2 gap-x-6">
          {QUOTES.map((q) => (
            <div key={q} className="flex h-6 items-center justify-between gap-2">
              <Checkbox
                checked={draft.quotes.includes(q)}
                onChange={() => patch({ quotes: toggle(draft.quotes, q) })}
                label={QUOTE_LABEL[q]}
              />
              <span className="zf-num text-label text-fg-3">{fmtCount(counts.quotes[q] ?? 0)}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section id="audit" title="Audit">
        {AUDIT_ROWS.map((r) => (
          <RangeRow
            key={r.key}
            label={r.label}
            unit={r.unit}
            value={draft.audit[r.key]}
            onChange={(v) => patch({ audit: { ...draft.audit, [r.key]: v } })}
          />
        ))}
      </Section>

      <Section id="metrics" title="$ Metrics">
        {MONEY_ROWS.map((r) => (
          <RangeRow
            key={r.key}
            label={r.label}
            unit={r.unit}
            value={draft.metrics[r.key]}
            onChange={(v) => patch({ metrics: { ...draft.metrics, [r.key]: v } })}
          />
        ))}
      </Section>

      <Section id="socials" title="Socials">
        <div className="grid grid-cols-2 gap-x-6">
          {(
            [
              ["x", "Has X"],
              ["website", "Has website"],
              ["telegram", "Has Telegram"],
              ["atLeastOne", "At least one social"],
              ["dexPaid", "Dex paid"],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="flex h-6 items-center">
              <Checkbox checked={draft.socials[key]} onChange={(on) => patch({ socials: { ...draft.socials, [key]: on } })} label={label} />
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}
