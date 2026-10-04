#!/usr/bin/env bun
/**
 * `bun run feed` (from apps/server): runs the configured ingest source alone (no DB, no gateway) and
 * prints every launch and migration as it is decoded, plus a summary line per minute.
 *   INGEST_SOURCE=rpc (default, public RPC logsSubscribe) | yellowstone (YELLOWSTONE_ENDPOINT, _X_TOKEN)
 *   FEED_MINUTES=<n> stops after n minutes and prints a final report (default: run until Ctrl-C).
 */
import type { DecodedEvent } from "@zerofee/core";
import { createSource } from "../app";
import { loadConfig, redactUrl } from "../config";
import { setLogLevel } from "../log";
import { SampleRing } from "../util/stats";

const cfg = loadConfig();
setLogLevel(cfg.logLevel === "debug" ? "debug" : "warn");
const source = createSource(cfg);
const minutes = Number(process.env.FEED_MINUTES ?? 0);

interface Counts {
  txs: number;
  launches: number;
  migrations: number;
  completes: number;
  curveTrades: number;
  poolTrades: number;
  decodeFailures: number;
}
const zero = (): Counts => ({ txs: 0, launches: 0, migrations: 0, completes: 0, curveTrades: 0, poolTrades: 0, decodeFailures: 0 });
let minute = zero();
const total = zero();
const latency = new SampleRing(100_000);
const launchLatency = new SampleRing(10_000);
const startedAt = Date.now();

const tsOf = (e: DecodedEvent): number | null => ("timestamp" in e ? Number(e.timestamp) * 1000 : null);
const time = (ms: number) => new Date(ms).toISOString().slice(11, 23);
const bump = (k: keyof Counts, n = 1) => {
  minute[k] += n;
  total[k] += n;
};

console.log(
  `feed: source=${source.name} rpc-ws=${redactUrl(cfg.rpcWsUrl)} programs=${cfg.rpcLogsPrograms.join(",")} commitment=${cfg.rpcLogsCommitment}`,
);
source.start({
  tx(tx) {
    bump("txs");
    for (const e of tx.events) {
      const ts = tsOf(e);
      const lat = ts === null ? null : tx.receivedAt - ts;
      switch (e.kind) {
        case "pumpCreate":
          bump("launches");
          if (lat !== null) launchLatency.add(lat);
          console.log(
            `${time(tx.receivedAt)} LAUNCH ${e.symbol.padEnd(10).slice(0, 10)} ${e.name.slice(0, 28).padEnd(28)} ${e.mint} ${e.isMayhemMode ? "mayhem " : ""}latency ${lat} ms`,
          );
          break;
        case "pumpMigrate":
          bump("migrations");
          console.log(`${time(tx.receivedAt)} MIGRATE ${e.mint} -> pool ${e.pool} latency ${lat} ms`);
          break;
        case "pumpComplete":
          bump("completes");
          break;
        case "pumpTrade":
          bump("curveTrades");
          if (lat !== null) latency.add(lat);
          break;
        case "ammBuy":
        case "ammSell":
          bump("poolTrades");
          if (lat !== null) latency.add(lat);
          break;
      }
    }
  },
  decodeFailure() {
    bump("decodeFailures");
  },
});

function summary(c: Counts, secs: number): string {
  const [p50, p90, p99] = latency.percentiles([50, 90, 99]);
  const [l50, l90] = launchLatency.percentiles([50, 90]);
  const h = source.health();
  const trades = c.curveTrades + c.poolTrades;
  return (
    `launches ${c.launches}, migrations ${c.migrations}, completes ${c.completes}, trades ${trades} (${(trades / secs).toFixed(1)}/s: curve ${c.curveTrades}, pumpswap ${c.poolTrades}), ` +
    `txs ${c.txs}, decode failures ${c.decodeFailures}, reconnects ${h.reconnects}, dropped ${h.dropped}, ` +
    `latency p50/p90/p99 ${p50}/${p90}/${p99} ms, launch p50/p90 ${l50}/${l90} ms`
  );
}

const timer = setInterval(() => {
  console.log(`-- last minute: ${summary(minute, 60)}`);
  minute = zero();
}, 60_000);

async function finish(): Promise<void> {
  clearInterval(timer);
  await source.stop();
  const secs = (Date.now() - startedAt) / 1000;
  console.log(`== total over ${secs.toFixed(0)} s: ${summary(total, secs)}`);
  for (const n of source.health().notes) console.log(`   ${n}`);
  process.exit(0);
}
if (minutes > 0) setTimeout(() => void finish(), minutes * 60_000);
process.on("SIGINT", () => void finish());
