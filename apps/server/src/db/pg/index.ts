/**
 * User-state store: one PgDriver (Bun.sql in production, PGlite in dev/tests) and the repositories
 * on top of it. `openUserDb` picks the driver from config and migrates.
 */
import { logger } from "../../log";
import { AuditRepo } from "./audit";
import { bunSqlDriver } from "./bun";
import type { PgDriver } from "./driver";
import { migrate } from "./migrations";
import { NotifyRepo } from "./notify";
import { pgliteDriver } from "./pglite";
import { PrefsRepo } from "./prefs";
import { TrackedWalletsRepo } from "./tracked";
import { UsersRepo } from "./users";

export * from "./driver";
export { LimitExceededError } from "./limits";
export { MIGRATIONS, migrate } from "./migrations";

const log = logger("userdb");

export class UserStore {
  readonly users: UsersRepo;
  readonly prefs: PrefsRepo;
  readonly tracked: TrackedWalletsRepo;
  readonly notify: NotifyRepo;
  readonly audit: AuditRepo;

  constructor(readonly db: PgDriver) {
    this.users = new UsersRepo(db);
    this.prefs = new PrefsRepo(db);
    this.tracked = new TrackedWalletsRepo(db);
    this.notify = new NotifyRepo(db);
    this.audit = new AuditRepo(db);
  }
}

export interface UserDbConfig {
  /** postgres://... (production). Null = PGlite. */
  databaseUrl: string | null;
  /** PGlite data directory, or "memory://". */
  pgliteDir: string;
}

/** Connects (Bun.sql or PGlite), applies migrations and returns the driver. */
export async function openUserDb(cfg: UserDbConfig): Promise<PgDriver> {
  const db = cfg.databaseUrl ? bunSqlDriver(cfg.databaseUrl) : await pgliteDriver(cfg.pgliteDir);
  try {
    const r = await migrate(db);
    log.info(
      `user state: ${db.kind === "postgres" ? "Postgres (DATABASE_URL)" : `PGlite at ${cfg.pgliteDir} (development only; set DATABASE_URL for production)`}, ` +
        `schema v${r.version}${r.applied.length ? ` (applied ${r.applied.join(", ")})` : ""}`,
    );
  } catch (e) {
    await db.close().catch(() => {});
    throw e;
  }
  return db;
}
