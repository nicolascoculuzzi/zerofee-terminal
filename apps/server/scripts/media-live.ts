#!/usr/bin/env bun
/**
 * Live image hit rate: runs the server in-process on the public RPC logs feed (pump program only, temp
 * SQLite and image cache, no accounts layer, nothing on-chain), and for every launch it sees, measures
 *   - launch -> metadata with an image (and socials), via the real metadata fetcher;
 *   - launch -> image served by GET /api/img (the real route over HTTP, s=96), retrying a 404 every 3 s
 *     for up to 60 s like a remounting avatar would;
 *   - request latency for a cold image (first request) and a warm one (a second request).
 *
 *   MINUTES=5 bun run --cwd apps/server media-live
 *   (IMG_PUMP_CDN=first|fallback|off and METADATA_GATEWAYS are honoured, as in the server)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageProxyUrl } from "@zerofee/protocol";
import { createApp, createSource } from "../src/app";
import { loadConfig } from "../src/config";
import type { IngestSink, Source } from "../src/ingest/types";
import { setLogLevel } from "../src/log";

const MINUTES = Number(process.env.MINUTES ?? 5);
const RETRY_MS = 3_000;
const GIVE_UP_MS = 60_000;

const dir = mkdtempSync(join(tmpdir(), "zf-media-live-"));
setLogLevel(process.env.LOG_LEVEL === "debug" ? "debug" : "warn");
const cfg = loadConfig({
  ...process.env,
  SERVER_PORT: "0",
  RPC_LOGS_PROGRAMS: "pump",
  DB_PATH: join(dir, "market.db"),
  IMG_CACHE_DIR: join(dir, "img-cache"),
  ENRICH_ENABLED: "false",
  PUMPPORTAL_ENABLED: "false",
});

interface Launch {
  mint: string;
  symbol: string;
  at: number;
  metaAt: number | null;
  image: string | null;
  socials: number;
  imgAt: number | null;
  imgStatus: number | null;
  attempts: number;
  coldMs: number | null;
  warmMs: number | null;
  bytes: number;
  type: string;
  busy: boolean;
  nextTry: number;
}
const launches = new Map<string, Launch>();

/** Wraps the real source to note when each launch arrived. */
function tap(inner: Source): Source {
  return {
    name: inner.name,
    start(sink: IngestSink) {
      inner.start({
        ...sink,
        tx(tx) {
          for (const e of tx.events) {
            if (e.kind === "pumpCreate" && !launches.has(e.mint)) {
              launches.set(e.mint, {
                mint: e.mint,
                symbol: e.symbol,
                at: tx.receivedAt,
                metaAt: null,
                image: null,
                socials: 0,
                imgAt: null,
                imgStatus: null,
                attempts: 0,
                coldMs: null,
                warmMs: null,
                bytes: 0,
                type: "",
                busy: false,
                nextTry: 0,
              });
            }
          }
          sink.tx(tx);
        },
      });
    },
    stop: () => inner.stop(),
    health: () => inner.health(),
  };
}

const app = createApp(cfg, { source: tap(createSource(cfg)), solUsd: null, pollers: false, enrich: false });
const base = `http://127.0.0.1:${app.gateway.port}`;
const startedAt = Date.now();
console.log(
  `media-live: ${MINUTES} min on ${cfg.rpcWsUrl.replace(/api-key=[^&]+/, "api-key=***")}, gateways ${cfg.metadataGateways.join(", ")}, pump CDN ${cfg.media.pumpCdn}`,
);

async function probe(l: Launch): Promise<void> {
  const url = imageProxyUrl(l.mint, l.image, 96) as string;
  l.busy = true;
  l.attempts++;
  try {
    const t0 = performance.now();
    const r = await fetch(`${base}${url}`);
    const body = new Uint8Array(await r.arrayBuffer());
    const ms = performance.now() - t0;
    l.imgStatus = r.status;
    if (r.ok) {
      l.imgAt = Date.now();
      l.coldMs = ms;
      l.bytes = body.byteLength;
      l.type = r.headers.get("content-type") ?? "";
      const t1 = performance.now();
      const again = await fetch(`${base}${url}`);
      await again.arrayBuffer();
      l.warmMs = performance.now() - t1;
    } else {
      l.nextTry = Date.now() + RETRY_MS;
    }
  } catch {
    l.nextTry = Date.now() + RETRY_MS;
  } finally {
    l.busy = false;
  }
}

const timer = setInterval(() => {
  const now = Date.now();
  for (const l of launches.values()) {
    if (l.metaAt === null) {
      const s = app.market.summary(l.mint);
      if (s?.image) {
        l.metaAt = now;
        l.image = s.image;
        l.socials = [s.socials.x, s.socials.telegram, s.socials.website].filter(Boolean).length;
      }
    }
    if (l.image && l.imgAt === null && !l.busy && now >= l.nextTry && now - (l.metaAt ?? now) <= GIVE_UP_MS) void probe(l);
  }
}, 250);

await Bun.sleep(MINUTES * 60_000);
// launches seen until now are measured; the last ones get the full retry window before the report
const cutoff = Date.now();
await Bun.sleep(GIVE_UP_MS);
clearInterval(timer);

const pct = (xs: number[], p: number): string => {
  if (!xs.length) return "-";
  const s = [...xs].sort((a, b) => a - b);
  return String(Math.round(s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] as number));
};
const rate = (n: number, d: number) => (d ? `${n}/${d} (${((100 * n) / d).toFixed(1)}%)` : `${n}/0`);
const all = [...launches.values()].filter((l) => l.at <= cutoff);
const withMeta = all.filter((l) => l.metaAt !== null);
const withImg = all.filter((l) => l.imgAt !== null);
const metaLat = withMeta.map((l) => (l.metaAt as number) - l.at);
const imgLat = withImg.map((l) => (l.imgAt as number) - l.at);
const hosts = new Map<string, number>();
for (const l of withMeta) {
  const h = new URL(l.image as string).hostname;
  hosts.set(h, (hosts.get(h) ?? 0) + 1);
}
const md = app.health().sources[0]?.notes.find((n) => n.startsWith("metadata:")) ?? "";
console.log(`\nlaunches measured: ${all.length} (of ${launches.size} seen in ${((Date.now() - startedAt) / 60_000).toFixed(1)} min)`);
console.log(
  `metadata with an image: ${rate(withMeta.length, all.length)}; launch -> metadata p50 ${pct(metaLat, 50)} ms, p90 ${pct(metaLat, 90)} ms`,
);
console.log(
  `image served by /api/img: ${rate(withImg.length, all.length)} of launches, ${rate(withImg.length, withMeta.length)} of those with an image`,
);
console.log(
  `launch -> image served: p50 ${pct(imgLat, 50)} ms, p90 ${pct(imgLat, 90)} ms, within 10 s: ${rate(imgLat.filter((x) => x <= 10_000).length, all.length)}`,
);
console.log(
  `proxy latency: first request p50 ${pct(
    withImg.map((l) => l.coldMs as number),
    50,
  )} ms p90 ${pct(
    withImg.map((l) => l.coldMs as number),
    90,
  )} ms; ` +
    `repeat p50 ${pct(
      withImg.map((l) => l.warmMs as number),
      50,
    )} ms p90 ${pct(
      withImg.map((l) => l.warmMs as number),
      90,
    )} ms`,
);
console.log(
  `image bytes at s=96: p50 ${pct(
    withImg.map((l) => l.bytes),
    50,
  )}, p90 ${pct(
    withImg.map((l) => l.bytes),
    90,
  )}; types ${[...new Set(withImg.map((l) => l.type))].join(", ")}`,
);
console.log(`socials: ${rate(withMeta.filter((l) => l.socials > 0).length, withMeta.length)} of tokens with metadata have at least one`);
console.log(
  `image hosts: ${[...hosts]
    .sort((a, b) => b[1] - a[1])
    .map(([h, n]) => `${h} ${n}`)
    .join(", ")}`,
);
console.log(`proxy sources: ${JSON.stringify(app.media.stats.sources)}; failures: ${JSON.stringify(app.media.stats.failures)}`);
console.log(`source health: ${JSON.stringify(app.media.health.snapshot())}`);
console.log(
  `proxy: resized ${app.media.stats.resized}, passthrough ${app.media.stats.passthrough}, prefetched ${app.media.stats.prefetched}`,
);
console.log(md);
const missing = all.filter((l) => l.imgAt === null).slice(0, 12);
if (missing.length) {
  console.log("\nexamples without a served image:");
  for (const l of missing)
    console.log(`  ${l.mint} ${l.symbol.slice(0, 12).padEnd(12)} image=${l.image ?? "-"} last=${l.imgStatus ?? "-"} tries=${l.attempts}`);
}
await app.stop();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
