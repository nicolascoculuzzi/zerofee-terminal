#!/usr/bin/env bun
/**
 * zerofee-terminal server. `bun run start` (or `bun run dev`) from apps/server, or
 * `bun apps/server/src/main.ts` from the repo root. Config: environment / `.env` (see .env.example).
 * Binds to 127.0.0.1 and runs with DRY_RUN=true unless configured otherwise. User state goes to
 * Postgres when DATABASE_URL is set, otherwise to an in-process PGlite database (development).
 */
import { createApp } from "./app";
import { loadConfig, redactUrl } from "./config";
import { logger, setLogLevel } from "./log";
import { createUserLayer } from "./user";

const log = logger("main");
const cfg = loadConfig();
setLogLevel(cfg.logLevel);
log.info(
  `starting: source=${cfg.source} rpc=${redactUrl(cfg.rpcUrl)} ws=${redactUrl(cfg.rpcWsUrl)} db=${cfg.dbPath} dryRun=${cfg.dryRun} bind=${cfg.host}:${cfg.port}`,
);
if (!cfg.dryRun) log.warn("DRY_RUN=false: POST /api/tx will SEND transactions to the landing lanes");
log.info(
  `accounts: origin=${cfg.auth.publicOrigin} siws domain=${cfg.auth.siwsDomain} allowed origins=${cfg.auth.allowedOrigins.join(",")}`,
);

const user = await createUserLayer(cfg);
const app = createApp(cfg, { user });

const statsTimer = setInterval(() => {
  const h = app.health();
  const s = h.sources[0];
  log.info(
    `launches ${h.ingest.launches} migrations ${h.ingest.migrations} trades ${h.ingest.trades} (${h.ingest.tradesPerSec1m}/s) ` +
      `decode failures ${h.ingest.decodeFailures} latency p50/p90 ${h.ingest.latency.p50}/${h.ingest.latency.p90} ms ` +
      `tokens ${h.tokens.inMemory} pulse ${JSON.stringify(h.tokens.pulse)} source ${s?.connected ? "up" : "DOWN"} reconnects ${s?.reconnects ?? 0} ` +
      `pending pool events ${h.ingest.pendingPoolEvents} db pending ${h.storage.pendingRows} SOL ${h.solUsd.price ?? "-"}`,
  );
}, 60_000);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info(`${signal}: shutting down`);
  clearInterval(statsTimer);
  await app.stop();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
