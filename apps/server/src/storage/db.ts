/**
 * SQLite (bun:sqlite) for shared market data: tokens, trades (rolling retention), candles, the PumpSwap
 * pool registry and the metadata cache. One writer (the batched StorageWriter); WAL lets the REST
 * readers run alongside it. Schema migrations are plain SQL, applied in order and tracked with
 * PRAGMA user_version.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const MIGRATIONS: readonly string[] = [
  // v1
  `
  CREATE TABLE tokens (
    mint TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    symbol TEXT NOT NULL DEFAULT '',
    launchpad TEXT NOT NULL,
    created_at INTEGER,
    migrated_at INTEGER,
    updated_at INTEGER NOT NULL,
    summary TEXT NOT NULL,
    state TEXT NOT NULL
  );
  CREATE INDEX tokens_created_at ON tokens(created_at);
  CREATE INDEX tokens_migrated_at ON tokens(migrated_at);
  CREATE INDEX tokens_updated_at ON tokens(updated_at);

  CREATE TABLE trades (
    id TEXT PRIMARY KEY,
    mint TEXT NOT NULL,
    signature TEXT NOT NULL,
    slot INTEGER NOT NULL,
    tx_index INTEGER,
    ev_index INTEGER NOT NULL,
    block_time INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    venue INTEGER NOT NULL,
    side INTEGER NOT NULL,
    trader TEXT NOT NULL,
    quote_amount TEXT NOT NULL,
    token_amount TEXT NOT NULL,
    amount_sol REAL NOT NULL,
    price_sol REAL NOT NULL,
    mc_sol REAL NOT NULL
  );
  CREATE INDEX trades_mint_time ON trades(mint, block_time);
  CREATE INDEX trades_time ON trades(block_time);

  CREATE TABLE candles (
    mint TEXT NOT NULL,
    tf TEXT NOT NULL,
    t INTEGER NOT NULL,
    o REAL NOT NULL,
    h REAL NOT NULL,
    l REAL NOT NULL,
    c REAL NOT NULL,
    v REAL NOT NULL,
    n INTEGER NOT NULL,
    sol_usd REAL,
    PRIMARY KEY (mint, tf, t)
  ) WITHOUT ROWID;
  CREATE INDEX candles_tf_t ON candles(tf, t);

  CREATE TABLE pools (
    pool TEXT PRIMARY KEY,
    base_mint TEXT NOT NULL,
    quote_mint TEXT NOT NULL,
    info TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX pools_base_mint ON pools(base_mint);

  CREATE TABLE metadata_cache (
    key TEXT PRIMARY KEY,
    json TEXT,
    ok INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  `,
];

export function migrate(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as { user_version: number };
  let v = row.user_version;
  for (; v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v] as string;
    const next = v + 1;
    db.transaction(() => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${next}`);
    })();
  }
  return v;
}

export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA temp_store = MEMORY");
  db.exec("PRAGMA cache_size = -65536");
  db.exec("PRAGMA mmap_size = 268435456");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}
