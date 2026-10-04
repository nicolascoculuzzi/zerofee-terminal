#!/usr/bin/env bun
/**
 * Trade capture audit: compares the trades a server recorded with the chain's own record, per venue, and says
 * where missing trades were lost. Reads only (DRY_RUN; no transaction is built or sent).
 *
 *   Against a running server's SQLite store (read-only), auditing the last WINDOW_MIN minutes:
 *     bun run apps/server/scripts/capture-audit.ts --db data/market.db [--health http://127.0.0.1:8787]
 *   In-process: starts the server (RPC logs feed, DRY_RUN, in-memory SQLite), runs it for --minutes, instruments
 *   the feed (every logs notification, every decoded transaction, socket up/down), then audits:
 *     bun run apps/server/scripts/capture-audit.ts --inprocess --minutes 8
 *
 * Options: --coins N (default 8), --mint <address> (repeatable; always audited), --window-min M (db mode),
 * --settle S (seconds left out at the end, default 90), --rps R (getTransaction budget, default 1.5),
 * --rpc URL (default RPC_URL or the public endpoint), --api URL (also count /api/trades pages), --json <file>,
 * --backfill (in-process: also backfill the audited coins and re-check them against the chain).
 *
 * Ground truth: getSignaturesForAddress on each coin's bonding curve / pool (newest first, down to the window
 * start), getTransaction for every successful signature in the window, decoded with the same event decoders
 * (Anchor event-CPI, tag e445a52e51cb9a1d). A trade counts as captured when the store holds a trade of the same
 * signature and side for the coin (per-signature counts, so a transaction with two buys needs two).
 */
import { Database } from "bun:sqlite";
import { DEFAULT_RPC_URL } from "@zerofee/core";
import type { TradeVenue } from "@zerofee/protocol";
import { type App, createApp, createSource } from "../src/app";
import { loadConfig } from "../src/config";
import { type CoinAccounts, coinTrades, type TruthTrade } from "../src/history/coin";
import { RpcHistoryReader, type SignatureInfo } from "../src/history/reader";
import { ingestFromJsonTx } from "../src/ingest/jsonTx";
import type { RpcLogsSource } from "../src/ingest/rpcLogs";
import type { IngestSink } from "../src/ingest/types";
import { setLogLevel } from "../src/log";
import { openDb } from "../src/storage/db";
import { RpcClient } from "../src/util/rpc";

// ---------------------------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string, def?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
};
const opts = (name: string): string[] => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] ? [argv[i + 1] as string] : []));

const INPROCESS = flag("inprocess");
const DB_PATH = opt("db");
const MINUTES = Number(opt("minutes", "8"));
const WINDOW_MIN = Number(opt("window-min", "10"));
const COINS = Number(opt("coins", "8"));
const SETTLE_S = Number(opt("settle", "90"));
const RPS = Number(opt("rps", "1.5"));
const RPC_URL = opt("rpc", process.env.RPC_URL ?? DEFAULT_RPC_URL) as string;
const HEALTH = opt("health");
const API = opt("api");
const JSON_OUT = opt("json");
const BACKFILL = flag("backfill");
const MINTS = opts("mint");

if (!INPROCESS && !DB_PATH) {
  console.error("usage: capture-audit.ts --db <market.db> | --inprocess [--minutes 8]");
  process.exit(2);
}

const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-");
const log = (...a: unknown[]) => console.log(`[audit ${new Date().toISOString().slice(11, 19)}]`, ...a);

// ---------------------------------------------------------------------------------------------
// in-process instrumentation
// ---------------------------------------------------------------------------------------------

interface Notified {
  slot: number;
  at: number;
  truncated: boolean;
  data: boolean;
  failed: boolean;
}

const notified = new Map<string, Notified>();
const applied = new Map<string, { events: number; source: string; at: number }>();
const downWindows: { from: number; to: number | null; slotBefore: number | null; slotAfter: number | null }[] = [];
const SIG_RE = /"signature":"([1-9A-HJ-NP-Za-km-z]{43,90})"/;
const SLOT_RE = /"context":\{"slot":(\d+)/;

async function runInProcess(): Promise<{ app: App; t0: number; t1: number; stop: () => Promise<void> }> {
  setLogLevel("warn");
  const cfg = loadConfig({
    ...process.env,
    SERVER_PORT: "0",
    DB_PATH: ":memory:",
    DRY_RUN: "true",
    PUMPPORTAL_ENABLED: "false",
    INGEST_SOURCE: "rpc",
    LOG_LEVEL: "warn",
  });
  let appRef: App | null = null;
  const rpc = new RpcClient({ url: cfg.rpcUrl });
  const source = createSource(cfg, { rpc, wants: (e, m) => appRef?.market.wantsRaydiumTx(e, m) ?? false }) as RpcLogsSource;
  const onMessage = source.onMessage.bind(source);
  source.onMessage = (raw: string) => {
    if (raw.includes('"logsNotification"')) {
      const sig = SIG_RE.exec(raw)?.[1];
      const slot = Number(SLOT_RE.exec(raw)?.[1] ?? 0);
      if (sig && !notified.has(sig))
        notified.set(sig, {
          slot,
          at: Date.now(),
          truncated: raw.includes("Log truncated"),
          data: raw.includes("Program data:"),
          failed: !raw.includes('"err":null'),
        });
    }
    onMessage(raw);
  };
  const start = source.start.bind(source);
  source.start = (sink: IngestSink) =>
    start({
      ...sink,
      tx: (tx) => {
        if (!applied.has(tx.signature)) applied.set(tx.signature, { events: tx.events.length, source: tx.source, at: Date.now() });
        sink.tx(tx);
      },
    });
  const app = createApp(cfg, { source, db: openDb(":memory:"), rpc, solUsd: undefined, enrich: false });
  appRef = app;
  let up = false;
  const poll = setInterval(() => {
    const h = source.health();
    if (up && !h.connected) downWindows.push({ from: Date.now(), to: null, slotBefore: h.slot, slotAfter: null });
    if (!up && h.connected) {
      const w = downWindows[downWindows.length - 1];
      if (w && w.to === null) w.to = Date.now();
    }
    up = h.connected;
  }, 100);
  const startedAt = Date.now();
  log(`server started in-process (rpc ${cfg.rpcUrl}, programs ${cfg.rpcLogsPrograms.join(",")}); running ${MINUTES} min`);
  const warm = 45_000;
  const until = startedAt + MINUTES * 60_000;
  while (Date.now() < until) {
    await Bun.sleep(30_000);
    const h = app.health();
    log(
      `trades ${h.ingest.trades} (${h.ingest.tradesPerSec1m}/s), latency p50 ${h.ingest.latency.p50} ms, queue dropped ${h.sources[0]?.dropped}, ` +
        `reconnects ${h.sources[0]?.reconnects}, notified ${notified.size}, applied ${applied.size}`,
    );
  }
  // Slots seen after a reconnect close the open down windows.
  for (const w of downWindows) {
    let after: number | null = null;
    for (const n of notified.values()) if (w.to !== null && n.at >= w.to && (after === null || n.slot < after)) after = n.slot;
    w.slotAfter = after;
  }
  const t1 = Date.now() - SETTLE_S * 1000;
  // let in-flight re-reads land, then stop the feed and the history service: the verification reads alone
  // share the RPC budget from here (the public RPC answers 429 at ~2 getTransaction calls per second per IP)
  await Bun.sleep(Math.min(SETTLE_S, 30) * 1000);
  await app.source?.stop();
  await (app as unknown as { history?: { stop(): Promise<void> } }).history?.stop();
  clearInterval(poll);
  return {
    app,
    t0: startedAt + warm,
    t1,
    stop: async () => {
      await app.stop();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------------------------

interface CoinPick {
  mint: string;
  venue: TradeVenue;
  recorded: number;
  accounts: CoinAccounts;
}

const VENUE_BY_CODE: TradeVenue[] = ["pump", "pumpswap", "launchlab", "cpmm"];
const QUOTA: Record<TradeVenue, number> = { pump: 0.5, pumpswap: 0.25, launchlab: 0.125, cpmm: 0.125 };

function accountsOf(db: Database, mint: string): CoinAccounts {
  const row = db.query("SELECT state FROM tokens WHERE mint = ?").get(mint) as { state: string } | null;
  const st = row ? (JSON.parse(row.state) as Record<string, unknown>) : {};
  const ll = st.launchLab as { pool?: string } | null | undefined;
  const pool = typeof st.pool === "string" ? st.pool : null;
  const launchLab = st.launchpad === "launchlab";
  return {
    mint,
    curve: !launchLab && typeof st.bondingCurve === "string" ? st.bondingCurve : null,
    pumpPool: !launchLab ? pool : null,
    launchLabPool: ll?.pool ?? null,
    cpmmPool: launchLab && st.migrated ? pool : null,
  };
}

async function pickCoins(db: Database, t0: number, t1: number): Promise<CoinPick[]> {
  const rows = db
    .query(
      `SELECT mint, venue, COUNT(*) AS n FROM trades WHERE block_time BETWEEN ? AND ? GROUP BY mint, venue HAVING n BETWEEN 4 AND 70 ORDER BY RANDOM() LIMIT 2000`,
    )
    .all(t0, t1) as { mint: string; venue: number; n: number }[];
  const picks: CoinPick[] = [];
  const taken = new Set<string>();
  for (const mint of MINTS) {
    const r = db
      .query("SELECT venue, COUNT(*) AS n FROM trades WHERE mint = ? AND block_time BETWEEN ? AND ? GROUP BY venue")
      .all(mint, t0, t1) as {
      venue: number;
      n: number;
    }[];
    for (const v of r.length ? r : [{ venue: 0, n: 0 }])
      picks.push({ mint, venue: VENUE_BY_CODE[v.venue] ?? "pump", recorded: v.n, accounts: accountsOf(db, mint) });
    taken.add(mint);
  }
  for (const venue of ["pump", "pumpswap", "launchlab", "cpmm"] as TradeVenue[]) {
    const want = Math.max(1, Math.round(COINS * QUOTA[venue]));
    let got = 0;
    for (const r of rows) {
      if (got >= want) break;
      if (VENUE_BY_CODE[r.venue] !== venue || taken.has(r.mint)) continue;
      const accounts = accountsOf(db, r.mint);
      const has =
        venue === "pump"
          ? accounts.curve
          : venue === "pumpswap"
            ? accounts.pumpPool
            : venue === "launchlab"
              ? accounts.launchLabPool
              : accounts.cpmmPool;
      if (!has) continue;
      taken.add(r.mint);
      picks.push({ mint: r.mint, venue, recorded: r.n, accounts });
      got++;
    }
  }
  return picks;
}

interface CoinResult {
  mint: string;
  venue: TradeVenue;
  account: string;
  truth: number;
  captured: number;
  missed: TruthTrade[];
  signatures: number;
  failedSkipped: number;
  apiTrades: number | null;
}

function accountFor(c: CoinPick): string | null {
  const a = c.accounts;
  return c.venue === "pump" ? a.curve : c.venue === "pumpswap" ? a.pumpPool : c.venue === "launchlab" ? a.launchLabPool : a.cpmmPool;
}

async function truthFor(
  reader: RpcHistoryReader,
  c: CoinPick,
  t0: number,
  t1: number,
): Promise<{ trades: TruthTrade[]; sigs: number; failed: number }> {
  const account = accountFor(c);
  if (!account) return { trades: [], sigs: 0, failed: 0 };
  const inWindow: SignatureInfo[] = [];
  let failed = 0;
  let before: string | undefined;
  for (let page = 0; page < 20; page++) {
    const sigs = await reader.signatures(account, { before, limit: 1_000 });
    if (!sigs.length) break;
    let older = false;
    for (const s of sigs) {
      const ms = (s.blockTime ?? 0) * 1000;
      if (ms < t0) {
        older = true;
        break;
      }
      if (ms > t1) continue;
      if (s.err) failed++;
      else inWindow.push(s);
    }
    if (older || sigs.length < 1_000) break;
    before = sigs[sigs.length - 1]?.signature;
  }
  const trades: TruthTrade[] = [];
  const txs = await reader.transactions(inWindow.map((s) => s.signature));
  txs.forEach((tx, i) => {
    const s = inWindow[i] as SignatureInfo;
    if (!tx) return;
    const built = ingestFromJsonTx({ signature: s.signature, tx, receivedAt: Date.now(), source: "audit" });
    if (built) trades.push(...coinTrades(built.tx, c.accounts));
  });
  return { trades, sigs: inWindow.length, failed };
}

function compare(db: Database, c: CoinPick, truth: TruthTrade[], t0: number, t1: number): { captured: number; missed: TruthTrade[] } {
  const venueCode = VENUE_BY_CODE.indexOf(c.venue);
  const rows = db
    .query("SELECT signature, side FROM trades WHERE mint = ? AND venue = ? AND block_time BETWEEN ? AND ?")
    .all(c.mint, venueCode, t0 - 15 * 60_000, t1 + 15 * 60_000) as { signature: string; side: number }[];
  const have = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.signature}|${r.side === 0 ? "buy" : "sell"}`;
    have.set(k, (have.get(k) ?? 0) + 1);
  }
  let captured = 0;
  const missed: TruthTrade[] = [];
  for (const t of truth) {
    const k = `${t.signature}|${t.side}`;
    const n = have.get(k) ?? 0;
    if (n > 0) {
      captured++;
      have.set(k, n - 1);
    } else missed.push(t);
  }
  return { captured, missed };
}

type LossClass =
  | "not delivered (reconnect gap)"
  | "not delivered (no notification)"
  | "truncated logs"
  | "notified, never decoded (queue drop / decode)"
  | "decoded without the event (logs)"
  | "decoded, not recorded (market)"
  | "unclassified (db mode)";

function classify(t: TruthTrade): LossClass {
  if (!INPROCESS) return "unclassified (db mode)";
  const n = notified.get(t.signature);
  if (!n) {
    const inGap = downWindows.some((w) => w.slotBefore !== null && t.slot > w.slotBefore && (w.slotAfter === null || t.slot < w.slotAfter));
    return inGap ? "not delivered (reconnect gap)" : "not delivered (no notification)";
  }
  if (n.truncated) return "truncated logs";
  const a = applied.get(t.signature);
  if (!a) return "notified, never decoded (queue drop / decode)";
  if (a.events <= t.evIndex) return "decoded without the event (logs)";
  return "decoded, not recorded (market)";
}

async function apiCount(mint: string): Promise<number | null> {
  if (!API) return null;
  let n = 0;
  let before: string | null = null;
  for (let page = 0; page < 200; page++) {
    const r = await fetch(`${API}/api/trades?mint=${mint}&limit=500${before ? `&before=${encodeURIComponent(before)}` : ""}`);
    if (!r.ok) return null;
    const body = (await r.json()) as { trades: unknown[]; next: string | null };
    n += body.trades.length;
    if (!body.next) break;
    before = body.next;
  }
  return n;
}

async function main(): Promise<void> {
  let db: Database;
  let t0: number;
  let t1: number;
  let inproc: Awaited<ReturnType<typeof runInProcess>> | null = null;
  let healthNotes: string[] = [];
  if (INPROCESS) {
    inproc = await runInProcess();
    inproc.app.writer.flush();
    db = (inproc.app.reader as unknown as { db: Database }).db;
    t0 = inproc.t0;
    t1 = inproc.t1;
    const h = inproc.app.health();
    healthNotes = [`reconnects ${h.sources[0]?.reconnects}, queue dropped ${h.sources[0]?.dropped}`, ...(h.sources[0]?.notes ?? [])];
  } else {
    db = new Database(DB_PATH as string, { readonly: true });
    t1 = Date.now() - SETTLE_S * 1000;
    t0 = t1 - WINDOW_MIN * 60_000;
    if (HEALTH) {
      try {
        const h = (await (await fetch(`${HEALTH}/api/health`)).json()) as {
          sources: { reconnects: number; dropped: number; notes: string[] }[];
        };
        healthNotes = [`reconnects ${h.sources[0]?.reconnects}, queue dropped ${h.sources[0]?.dropped}`, ...(h.sources[0]?.notes ?? [])];
      } catch (e) {
        healthNotes = [`health unavailable: ${e instanceof Error ? e.message : e}`];
      }
    }
  }
  const reader = new RpcHistoryReader({
    rpc: new RpcClient({ url: RPC_URL, maxConcurrent: 2, timeoutMs: 20_000 }),
    perSec: RPS,
    maxRetries: 12,
  });
  log(`window ${new Date(t0).toISOString()} .. ${new Date(t1).toISOString()} (${((t1 - t0) / 60_000).toFixed(1)} min)`);
  const picks = await pickCoins(db, t0, t1);
  log(`auditing ${picks.length} coins: ${picks.map((p) => `${short(p.mint)}/${p.venue}(${p.recorded})`).join(" ")}`);
  const results: CoinResult[] = [];
  for (const c of picks) {
    const account = accountFor(c);
    if (!account) continue;
    try {
      const truth = await truthFor(reader, c, t0, t1);
      const cmp = compare(db, c, truth.trades, t0, t1);
      results.push({
        mint: c.mint,
        venue: c.venue,
        account,
        truth: truth.trades.length,
        captured: cmp.captured,
        missed: cmp.missed,
        signatures: truth.sigs,
        failedSkipped: truth.failed,
        apiTrades: await apiCount(c.mint),
      });
      log(
        `${short(c.mint)} ${c.venue}: chain ${truth.trades.length} trades (${truth.sigs} txs, ${truth.failed} failed skipped), captured ${cmp.captured} (${pct(cmp.captured, truth.trades.length)})`,
      );
    } catch (e) {
      log(`${short(c.mint)}: audit failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // ---- report
  const byVenue = new Map<TradeVenue, { truth: number; captured: number; coins: number }>();
  const losses = new Map<string, number>();
  for (const r of results) {
    const v = byVenue.get(r.venue) ?? { truth: 0, captured: 0, coins: 0 };
    v.truth += r.truth;
    v.captured += r.captured;
    v.coins++;
    byVenue.set(r.venue, v);
    for (const m of r.missed) losses.set(classify(m), (losses.get(classify(m)) ?? 0) + 1);
  }
  const total = results.reduce((a, r) => ({ truth: a.truth + r.truth, captured: a.captured + r.captured }), { truth: 0, captured: 0 });
  console.log("\n=== capture rate (trades on chain in the window vs trades in the store) ===");
  console.log("venue      coins  chain  captured  rate");
  for (const [venue, v] of byVenue)
    console.log(
      `${venue.padEnd(10)} ${String(v.coins).padStart(5)} ${String(v.truth).padStart(6)} ${String(v.captured).padStart(9)}  ${pct(v.captured, v.truth)}`,
    );
  console.log(
    `${"all".padEnd(10)} ${String(results.length).padStart(5)} ${String(total.truth).padStart(6)} ${String(total.captured).padStart(9)}  ${pct(total.captured, total.truth)}`,
  );
  if (losses.size) {
    console.log("\n=== where missing trades were lost ===");
    for (const [k, n] of [...losses].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(6)}  ${k}`);
  }
  if (INPROCESS) {
    const inWindow = [...notified.values()].filter((n) => n.at >= t0 && n.at <= t1);
    console.log(
      `\nfeed: ${notified.size} notifications (${inWindow.filter((n) => n.truncated).length} truncated in window), ${applied.size} decoded txs, ` +
        `${downWindows.length} disconnects (${downWindows.map((w) => `${w.to ? Math.round((w.to - w.from) / 1000) : "?"} s`).join(", ")})`,
    );
  }
  if (healthNotes.length) console.log(`\nserver: ${healthNotes.join("\n        ")}`);
  console.log(`\nverification rpc: ${JSON.stringify(reader.stats)}`);

  let backfill: unknown = null;
  if (BACKFILL && inproc) backfill = await backfillCheck(inproc.app, reader, picks);
  if (JSON_OUT) {
    await Bun.write(
      JSON_OUT,
      JSON.stringify(
        {
          mode: INPROCESS ? "inprocess" : "db",
          window: { t0, t1 },
          byVenue: Object.fromEntries(byVenue),
          total,
          losses: Object.fromEntries(losses),
          coins: results.map((r) => ({ ...r, missed: r.missed.map((m) => `${m.signature}:${m.evIndex}`) })),
          disconnects: downWindows,
          health: healthNotes,
          backfill,
        },
        null,
        2,
      ),
    );
  }
  await inproc?.stop();
  process.exit(0);
}

/**
 * --backfill: asks the in-process server to backfill each audited coin's full history, waits for it, then counts
 * the coin's successful trade transactions on chain (whole history) against the trades the server now stores.
 */
async function backfillCheck(app: App, reader: RpcHistoryReader, picks: CoinPick[]): Promise<unknown> {
  const history = (
    app as unknown as {
      history?: {
        start(): void;
        request(mint: string, priority: 0 | 1 | 2): void;
        state(mint: string): { state: string } | null;
        busy(mint: string): boolean;
      };
    }
  ).history;
  if (!history) {
    log("backfill: this server has no history service");
    return null;
  }
  const out: unknown[] = [];
  history.start();
  for (const c of picks.filter((p) => p.venue === "pump").slice(0, 3)) {
    history.request(c.mint, 0);
    const t0 = Date.now();
    await Bun.sleep(1_000);
    while (Date.now() - t0 < 20 * 60_000 && history.busy(c.mint)) await Bun.sleep(2_000);
    app.writer.flush();
    const db = (app.reader as unknown as { db: Database }).db;
    const stored = db.query("SELECT COUNT(*) AS n FROM trades WHERE mint = ?").get(c.mint) as { n: number };
    const truth = await truthFor(reader, c, 0, Date.now());
    const cmp = compare(db, c, truth.trades, 0, Date.now());
    log(
      `backfill ${short(c.mint)} ${c.venue}: state ${history.state(c.mint)?.state}, stored ${stored.n} trades; chain ${truth.trades.length} trades in ${truth.sigs} txs; captured ${cmp.captured} (${pct(cmp.captured, truth.trades.length)})`,
    );
    out.push({
      mint: c.mint,
      venue: c.venue,
      state: history.state(c.mint),
      stored: stored.n,
      chain: truth.trades.length,
      txs: truth.sigs,
      captured: cmp.captured,
    });
  }
  return out;
}

await main();
