#!/usr/bin/env bun
/**
 * Live image hit rate: runs the server in-process on the public RPC logs feed (pump program only, no
 * accounts layer, nothing on-chain) and measures what a user sees.
 *
 *  - Launches: launch -> metadata with an image, and launch -> image served by GET /api/img (s=96), probed
 *    every 3 s for up to 2 min after the metadata named an image (like a remounting avatar).
 *  - Restored tokens (a restart on a populated DATA_DIR): every restored token whose metadata names an
 *    image is "scrolled to" once at a random moment in the first half of the run and probed every 5 s for
 *    up to 2 min; time-to-image counts from that first look. A Pulse client (3 IPs) also requests every
 *    avatar in the Pulse columns as they appear, all at once, as a browser does.
 *  - Upstream answers by host and status (every outbound fetch goes through a counting wrapper), so 429s are
 *    counted for metadata and images alike.
 *  - Ingest latency (p50/p90/p99 of trade detection) and event-loop lag (p50/p99/max, sampled every 20 ms).
 *
 *   MINUTES=10 DATA_DIR=/tmp/zf-live bun run --cwd apps/server media-live    # first run fills DATA_DIR
 *   MINUTES=10 DATA_DIR=/tmp/zf-live bun run --cwd apps/server media-live    # restart on the same data
 *   (IMG_* and METADATA_* settings are honoured, as in the server; without DATA_DIR a temp dir is used)
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageProxyUrl } from "@zerofee/protocol";
import { createApp, createSource } from "../src/app";
import { loadConfig } from "../src/config";
import type { IngestSink, Source } from "../src/ingest/types";
import { setLogLevel } from "../src/log";

const MINUTES = Number(process.env.MINUTES ?? 5);
const LAUNCH_RETRY_MS = 3_000;
const RESTORED_RETRY_MS = 5_000;
const GIVE_UP_MS = 120_000;

const keep = !!process.env.DATA_DIR;
const dir = process.env.DATA_DIR ?? mkdtempSync(join(tmpdir(), "zf-media-live-"));
mkdirSync(dir, { recursive: true });
setLogLevel(process.env.LOG_LEVEL === "debug" ? "debug" : process.env.LOG_LEVEL === "info" ? "info" : "warn");

// ---- upstream accounting: every outbound fetch -------------------------------------------------------
const upstream = new Map<string, Map<string, number>>();
const count = (host: string, key: string) => {
  const m = upstream.get(host) ?? new Map<string, number>();
  upstream.set(host, m);
  m.set(key, (m.get(key) ?? 0) + 1);
};
const countingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  let host = "?";
  try {
    host = new URL(url).hostname;
  } catch {}
  try {
    const r = await fetch(input, init);
    count(host, String(r.status));
    return r;
  } catch (e) {
    count(host, (e as Error)?.name === "AbortError" || (e as Error)?.name === "TimeoutError" ? "abort" : "network");
    throw e;
  }
}) as typeof fetch;

// ---- event-loop lag ---------------------------------------------------------------------------------
const lag: number[] = [];
let lagLast = performance.now();
const lagTimer = setInterval(() => {
  const now = performance.now();
  lag.push(Math.max(0, now - lagLast - 20));
  lagLast = now;
}, 20);

const cfg = loadConfig({
  ...process.env,
  SERVER_PORT: "0",
  RPC_LOGS_PROGRAMS: "pump",
  DB_PATH: join(dir, "market.db"),
  IMG_CACHE_DIR: join(dir, "img-cache"),
  ENRICH_ENABLED: "false",
  PUMPPORTAL_ENABLED: "false",
  TRUST_PROXY: "true",
});

interface Probe {
  mint: string;
  symbol: string;
  /** launch time, or the first look for a restored token */
  at: number;
  metaAt: number | null;
  image: string | null;
  firstProbeAt: number | null;
  imgAt: number | null;
  imgStatus: number | null;
  imgState: string | null;
  attempts: number;
  coldMs: number | null;
  cache: string | null;
  bytes: number;
  busy: boolean;
  nextTry: number;
}
const probe = (mint: string, symbol: string, at: number): Probe => ({
  mint,
  symbol,
  at,
  metaAt: null,
  image: null,
  firstProbeAt: null,
  imgAt: null,
  imgStatus: null,
  imgState: null,
  attempts: 0,
  coldMs: null,
  cache: null,
  bytes: 0,
  busy: false,
  nextTry: 0,
});
const launches = new Map<string, Probe>();

function tap(inner: Source): Source {
  return {
    name: inner.name,
    start(sink: IngestSink) {
      inner.start({
        ...sink,
        tx(tx) {
          for (const e of tx.events)
            if (e.kind === "pumpCreate" && !launches.has(e.mint)) launches.set(e.mint, probe(e.mint, e.symbol, tx.receivedAt));
          sink.tx(tx);
        },
      });
    },
    stop: () => inner.stop(),
    health: () => inner.health(),
  };
}

const t0 = Date.now();
const app = createApp(cfg, { source: tap(createSource(cfg)), solUsd: null, pollers: false, enrich: false, fetchFn: countingFetch });
const base = `http://127.0.0.1:${app.gateway.port}`;
const runMs = MINUTES * 60_000;

// restored tokens: everything in memory before the feed delivered anything
const restored = new Map<string, Probe>();
for (const [mint, rec] of app.market.tokens) {
  const p = probe(mint, rec.symbol ?? "", t0 + Math.random() * (runMs / 2));
  if (rec.image) {
    p.image = rec.image;
    p.metaAt = t0;
  }
  restored.set(mint, p);
}
const restoredWithImageAtStart = [...restored.values()].filter((p) => p.image).length;
console.log(
  `media-live: ${MINUTES} min, data ${dir}${keep ? " (kept)" : ""}, restored ${restored.size} tokens (${restoredWithImageAtStart} with an image), ` +
    `gateways ${cfg.metadataGateways.join(", ")}, pump CDN ${cfg.media.pumpCdn}, prefetch ${cfg.media.prefetch ? "on" : "off"}`,
);

async function request(p: Probe, ip: string, retryMs: number): Promise<void> {
  const url = imageProxyUrl(p.mint, p.image, 96) as string;
  p.busy = true;
  p.attempts++;
  p.firstProbeAt ??= Date.now();
  try {
    const s = performance.now();
    const r = await fetch(`${base}${url}`, { headers: { "x-forwarded-for": ip } });
    const body = new Uint8Array(await r.arrayBuffer());
    p.imgStatus = r.status;
    p.imgState = r.headers.get("x-zf-image");
    if (r.ok) {
      p.imgAt = Date.now();
      p.coldMs = performance.now() - s;
      p.bytes = body.byteLength;
      p.cache = r.headers.get("x-zf-cache");
    } else {
      p.nextTry = Date.now() + retryMs;
    }
  } catch {
    p.nextTry = Date.now() + retryMs;
  } finally {
    p.busy = false;
  }
}

/** Viewers are many users: 64 client IPs (the per-IP limits are not what this measures). */
const viewerIp = (mint: string): string => `203.0.113.${(mint.charCodeAt(0) * 31 + mint.charCodeAt(1) * 7 + mint.charCodeAt(2)) % 64}`;

// Pulse client: every avatar in the columns, requested as soon as it appears (once; a 404 keeps the monogram)
const pulseSeen = new Set<string>();
let pulseRequests = 0;
let pulseOk = 0;
const pulseTimer = setInterval(() => {
  for (const col of ["new", "final", "migrated"] as const) {
    for (const s of app.pulse.snapshot(col).slice(0, 40)) {
      if (!s.image || pulseSeen.has(`${s.mint}|${s.image}`)) continue;
      pulseSeen.add(`${s.mint}|${s.image}`);
      for (const ip of ["198.51.100.1", "198.51.100.2", "198.51.100.3"]) {
        pulseRequests++;
        void fetch(`${base}${imageProxyUrl(s.mint, s.image, 96)}`, { headers: { "x-forwarded-for": ip } })
          .then(async (r) => {
            await r.arrayBuffer();
            if (r.ok) pulseOk++;
          })
          .catch(() => {});
      }
    }
  }
}, 1_000);

const timer = setInterval(() => {
  const now = Date.now();
  for (const p of launches.values()) {
    if (p.metaAt === null) {
      const s = app.market.summary(p.mint);
      if (s?.image) {
        p.metaAt = now;
        p.image = s.image;
      }
    }
    if (p.image && p.imgAt === null && !p.busy && now >= p.nextTry && now - (p.metaAt ?? now) <= GIVE_UP_MS)
      void request(p, viewerIp(p.mint), LAUNCH_RETRY_MS);
  }
  for (const p of restored.values()) {
    if (now < p.at || now > t0 + runMs) continue;
    if (!p.image) {
      const s = app.market.summary(p.mint);
      if (s?.image) {
        p.image = s.image;
        p.metaAt = now;
      }
    }
    if (p.image && p.imgAt === null && !p.busy && now >= p.nextTry && now - Math.max(p.at, p.metaAt ?? 0) <= GIVE_UP_MS)
      void request(p, viewerIp(p.mint), RESTORED_RETRY_MS);
  }
}, 250);

await Bun.sleep(runMs);
const cutoff = Date.now();
await Bun.sleep(GIVE_UP_MS);
clearInterval(timer);
clearInterval(pulseTimer);
clearInterval(lagTimer);

const pct = (xs: number[], p: number): string => {
  if (!xs.length) return "-";
  const s = [...xs].sort((a, b) => a - b);
  return String(Math.round(s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] as number));
};
const rate = (n: number, d: number) => (d ? `${n}/${d} (${((100 * n) / d).toFixed(1)}%)` : `${n}/0`);
const h = app.health();

const all = [...launches.values()].filter((l) => l.at <= cutoff);
const withMeta = all.filter((l) => l.metaAt !== null);
const withImg = all.filter((l) => l.imgAt !== null);
console.log(`\n== launches: ${all.length} measured (of ${launches.size} seen in ${((Date.now() - t0) / 60_000).toFixed(1)} min)`);
console.log(
  `metadata named an image: ${rate(withMeta.length, all.length)}; launch -> metadata p50 ${pct(
    withMeta.map((l) => (l.metaAt as number) - l.at),
    50,
  )} ms p90 ${pct(
    withMeta.map((l) => (l.metaAt as number) - l.at),
    90,
  )} ms`,
);
console.log(`image served: ${rate(withImg.length, withMeta.length)} of launches whose metadata names an image`);
const lat = withImg.map((l) => (l.imgAt as number) - l.at);
console.log(`launch -> image: p50 ${pct(lat, 50)} ms, p90 ${pct(lat, 90)} ms, p99 ${pct(lat, 99)} ms`);
const mlat = withImg.map((l) => (l.imgAt as number) - (l.metaAt as number));
console.log(`metadata -> image: p50 ${pct(mlat, 50)} ms, p90 ${pct(mlat, 90)} ms`);
console.log(
  `first request served from cache (prefetched): ${rate(withImg.filter((l) => l.cache === "hit" && l.attempts === 1).length, withImg.length)}`,
);
console.log(
  `bytes at s=96: p50 ${pct(
    withImg.map((l) => l.bytes),
    50,
  )} p90 ${pct(
    withImg.map((l) => l.bytes),
    90,
  )}`,
);

const rs = [...restored.values()].filter((p) => p.image && p.firstProbeAt !== null);
const rsImg = rs.filter((p) => p.imgAt !== null);
const rlat = rsImg.map((p) => (p.imgAt as number) - (p.firstProbeAt as number));
console.log(
  `\n== restored: ${restored.size} tokens, ${restoredWithImageAtStart} with an image at start, ${rs.length} with an image and looked at`,
);
console.log(`image served: ${rate(rsImg.length, rs.length)}; first look -> image p50 ${pct(rlat, 50)} ms p90 ${pct(rlat, 90)} ms`);
console.log(`first look served from cache: ${rate(rsImg.filter((p) => p.attempts === 1 && p.cache === "hit").length, rs.length)}`);
console.log(`\n== pulse client: ${pulseRequests} avatar requests, ${rate(pulseOk, pulseRequests)} served on the first try`);

console.log("\n== upstream answers by host (status: count)");
for (const [host, m] of [...upstream].sort(
  (a, b) => [...b[1].values()].reduce((x, y) => x + y) - [...a[1].values()].reduce((x, y) => x + y),
)) {
  if (host.includes("solana") || host.includes("helius")) continue;
  console.log(
    `  ${host.padEnd(36)} ${[...m]
      .sort()
      .map(([k, v]) => `${k}:${v}`)
      .join(" ")}`,
  );
}
const total429 = [...upstream].filter(([host]) => !host.includes("solana")).reduce((a, [, m]) => a + (m.get("429") ?? 0), 0);
console.log(`  total 429s (metadata + images): ${total429}`);

const media = app.media as unknown as { stats: Record<string, unknown>; health: { snapshot(): unknown } };
console.log(`\nproxy failures: ${JSON.stringify(media.stats.failures)}; sources: ${JSON.stringify(media.stats.sources)}`);
console.log(`proxy: ${JSON.stringify({ ...media.stats, failures: undefined, sources: undefined })}`);
const notes = h.sources[0]?.notes.filter((n) => n.startsWith("metadata") || n.startsWith("images")) ?? [];
for (const n of notes) console.log(n);
const ing = h.ingest.latency;
console.log(`\n== ingest latency (trades): p50 ${ing.p50} ms, p90 ${ing.p90} ms, p99 ${ing.p99} ms (${ing.samples} samples)`);
console.log(`event-loop lag (20 ms timer): p50 ${pct(lag, 50)} ms, p99 ${pct(lag, 99)} ms, max ${pct(lag, 100)} ms`);
const extra = h as unknown as { eventLoopLag?: unknown };
if (extra.eventLoopLag) console.log(`server loop-lag monitor (50 ms timer, last 5 min): ${JSON.stringify(extra.eventLoopLag)}`);
const m2 = app.media as unknown as {
  pacer?: { snapshot(): { host: string; started: number; throttled: number; rate: number }[] };
  jobCounts?: () => unknown;
  pool?: { stats: unknown; timing: { wait: { percentiles(p: number[]): unknown }; run: { percentiles(p: number[]): unknown } } };
};
if (m2.pacer)
  console.log(
    `pacer: ${m2.pacer
      .snapshot()
      .filter((x) => x.started > 2)
      .map((x) => `${x.host} started ${x.started} throttled ${x.throttled} rate ${x.rate}`)
      .join("; ")}`,
  );
if (m2.jobCounts) console.log(`image jobs now: ${JSON.stringify(m2.jobCounts())}`);
if (m2.pool)
  console.log(
    `work pool: ${JSON.stringify(m2.pool.stats)}; wait p50/p99 ${JSON.stringify(m2.pool.timing.wait.percentiles([50, 99]))} ms, run p50/p99 ${JSON.stringify(m2.pool.timing.run.percentiles([50, 99]))} ms`,
  );
const missing = [...all.filter((l) => l.metaAt !== null && l.imgAt === null), ...rs.filter((p) => p.imgAt === null)].slice(0, 15);
if (missing.length) {
  console.log("\nexamples without a served image:");
  for (const l of missing)
    console.log(
      `  ${l.mint} ${l.symbol.slice(0, 10).padEnd(10)} ${l.image ?? "-"} last=${l.imgStatus ?? "-"}/${l.imgState ?? "-"} tries=${l.attempts}`,
    );
}
const noMeta = all.filter((l) => l.metaAt === null).slice(0, 8);
if (noMeta.length) {
  console.log("\nexamples of launches without an image URL:");
  for (const l of noMeta) {
    const rec = app.market.tokens.get(l.mint);
    console.log(`  ${l.mint} ${l.symbol.slice(0, 10).padEnd(10)} uri=${rec?.uri ?? "-"} metadata=${rec?.metadataState ?? "-"}`);
  }
}
await app.stop();
if (!keep) rmSync(dir, { recursive: true, force: true });
process.exit(0);
