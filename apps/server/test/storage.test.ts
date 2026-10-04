/** SQLite storage: migrations, batched writes, queries, retention, record codec and restore. */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { MarketState } from "../src/market/state";
import { newTokenRecord } from "../src/market/token";
import { deserializeRecord, serializeRecord } from "../src/storage/codec";
import { MIGRATIONS, openDb } from "../src/storage/db";
import { StorageReader } from "../src/storage/reader";
import { restoreMarket } from "../src/storage/restore";
import { StorageWriter } from "../src/storage/writer";
import { addr, FakeCurve, FakeResolver, synthTx } from "./helpers";

const CFG = { sniperSlots: 3, bundleMinBuyers: 4, proTraderWallets: [] };
const T0 = Math.floor(Date.now() / 1000) - 60;

function setup() {
  const db = openDb(":memory:");
  const writer = new StorageWriter(db, { flushMs: 1_000_000, retentionHours: 72 });
  const reader = new StorageReader(db);
  return { db, writer, reader };
}

describe("schema", () => {
  test("migrations run once and set user_version; WAL is requested", () => {
    const { db } = setup();
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(tables).toEqual(["candles", "metadata_cache", "pools", "token_history", "tokens", "trades", "wallet_funders"]);
  });

  test("v2 backfills creator / migrated of rows written before it", () => {
    const db = new Database(":memory:");
    db.exec(MIGRATIONS[0] as string);
    db.exec("PRAGMA user_version = 1");
    const state = (o: Record<string, unknown>) => JSON.stringify({ mint: "M", ...o });
    db.run("INSERT INTO tokens (mint, launchpad, updated_at, summary, state) VALUES ('A', 'pump', 1, '{}', ?), ('B', 'pump', 1, '{}', ?)", [
      state({ creatorAtCreate: "DEV", creator: "LIVE", migrated: true }),
      state({ creatorAtCreate: null, creator: "LIVE2", migrated: false }),
    ]);
    db.exec(MIGRATIONS[1] as string);
    expect(db.query("SELECT mint, creator, migrated FROM tokens ORDER BY mint").all()).toEqual([
      { mint: "A", creator: "DEV", migrated: 1 },
      { mint: "B", creator: "LIVE2", migrated: 0 },
    ]);
  });

  test("v3: trade SOL values become nullable; the 0s earlier versions wrote for unknown values become NULL", () => {
    const db = new Database(":memory:", { strict: true });
    db.exec(MIGRATIONS[0] as string);
    db.exec(MIGRATIONS[1] as string);
    const row = (id: string, amountSol: number, priceSol: number, mcSol: number) => [
      id,
      "M",
      `sig-${id}`,
      1,
      0,
      1,
      1,
      0,
      0,
      "T",
      "10",
      "20",
      amountSol,
      priceSol,
      mcSol,
    ];
    const insert = db.prepare(
      "INSERT INTO trades (id, mint, signature, slot, ev_index, block_time, received_at, venue, side, trader, quote_amount, token_amount, amount_sol, price_sol, mc_sol) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run(...row("known", 0.5, 3e-8, 30));
    insert.run(...row("exotic", 0, 0, 0));
    db.exec(MIGRATIONS[2] as string);
    const rows = new StorageReader(db).recentTrades("M", 10).sort((a, b) => a.id.localeCompare(b.id));
    expect(rows.map((t) => [t.id, t.amountSol, t.priceSol, t.mcSol])).toEqual([
      ["exotic", null, null, null],
      ["known", 0.5, 3e-8, 30],
    ]);
    // NULLs are accepted from now on, and the indexes are back
    insert.run(...row("new", 0, 0, 0));
    db.run("UPDATE trades SET amount_sol = NULL, price_sol = NULL, mc_sol = NULL WHERE id = 'new'");
    const idx = (
      db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'trades' ORDER BY name").all() as { name: string }[]
    ).map((r) => r.name);
    expect(idx).toEqual(["sqlite_autoindex_trades_1", "trades_mint_time", "trades_time"]);
  });
});

describe("writer + reader", () => {
  test("trades, candles and tokens are written in one batch; candle upserts coalesce", () => {
    const { writer, reader, db } = setup();
    const resolver = new FakeResolver();
    const m = new MarketState(CFG, { resolver, solUsd: () => 100, storage: writer });
    m.persistIntervalMs = 0;
    const mint = addr("store-mint");
    const c = new FakeCurve(mint, addr("store-dev"));
    m.applyTx(synthTx(10, [c.create(T0), c.buy(addr("store-dev"), 1_000_000_000n, T0)]));
    m.applyTx(synthTx(11, [c.buy(addr("b1"), 500_000_000n, T0)])); // same 1s bucket: one candle row
    expect(writer.pending).toBeGreaterThan(0);
    writer.flush();
    expect(writer.pending).toBe(0);
    expect((db.query("SELECT COUNT(*) AS n FROM trades").get() as { n: number }).n).toBe(2);
    const candles = reader.candles(mint, "1s", 0, Date.now() + 1, 100);
    expect(candles).toHaveLength(1);
    expect(candles[0]?.n).toBe(2);
    expect(reader.token(mint)?.summary.mint).toBe(mint);
    expect(reader.recentTrades(mint, 10).map((t) => t.slot)).toEqual([11, 10]);
  });

  test("dead-slot deletes and emptied candles are removed", () => {
    const { writer, reader, db } = setup();
    const m = new MarketState(CFG, { resolver: new FakeResolver(), solUsd: () => 100, storage: writer });
    const mint = addr("store-dead");
    const c = new FakeCurve(mint, addr("d"));
    m.applyTx(synthTx(20, [c.create(T0)]));
    m.applyTx(synthTx(21, [c.buy(addr("gone"), 1_000_000n, T0 + 30)]));
    writer.flush();
    m.dropSlot(21);
    writer.flush();
    expect((db.query("SELECT COUNT(*) AS n FROM trades").get() as { n: number }).n).toBe(0);
    expect(reader.candles(mint, "1s", 0, Date.now() + 1, 100)).toEqual([]);
  });

  test("retention prunes trades older than the window and short-timeframe candles", () => {
    const { writer, db } = setup();
    const old = Date.now() - 80 * 3_600_000;
    for (const [id, t] of [
      ["a:0", old],
      ["b:0", Date.now()],
    ] as const) {
      writer.trade(
        {
          id,
          signature: id,
          slot: 1,
          txIndex: null,
          mint: "M",
          venue: "pump",
          side: "buy",
          trader: "T",
          quoteAmount: "1",
          tokenAmount: "1",
          amountSol: 1,
          amountUsd: null,
          priceSol: 1,
          mcSol: 1,
          blockTime: t,
          receivedAt: t,
          tags: [],
        },
        0,
      );
    }
    writer.candle("M", "1s", { t: Date.now() - 3 * 86_400_000, o: 1, h: 1, l: 1, c: 1, v: 1, n: 1, solUsd: null });
    writer.candle("M", "1m", { t: Date.now() - 3 * 86_400_000, o: 1, h: 1, l: 1, c: 1, v: 1, n: 1, solUsd: null });
    writer.flush();
    writer.prune();
    expect((db.query("SELECT id FROM trades").all() as { id: string }[]).map((r) => r.id)).toEqual(["b:0"]);
    expect((db.query("SELECT tf FROM candles").all() as { tf: string }[]).map((r) => r.tf)).toEqual(["1m"]);
  });

  test("pools and the metadata cache round-trip", () => {
    const { writer, reader } = setup();
    writer.pool({ pool: "P", baseMint: "B", quoteMint: "Q", fromAccount: true, updatedAt: 1 } as never);
    const store = reader.metadataStore((k, j, ok) => writer.metadata(k, j, ok));
    store.put("ipfs:Qm", '{"name":"x"}', true);
    writer.flush();
    expect(reader.pools()[0]).toMatchObject({ pool: "P", baseMint: "B" });
    expect(store.get("ipfs:Qm")).toMatchObject({ json: '{"name":"x"}', ok: true });
  });
});

describe("record codec", () => {
  test("bigints survive; strings that look like bigints stay strings", () => {
    const rec = newTokenRecord("M", 1, {
      name: "100n",
      supply: 2_000_000_000_000_000n,
      curve: { vToken: 1n, vQuote: 2n, rToken: 3n, rQuote: 4n },
    });
    const { rec: back } = deserializeRecord(serializeRecord(rec), 2);
    expect(back.name).toBe("100n");
    expect(back.supply).toBe(2_000_000_000_000_000n);
    expect(back.curve).toEqual({ vToken: 1n, vQuote: 2n, rToken: 3n, rQuote: 4n });
    expect(back.windows.totals(0).txns).toBe(0);
  });
});

describe("restore", () => {
  test("restores token records and replays trades to rebuild holders and windows", () => {
    const { writer, reader, db } = setup();
    const m = new MarketState(CFG, { resolver: new FakeResolver(), solUsd: () => 100, storage: writer });
    m.persistIntervalMs = 0;
    const mint = addr("restore-mint");
    const dev = addr("restore-dev");
    const c = new FakeCurve(mint, dev);
    m.applyTx(synthTx(30, [c.create(T0), c.buy(dev, 1_000_000_000n, T0)]));
    m.applyTx(synthTx(31, [c.buy(addr("r1"), 500_000_000n, T0 + 1)]));
    m.applyTx(synthTx(32, [c.buy(addr("r2"), 500_000_000n, T0 + 1), c.buy(addr("r3"), 500_000_000n, T0 + 1)])); // multi-wallet tx
    writer.flush();
    const before = m.summary(mint);

    const m2 = new MarketState(CFG, { resolver: new FakeResolver(), solUsd: () => 100 });
    const r = restoreMarket(m2, new StorageReader(db), { sinceMs: 0, replaySinceMs: 0, now: Date.now() });
    expect(r).toMatchObject({ tokens: 1, replayed: 1, trades: 4 });
    const after = m2.summary(mint);
    expect(after).toMatchObject({
      name: before?.name,
      holders: before?.holders,
      buys: before?.buys,
      bondingProgressBps: before?.bondingProgressBps,
    });
    expect(after?.devPct).toBeCloseTo(before?.devPct ?? 0, 9);
    expect(m2.tokens.get(mint)?.holders?.bundlers.has(addr("r2"))).toBe(true);
    expect(m2.recentTrades(mint)).toHaveLength(4);
    void reader;
  });
});
