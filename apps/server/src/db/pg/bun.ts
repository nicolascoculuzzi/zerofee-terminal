/**
 * Production driver: Bun's built-in Postgres client (`new SQL(url)`), a pooled connection with
 * automatic prepared statements. `unsafe(text, params)` is the parameterized-query entry point (the
 * name refers to tagged-template escaping, which we do not use; values are still sent as bound
 * parameters, never interpolated).
 */
import { SQL } from "bun";
import type { PgDriver, Queryable, Row } from "./driver";

export interface BunSqlOptions {
  /** Pool size (default 10). */
  max?: number;
  idleTimeoutSec?: number;
  connectTimeoutSec?: number;
}

function wrap(q: SQL): Queryable {
  return {
    async query<T extends Row = Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      const rows = await q.unsafe<T[]>(text, [...params]);
      return Array.from(rows);
    },
    async exec(script: string): Promise<void> {
      // No parameters: Bun uses the simple query protocol, so a script may hold several statements.
      await q.unsafe(script);
    },
  };
}

export function bunSqlDriver(url: string, o: BunSqlOptions = {}): PgDriver {
  const sql = new SQL({
    url,
    max: o.max ?? 10,
    idleTimeout: o.idleTimeoutSec ?? 30,
    connectionTimeout: o.connectTimeoutSec ?? 10,
  });
  const root = wrap(sql);
  return {
    kind: "postgres",
    query: root.query,
    exec: root.exec,
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return (await sql.begin((tx) => fn(wrap(tx)))) as T;
    },
    close: () => sql.close({ timeout: 5 }),
  };
}
