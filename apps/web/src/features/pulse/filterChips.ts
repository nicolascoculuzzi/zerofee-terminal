import { type AuditRanges, emptyFilter, type MoneyRanges, type PulseFilter, type Range } from "../../lib/filters";
import { fmtCompact } from "../../lib/format";
import { LAUNCHPADS, QUOTES } from "../../lib/metrics";

/**
 * Active-filter chips for a column header (DESIGN.md 4.3): "label | value ×", one per active
 * condition, in the order the filter modal lists them. `clear` returns the filter without it.
 */
export interface FilterChip {
  id: string;
  label: string;
  value: string;
  clear: (f: PulseFilter) => PulseFilter;
}

export const AUDIT_SHORT: Record<keyof AuditRanges, string> = {
  ageMin: "Age",
  top10: "Top 10",
  dev: "Dev",
  snipers: "Snipers",
  insiders: "Insiders",
  bundlers: "Bundlers",
  holders: "Holders",
  proTraders: "Pro",
};

export const MONEY_SHORT: Record<keyof MoneyRanges, string> = {
  liquidity: "Liq",
  volume: "Vol",
  marketCap: "MC",
  txns: "Txns",
  buys: "Buys",
  sells: "Sells",
};

const AUDIT_UNIT: Record<keyof AuditRanges, "min" | "%" | "#"> = {
  ageMin: "min",
  top10: "%",
  dev: "%",
  snipers: "%",
  insiders: "%",
  bundlers: "%",
  holders: "#",
  proTraders: "#",
};

const MONEY_UNIT: Record<keyof MoneyRanges, "$" | "#"> = {
  liquidity: "$",
  volume: "$",
  marketCap: "$",
  txns: "#",
  buys: "#",
  sells: "#",
};

/** A typed threshold, shortened without padding zeros: 5000 reads "5K", 1200000 "1.2M", 0.5 "0.5". */
export function shortNumber(n: number): string {
  // Only zeros after the decimal point go: "5.00K" becomes "5K", "1.20M" becomes "1.2M", "100K" stays.
  return fmtCompact(n)
    .replace(/\.0+(?=[KMBT]?$)/, "")
    .replace(/(\.\d*?[1-9])0+(?=[KMBT]?$)/, "$1");
}

function unitFormat(unit: "min" | "%" | "#" | "$"): (n: number) => string {
  if (unit === "$") return (n) => `$${shortNumber(n)}`;
  if (unit === "%") return (n) => `${shortNumber(n)}%`;
  if (unit === "min") return (n) => `${shortNumber(n)}m`;
  return shortNumber;
}

/** "5K–50K", "5K+" or "up to 50K" (no comparison glyphs, DESIGN.md 2.2). */
export function rangeText(r: Range, fmt: (n: number) => string): string {
  if (r.min !== null && r.max !== null) return `${fmt(r.min)}–${fmt(r.max)}`;
  if (r.min !== null) return `${fmt(r.min)}+`;
  if (r.max !== null) return `up to ${fmt(r.max)}`;
  return "";
}

function keywords(raw: string): string[] {
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

function listText(selected: string[], labels: Record<string, string>, total: number): string {
  if (selected.length === 0) return "None";
  if (selected.length <= 2) return selected.map((s) => labels[s] ?? s).join(", ");
  return `${selected.length} of ${total}`;
}

const PROTOCOL_LABEL = Object.fromEntries(LAUNCHPADS.map((l) => [l.id, l.label]));
const QUOTE_LABEL: Record<string, string> = { SOL: "SOL", USDC: "USDC", USD1: "USD1", OTHER: "Other" };

export function filterChips(f: PulseFilter): FilterChip[] {
  const chips: FilterChip[] = [];
  const include = keywords(f.include);
  if (include.length) chips.push({ id: "include", label: "Include", value: include.join(", "), clear: (x) => ({ ...x, include: "" }) });
  const exclude = keywords(f.exclude);
  if (exclude.length) chips.push({ id: "exclude", label: "Exclude", value: exclude.join(", "), clear: (x) => ({ ...x, exclude: "" }) });
  if (f.protocols.length !== LAUNCHPADS.length) {
    chips.push({
      id: "protocols",
      label: "Protocols",
      value: listText(f.protocols, PROTOCOL_LABEL, LAUNCHPADS.length),
      clear: (x) => ({ ...x, protocols: emptyFilter().protocols }),
    });
  }
  if (f.quotes.length !== QUOTES.length) {
    chips.push({
      id: "quotes",
      label: "Quote",
      value: listText(f.quotes, QUOTE_LABEL, QUOTES.length),
      clear: (x) => ({ ...x, quotes: emptyFilter().quotes }),
    });
  }
  for (const key of Object.keys(f.audit) as (keyof AuditRanges)[]) {
    const r = f.audit[key];
    if (r.min === null && r.max === null) continue;
    chips.push({
      id: `audit.${key}`,
      label: AUDIT_SHORT[key],
      value: rangeText(r, unitFormat(AUDIT_UNIT[key])),
      clear: (x) => ({ ...x, audit: { ...x.audit, [key]: { min: null, max: null } } }),
    });
  }
  for (const key of Object.keys(f.metrics) as (keyof MoneyRanges)[]) {
    const r = f.metrics[key];
    if (r.min === null && r.max === null) continue;
    chips.push({
      id: `metrics.${key}`,
      label: MONEY_SHORT[key],
      value: rangeText(r, unitFormat(MONEY_UNIT[key])),
      clear: (x) => ({ ...x, metrics: { ...x.metrics, [key]: { min: null, max: null } } }),
    });
  }
  const socials: { key: keyof PulseFilter["socials"]; label: string; value: string }[] = [
    { key: "x", label: "Has", value: "X" },
    { key: "website", label: "Has", value: "Website" },
    { key: "telegram", label: "Has", value: "Telegram" },
    { key: "atLeastOne", label: "Socials", value: "Any" },
    { key: "dexPaid", label: "Dex", value: "Paid" },
  ];
  for (const s of socials) {
    if (!f.socials[s.key]) continue;
    chips.push({
      id: `socials.${s.key}`,
      label: s.label,
      value: s.value,
      clear: (x) => ({ ...x, socials: { ...x.socials, [s.key]: false } }),
    });
  }
  return chips;
}
