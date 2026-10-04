import type { Launchpad, QuoteToken, TokenSummary } from "../protocol";
import { LAUNCHPADS, QUOTES } from "./metrics";

export interface Range {
  min: number | null;
  max: number | null;
}

export interface AuditRanges {
  ageMin: Range;
  top10: Range;
  dev: Range;
  snipers: Range;
  insiders: Range;
  bundlers: Range;
  holders: Range;
  proTraders: Range;
}

export interface MoneyRanges {
  liquidity: Range;
  volume: Range;
  marketCap: Range;
  txns: Range;
  buys: Range;
  sells: Range;
}

/** One Pulse column filter (versioned so exports stay importable). */
export interface PulseFilter {
  v: 1;
  /** Comma-separated; a token matches if its name or ticker contains any of them. */
  include: string;
  /** Comma-separated; a token is hidden if its name or ticker contains any of them. */
  exclude: string;
  /** Selected launchpads; all selected by default. */
  protocols: Launchpad[];
  quotes: QuoteToken[];
  audit: AuditRanges;
  metrics: MoneyRanges;
  socials: { x: boolean; telegram: boolean; website: boolean; atLeastOne: boolean; dexPaid: boolean };
}

export const AUDIT_FIELDS: { key: keyof AuditRanges; label: string; unit: "min" | "%" | "#" }[] = [
  { key: "ageMin", label: "Age", unit: "min" },
  { key: "top10", label: "Top 10 Holders", unit: "%" },
  { key: "dev", label: "Dev Holding", unit: "%" },
  { key: "snipers", label: "Snipers", unit: "%" },
  { key: "insiders", label: "Insiders", unit: "%" },
  { key: "bundlers", label: "Bundle", unit: "%" },
  { key: "holders", label: "Holders", unit: "#" },
  { key: "proTraders", label: "Pro Traders", unit: "#" },
];

export const MONEY_FIELDS: { key: keyof MoneyRanges; label: string; unit: "$" | "#" }[] = [
  { key: "liquidity", label: "Liquidity", unit: "$" },
  { key: "volume", label: "Volume", unit: "$" },
  { key: "marketCap", label: "Market Cap", unit: "$" },
  { key: "txns", label: "Txns", unit: "#" },
  { key: "buys", label: "Buys", unit: "#" },
  { key: "sells", label: "Sells", unit: "#" },
];

const ALL_PROTOCOLS = LAUNCHPADS.map((l) => l.id);

const emptyRange = (): Range => ({ min: null, max: null });

export function emptyFilter(): PulseFilter {
  return {
    v: 1,
    include: "",
    exclude: "",
    protocols: [...ALL_PROTOCOLS],
    quotes: [...QUOTES],
    audit: {
      ageMin: emptyRange(),
      top10: emptyRange(),
      dev: emptyRange(),
      snipers: emptyRange(),
      insiders: emptyRange(),
      bundlers: emptyRange(),
      holders: emptyRange(),
      proTraders: emptyRange(),
    },
    metrics: {
      liquidity: emptyRange(),
      volume: emptyRange(),
      marketCap: emptyRange(),
      txns: emptyRange(),
      buys: emptyRange(),
      sells: emptyRange(),
    },
    socials: { x: false, telegram: false, website: false, atLeastOne: false, dexPaid: false },
  };
}

function rangeActive(r: Range): boolean {
  return r.min !== null || r.max !== null;
}

/**
 * Unknown is not zero (DESIGN.md 4.16, packages/protocol market.ts): a value the server sends as null
 * (or a NaN placeholder) fails any min or max set on it, so the token drops out while that filter is
 * active. "Max MC $50K" must not let a token with an unknown market cap through as "$0".
 */
export function inRange(value: number | null | undefined, r: Range): boolean {
  if (r.min === null && r.max === null) return true;
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (r.min !== null && value < r.min) return false;
  if (r.max !== null && value > r.max) return false;
  return true;
}

/**
 * Token age in minutes for the age filter. A creation time the server did not observe means the token
 * is older than its observation window: it passes a minimum age and fails a maximum (the copy-trade
 * filters' rule, packages/protocol trackers.ts).
 */
function ageInRange(createdAt: number | null, now: number, r: Range): boolean {
  if (typeof createdAt === "number" && Number.isFinite(createdAt)) return inRange((now - createdAt) / 60_000, r);
  return r.max === null;
}

function keywords(raw: string): string[] {
  return raw
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}

/** Number of active conditions, for the badge on each column's filter button. */
export function activeFilterCount(f: PulseFilter): number {
  let n = 0;
  if (keywords(f.include).length) n++;
  if (keywords(f.exclude).length) n++;
  if (f.protocols.length !== ALL_PROTOCOLS.length) n++;
  if (f.quotes.length !== QUOTES.length) n++;
  for (const r of Object.values(f.audit)) if (rangeActive(r)) n++;
  for (const r of Object.values(f.metrics)) if (rangeActive(r)) n++;
  for (const v of Object.values(f.socials)) if (v) n++;
  return n;
}

export interface CompiledFilter {
  include: string[];
  exclude: string[];
  protocols: Set<Launchpad>;
  quotes: Set<QuoteToken>;
  f: PulseFilter;
}

export function compileFilter(f: PulseFilter): CompiledFilter {
  return {
    include: keywords(f.include),
    exclude: keywords(f.exclude),
    protocols: new Set(f.protocols),
    quotes: new Set(f.quotes),
    f,
  };
}

export function matchesFilter(t: TokenSummary, c: CompiledFilter, now: number): boolean {
  const { f } = c;
  if (!c.protocols.has(t.launchpad)) return false;
  if (!c.quotes.has(t.quote)) return false;
  if (c.include.length || c.exclude.length) {
    const hay = `${t.name} ${t.symbol}`.toLowerCase();
    if (c.include.length && !c.include.some((k) => hay.includes(k))) return false;
    if (c.exclude.some((k) => hay.includes(k))) return false;
  }
  const a = f.audit;
  if (!ageInRange(t.createdAt, now, a.ageMin)) return false;
  if (!inRange(t.risk.top10Pct, a.top10)) return false;
  if (!inRange(t.risk.devPct, a.dev)) return false;
  if (!inRange(t.risk.snipersPct, a.snipers)) return false;
  if (!inRange(t.risk.insidersPct, a.insiders)) return false;
  if (!inRange(t.risk.bundlersPct, a.bundlers)) return false;
  if (!inRange(t.holders, a.holders)) return false;
  if (!inRange(t.proTraders, a.proTraders)) return false;
  const m = f.metrics;
  if (!inRange(t.liquidityUsd, m.liquidity)) return false;
  if (!inRange(t.volumeUsd, m.volume)) return false;
  if (!inRange(t.marketCapUsd, m.marketCap)) return false;
  if (!inRange(t.txns, m.txns)) return false;
  if (!inRange(t.buys, m.buys)) return false;
  if (!inRange(t.sells, m.sells)) return false;
  const s = f.socials;
  if (s.x && !t.socials.x) return false;
  if (s.telegram && !t.socials.telegram) return false;
  if (s.website && !t.socials.website) return false;
  if (s.atLeastOne && !t.socials.x && !t.socials.telegram && !t.socials.website) return false;
  if (s.dexPaid && !t.dexPaid) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Blacklists (applied to every feed)
// ---------------------------------------------------------------------------

export interface BlacklistEntry {
  value: string;
  note: string;
  addedAt: number;
}

export interface Blacklists {
  tokens: BlacklistEntry[];
  devs: BlacklistEntry[];
  fundingWallets: BlacklistEntry[];
  xHandles: BlacklistEntry[];
}

export interface CompiledBlacklists {
  tokens: Set<string>;
  devs: Set<string>;
  funders: Set<string>;
  handles: Set<string>;
  size: number;
}

export function normalizeHandle(raw: string): string {
  return (
    raw
      .trim()
      .replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "")
      .replace(/^@/, "")
      .split(/[/?#]/)[0]
      ?.toLowerCase() ?? ""
  );
}

export function compileBlacklists(b: Blacklists): CompiledBlacklists {
  const tokens = new Set(b.tokens.map((e) => e.value));
  const devs = new Set(b.devs.map((e) => e.value));
  const funders = new Set(b.fundingWallets.map((e) => e.value));
  const handles = new Set(b.xHandles.map((e) => normalizeHandle(e.value)));
  return { tokens, devs, funders, handles, size: tokens.size + devs.size + funders.size + handles.size };
}

export function isBlacklisted(t: TokenSummary, b: CompiledBlacklists): boolean {
  if (b.size === 0) return false;
  if (b.tokens.has(t.mint)) return true;
  if (b.devs.has(t.creator)) return true;
  if (t.fundingWallet && b.funders.has(t.fundingWallet)) return true;
  if (t.socials.x && b.handles.has(normalizeHandle(t.socials.x))) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

export interface FilterExport {
  app: "zerofee";
  kind: "pulse-filters";
  v: 1;
  /** One filter, or presets per column. */
  filters: PulseFilter | Partial<Record<"new" | "final" | "migrated", PulseFilter[]>>;
}

export function exportFilters(filters: FilterExport["filters"]): string {
  const payload: FilterExport = { app: "zerofee", kind: "pulse-filters", v: 1, filters };
  return JSON.stringify(payload, null, 2);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function normalizeRange(raw: unknown): Range {
  if (!raw || typeof raw !== "object") return emptyRange();
  const r = raw as Record<string, unknown>;
  return { min: num(r.min), max: num(r.max) };
}

/** Validates and normalizes any object into a PulseFilter (unknown fields are dropped). */
export function normalizeFilter(raw: unknown): PulseFilter {
  const base = emptyFilter();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const audit = (r.audit ?? {}) as Record<string, unknown>;
  const metrics = (r.metrics ?? {}) as Record<string, unknown>;
  const socials = (r.socials ?? {}) as Record<string, unknown>;
  const protocols = Array.isArray(r.protocols)
    ? (r.protocols.filter((p) => ALL_PROTOCOLS.includes(p as Launchpad)) as Launchpad[])
    : base.protocols;
  const quotes = Array.isArray(r.quotes) ? (r.quotes.filter((q) => QUOTES.includes(q as QuoteToken)) as QuoteToken[]) : base.quotes;
  return {
    v: 1,
    include: typeof r.include === "string" ? r.include : "",
    exclude: typeof r.exclude === "string" ? r.exclude : "",
    protocols,
    quotes,
    audit: Object.fromEntries(AUDIT_FIELDS.map(({ key }) => [key, normalizeRange(audit[key])])) as unknown as AuditRanges,
    metrics: Object.fromEntries(MONEY_FIELDS.map(({ key }) => [key, normalizeRange(metrics[key])])) as unknown as MoneyRanges,
    socials: {
      x: socials.x === true,
      telegram: socials.telegram === true,
      website: socials.website === true,
      atLeastOne: socials.atLeastOne === true,
      dexPaid: socials.dexPaid === true,
    },
  };
}

export type ParsedImport =
  | { kind: "single"; filter: PulseFilter }
  | { kind: "columns"; columns: Partial<Record<"new" | "final" | "migrated", PulseFilter[]>> };

export function parseFilterImport(text: string): ParsedImport {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Not valid JSON");
  }
  if (!data || typeof data !== "object") throw new Error("Expected a JSON object");
  const obj = data as Record<string, unknown>;
  const payload = obj.kind === "pulse-filters" ? obj.filters : obj;
  if (!payload || typeof payload !== "object") throw new Error("No filters found");
  const p = payload as Record<string, unknown>;
  if ("new" in p || "final" in p || "migrated" in p) {
    const columns: Partial<Record<"new" | "final" | "migrated", PulseFilter[]>> = {};
    for (const col of ["new", "final", "migrated"] as const) {
      const list = p[col];
      if (Array.isArray(list)) columns[col] = list.slice(0, 3).map(normalizeFilter);
    }
    return { kind: "columns", columns };
  }
  return { kind: "single", filter: normalizeFilter(p) };
}
