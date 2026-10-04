import {
  type AuditRanges,
  emptyFilter,
  type MoneyRanges,
  normalizeFilter,
  type ParsedImport,
  type PulseFilter,
  parseFilterImport,
  type Range,
} from "../../lib/filters";
import { parseAmount } from "../../lib/format";
import { LAUNCHPADS, QUOTES } from "../../lib/metrics";
import type { Launchpad, PulseColumnId, QuoteToken } from "../../protocol";

/**
 * Filter import (DESIGN.md 4.16): our versioned JSON (lib/filters) or an Axiom-style export,
 * whose fields are named after the panel labels ("Top 10 Holders %", "Dev Holding %",
 * "Bundle %", "Age (mins)", "Num Buys"…). Keys are matched ignoring case, spaces and symbols;
 * ranges may be {min, max}, [min, max], or separate "...Min" / "minX" keys; amounts accept
 * "5k" and "1.2m". Unknown fields are ignored.
 */

type RangeTarget = ["audit", keyof AuditRanges] | ["metrics", keyof MoneyRanges];

const RANGE_KEYS: Record<string, RangeTarget> = {};
function alias(target: RangeTarget, ...names: string[]): void {
  for (const n of names) RANGE_KEYS[n] = target;
}
alias(["audit", "ageMin"], "age", "agemin", "agemins", "ageminutes", "ageinminutes");
alias(["audit", "top10"], "top10", "top10holders", "top10holderspct", "top10holderspercent", "top10pct");
alias(["audit", "dev"], "dev", "devholding", "devholdingpct", "devholdingpercent", "devpct");
alias(["audit", "snipers"], "snipers", "sniperspct", "sniper", "sniperholding");
alias(["audit", "insiders"], "insiders", "insiderspct", "insider", "insiderholding");
alias(["audit", "bundlers"], "bundle", "bundlepct", "bundlers", "bundlerspct", "bundled");
alias(["audit", "holders"], "holders", "holdercount", "numholders");
alias(["audit", "proTraders"], "protraders", "pro", "protradercount");
alias(["metrics", "liquidity"], "liquidity", "liq", "liquidityusd");
alias(["metrics", "volume"], "volume", "vol", "volumeusd");
alias(["metrics", "marketCap"], "marketcap", "mc", "mcap", "marketcapusd");
alias(["metrics", "txns"], "txns", "transactions", "txcount", "numtxns");
alias(["metrics", "buys"], "buys", "numbuys");
alias(["metrics", "sells"], "sells", "numsells");

const SOCIAL_KEYS: Record<string, keyof PulseFilter["socials"]> = {
  x: "x",
  twitter: "x",
  hasx: "x",
  hastwitter: "x",
  website: "website",
  haswebsite: "website",
  telegram: "telegram",
  hastelegram: "telegram",
  atleastonesocial: "atLeastOne",
  anysocial: "atLeastOne",
  dexpaid: "dexPaid",
};

const PROTOCOL_KEYS: Record<string, Launchpad> = {
  pumpfun: "pump",
  raydiumlaunchlab: "launchlab",
  meteoradbc: "meteora_dbc",
  meteora: "meteora_dbc",
};
for (const l of LAUNCHPADS) {
  PROTOCOL_KEYS[norm(l.id)] = l.id;
  PROTOCOL_KEYS[norm(l.label)] = l.id;
}

const COLUMN_KEYS: Record<string, PulseColumnId> = {
  new: "new",
  newpairs: "new",
  final: "final",
  finalstretch: "final",
  migrated: "migrated",
};

function norm(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return parseAmount(v);
  return null;
}

function rangeOf(v: unknown): Range | null {
  if (Array.isArray(v)) return { min: num(v[0]), max: num(v[1]) };
  if (v && typeof v === "object") {
    const r = v as Record<string, unknown>;
    return { min: num(r.min ?? r.from ?? r.low), max: num(r.max ?? r.to ?? r.high) };
  }
  return null;
}

function words(v: unknown): string {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string").join(", ");
  return typeof v === "string" ? v : "";
}

function setRange(f: PulseFilter, target: RangeTarget, patch: Partial<Range>): void {
  if (target[0] === "audit") f.audit[target[1]] = { ...f.audit[target[1]], ...patch };
  else f.metrics[target[1]] = { ...f.metrics[target[1]], ...patch };
}

function applyAxiom(f: PulseFilter, obj: Record<string, unknown>): void {
  for (const [rawKey, value] of Object.entries(obj)) {
    const key = norm(rawKey);
    if ((key === "audit" || key === "metrics" || key === "socials" || key === "filters") && value && typeof value === "object") {
      applyAxiom(f, value as Record<string, unknown>);
      continue;
    }
    if (key === "searchkeywords" || key === "keywords" || key === "include" || key === "includekeywords") {
      f.include = words(value);
      continue;
    }
    if (key === "excludekeywords" || key === "exclude") {
      f.exclude = words(value);
      continue;
    }
    if ((key === "protocols" || key === "launchpads") && Array.isArray(value)) {
      const picked = value.map((v) => (typeof v === "string" ? PROTOCOL_KEYS[norm(v)] : undefined)).filter((v): v is Launchpad => !!v);
      if (picked.length > 0) f.protocols = [...new Set(picked)];
      continue;
    }
    if ((key === "quotetokens" || key === "quotes") && Array.isArray(value)) {
      const picked = value
        .map((v) => (typeof v === "string" ? v.toUpperCase() : ""))
        .filter((v): v is QuoteToken => QUOTES.includes(v as QuoteToken));
      if (picked.length > 0) f.quotes = [...new Set(picked)];
      continue;
    }
    const social = SOCIAL_KEYS[key];
    if (social && typeof value === "boolean") {
      f.socials[social] = value;
      continue;
    }
    const target = RANGE_KEYS[key];
    const range = rangeOf(value);
    if (target && range) {
      setRange(f, target, range);
      continue;
    }
    // Separate bounds: "top10HoldersMin", "minMarketCap".
    const bound = /^(min|max)(.+)$/.exec(key) ?? /^(.+?)(min|max)$/.exec(key);
    if (!bound) continue;
    const [side, base] = bound[1] === "min" || bound[1] === "max" ? [bound[1], bound[2]] : [bound[2], bound[1]];
    const t = base ? RANGE_KEYS[base] : undefined;
    const n = num(value);
    if (t && n !== null) setRange(f, t, side === "min" ? { min: n } : { max: n });
  }
}

function fromAxiom(obj: Record<string, unknown>): PulseFilter {
  const f = emptyFilter();
  applyAxiom(f, obj);
  return normalizeFilter(f);
}

function looksOurs(data: Record<string, unknown>): boolean {
  if (data.kind === "pulse-filters" || data.app === "zerofee") return true;
  if ("audit" in data && "metrics" in data && "v" in data) return true;
  const cols = ["new", "final", "migrated"].map((c) => data[c]).filter(Array.isArray) as unknown[][];
  return cols.length > 0 && cols.every((list) => list.every((x) => !!x && typeof x === "object" && "audit" in x && "metrics" in x));
}

export function importFilters(text: string): ParsedImport {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Not valid JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Expected a JSON object");
  const obj = data as Record<string, unknown>;
  if (looksOurs(obj)) return parseFilterImport(text);

  const columns: Partial<Record<PulseColumnId, PulseFilter[]>> = {};
  for (const [rawKey, value] of Object.entries(obj)) {
    const column = COLUMN_KEYS[norm(rawKey)];
    if (!column || !value || typeof value !== "object") continue;
    const list = Array.isArray(value) ? value : [value];
    columns[column] = list
      .slice(0, 3)
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map(fromAxiom);
  }
  if (Object.keys(columns).length > 0) return { kind: "columns", columns };

  const single = fromAxiom(obj);
  if (JSON.stringify(single) === JSON.stringify(emptyFilter())) throw new Error("No filter fields found");
  return { kind: "single", filter: single };
}
