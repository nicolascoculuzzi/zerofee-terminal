/**
 * The nightly SQLite snapshot: slim and full modes against the server's real schema, schema and
 * user_version preserved, the trade cut-off, the CLI contract, and point-in-time consistency while
 * another process keeps writing.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, openDb } from "../../apps/server/src/storage/db";
import { snapshot, verify } from "./sqlite-snapshot";

const dir = mkdtempSync(join(tmpdir(), "zerofee-snapshot-"));
const dbPath = join(dir, "market.db");
const script = join(import.meta.dir, "sqlite-snapshot.ts");
const NOW = 1_791_000_000_000;
const HOUR = 3_600_000;

const count = (db: Database, sql: string, ...params: (string | number)[]) => (db.query(sql).get(...params) as { n: number }).n;

function schemaOf(path: string): unknown[] {
  const db = new Database(path, { readonly: true });
  try {
    return db.query("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  } finally {
    db.close();
  }
}

beforeAll(() => {
  const db = openDb(dbPath); // the server's own schema, migrations and WAL mode
  const tok = db.prepare(
    "INSERT INTO tokens (mint, name, symbol, launchpad, created_at, migrated_at, updated_at, summary, state) VALUES (?, ?, ?, 'pump', ?, NULL, ?, '{}', '{}')",
  );
  for (let i = 0; i < 5; i++) tok.run(`mint${i}`, `Name ${i}`, `S${i}`, NOW - i * HOUR, NOW - i * HOUR);
  const trade = db.prepare(
    "INSERT INTO trades (id, mint, signature, slot, tx_index, ev_index, block_time, received_at, venue, side, trader, quote_amount, token_amount, amount_sol, price_sol, mc_sol) VALUES (?, ?, ?, ?, NULL, 0, ?, ?, 0, 0, 'trader', '1', '2', 0.1, 0.000001, 30)",
  );
  // 10 trades an hour over the 72 h retention window
  for (let h = 0; h < 72; h++) {
    for (let k = 0; k < 10; k++)
      trade.run(`t${h}-${k}`, `mint${k % 5}`, `sig${h}-${k}`, 1_000 + h * 10 + k, NOW - h * HOUR - k * 1_000, NOW - h * HOUR);
  }
  const candle = db.prepare("INSERT INTO candles (mint, tf, t, o, h, l, c, v, n, sol_usd) VALUES (?, '1m', ?, 1, 2, 0.5, 1.5, 10, 3, 120)");
  for (let i = 0; i < 100; i++) candle.run(`mint${i % 5}`, NOW - i * 60_000);
  db.run("INSERT INTO pools (pool, base_mint, quote_mint, info, updated_at) VALUES ('pool1', 'mint0', 'quote', '{}', ?)", [NOW]);
  db.run(`INSERT INTO metadata_cache (key, json, ok, fetched_at) VALUES ('cid1', '{"name":"x"}', 1, ?)`, [NOW]);
  // funded-by results are kept forever (each one cost 100 Helius credits): a slim snapshot keeps them
  db.run("INSERT INTO wallet_funders (wallet, funder, fetched_at) VALUES ('wallet1', 'funder1', ?)", [NOW]);
  db.close();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("snapshot", () => {
  test("slim: same schema and version, every row except trades older than the cut-off", () => {
    const out = join(dir, "slim.db");
    const s = snapshot({ db: dbPath, out, mode: "slim", tradesHours: 6, now: NOW });
    expect(s.integrity).toBe("ok");
    expect(s.userVersion).toBe(MIGRATIONS.length);
    expect(s.tradesSince).toBe(NOW - 6 * HOUR);
    expect(schemaOf(out)).toEqual(schemaOf(dbPath));

    const src = new Database(dbPath, { readonly: true });
    const keptTrades = count(src, "SELECT count(*) AS n FROM trades WHERE block_time >= ?", NOW - 6 * HOUR);
    src.close();
    expect(keptTrades).toBe(61);
    expect(s.rows).toEqual({ candles: 100, metadata_cache: 1, pools: 1, tokens: 5, trades: keptTrades, wallet_funders: 1 });
    expect(s.newest).toEqual({ candles: NOW, tokens: NOW, trades: NOW });
    expect(s.bytes).toBeGreaterThan(0);
    expect(s.bytes).toBeLessThan(s.sourceBytes);
  });

  test("full: an exact copy, old trades included, readable as a single file", () => {
    const out = join(dir, "full.db");
    const s = snapshot({ db: dbPath, out, mode: "full", tradesHours: 6, now: NOW });
    expect(s.integrity).toBe("ok");
    expect(s.tradesSince).toBeNull();
    expect(s.rows.trades).toBe(720);
    expect(schemaOf(out)).toEqual(schemaOf(dbPath));
    const db = new Database(out, { readonly: true });
    expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("delete");
    db.close();
  });

  test("overwrites a previous snapshot and refuses a missing source", () => {
    const out = join(dir, "again.db");
    writeFileSync(out, "stale bytes");
    expect(snapshot({ db: dbPath, out, mode: "slim", tradesHours: 1, now: NOW }).integrity).toBe("ok");
    expect(() => snapshot({ db: join(dir, "missing.db"), out, mode: "slim", tradesHours: 6 })).toThrow(/no database/);
  });

  test("one consistent point in time while another process keeps writing", async () => {
    // The writer inserts a token and its candle in one transaction, as fast as it can. Any snapshot
    // that isn't a single read transaction would sooner or later catch one without the other.
    const writerSrc = `
      import { Database } from "bun:sqlite";
      const db = new Database(${JSON.stringify(dbPath)});
      db.exec("PRAGMA busy_timeout = 5000");
      const tok = db.prepare("INSERT INTO tokens (mint, name, symbol, launchpad, created_at, migrated_at, updated_at, summary, state) VALUES (?, '', '', 'pump', 0, NULL, 0, '{}', '{}')");
      const can = db.prepare("INSERT INTO candles (mint, tf, t, o, h, l, c, v, n, sol_usd) VALUES (?, '1m', 0, 1, 1, 1, 1, 1, 1, NULL)");
      const pair = db.transaction((i) => { tok.run("pair" + i); can.run("pair" + i); });
      const end = Date.now() + 4000;
      for (let i = 0; Date.now() < end; i++) pair(i);
    `;
    const writer = Bun.spawn(["bun", "-e", writerSrc], { stdout: "ignore", stderr: "inherit" });
    try {
      const probe = new Database(dbPath, { readonly: true });
      const t0 = Date.now();
      while (count(probe, "SELECT count(*) AS n FROM tokens WHERE mint LIKE 'pair%'") === 0 && Date.now() - t0 < 10_000)
        await Bun.sleep(20);
      probe.close();
      for (let i = 0; i < 5; i++) {
        const out = join(dir, `concurrent-${i}.db`);
        expect(snapshot({ db: dbPath, out, mode: "slim", tradesHours: 6, now: NOW }).integrity).toBe("ok");
        const snap = new Database(out, { readonly: true });
        const tokens = count(snap, "SELECT count(*) AS n FROM tokens WHERE mint LIKE 'pair%'");
        const candles = count(snap, "SELECT count(*) AS n FROM candles WHERE mint LIKE 'pair%'");
        snap.close();
        expect(tokens).toBe(candles);
        expect(tokens).toBeGreaterThan(0);
      }
    } finally {
      writer.kill();
      await writer.exited;
    }
  }, 30_000);
});

describe("cli", () => {
  const run = (...args: string[]) => Bun.spawnSync(["bun", script, ...args], { stdout: "pipe", stderr: "pipe" });

  test("snapshot prints one JSON line and exits 0", () => {
    const r = run("--db", dbPath, "--out", join(dir, "cli.db"), "--mode", "slim", "--trades-hours", "6");
    expect(r.exitCode).toBe(0);
    const summary = JSON.parse(r.stdout.toString());
    expect(summary).toMatchObject({ mode: "slim", integrity: "ok" });
  });

  test("--verify of a corrupt file and bad arguments exit 1 with a JSON error", () => {
    const junk = join(dir, "junk.db");
    writeFileSync(junk, "this is not a database file, just junk bytes ".repeat(200));
    const bad = run("--verify", junk);
    expect(bad.exitCode).toBe(1);
    expect(JSON.parse(bad.stderr.toString()).error).toBeString();
    expect(run("--db", dbPath).exitCode).toBe(1);
    expect(run("--out", join(dir, "x.db"), "--mode", "weird").exitCode).toBe(1);
    expect(run("--bogus", "1").exitCode).toBe(1);
  });

  test("verify reports counts and freshness of an existing snapshot", () => {
    const v = verify(join(dir, "slim.db"));
    expect(v.integrity).toBe("ok");
    expect(v.rows.tokens).toBe(5);
  });
});
