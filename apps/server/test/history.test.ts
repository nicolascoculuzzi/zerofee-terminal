/**
 * Trade-history backfill (src/history): a coin first seen mid-life gets its whole history from (fake) chain reads,
 * idempotently with live capture; candles / holders / windows match a server that saw every trade live; coverage
 * moves unknown -> partial -> backfilling -> complete; caps, gaps, priorities and the real decoder.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Address } from "@solana/kit";
import { bondingCurvePda } from "@zerofee/core";
import { TIMEFRAMES, type TokenHistory } from "@zerofee/protocol";
import type { HistoryConfig } from "../src/config";
import { HistoryService } from "../src/history/service";
import type { IngestTx } from "../src/ingest/types";
import { setLogLevel } from "../src/log";
import { MarketState } from "../src/market/state";
import { openDb } from "../src/storage/db";
import { StorageReader } from "../src/storage/reader";
import { StorageWriter } from "../src/storage/writer";
import { RpcError } from "../src/util/rpc";
import { addr, FakeCurve, FakeResolver, fixture, synthTx, waitFor } from "./helpers";
import { type ChainTx, chainTx, decodeFake, FakeHistoryReader, HISTORY_CFG } from "./historyHelpers";

setLogLevel("error");
const CFG = { sniperSlots: 3, bundleMinBuyers: 4, proTraderWallets: [] };

interface World {
  market: MarketState;
  writer: StorageWriter;
  reader: StorageReader;
  states: TokenHistory["state"][];
}

function world(): World {
  const db = openDb(":memory:");
  const writer = new StorageWriter(db, { flushMs: 1_000_000, retentionHours: 72 });
  const reader = new StorageReader(db);
  const market = new MarketState(CFG, { resolver: new FakeResolver(), solUsd: () => 100, storage: writer });
  market.persistIntervalMs = 0;
  const states: TokenHistory["state"][] = [];
  const set = market.setHistory.bind(market);
  market.setHistory = (mint, h) => {
    if (states[states.length - 1] !== h.state) states.push(h.state);
    set(mint, h);
  };
  return { market, writer, reader, states };
}

let services: HistoryService[] = [];
afterEach(async () => {
  for (const s of services) await s.stop();
  services = [];
});

function service(w: World, reader: FakeHistoryReader, cfg: Partial<HistoryConfig> = {}, watched: string[] = []): HistoryService {
  const s = new HistoryService({
    cfg: { ...HISTORY_CFG, ...cfg },
    market: w.market,
    reader,
    store: w.reader,
    writer: w.writer,
    watched: () => watched,
    listed: () => [],
    decode: decodeFake,
  });
  services.push(s);
  return s;
}

/** A coin's full on-chain life: create, then `n` trades by several wallets, 20 s apart (inside the last 24 h). */
function coinLife(tag: string, n: number, slot0 = 5_000) {
  const mint = addr(`${tag}-mint`);
  const dev = addr(`${tag}-dev`);
  const curve = new FakeCurve(mint, dev);
  const t0 = Math.floor(Date.now() / 1000) - n * 20 - 120;
  const txs: IngestTx[] = [
    synthTx(slot0, [curve.create(t0), curve.buy(dev, 1_000_000_000n, t0)], { signature: `${tag}-create`.padEnd(88, "c") }),
  ];
  const wallets = [0, 1, 2, 3, 4, 5].map((i) => addr(`${tag}-w${i}`));
  const held = new Map<string, bigint>();
  for (let i = 1; i <= n; i++) {
    const w = wallets[i % wallets.length] as string;
    const ts = t0 + i * 20;
    const h = held.get(w) ?? 0n;
    const ev = i % 4 === 0 && h > 0n ? curve.sell(w, h / 2n, ts) : curve.buy(w, 50_000_000n * BigInt(1 + (i % 3)), ts);
    if (ev.isBuy) held.set(w, h + ev.tokenAmount);
    else held.set(w, h - ev.tokenAmount);
    txs.push(synthTx(slot0 + i * 3, [ev], { signature: `${tag}-t${i}`.padEnd(88, "x") }));
  }
  return { mint, dev, curve, txs };
}

function chainOf(account: string, txs: IngestTx[]): Map<string, ChainTx[]> {
  return new Map([[account, [...txs].reverse().map((t) => chainTx(t))]]);
}

const stripSolUsd = (c: { t: number; o: number; h: number; l: number; c: number; v: number; n: number }) => ({
  t: c.t,
  o: c.o,
  h: c.h,
  l: c.l,
  c: c.c,
  v: Number(c.v.toFixed(9)),
  n: c.n,
});

describe("backfill of a coin first seen mid-life", () => {
  test("every trade from the create on; live overlap not duplicated; same candles / holders / windows as a full live view", async () => {
    const life = coinLife("mid", 40);
    const w = world();
    // the server only saw the last two trades live
    for (const tx of life.txs.slice(-2)) w.market.applyTx(tx);
    const rec = w.market.tokens.get(life.mint);
    expect(rec?.createdAt).toBeNull();
    expect(rec?.holders).toBeNull();
    const curveAddr = life.curve.bondingCurve;
    if (rec) rec.bondingCurve = curveAddr;
    const reader = new FakeHistoryReader(chainOf(curveAddr, life.txs));
    const svc = service(w, reader);
    expect(svc.state(life.mint)?.state).toBe("partial");
    svc.start();
    svc.request(life.mint, 0);
    await waitFor(() => svc.state(life.mint)?.state === "complete", 5_000);
    w.writer.flush();

    // 1 create-tx buy + 40 trades, the two live ones not stored twice
    const rows = w.reader.tradesOfMint(life.mint);
    expect(rows).toHaveLength(41);
    expect(new Set(rows.map((r) => `${r.signature}|${r.side}|${r.token_amount}`)).size).toBe(41);
    expect(new Set(rows.map((r) => r.id)).size).toBe(41);
    // the live trades were already held: never fetched
    for (const tx of life.txs.slice(-2)) expect(reader.fetched).not.toContain(tx.signature);
    // (the initial "partial" is assessed in place, before any change goes out)
    expect(w.states).toEqual(["backfilling", "complete"]);
    const h = svc.state(life.mint);
    expect(h).toMatchObject({ state: "complete", fromCreation: true, capped: false, trades: 41, progress: null });

    // reference: a server that saw the whole life live
    const ref = world();
    for (const tx of life.txs) ref.market.applyTx(tx);
    const a = w.market.summary(life.mint);
    const b = ref.market.summary(life.mint);
    expect(a?.createdAt).toBe(b?.createdAt ?? -1);
    expect(a?.holders).toBe(b?.holders ?? -1);
    expect(a?.top10Pct).toBeCloseTo(b?.top10Pct ?? -1, 9);
    expect(a?.devPct).toBeCloseTo(b?.devPct ?? -1, 9);
    expect(a?.snipersPct).toBeCloseTo(b?.snipersPct ?? -1, 9);
    expect({ txns: a?.txns, buys: a?.buys, sells: a?.sells }).toEqual({ txns: b?.txns, buys: b?.buys, sells: b?.sells });
    expect(a?.volume24h).toBeCloseTo(b?.volume24h ?? -1, 9);
    expect(a?.athMcSol).toBeCloseTo(b?.athMcSol ?? -1, 6);
    expect(a?.mcSol).toBeCloseTo(b?.mcSol ?? -1, 9);
    for (const tf of TIMEFRAMES) {
      const stored = new Map(w.reader.candles(life.mint, tf, 0, Date.now() + 60_000, 10_000).map((c) => [c.t, c]));
      for (const c of w.market.candles.range(life.mint, tf)) stored.set(c.t, c);
      const got = [...stored.values()].sort((x, y) => x.t - y.t).map(stripSolUsd);
      expect(got).toEqual(ref.market.candles.range(life.mint, tf).map(stripSolUsd));
    }
    // the trade ring is the newest trades in chain order
    expect(w.market.recentTrades(life.mint, 5).map((t) => t.signature)).toEqual(
      ref.market.recentTrades(life.mint, 5).map((t) => t.signature),
    );
  });

  test("idempotent: a second walk adds nothing; a late live copy of a backfilled tx is a duplicate", async () => {
    const life = coinLife("idem", 12);
    const w = world();
    w.market.applyTx(life.txs[life.txs.length - 1] as IngestTx);
    const rec = w.market.tokens.get(life.mint);
    const curveAddr = life.curve.bondingCurve;
    if (rec) rec.bondingCurve = curveAddr;
    const reader = new FakeHistoryReader(chainOf(curveAddr, life.txs));
    const svc = service(w, reader);
    svc.start();
    svc.request(life.mint, 0);
    await waitFor(() => svc.state(life.mint)?.state === "complete", 5_000);
    w.writer.flush();
    const n = w.reader.tradesOfMint(life.mint).length;
    expect(n).toBe(13);
    const txnsBefore = w.market.summary(life.mint)?.txns;
    // a live notification of an old trade arrives late (same signature and slot)
    w.market.applyTx(life.txs[3] as IngestTx);
    expect(w.market.stats.duplicates).toBeGreaterThan(0);
    // a gap-fill walks again (with the `until` cursor) and adds nothing
    svc.onGap({ source: "test", reason: "reconnect", fromSlot: 0, toSlot: 1 });
    await waitFor(() => w.states.filter((s) => s === "complete").length >= 2, 5_000);
    w.writer.flush();
    expect(w.reader.tradesOfMint(life.mint)).toHaveLength(n);
    expect(w.market.summary(life.mint)?.txns).toBe(txnsBefore);
    const last = reader.calls[reader.calls.length - 1];
    expect(last?.until).toBe(life.txs[life.txs.length - 1]?.signature);
    expect(w.states).toEqual(["backfilling", "complete", "partial", "backfilling", "complete"]);
  });

  test("a transaction live saw truncated (fewer events) gets its missing trades, not duplicates of the others", async () => {
    const mint = addr("trunc-mint");
    const dev = addr("trunc-dev");
    const curve = new FakeCurve(mint, dev);
    const t0 = Math.floor(Date.now() / 1000) - 600;
    const create = synthTx(100, [curve.create(t0)], { signature: "trunc-create".padEnd(88, "c") });
    const a = curve.buy(addr("ta"), 100_000_000n, t0 + 10);
    const b = curve.buy(addr("tb"), 200_000_000n, t0 + 10);
    const full = synthTx(101, [a, b], { signature: "trunc-bundle".padEnd(88, "b") });
    const w = world();
    w.market.applyTx(create);
    w.market.applyTx({ ...full, events: [a] }); // the logs were cut after the first event
    w.writer.flush();
    expect(w.reader.tradeSignatures(mint).has(full.signature)).toBe(true);
    // collect + merge directly: the content index holds the live trade once
    const known = { counts: new Map<string, number>(), sigs: new Set<string>() };
    for (const r of w.reader.tradeKeys(mint)) {
      const k = `${r.signature}|${r.side === 0 ? "buy" : "sell"}|${r.token_amount}`;
      known.counts.set(k, (known.counts.get(k) ?? 0) + 1);
      known.sigs.add(r.signature);
    }
    const { entries } = w.market.collectHistory({ mint, curve: addr("trunc-curve"), pumpPool: null, launchLabPool: null, cpmmPool: null }, [
      { tx: full, seq: -1 },
    ]);
    const { added } = w.market.mergeHistory(mint, entries, known);
    expect(added.map((t) => t.trader)).toEqual([addr("tb")]);
    w.writer.flush();
    expect(w.reader.tradesOfMint(mint)).toHaveLength(2);
  });
});

describe("caps, priorities, discovery", () => {
  test("the per-coin cap stops the walk: partial, capped, newest trades kept", async () => {
    const life = coinLife("cap", 30);
    const w = world();
    w.market.applyTx(life.txs[life.txs.length - 1] as IngestTx);
    const rec = w.market.tokens.get(life.mint);
    const curveAddr = life.curve.bondingCurve;
    if (rec) rec.bondingCurve = curveAddr;
    const svc = service(w, new FakeHistoryReader(chainOf(curveAddr, life.txs)), { maxTxPerCoin: 10 });
    svc.start();
    svc.request(life.mint, 0);
    await waitFor(() => w.states.includes("backfilling") && svc.state(life.mint)?.state === "partial", 5_000);
    expect(svc.state(life.mint)).toMatchObject({ state: "partial", capped: true, fromCreation: false });
    w.writer.flush();
    const rows = w.reader.tradesOfMint(life.mint);
    expect(rows).toHaveLength(11);
    expect(Math.min(...rows.map((r) => r.slot))).toBeGreaterThan(5_000 + 19 * 3);
    expect(w.market.tokens.get(life.mint)?.holders).toBeNull(); // not from the creation: no holder book
  });

  test("a viewed coin pre-empts a background walk already running", async () => {
    const bg = coinLife("bg", 40, 10_000);
    const vw = coinLife("vw", 6, 20_000);
    const w = world();
    const chain = new Map<string, ChainTx[]>();
    for (const [life, acct] of [
      [bg, bg.curve.bondingCurve],
      [vw, vw.curve.bondingCurve],
    ] as const) {
      w.market.applyTx(life.txs[life.txs.length - 1] as IngestTx);
      const rec = w.market.tokens.get(life.mint);
      if (rec) rec.bondingCurve = acct;
      for (const [k, v] of chainOf(acct, life.txs)) chain.set(k, v);
    }
    const done: string[] = [];
    const set = w.market.setHistory.bind(w.market);
    w.market.setHistory = (m, h) => {
      if (h.state === "complete") done.push(m);
      set(m, h);
    };
    const svc = service(w, new FakeHistoryReader(chain, 1, 2), { mergeEvery: 3 });
    svc.start();
    svc.request(bg.mint, 2, "midlife");
    await waitFor(() => w.market.tokens.get(bg.mint)?.history?.state === "backfilling", 5_000);
    svc.request(vw.mint, 0);
    await waitFor(() => done.length === 2, 10_000);
    expect(done).toEqual([vw.mint, bg.mint]);
  });

  test("a pump coin never seen live is discovered from its curve PDA", async () => {
    const mint = "4ddZmkmhHJ2C6436znty5s3YpezEkEX6S1oebwhapump";
    const curve = new FakeCurve(mint, addr("disc-dev"));
    const t0 = Math.floor(Date.now() / 1000) - 300;
    const txs = [
      synthTx(7_000, [curve.create(t0)], { signature: "disc-create".padEnd(88, "c") }),
      synthTx(7_001, [curve.buy(addr("d1"), 100_000_000n, t0 + 5)], { signature: "disc-1".padEnd(88, "x") }),
      synthTx(7_002, [curve.buy(addr("d2"), 100_000_000n, t0 + 9)], { signature: "disc-2".padEnd(88, "x") }),
    ];
    const pda = await bondingCurvePda(mint as Address);
    const w = world();
    expect(w.market.tokens.has(mint)).toBe(false);
    const svc = service(w, new FakeHistoryReader(chainOf(pda, txs)));
    svc.start();
    svc.request(mint, 0);
    await waitFor(() => svc.state(mint)?.state === "complete", 5_000);
    expect(w.market.summary(mint)).toMatchObject({ createdAt: t0 * 1000, holders: 2, buys: 2, launchpad: "pump" });
  });
});

describe("the real decoder", () => {
  test("a fetched mainnet transaction (getTransaction JSON) becomes the same trade the gRPC feed records", async () => {
    const f = fixture("pump-buy");
    const w = world();
    // the coin, known by its mint only
    const mint = (await import("@zerofee/core")).decodeLogEvents(f.tx.meta.logMessages).events.find((e) => e.kind === "pumpTrade") as
      | { mint: string; user: string; isBuy: boolean }
      | undefined;
    if (!mint) throw new Error("fixture without a trade");
    const curveAddr = addr("real-curve");
    w.market.ensureToken(mint.mint, { launchpad: "pump", bondingCurve: curveAddr });
    const reader = new FakeHistoryReader(
      new Map([
        [curveAddr, [{ info: { signature: f.signature, slot: f.tx.slot, err: null, blockTime: f.tx.blockTime }, tx: f.tx as never }]],
      ]),
    );
    const svc = new HistoryService({
      cfg: HISTORY_CFG,
      market: w.market,
      reader,
      store: w.reader,
      writer: w.writer,
      watched: () => [],
      listed: () => [],
    });
    services.push(svc);
    svc.start();
    svc.request(mint.mint, 0);
    await waitFor(() => svc.state(mint.mint)?.state === "complete", 5_000);
    w.writer.flush();
    const rows = w.reader.tradesOfMint(mint.mint);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ signature: f.signature, slot: f.tx.slot, trader: mint.user, side: mint.isBuy ? 0 : 1 });
    expect(rows[0]?.id).toBe(`${f.signature}:0`);
  });
});

describe("storage", () => {
  test("a backfilled coin's trades outlive TRADES_RETENTION_HOURS until retain_until", () => {
    const db = openDb(":memory:");
    const writer = new StorageWriter(db, { flushMs: 1_000_000, retentionHours: 1 });
    const reader = new StorageReader(db);
    const market = new MarketState(CFG, { resolver: new FakeResolver(), solUsd: () => 100, storage: writer });
    const old = Math.floor(Date.now() / 1000) - 5 * 3_600;
    for (const tag of ["keep", "drop"]) {
      const c = new FakeCurve(addr(`ret-${tag}`), addr(`ret-dev-${tag}`));
      market.applyTx(synthTx(10, [c.create(old), c.buy(addr("rb"), 100_000_000n, old)]));
    }
    writer.history({
      mint: addr("ret-keep"),
      state: "complete",
      fromSlot: 10,
      fromTime: old * 1000,
      fromCreation: true,
      capped: false,
      trades: 1,
      cursors: null,
      retainUntil: Date.now() + 86_400_000,
      updatedAt: Date.now(),
    });
    writer.flush();
    writer.prune();
    expect(reader.tradesOfMint(addr("ret-keep"))).toHaveLength(1);
    expect(reader.tradesOfMint(addr("ret-drop"))).toHaveLength(0);
    expect(reader.historyRow(addr("ret-keep"))).toMatchObject({ state: "complete", fromCreation: true, capped: false });
  });

  test("trades page newest first by (slot, tx index, id) with a cursor; a signature works as a cursor", () => {
    const db = openDb(":memory:");
    const writer = new StorageWriter(db, { flushMs: 1_000_000, retentionHours: 72 });
    const reader = new StorageReader(db);
    const market = new MarketState(CFG, { resolver: new FakeResolver(), solUsd: () => 100, storage: writer });
    const life = coinLife("page", 25);
    for (const tx of life.txs) market.applyTx(tx);
    writer.flush();
    const seen: string[] = [];
    let cursor: { slot: number; txIndex: number; id: string } | null = null;
    for (let i = 0; i < 10; i++) {
      const p = reader.tradesPage(life.mint, cursor, 7);
      seen.push(...p.trades.map((t) => t.id));
      if (!p.next) break;
      const m = /^(\d+):(-?\d+):(.+)$/.exec(p.next) as RegExpExecArray;
      cursor = { slot: Number(m[1]), txIndex: Number(m[2]), id: m[3] as string };
    }
    expect(seen).toHaveLength(26);
    expect(new Set(seen).size).toBe(26);
    const slots = seen.map((id) => reader.tradesOfMint(life.mint).find((r) => r.id === id)?.slot ?? 0);
    expect([...slots].sort((a, b) => b - a)).toEqual(slots);
    const at = reader.slotOfSignature(life.txs[10]?.signature as string);
    expect(at?.slot).toBe(life.txs[10]?.slot);
  });
});

describe("holder shares never exceed the circulating supply", () => {
  /** A whale flips the coin; the live feed saw every buy but none of the sells. */
  function flips() {
    const mint = addr("flip-mint");
    const dev = addr("flip-dev");
    const whale = addr("flip-whale");
    const curve = new FakeCurve(mint, dev);
    const t0 = Math.floor(Date.now() / 1000) - 900;
    const all: IngestTx[] = [synthTx(9_000, [curve.create(t0)], { signature: "flip-create".padEnd(88, "c") })];
    const seenLive: IngestTx[] = [all[0] as IngestTx];
    for (let i = 0; i < 6; i++) {
      const buy = synthTx(9_001 + i * 2, [curve.buy(whale, 30_000_000_000n, t0 + 10 + i * 20)], {
        signature: `flip-b${i}`.padEnd(88, "b"),
      });
      const bought = (buy.events[0] as { tokenAmount: bigint }).tokenAmount;
      const sell = synthTx(9_002 + i * 2, [curve.sell(whale, bought, t0 + 20 + i * 20)], { signature: `flip-s${i}`.padEnd(88, "s") });
      all.push(buy, sell);
      seenLive.push(buy); // the sells were lost by the feed
    }
    const last = synthTx(9_100, [curve.buy(addr("flip-small"), 500_000_000n, t0 + 200)], { signature: "flip-last".padEnd(88, "l") });
    all.push(last);
    seenLive.push(last);
    return { mint, curve, all, seenLive };
  }

  test("a book that missed sells is bounded (top 10 <= circulating share <= 100%) and flagged", () => {
    const f = flips();
    const w = world();
    for (const tx of f.seenLive) w.market.applyTx(tx);
    const rec = w.market.tokens.get(f.mint);
    if (!rec?.holders) throw new Error("no holder book");
    // the raw book: the whale "holds" six bags it sold
    const raw = rec.holders.topHolders(10).reduce((sum, [, b]) => sum + b, 0n);
    expect(raw > rec.supply).toBe(true); // what the old metric divided by supply: 100%+ (DONALDMAXX showed 109%)
    expect(rec.holders.metrics(rec.supply).top10Pct).toBeLessThanOrEqual(100);
    const s = w.market.summary(f.mint);
    const circulatingPct = Number((((rec.initialRealTokenReserves ?? 0n) - (rec.curve?.rToken ?? 0n)) * 1_000_000n) / rec.supply) / 10_000;
    expect(s?.top10Pct).toBeLessThanOrEqual(circulatingPct + 1e-9);
    expect(s?.top10Pct).toBeLessThanOrEqual(100);
    expect(w.market.holdersOvercounted(f.mint)).toBe(true);
  });

  test("a gap-fill finds the missed sells and the rebuilt book is exact again", async () => {
    const f = flips();
    const w = world();
    for (const tx of f.seenLive) w.market.applyTx(tx);
    const svc = service(w, new FakeHistoryReader(chainOf(f.curve.bondingCurve, f.all)), {}, [f.mint]);
    svc.start();
    svc.scan(); // viewed + overcounted: queues the repair
    await waitFor(() => !svc.busy(f.mint) && w.reader.tradesOfMint(f.mint).length === 13, 5_000);
    const ref = world();
    for (const tx of f.all) ref.market.applyTx(tx);
    expect(w.market.holdersOvercounted(f.mint)).toBe(false);
    expect(w.market.summary(f.mint)?.top10Pct).toBeCloseTo(ref.market.summary(f.mint)?.top10Pct ?? -1, 9);
    expect(w.market.summary(f.mint)?.holders).toBe(ref.market.summary(f.mint)?.holders ?? -1);
  });
});

describe("backfill writes go through the writer thread", () => {
  test("drain() makes queued trades and coverage readable from another connection", async () => {
    const dir = await import("node:fs").then((fs) => fs.mkdtempSync(`${(process.env.TMPDIR ?? "/tmp").replace(/\/$/, "")}/zf-hist-`));
    const path = `${dir}/market.db`;
    const db = openDb(path);
    const writer = new StorageWriter(db, { flushMs: 1_000_000, retentionHours: 72, threadPath: path });
    expect(writer.threaded).toBe(true);
    const market = new MarketState(CFG, { resolver: new FakeResolver(), solUsd: () => 100, storage: writer });
    const life = coinLife("thread", 30);
    for (const tx of life.txs) market.applyTx(tx);
    writer.history({
      mint: life.mint,
      state: "complete",
      fromSlot: 5_000,
      fromTime: 1,
      fromCreation: true,
      capped: false,
      trades: 31,
      cursors: null,
      retainUntil: null,
      updatedAt: Date.now(),
    });
    await writer.drain();
    const other = new StorageReader(openDb(path));
    expect(other.tradesOfMint(life.mint)).toHaveLength(31);
    expect(other.historyRow(life.mint)).toMatchObject({ state: "complete", trades: 31 });
    await writer.stop();
  });
});

describe("long histories and failing reads", () => {
  test("a history older than the trade retention survives the prune that runs during its backfill", async () => {
    const life = coinLife("old", 20);
    // shift the whole life 5 days back (retention is 72 h)
    const shift = 5n * 86_400n;
    for (const tx of life.txs) for (const ev of tx.events) if ("timestamp" in ev) (ev as { timestamp: bigint }).timestamp -= shift;
    const db = openDb(":memory:");
    const writer = new StorageWriter(db, { flushMs: 1_000_000, retentionHours: 72 });
    const w: World = {
      market: new MarketState(CFG, { resolver: new FakeResolver(), solUsd: () => 100, storage: writer }),
      writer,
      reader: new StorageReader(db),
      states: [],
    };
    w.market.applyTx(life.txs[life.txs.length - 1] as IngestTx);
    const rec = w.market.tokens.get(life.mint);
    if (rec) rec.bondingCurve = life.curve.bondingCurve;
    const reader = new FakeHistoryReader(chainOf(life.curve.bondingCurve, life.txs));
    const fetch = reader.transactions.bind(reader);
    reader.transactions = async (sigs) => {
      writer.flush();
      writer.prune(); // the minute timer firing mid-backfill
      return fetch(sigs);
    };
    const svc = service(w, reader);
    svc.start();
    svc.request(life.mint, 0);
    await waitFor(() => svc.state(life.mint)?.state === "complete", 5_000);
    writer.flush();
    writer.prune();
    expect(w.reader.tradesOfMint(life.mint)).toHaveLength(21);
    expect(svc.state(life.mint)?.trades).toBe(21);
  });

  test("a failed getTransaction batch is retried, not dropped", async () => {
    const life = coinLife("flaky", 12);
    const w = world();
    w.market.applyTx(life.txs[life.txs.length - 1] as IngestTx);
    const rec = w.market.tokens.get(life.mint);
    if (rec) rec.bondingCurve = life.curve.bondingCurve;
    const reader = new FakeHistoryReader(chainOf(life.curve.bondingCurve, life.txs));
    const fetch = reader.transactions.bind(reader);
    let calls = 0;
    reader.transactions = async (sigs) => {
      calls++;
      if (calls % 3 === 0) throw new RpcError("getTransaction", 429, "HTTP 429");
      return fetch(sigs);
    };
    const svc = new HistoryService({
      cfg: HISTORY_CFG,
      market: w.market,
      reader,
      store: w.reader,
      writer: w.writer,
      watched: () => [],
      listed: () => [],
      decode: decodeFake,
      retryMs: 5,
    });
    services.push(svc);
    svc.start();
    svc.request(life.mint, 0);
    await waitFor(() => svc.state(life.mint)?.state === "complete", 5_000);
    w.writer.flush();
    expect(w.reader.tradesOfMint(life.mint)).toHaveLength(13);
  });
});

describe("what a viewer sees while a slow backfill runs", () => {
  test("trades are stored and published per merge round (HISTORY_MERGE_MS), newest first, long before the walk ends", async () => {
    const life = coinLife("slow", 30);
    const w = world();
    w.market.applyTx(life.txs[life.txs.length - 1] as IngestTx);
    const rec = w.market.tokens.get(life.mint);
    if (rec) rec.bondingCurve = life.curve.bondingCurve;
    // ~25 ms per getTransaction: the count rule (mergeEvery 1,000) alone would show nothing until the end
    const reader = new FakeHistoryReader(chainOf(life.curve.bondingCurve, life.txs), 1, 25);
    const rounds: { at: number; slots: number[]; added: number; state: string }[] = [];
    const svc = new HistoryService({
      cfg: { ...HISTORY_CFG, mergeEvery: 1_000, mergeMs: 100 },
      market: w.market,
      reader,
      store: w.reader,
      writer: w.writer,
      watched: () => [],
      listed: () => [],
      decode: decodeFake,
      publish: (_m, added, _candles, h) =>
        rounds.push({ at: Date.now(), slots: added.map((t) => t.slot), added: h.progress?.added ?? -1, state: h.state }),
    });
    services.push(svc);
    svc.start();
    svc.request(life.mint, 0);
    await waitFor(() => svc.state(life.mint)?.state === "complete", 10_000);
    const partial = rounds.filter((r) => r.state === "backfilling" && r.slots.length > 0);
    // several rounds went out while backfilling, each with its trades stored and counted in `progress.added`
    expect(partial.length).toBeGreaterThanOrEqual(3);
    expect(partial[0]?.added).toBeGreaterThan(0);
    for (let i = 1; i < partial.length; i++)
      expect((partial[i] as { added: number }).added).toBeGreaterThan((partial[i - 1] as { added: number }).added);
    // the first round holds the newest trades: every later round is older
    const newestFirst = Math.min(...(partial[0] as { slots: number[] }).slots);
    for (const r of partial.slice(1)) expect(Math.max(...r.slots)).toBeLessThan(newestFirst);
    w.writer.flush();
    expect(w.reader.tradesOfMint(life.mint)).toHaveLength(31);
  });

  test("a graduate's pool is walked before its curve, each account newest transaction first", async () => {
    const life = coinLife("grad", 10);
    const w = world();
    w.market.applyTx(life.txs[life.txs.length - 1] as IngestTx);
    const rec = w.market.tokens.get(life.mint);
    const pool = addr("grad-pool");
    if (rec) {
      rec.bondingCurve = life.curve.bondingCurve;
      rec.pool = pool;
      rec.migrated = true;
    }
    // the curve carries the older half of the life, the pool the newer half
    const older = life.txs.slice(0, 6);
    const newer = life.txs.slice(6, -1);
    const chain = new Map([...chainOf(life.curve.bondingCurve, older), ...chainOf(pool, newer)]);
    const reader = new FakeHistoryReader(chain);
    const svc = service(w, reader);
    svc.start();
    svc.request(life.mint, 0);
    await waitFor(() => svc.state(life.mint)?.state === "complete", 5_000);
    expect(reader.calls[0]?.address).toBe(pool);
    const expected = [...newer]
      .reverse()
      .map((t) => t.signature)
      .concat([...older].reverse().map((t) => t.signature));
    expect(reader.fetched).toEqual(expected);
  });
});

describe("one viewer, several coins", () => {
  test("a coin nobody views any more steps back: the page open now is backfilled first", async () => {
    const a = coinLife("left", 30);
    const b = coinLife("open", 6, 9_000);
    const w = world();
    for (const life of [a, b]) {
      w.market.applyTx(life.txs[life.txs.length - 1] as IngestTx);
      const rec = w.market.tokens.get(life.mint);
      if (rec) rec.bondingCurve = life.curve.bondingCurve;
    }
    const chain = new Map([...chainOf(a.curve.bondingCurve, a.txs), ...chainOf(b.curve.bondingCurve, b.txs)]);
    let skew = 0;
    let watched = [a.mint];
    const done: string[] = [];
    const set = w.market.setHistory.bind(w.market);
    w.market.setHistory = (m, h) => {
      if (h.state === "complete") done.push(m);
      set(m, h);
    };
    const svc = new HistoryService({
      cfg: HISTORY_CFG,
      market: w.market,
      reader: new FakeHistoryReader(chain, 1, 15),
      store: w.reader,
      writer: w.writer,
      watched: () => watched,
      listed: () => [],
      decode: decodeFake,
      now: () => Date.now() + skew,
    });
    services.push(svc);
    svc.start();
    svc.request(a.mint, 0);
    await waitFor(() => w.market.tokens.get(a.mint)?.history?.state === "backfilling", 5_000);
    // the viewer moves on to B; A's walk is still running
    watched = [b.mint];
    svc.request(b.mint, 0);
    skew = 20_000;
    svc.scan();
    await waitFor(() => done.length === 2, 10_000);
    expect(done).toEqual([b.mint, a.mint]);
  });
});
