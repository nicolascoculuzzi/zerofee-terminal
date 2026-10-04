/**
 * TokenRecord <-> JSON for the tokens.state column. Bigints are tagged objects ({"$big":"123"}) so no
 * user-controlled string (token names...) can be mistaken for one. Rolling windows, holder books and the
 * trade ring are rebuilt on restore by replaying stored trades (see restore.ts).
 */
import type { TokenRecord } from "../market/token";
import { newTokenRecord } from "../market/token";

const SKIP = new Set(["windows", "holders", "trades", "proTraders", "lastPersistAt", "bootstrapRequested"]);

export function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? { $big: v.toString() } : v;
}

export function bigintReviver(_k: string, v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (typeof o.$big === "string" && Object.keys(o).length === 1) return BigInt(o.$big);
  }
  return v;
}

/** Pro traders persisted per token (the trades table does not keep tags, so replay cannot rebuild them). */
const MAX_PERSISTED_PROS = 5_000;

export function serializeRecord(rec: TokenRecord): string {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) if (!SKIP.has(k)) out[k] = v;
  out.hasHolders = rec.holders !== null;
  out.hasPros = rec.proTraders !== null;
  if (rec.proTraders?.size) out.proTraderList = [...rec.proTraders].slice(0, MAX_PERSISTED_PROS);
  return JSON.stringify(out, bigintReplacer);
}

export function deserializeRecord(json: string, now: number): { rec: TokenRecord; hadHolders: boolean } {
  const raw = JSON.parse(json, bigintReviver) as Record<string, unknown>;
  const { hasHolders, hasPros, proTraderList, ...fields } = raw;
  const rec = newTokenRecord(String(fields.mint), now, fields as Partial<TokenRecord>);
  rec.proTraders = hasPros ? new Set(Array.isArray(proTraderList) ? proTraderList.filter((x) => typeof x === "string") : []) : null;
  return { rec, hadHolders: hasHolders === true };
}
