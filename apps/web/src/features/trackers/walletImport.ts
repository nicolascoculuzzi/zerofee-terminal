import { isBase58Address } from "../../lib/address";
import { shortAddr } from "../../lib/format";
import type { TrackedWallet } from "../../state/trackers";

/**
 * Wallet-list import and export.
 *
 * Accepted input (auto-detected):
 * - zerofee JSON export: `[{ address, name, emoji, alerts }]`
 * - BullX-style JSON: arrays of `{ address | walletAddress, name | label | tag }`, also wrapped in
 *   `{ wallets: [...] }` / `{ data: [...] }`, or an `{ "<address>": "<name>" }` map
 * - GMGN-style text, one wallet per line: `address name`, `name:address`, CSV `address,name`
 *   (tab, `;` and `|` separators work too; a leading emoji on the name becomes the wallet tag;
 *   a CSV header line and `#` / `//` comment lines are skipped)
 */

export type ImportedWallet = Omit<TrackedWallet, "createdAt">;

export interface SkippedEntry {
  /** "Line 4" or "Entry 2". */
  where: string;
  text: string;
  reason: string;
}

export interface WalletImportResult {
  format: "empty" | "json" | "lines";
  wallets: ImportedWallet[];
  skipped: SkippedEntry[];
  /** Addresses repeated inside the pasted text (kept once). */
  duplicates: number;
  /** Fatal problem, e.g. malformed JSON. */
  error: string | null;
}

const B58 = "1-9A-HJ-NP-Za-km-z";
const ADDRESS_IN_TEXT = new RegExp(`(?<![${B58}])[${B58}]{32,44}(?![${B58}])`);
const EMOJI_SEQ = "\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier}|\\u200D\\p{Extended_Pictographic})*";
const LEADING_EMOJI = new RegExp(`^(${EMOJI_SEQ})\\s*`, "u");
const EMOJI_ONLY = new RegExp(`^${EMOJI_SEQ}$`, "u");
const EDGE_SEPARATORS = /^[\s,;:|"'=>–—-]+|[\s,;:|"'=<–—-]+$/g;
const EMPTY_BRACKETS = /[([{]\s*[)\]}]/g;
const BOOL_WORD = /^(true|false|yes|no|on|off)$/i;
const TRUE_WORD = /^(true|yes|on|1)$/i;
const MAX_NAME = 40;

const ADDRESS_KEYS = ["address", "walletaddress", "wallet_address", "wallet", "addr", "pubkey", "publickey"];
const NAME_KEYS = ["name", "label", "tag", "alias", "nickname", "remark", "note"];
const EMOJI_KEYS = ["emoji", "icon"];
const ALERT_KEYS = ["alerts", "alert", "notify", "notifications"];
const LIST_KEYS = ["wallets", "data", "list", "items", "trackedwallets", "result"];

function cleanName(raw: string): string {
  const s = raw.replace(EMPTY_BRACKETS, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(s);
  return chars.length > MAX_NAME ? chars.slice(0, MAX_NAME).join("").trim() : s;
}

/** Splits a leading emoji off a name ("🐋 Whale" → emoji 🐋, name Whale). */
function splitName(raw: string): { name: string; emoji: string } {
  const s = raw.trim();
  const m = LEADING_EMOJI.exec(s);
  if (m?.[1]) return { emoji: m[1], name: cleanName(s.slice(m[0].length)) };
  return { emoji: "", name: cleanName(s) };
}

/** The wallet tag: an emoji (other tools' exports) or up to 2 characters (ours). */
function cleanTag(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const s = raw.trim();
  if (s.length <= 16 && EMOJI_ONLY.test(s)) return s;
  const chars = Array.from(s);
  return chars.length > 0 && chars.length <= 2 && !/\s/.test(s) ? s : "";
}

function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return TRUE_WORD.test(v.trim());
  return false;
}

function lowerKeys(obj: Record<string, unknown>): Map<string, unknown> {
  return new Map(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]));
}

function pick(obj: Map<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = obj.get(k);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function wallet(address: string, rawName: string, emoji = "", alerts = false): ImportedWallet {
  const split = splitName(rawName);
  return { address, name: split.name || shortAddr(address), emoji: emoji || split.emoji, alerts };
}

/** Splits a delimited line (tab, comma, semicolon or pipe), honouring double quotes. */
function splitFields(line: string): string[] | null {
  const sep = line.includes("\t") ? "\t" : line.includes(",") ? "," : line.includes(";") ? ";" : line.includes("|") ? "|" : null;
  if (!sep) return null;
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === sep && !quoted) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** One text line → wallet, or null when the line holds no Solana address. */
export function parseWalletLine(line: string): ImportedWallet | null {
  const fields = splitFields(line);
  if (fields) {
    const idx = fields.findIndex((f) => isBase58Address(f));
    const address = idx >= 0 ? fields[idx] : undefined;
    if (address !== undefined) {
      let name = "";
      let emoji = "";
      let alerts = false;
      fields.forEach((f, i) => {
        if (i === idx || !f) return;
        if (!emoji && EMOJI_ONLY.test(f)) emoji = f;
        else if (BOOL_WORD.test(f)) alerts = TRUE_WORD.test(f);
        else if (!name) name = f;
      });
      return wallet(address, name, emoji, alerts);
    }
  }
  const m = ADDRESS_IN_TEXT.exec(line);
  if (!m || !isBase58Address(m[0])) return null;
  const address = m[0];
  const rest = `${line.slice(0, m.index)} ${line.slice(m.index + address.length)}`.replace(EDGE_SEPARATORS, "");
  return wallet(address, rest);
}

function entryToWallet(entry: unknown): ImportedWallet | string {
  if (typeof entry === "string") return parseWalletLine(entry) ?? "No Solana address";
  if (Array.isArray(entry)) {
    const parts = entry.filter((x): x is string => typeof x === "string");
    return parseWalletLine(parts.join("\t")) ?? "No Solana address";
  }
  if (entry && typeof entry === "object") {
    const obj = lowerKeys(entry as Record<string, unknown>);
    const rawAddress = pick(obj, ADDRESS_KEYS);
    if (typeof rawAddress !== "string") return "Missing address";
    const address = rawAddress.trim();
    if (!isBase58Address(address)) return "Not a Solana address";
    const rawName = pick(obj, NAME_KEYS);
    return wallet(address, typeof rawName === "string" ? rawName : "", cleanTag(pick(obj, EMOJI_KEYS)), toBool(pick(obj, ALERT_KEYS)));
  }
  return "Unsupported entry";
}

function jsonEntries(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [data];
  const obj = data as Record<string, unknown>;
  const keyed = lowerKeys(obj);
  for (const key of LIST_KEYS) {
    const v = keyed.get(key);
    if (Array.isArray(v)) return v;
  }
  // A single wallet object.
  const single = pick(keyed, ADDRESS_KEYS);
  if (typeof single === "string" && isBase58Address(single.trim())) return [obj];
  // An { address: name | {...} } map.
  return Object.entries(obj).map(([key, v]) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? { address: key, ...(v as Record<string, unknown>) }
      : { address: key, name: typeof v === "string" ? v : "" },
  );
}

function preview(entry: unknown): string {
  let s: string;
  try {
    s = typeof entry === "string" ? entry : (JSON.stringify(entry) ?? String(entry));
  } catch {
    s = String(entry);
  }
  return s.length > 90 ? `${s.slice(0, 89)}…` : s;
}

interface Row {
  where: string;
  text: string;
  result: ImportedWallet | string;
}

function collect(format: WalletImportResult["format"], rows: Row[]): WalletImportResult {
  const seen = new Set<string>();
  const wallets: ImportedWallet[] = [];
  const skipped: SkippedEntry[] = [];
  let duplicates = 0;
  for (const r of rows) {
    if (typeof r.result === "string") {
      skipped.push({ where: r.where, text: r.text, reason: r.result });
      continue;
    }
    if (seen.has(r.result.address)) {
      duplicates++;
      continue;
    }
    seen.add(r.result.address);
    wallets.push(r.result);
  }
  return { format, wallets, skipped, duplicates, error: null };
}

export function parseWalletImport(text: string): WalletImportResult {
  const trimmed = text.trim();
  if (!trimmed) return { format: "empty", wallets: [], skipped: [], duplicates: 0, error: null };
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return { format: "json", wallets: [], skipped: [], duplicates: 0, error: `Looks like JSON but doesn't parse: ${detail}` };
    }
    return collect(
      "json",
      jsonEntries(data).map((entry, i) => ({ where: `Entry ${i + 1}`, text: preview(entry), result: entryToWallet(entry) })),
    );
  }
  const rows: Row[] = [];
  let sawContent = false;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) return;
    const first = !sawContent;
    sawContent = true;
    const parsed = parseWalletLine(line);
    if (!parsed && first && /\b(address|wallet|addr)\b/i.test(line)) return; // CSV header
    rows.push({ where: `Line ${i + 1}`, text: preview(line), result: parsed ?? "No Solana address" });
  });
  return collect("lines", rows);
}

export function walletsToJson(wallets: readonly TrackedWallet[]): string {
  return JSON.stringify(
    wallets.map(({ address, name, emoji, alerts }) => ({ address, name, emoji, alerts })),
    null,
    2,
  );
}

/** GMGN-style "address name" lines. */
export function walletsToLines(wallets: readonly TrackedWallet[]): string {
  return wallets.map((w) => `${w.address} ${w.name}`).join("\n");
}
