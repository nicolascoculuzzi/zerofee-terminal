/**
 * Postgres test fixtures, all offline and in-process:
 *  - PGlite (the dev/test driver);
 *  - Bun.sql (the production driver) talking the real Postgres wire protocol to a PGlite instance
 *    behind @electric-sql/pglite-socket on a random local port.
 * Running the same suites through both proves the repository SQL is portable across the two drivers.
 *
 * Starting PGlite compiles its WASM and runs initdb (about a second, much more on a busy machine), so
 * one migrated template is built per test process and every suite gets an independent clone of it.
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { bunSqlDriver } from "../src/db/pg/bun";
import type { PgDriver } from "../src/db/pg/driver";
import { migrate } from "../src/db/pg/migrations";
import { pgliteInstanceDriver } from "../src/db/pg/pglite";

export interface TestDb {
  name: string;
  db: PgDriver;
  close(): Promise<void>;
}

let template: Promise<PGlite> | null = null;

/** A migrated PGlite kept for the life of the test process; suites clone it. */
function migratedTemplate(): Promise<PGlite> {
  template ??= (async () => {
    const pg = await PGlite.create();
    await migrate(pgliteInstanceDriver(pg));
    return pg;
  })();
  return template;
}

export async function pgliteDb(opts: { migrate?: boolean } = {}): Promise<TestDb> {
  const pg = opts.migrate === false ? await PGlite.create() : await (await migratedTemplate()).clone();
  const db = pgliteInstanceDriver(pg);
  return { name: "pglite", db, close: () => db.close() };
}

/** Bun.sql -> TCP -> pglite-socket -> PGlite. */
export async function bunSqlDb(opts: { migrate?: boolean } = {}): Promise<TestDb> {
  const pg = await (await migratedTemplate()).clone();
  if (opts.migrate === false) await pg.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  // clone() is typed as the interface but returns a PGlite instance, which is what the server needs.
  const server = new PGLiteSocketServer({ db: pg as PGlite, port: 0, host: "127.0.0.1" });
  await server.start();
  const db = bunSqlDriver(`postgres://postgres:postgres@${server.getServerConn()}/postgres`, { max: 1 });
  return {
    name: "bun.sql",
    db,
    async close() {
      await db.close();
      await server.stop();
      await pg.close();
    },
  };
}

export const DRIVERS: { name: string; open: (o?: { migrate?: boolean }) => Promise<TestDb> }[] = [
  { name: "pglite", open: pgliteDb },
  { name: "bun.sql over the wire protocol", open: bunSqlDb },
];
