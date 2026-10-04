#!/usr/bin/env bun
/**
 * Wallet-tracker matcher benchmark (offline, synthetic). Builds the in-memory index for USERS x
 * PER_USER tracked wallets (plus POPULAR wallets each tracked by FANS more users), then pushes TRADES
 * synthetic trades through the full match path (index lookup, balance / first-buy, rows for the
 * owners with an open socket, alert hook, feed flush) and reports throughput and heap per address.
 *
 *   bun run --cwd apps/server tracker-bench
 *   USERS=10 PER_USER=10000 TRADES=200000 MATCH_PCT=5 bun apps/server/scripts/tracker-bench.ts --json
 */
import { heapStats } from "bun:jsc";
import type { Trade } from "@zerofee/protocol";
import { loadConfig } from "../src/config";
import type { PgDriver, UserStore } from "../src/db/pg";
import type { IngestTx } from "../src/ingest/types";
import { setLogLevel } from "../src/log";
import { newTokenRecord } from "../src/market/token";
import type { Publisher } from "../src/trackers/feed";
import { TrackerService } from "../src/trackers/service";
import { type TrackedInput, WalletIndex } from "../src/trackers/walletIndex";

setLogLevel("error");
const env = (k: string, d: number) => Number(process.env[k] ?? d);
const USERS = env("USERS", 1_000);
const PER_USER = env("PER_USER", 100);
const POPULAR = env("POPULAR", 500);
const FANS = env("FANS", 40);
const TRADES = env("TRADES", 100_000);
const MATCH_PCT = env("MATCH_PCT", 2);
const ONLINE_PCT = env("ONLINE_PCT", 10);

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
let seed = 7;
const rnd = () => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed;
};
const codes = new Array<number>(44);
/** Flat (non-rope) 44-character strings, like the ones a database read or the decoder produces. */
const randomAddress = () => {
  for (let i = 0; i < 44; i++) codes[i] = B58.charCodeAt(rnd() % 58);
  return String.fromCharCode(...codes);
};

const lists: TrackedInput[][] = [];
const tracked: string[] = [];
for (let u = 0; u < USERS; u++) {
  lists.push(
    Array.from({ length: PER_USER }, () => {
      const address = randomAddress();
      tracked.push(address);
      return { address, label: `wallet ${u}`, emoji: "🐳", tags: [] };
    }),
  );
}
const popular: TrackedInput[] = tracked.slice(0, POPULAR).map((address) => ({ address, label: "kol", emoji: "", tags: [] }));

// Memory: the index alone over strings that already exist (as after reading them from Postgres).
Bun.gc(true);
Bun.gc(true);
const heap0 = heapStats().heapSize;
const probe = new WalletIndex({ maxEntries: 100_000_000, maxTrackedPerUser: 10_000 });
for (let u = 0; u < USERS; u++) probe.setTracked(`user-${u}`, lists[u] as TrackedInput[]);
for (let f = 0; f < FANS; f++) probe.setTracked(`fan-${f}`, popular);
Bun.gc(true);
Bun.gc(true);
const bytesPerAddress = (heapStats().heapSize - heap0) / probe.stats.addresses;

let alertCalls = 0;
let rows = 0;
const online = new Set<string>();
const hub: Publisher = {
  hasSubscribers: (topic) => online.has(topic),
  publish: (topic, _type, data) => {
    if (!online.has(topic)) return false;
    rows += (data as { rows?: unknown[] }).rows?.length ?? 0;
    JSON.stringify(data); // the gateway serializes every frame once
    return true;
  },
};
const svc = new TrackerService({
  cfg: loadConfig({ LOG_LEVEL: "error" }).trackers,
  db: {} as PgDriver, // never touched: no copy tasks, no reloads
  store: {} as UserStore,
  alerts: { onWalletActivity: () => alertCalls++ },
});
svc.attachHub(hub);
const mints = Array.from({ length: 500 }, randomAddress);
const tokens = new Map(mints.map((m, i) => [m, newTokenRecord(m, 0, { symbol: `T${i}`, name: `Token ${i}` })]));
svc.attachMarket({ tokens, summary: () => null, recentTrades: () => [] }, () => 150);
const b0 = performance.now();
for (let u = 0; u < USERS; u++) svc.index.setTracked(`user-${u}`, lists[u] as TrackedInput[]);
for (let f = 0; f < FANS; f++) svc.index.setTracked(`fan-${f}`, popular);
const buildMs = performance.now() - b0;
for (let u = 0; u < USERS; u += Math.max(1, Math.round(100 / ONLINE_PCT))) online.add(`tracked@user-${u}`);
for (let f = 0; f < FANS; f += Math.max(1, Math.round(100 / ONLINE_PCT))) online.add(`tracked@fan-${f}`);

const every = Math.max(1, Math.round(100 / MATCH_PCT));
const trades: Trade[] = [];
for (let i = 0; i < TRADES; i++) {
  const trader = i % every === 0 ? (tracked[rnd() % tracked.length] as string) : randomAddress();
  trades.push({
    id: `sig${i}:0`,
    signature: `sig${i}`,
    slot: 1_000 + (i >> 6),
    txIndex: null,
    mint: mints[i % mints.length] as string,
    venue: i % 4 === 0 ? "pumpswap" : "pump",
    side: i % 3 === 0 ? "sell" : "buy",
    trader,
    quoteAmount: "100000000",
    tokenAmount: "3000000000000",
    amountSol: 0.1,
    amountUsd: 15,
    priceSol: 3e-8,
    mcSol: 30,
    blockTime: 1_791_000_000_000,
    receivedAt: 1_791_000_000_400,
    tags: [],
  });
}
const tx = { signers: null, tokenBalances: null } as unknown as IngestTx;

// Warm up, then measure lookups alone and the whole path.
for (let i = 0; i < Math.min(10_000, TRADES); i++) svc.index.get((trades[i] as Trade).trader);
const l0 = performance.now();
let hits = 0;
for (const t of trades) if (svc.index.get(t.trader)) hits++;
const lookupMs = performance.now() - l0;
const m0 = performance.now();
for (const t of trades) svc.onTrade(t, tx);
svc.feed.flush();
const matchMs = performance.now() - m0;

const result = {
  addresses: svc.index.stats.addresses,
  watchers: svc.index.stats.entries,
  users: svc.index.stats.users,
  buildMs: Math.round(buildMs),
  bytesPerAddress: Math.round(bytesPerAddress),
  trades: TRADES,
  matches: svc.stats.matchedTrades,
  hits,
  lookupsPerSec: Math.round(TRADES / (lookupMs / 1000)),
  tradesPerSec: Math.round(TRADES / (matchMs / 1000)),
  alertCalls,
  rowsPublished: rows,
};
if (process.argv.includes("--json")) console.log(JSON.stringify(result));
else {
  console.log(
    `index: ${result.addresses.toLocaleString("en-US")} addresses, ${result.watchers.toLocaleString("en-US")} watchers, ${result.users} users, ` +
      `built in ${result.buildMs} ms, ~${result.bytesPerAddress} B/address`,
  );
  console.log(
    `match: ${TRADES.toLocaleString("en-US")} trades (${MATCH_PCT}% tracked): lookups ${result.lookupsPerSec.toLocaleString("en-US")}/s, ` +
      `full path ${result.tradesPerSec.toLocaleString("en-US")} trades/s, ${result.matches} matches, ${rows} rows to online owners, ${alertCalls} alert calls`,
  );
}
