/**
 * The Postgres seam for user state (accounts, sessions, settings, alerts). Production talks to a real
 * Postgres through Bun's built-in SQL client (bun.ts); development and tests run PGlite, Postgres
 * compiled to WASM, in-process (pglite.ts). Repositories only see this interface, so both run the
 * same SQL.
 *
 * Portability rules (each checked against both drivers under Bun 1.3, see test/pg.test.ts):
 *  - Parameters: strings, numbers, booleans, null and Uint8Array only. Timestamps go in as ISO strings
 *    with an explicit `::timestamptz` cast (iso()). JSON goes in as JSON.stringify(...) with a
 *    `::text::jsonb` cast: when a parameter is typed json/jsonb, Bun JSON-encodes the bound value, so a
 *    bare `$1::jsonb` would store the string as a JSON string scalar while PGlite stores the document.
 *    Cast parameters whose type Postgres cannot infer (`$1::uuid` in a SELECT list). No array
 *    parameters: Bun binds a JS array as a comma-joined string; pass a JSON array through
 *    jsonb_to_recordset / jsonb_array_elements_text instead.
 *  - Results: read int8 with toInt (PGlite returns number or bigint, Bun a string), jsonb with toJson
 *    (object vs string), timestamptz with toMs (Date in both) and bytea with toBytes (Uint8Array vs Buffer).
 *  - Errors: sqlState() reads the SQLSTATE ("23505") from either driver (PGlite: `code`, Bun: `errno`).
 *  - Inside transaction(fn) use only the `tx` handle: both drivers serialize on it (PGlite has one
 *    connection; a pool of one would deadlock on the outer handle).
 */

export type Row = Record<string, unknown>;

export interface Queryable {
  /** Runs one statement with $1..$n parameters and returns its rows (use RETURNING to count changes). */
  query<T extends Row = Row>(text: string, params?: readonly unknown[]): Promise<T[]>;
  /** Runs a multi-statement script without parameters (migrations). */
  exec(script: string): Promise<void>;
}

export interface PgDriver extends Queryable {
  readonly kind: "postgres" | "pglite";
  /** BEGIN; fn(tx); COMMIT - or ROLLBACK when fn throws (the error propagates). */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** SQLSTATE of a driver error ("23505" = unique violation), or null. */
export function sqlState(e: unknown): string | null {
  if (!e || typeof e !== "object") return null;
  const { errno, code } = e as { errno?: unknown; code?: unknown };
  for (const v of [errno, code]) if (typeof v === "string" && /^[0-9A-Z]{5}$/.test(v)) return v;
  return null;
}

export const isUniqueViolation = (e: unknown): boolean => sqlState(e) === "23505";

/** Epoch ms -> ISO string for a `$n::timestamptz` parameter. */
export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** timestamptz (Date, or an ISO string from a text cast) -> epoch ms. */
export function toMs(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string") return Date.parse(v);
  if (typeof v === "number") return v;
  throw new TypeError(`expected a timestamp, got ${typeof v}`);
}

export function toMsOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : toMs(v);
}

/** int2/int4/int8 from either driver -> number (ids and counts stay far below 2^53). */
export function toInt(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint" || typeof v === "string") return Number(v);
  throw new TypeError(`expected an integer, got ${typeof v}`);
}

/** jsonb from either driver (PGlite parses it, Bun may hand back the text). */
export function toJson<T>(v: unknown): T {
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return v as T;
    }
  }
  return v as T;
}

/** bytea -> a plain Uint8Array. */
export function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
  throw new TypeError(`expected bytea, got ${typeof v}`);
}

/** Text that may be NULL. */
export function toStrOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}
