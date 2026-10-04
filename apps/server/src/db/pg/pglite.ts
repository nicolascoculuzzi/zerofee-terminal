/**
 * Development / test driver: PGlite (Postgres 18 compiled to WASM) in this process. No install, no
 * server. In memory by default, or persisted to a directory. Single connection: every query is
 * serialized, which is fine for a dev box and for tests, not for production traffic.
 * Loaded with a dynamic import so production (DATABASE_URL) never pays for the WASM bundle.
 */
import { mkdirSync } from "node:fs";
import type { PGliteInterface, Transaction } from "@electric-sql/pglite";
import type { PgDriver, Queryable, Row } from "./driver";

function wrap(q: PGliteInterface | Transaction): Queryable {
  return {
    async query<T extends Row = Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      return (await q.query<T>(text, [...params])).rows;
    },
    async exec(script: string): Promise<void> {
      await q.exec(script);
    },
  };
}

/** A PgDriver over an existing PGlite instance (closing the driver closes the instance). */
export function pgliteInstanceDriver(db: PGliteInterface): PgDriver {
  const root = wrap(db);
  return {
    kind: "pglite",
    query: root.query,
    exec: root.exec,
    transaction: <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> => db.transaction((tx) => fn(wrap(tx))),
    close: () => db.close(),
  };
}

/** `dataDir` null / "memory://" = in memory (lost on exit). */
export async function pgliteDriver(dataDir: string | null = null): Promise<PgDriver> {
  const { PGlite } = await import("@electric-sql/pglite");
  const persistent = dataDir !== null && dataDir !== "memory://";
  if (persistent) mkdirSync(dataDir, { recursive: true });
  return pgliteInstanceDriver(persistent ? await PGlite.create({ dataDir }) : await PGlite.create());
}
