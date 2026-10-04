import { normalizeHandle } from "../../lib/filters";
import type { TrackedHandle } from "../../state/trackers";

/**
 * X handle-list import and export. Accepts our JSON export `[{ handle, tweets, profile, follows }]`,
 * a JSON array of handles (strings, or objects with `handle | username | screen_name`), or plain
 * text with handles separated by new lines, commas or spaces (`@name` and x.com links work).
 */

/** Same rule as useTrackers.addHandle. */
export const HANDLE_RE = /^[a-z0-9_]{1,15}$/;

export interface ImportedHandle {
  handle: string;
  tweets?: boolean;
  profile?: boolean;
  follows?: boolean;
}

export interface HandleImportResult {
  handles: ImportedHandle[];
  invalid: string[];
  duplicates: number;
  error: string | null;
}

const HANDLE_KEYS = ["handle", "username", "screen_name", "screenname", "user", "account"];

function flag(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function fromEntry(entry: unknown): ImportedHandle | string {
  if (typeof entry === "string") {
    const handle = normalizeHandle(entry);
    return HANDLE_RE.test(handle) ? { handle } : entry;
  }
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const obj = new Map(Object.entries(entry as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), v]));
    const raw = HANDLE_KEYS.map((k) => obj.get(k)).find((v): v is string => typeof v === "string");
    const handle = raw ? normalizeHandle(raw) : "";
    if (!HANDLE_RE.test(handle)) return raw ?? JSON.stringify(entry);
    return {
      handle,
      tweets: flag(obj.get("tweets")),
      profile: flag(obj.get("profile")),
      follows: flag(obj.get("follows")),
    };
  }
  return String(entry);
}

export function parseHandleImport(text: string): HandleImportResult {
  const trimmed = text.trim();
  if (!trimmed) return { handles: [], invalid: [], duplicates: 0, error: null };
  let entries: unknown[];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch (e) {
      return {
        handles: [],
        invalid: [],
        duplicates: 0,
        error: `Looks like JSON but doesn't parse: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const obj = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
    entries = Array.isArray(data) ? data : Array.isArray(obj?.handles) ? obj.handles : [data];
  } else {
    entries = trimmed.split(/[\s,;]+/).filter(Boolean);
  }
  const seen = new Set<string>();
  const handles: ImportedHandle[] = [];
  const invalid: string[] = [];
  let duplicates = 0;
  for (const entry of entries) {
    const r = fromEntry(entry);
    if (typeof r === "string") {
      invalid.push(r.length > 60 ? `${r.slice(0, 59)}…` : r);
      continue;
    }
    if (seen.has(r.handle)) {
      duplicates++;
      continue;
    }
    seen.add(r.handle);
    handles.push(r);
  }
  return { handles, invalid, duplicates, error: null };
}

export function handlesToJson(handles: readonly TrackedHandle[]): string {
  return JSON.stringify(
    handles.map(({ handle, tweets, profile, follows }) => ({ handle, tweets, profile, follows })),
    null,
    2,
  );
}
