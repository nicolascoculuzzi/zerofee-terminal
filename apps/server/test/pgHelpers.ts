/**
 * Postgres test fixtures, all offline and in-process:
 *  - PGlite (the dev/test driver);
 *  - Bun.sql (the production driver) talking the real Postgres wire protocol to a PGlite instance
 *    behind @electric-sql/pglite-socket on a random local port.
 * Running the same suites through both proves the repository SQL is portable across the two drivers.
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { bunSqlDriver } from "../src/db/pg/bun";
import type { PgDriver } from "../src/db/pg/driver";
import { migrate } from "../src/db/pg/migrations";
import { pgliteDriver } from "../src/db/pg/pglite";

export interface TestDb {
  name: string;
  db: PgDriver;
  close(): Promise<void>;
}

export async function pgliteDb(opts: { migrate?: boolean } = {}): Promise<TestDb> {
  const db = await pgliteDriver(null);
  if (opts.migrate !== false) await migrate(db);
  return { name: "pglite", db, close: () => db.close() };
}

/** Bun.sql -> TCP -> pglite-socket -> PGlite. */
export async function bunSqlDb(opts: { migrate?: boolean } = {}): Promise<TestDb> {
  const pg = await PGlite.create();
  const server = new PGLiteSocketServer({ db: pg, port: 0, host: "127.0.0.1" });
  await server.start();
  const db = bunSqlDriver(`postgres://postgres:postgres@${server.getServerConn()}/postgres`, { max: 1 });
  if (opts.migrate !== false) await migrate(db);
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
