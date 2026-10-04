#!/usr/bin/env bun
/**
 * Consistent online snapshot of the market-data SQLite database (WAL mode, live writer) for the
 * nightly backup, plus a verifier for restore drills. It runs inside the server container, where
 * bun:sqlite and the database live:
 *
 *   bun deploy/backup/sqlite-snapshot.ts --db /data/market.db --out /backups/market.db [--mode slim|full] [--trades-hours 6]
 *   bun deploy/backup/sqlite-snapshot.ts --verify /restore/market.db
 *
 * full   VACUUM INTO: an exact, compacted copy.
 * slim   (default) The same schema and every row except trades older than --trades-hours. The 72 h
 *        trade tape is most of the file and the chain re-streams it anyway. A restore needs tokens,
 *        candles, the pool registry, the metadata cache and the wallet funding cache (paid Helius
 *        lookups), plus the recent trades the server replays for holder metrics (REPLAY_HOURS, default 6),
 *        and every trade of a coin whose history was backfilled from chain (token_history.retain_until:
 *        its "complete" coverage would otherwise be wrong after a restore).
 * Both modes read inside one transaction, so the copy is a single point-in-time snapshot while the
 * server keeps writing (WAL readers never block the writer).
 *
 * Prints one JSON line (sizes, row counts, integrity) and exits non-zero on any failure. It depends
 * only on bun:sqlite, so it also runs from a bare oven/bun container.
 */
import { Database } from "bun:sqlite";
import { existsSync, rmSync, statSync } from "node:fs";

export type SnapshotMode = "slim" | "full";

export interface SnapshotOptions {
  db: string;
  out: string;
  mode: SnapshotMode;
  /** slim: keep trades newer than this many hours. */
  tradesHours: number;
  now?: number;
}

export interface VerifySummary {
  path: string;
  bytes: number;
  userVersion: number;
  integrity: string;
  rows: Record<string, number>;
  /** Newest timestamps (ms) per table, where the column exists: how fresh the copy is. */
  newest: Record<string, number | null>;
}

export interface SnapshotSummary extends VerifySummary {
  mode: SnapshotMode;
  source: string;
  sourceBytes: number;
  /** slim: oldest trade block_time kept (ms). */
  tradesSince: number | null;
  ms: number;
}

interface SchemaRow {
  type: string;
  name: string;
  sql: string;
}

const NEWEST: Record<string, string> = { tokens: "updated_at", trades: "block_time", candles: "t" };

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

function dbBytes(path: string): number {
  let n = 0;
  for (const p of [path, `${path}-wal`]) if (existsSync(p)) n += statSync(p).size;
  return n;
}

/** Insertable columns of a table (hidden and generated columns excluded). */
function columns(db: Database, schema: string, table: string): string[] {
  const rows = db.query(`PRAGMA ${schema}.table_xinfo(${quote(table)})`).all() as { name: string; hidden: number }[];
  return rows.filter((r) => r.hidden === 0).map((r) => quote(r.name));
}

export function verify(path: string): VerifySummary {
  const db = new Database(path, { readonly: true });
  try {
    const integrity = (db.query("PRAGMA integrity_check").all() as { integrity_check: string }[]).map((r) => r.integrity_check).join("; ");
    const userVersion = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    const rows: Record<string, number> = {};
    const newest: Record<string, number | null> = {};
    const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {
      name: string;
    }[];
    for (const { name } of tables) {
      rows[name] = (db.query(`SELECT count(*) AS n FROM ${quote(name)}`).get() as { n: number }).n;
      const col = NEWEST[name];
      if (col && columns(db, "main", name).includes(quote(col))) {
        newest[name] = (db.query(`SELECT max(${quote(col)}) AS v FROM ${quote(name)}`).get() as { v: number | null }).v;
      }
    }
    return { path, bytes: statSync(path).size, userVersion, integrity, rows, newest };
  } finally {
    db.close();
  }
}

export function snapshot(o: SnapshotOptions): SnapshotSummary {
  const t0 = performance.now();
  if (!existsSync(o.db)) throw new Error(`no database at ${o.db}`);
  if (o.mode !== "slim" && o.mode !== "full") throw new Error("mode must be slim or full");
  for (const p of [o.out, `${o.out}-journal`, `${o.out}-wal`, `${o.out}-shm`]) rmSync(p, { force: true });

  // A normal handle (ATTACHed databases inherit read-only), but nothing below writes to main.
  const src = new Database(o.db);
  let tradesSince: number | null = null;
  try {
    src.exec("PRAGMA busy_timeout = 10000");
    if (o.mode === "full") {
      src.run("VACUUM INTO ?", [o.out]);
    } else {
      const schema = src
        .query("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")
        .all() as SchemaRow[];
      if (schema.some((s) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(s.sql)))
        throw new Error("virtual tables are not supported in slim mode; use --mode full");
      const userVersion = (src.query("PRAGMA user_version").get() as { user_version: number }).user_version;
      const tables = schema.filter((s) => s.type === "table");

      // 1. Empty tables (indexes come after the bulk insert: faster, same result).
      const out = new Database(o.out, { create: true });
      try {
        for (const s of tables) out.exec(s.sql);
      } finally {
        out.close();
      }

      // 2. Rows, all read in one transaction: one consistent point in time.
      tradesSince = (o.now ?? Date.now()) - o.tradesHours * 3_600_000;
      src.run("ATTACH DATABASE ? AS snap", [o.out]);
      try {
        src.exec("BEGIN");
        try {
          for (const s of tables) {
            const t = quote(s.name);
            const cols = columns(src, "main", s.name).join(", ");
            if (s.name === "trades") {
              const retained = tables.some((x) => x.name === "token_history")
                ? " OR mint IN (SELECT mint FROM main.token_history WHERE retain_until >= ?)"
                : "";
              src.run(
                `INSERT INTO snap.${t} (${cols}) SELECT ${cols} FROM main.${t} WHERE block_time >= ?${retained}`,
                retained ? [tradesSince, o.now ?? Date.now()] : [tradesSince],
              );
            } else {
              src.run(`INSERT INTO snap.${t} (${cols}) SELECT ${cols} FROM main.${t}`);
            }
          }
          const hasSequence = src.query("SELECT 1 FROM main.sqlite_master WHERE name = 'sqlite_sequence'").get();
          if (hasSequence) src.run("INSERT INTO snap.sqlite_sequence SELECT * FROM main.sqlite_sequence");
          src.exec("COMMIT");
        } catch (e) {
          if (!src.inTransaction) throw e;
          src.exec("ROLLBACK");
          throw e;
        }
      } finally {
        src.exec("DETACH DATABASE snap");
      }

      // 3. Indexes, views and triggers, then the schema version the server's migrations check.
      const fin = new Database(o.out);
      try {
        for (const s of schema) if (s.type !== "table") fin.exec(s.sql);
        fin.exec(`PRAGMA user_version = ${Number(userVersion)}`);
      } finally {
        fin.close();
      }
    }
    // A self-contained single file (no -wal/-shm needed to read it), whatever the source's mode.
    const norm = new Database(o.out);
    try {
      norm.exec("PRAGMA journal_mode = DELETE");
    } finally {
      norm.close();
    }
  } catch (e) {
    for (const p of [o.out, `${o.out}-journal`, `${o.out}-wal`, `${o.out}-shm`]) rmSync(p, { force: true });
    throw e;
  } finally {
    src.close();
  }

  const v = verify(o.out);
  return { mode: o.mode, source: o.db, sourceBytes: dbBytes(o.db), tradesSince, ms: Math.round(performance.now() - t0), ...v };
}

function parseArgs(argv: string[]): { verify: string | null; opts: SnapshotOptions } {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i] as string;
    if (!k.startsWith("--")) throw new Error(`unexpected argument ${k}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${k} needs a value`);
    args.set(k.slice(2), v);
    i++;
  }
  for (const k of args.keys()) if (!["db", "out", "mode", "trades-hours", "verify"].includes(k)) throw new Error(`unknown option --${k}`);
  const tradesHours = Number(args.get("trades-hours") ?? 6);
  if (!Number.isFinite(tradesHours) || tradesHours < 0 || tradesHours > 24 * 365)
    throw new Error("--trades-hours must be a number of hours");
  const verifyPath = args.get("verify") ?? null;
  const out = args.get("out");
  if (!verifyPath && !out) throw new Error("--out is required (or --verify <path>)");
  return {
    verify: verifyPath,
    opts: { db: args.get("db") ?? "/data/market.db", out: out ?? "", mode: (args.get("mode") ?? "slim") as SnapshotMode, tradesHours },
  };
}

if (import.meta.main) {
  try {
    const { verify: verifyPath, opts } = parseArgs(process.argv.slice(2));
    const summary = verifyPath ? verify(verifyPath) : snapshot(opts);
    console.log(JSON.stringify(summary));
    if (summary.integrity !== "ok") process.exit(1);
  } catch (e) {
    console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    process.exit(1);
  }
}
